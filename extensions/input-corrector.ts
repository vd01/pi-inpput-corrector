/**
 * Input Corrector Extension
 *
 * A Pi extension that checks each user input for language quality.
 * Uses a configured sub-agent (direct API call) with minimal overhead.
 *
 * Auto-creates a default agent file on first run if none exists.
 *   - User creates ~/.pi/agent/agents/input-corrector.md (see README)
 *   - The agent file specifies model, system prompt, and x- config fields
 *
 * On each user input (excluding commands and !bash):
 *   - If input is clear/idiomatic -> encouraging notification, pass through
 *   - If Chinese/mixed/unnatural -> show 1-3 suggestions, wait for rewrite
 *   - After rewrite -> pass through without re-checking (once per input)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ------------------------------------------------------------------

interface CorrectorConfig {
  model: string;
  providerId: string;
  modelName: string;
  failMode: "open" | "closed";
  enabled: boolean;
  systemPrompt: string;
}

interface SubagentVerdict {
  verdict: "clear" | "needs_correction";
  suggestions?: string[];
  failReason?: string;
  /** Raw model response text for diagnostics */
  rawResponse?: string;
}

interface ProviderConnection {
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string | undefined>;
}

// --- Constants --------------------------------------------------------------

const AGENT_FILENAME = "input-corrector.md";
const WIDGET_ID = "input-corrector";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_SUGGESTIONS = 3;
const RAW_RESPONSE_SLICE = 500;

/** English stop words — used to detect trivial/cosmetic suggestions */
const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by",
  "is", "are", "was", "were", "be", "been", "it", "its",
  "that", "this", "these", "those", "and", "or", "but", "not",
  "with", "from", "as", "do", "does", "did", "has", "have", "had",
  "will", "would", "can", "could", "should", "may", "might",
  "shall", "must", "if", "then", "than", "so", "no", "up", "out",
  "just", "also", "very", "too", "more", "most", "some", "any",
  "all", "each", "every", "both", "few", "many", "much", "own",
  "other", "such", "only", "same", "being", "having", "doing",
]);

// --- Default Agent Template ------------------------------------------------

const DEFAULT_AGENT_CONTENT = `---
name: input-corrector
description: Checks user input language quality and suggests natural alternatives
model: google/gemini-2.5-flash
x-fail-mode: open
x-enabled: true
---
Output ONLY a JSON object. Do NOT think, reason, analyze, or explain. No chain-of-thought. No commentary. Just the JSON.

Rules:
- If the input is clear, natural, idiomatic English: {"verdict":"clear"}
- If the input contains Chinese characters (even mixed with English): {"verdict":"needs_correction","suggestions":["...","..."]}
- If the input is unnatural, awkward, or impractical English: {"verdict":"needs_correction","suggestions":["...","..."]}

For "needs_correction", provide 1-3 idiomatic English alternatives.
Make suggestions concise and natural - what a fluent speaker would actually write.
`;

// --- Helpers ----------------------------------------------------------------

/** Tokenize text into words (split on punctuation/whitespace, drop empties) */
export function tokenize(text: string): string[] {
  return text.split(/[\s,.;:!?()\[\]{}'"+]+/).filter((w) => w.length > 0);
}

/**
 * Check whether any suggestion has ≥2 novel content words vs the original.
 * Filters out trivial/cosmetic tweaks where the model is just nitpicking.
 */
export function hasMeaningfulSuggestion(original: string, suggestions: string[]): boolean {
  const origLower = original.toLowerCase().trim();
  const origWords = new Set(tokenize(origLower));

  return suggestions.some((s) => {
    const sLower = s.toLowerCase().trim();
    if (sLower === origLower) return false;
    const novelContentWords = tokenize(sLower)
      .filter((w) => !origWords.has(w) && !STOP_WORDS.has(w))
      .length;
    return novelContentWords >= 2;
  });
}

/** Combine two AbortSignals: if either fires, the combined signal fires. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const abort = (s: AbortSignal) => controller.abort(s.reason);
  a.addEventListener("abort", () => abort(a), { once: true });
  b.addEventListener("abort", () => abort(b), { once: true });
  return controller.signal;
}

// --- Config -----------------------------------------------------------------

/** Auto-create the default agent file if it doesn't exist. */
function ensureDefaultAgent(): string | null {
  const agentsDir = path.join(getAgentDir(), "agents");
  const filePath = path.join(agentsDir, AGENT_FILENAME);

  if (fs.existsSync(filePath)) return filePath;

  try {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(filePath, DEFAULT_AGENT_CONTENT, "utf-8");
    return filePath;
  } catch (e) {
    console.warn("[input-corrector] Failed to create default agent file:", e);
    return null;
  }
}

/** Load config from agent file (searches user dir then project dir). */
function loadConfig(cwd: string): CorrectorConfig | null {
  const searchPaths = [
    path.join(getAgentDir(), "agents"),
    path.join(cwd, ".pi", "agents"),
  ];

  for (const dir of searchPaths) {
    const filePath = path.join(dir, AGENT_FILENAME);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { frontmatter, body } =
        parseFrontmatter<Record<string, string>>(content);

      if (!frontmatter.model) {
        console.warn(`[input-corrector] ${filePath} missing "model" field`);
        continue;
      }

      const model = frontmatter.model;
      const slashIdx = model.indexOf("/");
      const providerId = slashIdx >= 0 ? model.slice(0, slashIdx) : model;
      const modelName = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;

      return {
        model,
        providerId,
        modelName,
        failMode: (frontmatter["x-fail-mode"] as "open" | "closed") ?? "open",
        enabled: frontmatter["x-enabled"] !== "false",
        systemPrompt: body.trim() || "",
      };
    } catch (e) {
      console.warn(`[input-corrector] Failed to load ${filePath}:`, e);
      return null;
    }
  }

  return null;
}

// --- Provider API -----------------------------------------------------------

export function buildOpenAIPayload(
  modelName: string,
  systemPrompt: string,
  userInput: string,
): object {
  return {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ],
    max_tokens: 300,
    temperature: 0.1,
    response_format: { type: "json_object" },
    reasoning_effort: "none",
  };
}

export function buildGeminiPayload(
  modelName: string,
  systemPrompt: string,
  userInput: string,
): object {
  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userInput }] }],
    generationConfig: {
      maxOutputTokens: 300,
      temperature: 0.1,
      responseMimeType: "application/json",
    },
    thinkingConfig: { thinkingBudget: 0 },
  };
}

/**
 * Extract JSON from the LLM response text.
 * Handles: code fences, prose-wrapped JSON, and raw JSON.
 */
export function extractJSON(text: string): string {
  const trimmed = text.trim();

  // 1. Code fence: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // 2. Brace-depth scan: find outermost {...} containing "verdict"
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = trimmed.slice(start, i + 1);
        if (candidate.includes('"verdict"')) return candidate;
        start = -1; // not our JSON, keep looking
      }
    }
  }

  // 3. Fallback: assume the whole text is JSON
  return trimmed;
}

/** Parse the sub-agent's JSON response into a verdict. */
export function parseVerdict(responseText: string): SubagentVerdict | null {
  try {
    const parsed = JSON.parse(extractJSON(responseText));
    if (parsed.verdict === "clear") return { verdict: "clear" };
    if (parsed.verdict === "needs_correction") {
      return {
        verdict: "needs_correction",
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions.slice(0, MAX_SUGGESTIONS)
          : [],
      };
    }
    console.warn(
      `[input-corrector] Unknown verdict "${parsed.verdict}":`,
      JSON.stringify(parsed).slice(0, RAW_RESPONSE_SLICE),
    );
    return null;
  } catch (e) {
    console.warn(
      `[input-corrector] Parse failed (${responseText.length} chars):`,
      responseText.slice(0, RAW_RESPONSE_SLICE),
      "\nError:", e,
    );
    return null;
  }
}

/** Extract response text from an OpenAI-compatible API response. */
export function extractOpenAIText(data: any): string {
  const msg = data?.choices?.[0]?.message;
  let text = msg?.content ?? "";
  // DeepSeek reasoning models may put the answer in reasoning_content
  if (!text && msg?.reasoning_content) {
    const jsonMatch = msg.reasoning_content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      text = jsonMatch[0];
      console.log("[input-corrector] Extracted from reasoning_content fallback");
    }
  }
  return text;
}

/** Extract response text from a Gemini API response. */
export function extractGeminiText(data: any): string {
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

/**
 * Call the configured correction model via direct HTTP request.
 * Supports OpenAI-compatible and Gemini API formats.
 */
async function callCorrector(
  userInput: string,
  config: CorrectorConfig,
  conn: ProviderConnection,
  signal?: AbortSignal,
): Promise<SubagentVerdict> {
  const isGemini = config.providerId === "google";
  const baseUrl = conn.baseUrl.replace(/\/+$/, "");

  // Build request
  const url = isGemini
    ? `${baseUrl}/v1/models/${config.modelName}:generateContent`
    : `${baseUrl}/chat/completions`;

  const body = JSON.stringify(
    isGemini
      ? buildGeminiPayload(config.modelName, config.systemPrompt, userInput)
      : buildOpenAIPayload(config.modelName, config.systemPrompt, userInput),
  );

  const headers: Record<string, string> = {};
  // Copy non-null headers from provider config
  for (const [k, v] of Object.entries(conn.headers)) {
    if (v != null) headers[k] = v;
  }
  headers["Content-Type"] = "application/json";
  if (conn.apiKey) {
    if (isGemini) {
      if (!headers["x-goog-api-key"]) headers["x-goog-api-key"] = conn.apiKey;
    } else {
      if (!headers["Authorization"]) headers["Authorization"] = `Bearer ${conn.apiKey}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: signal ? anySignal(signal, controller.signal) : controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "(no body)");
      console.warn(`[input-corrector] API error ${response.status}: ${errorText}`);
      return { verdict: "clear", failReason: `API error ${response.status}` };
    }

    const data = await response.json();
    const responseText = isGemini ? extractGeminiText(data) : extractOpenAIText(data);

    if (!responseText) {
      console.warn(
        "[input-corrector] Empty response. Message:",
        JSON.stringify(data?.choices?.[0]?.message ?? data?.candidates?.[0]).slice(0, RAW_RESPONSE_SLICE),
      );
      return { verdict: "clear", failReason: "Empty response from model", rawResponse: "(empty)" };
    }

    const parsed = parseVerdict(responseText);
    if (!parsed) {
      return {
        verdict: "clear",
        failReason: "Could not parse model response",
        rawResponse: responseText.slice(0, RAW_RESPONSE_SLICE),
      };
    }
    parsed.rawResponse = responseText.slice(0, RAW_RESPONSE_SLICE);
    return parsed;
  } catch (e: any) {
    const isTimeout = e.name === "AbortError";
    console.warn(`[input-corrector] ${isTimeout ? "Request timed out" : "Request failed"}:`, e);
    return {
      verdict: "clear",
      failReason: isTimeout ? "Request timed out (25s)" : `Request failed: ${e.message || e}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// --- UI Helpers -------------------------------------------------------------

export function showSuggestionsWidget(ctx: any, originalInput: string, suggestions: string[]) {
  const lines = [
    "-- Input Corrector ------------------------------",
    " Your input:",
    ` > ${originalInput}`,
    "",
    " Suggestions:",
    ...suggestions.map((s, i) => ` ${i + 1}. ${s}`),
    "",
    " Please rewrite your input above. --------------",
  ];
  ctx.ui.setWidget(WIDGET_ID, lines);
}

export function showErrorWidget(ctx: any, originalInput: string, reason: string, rawResponse?: string) {
  const lines = [
    "-- Input Corrector ------------------------------",
    " Your input:",
    ` > ${originalInput}`,
    "",
    ` Could not generate suggestions (${reason}).`,
  ];
  if (rawResponse) {
    lines.push("", " Model raw response:", ` > ${rawResponse}`);
  }
  lines.push("", " Press Enter to send your input as-is.");
  ctx.ui.setWidget(WIDGET_ID, lines);
}

function clearWidget(ctx: any) {
  ctx.ui.setWidget(WIDGET_ID, undefined);
}

// --- Extension Entry Point --------------------------------------------------

export default function (pi: ExtensionAPI) {
  let config: CorrectorConfig | null = null;
  let providerConn: ProviderConnection | null = null;
  let passThrough = false;
  let checkSeq = 0;
  let correctionsCount = 0;
  let lastRawResponse: string | null = null;
  let debugMode = false;

  // --- Commands ---

  pi.registerCommand("corrector", {
    description: "Input Corrector: status, toggle, mode, debug, help",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";

      switch (sub) {
        case "status": {
          ctx.ui.notify(
            [
              "Input Corrector Status",
              "",
              `  Enabled: ${config?.enabled ?? false}`,
              `  Model: ${config?.model ?? "N/A"}`,
              `  Fail mode: ${config?.failMode ?? "N/A"}`,
              `  Provider: ${config?.providerId ?? "N/A"}`,
              `  Debug mode: ${debugMode}`,
              `  Corrections this session: ${correctionsCount}`,
              `  Status: ${providerConn ? "Connected" : "Not connected"}`,
            ].join("\n"),
            "info",
          );
          break;
        }
        case "toggle": {
          if (!config) { ctx.ui.notify("[corrector] Not configured", "warning"); break; }
          config.enabled = !config.enabled;
          ctx.ui.notify(
            `[corrector] ${config.enabled ? "Enabled" : "Disabled"}`,
            config.enabled ? "success" : "warning",
          );
          break;
        }
        case "mode": {
          if (!config) { ctx.ui.notify("[corrector] Not configured", "warning"); break; }
          const mode = (args ?? "").trim().split(/\s+/)[1];
          if (mode === "open" || mode === "closed") {
            config.failMode = mode;
            ctx.ui.notify(`[corrector] Fail mode set to ${mode}`, "info");
          } else {
            ctx.ui.notify("Usage: /corrector mode open|closed", "warning");
          }
          break;
        }
        case "debug": {
          debugMode = !debugMode;
          ctx.ui.notify(
            `[corrector] Debug mode ${debugMode ? "ON" : "OFF"}`,
            debugMode ? "success" : "warning",
          );
          break;
        }
        case "last": {
          ctx.ui.notify(
            lastRawResponse
              ? `[corrector] Last raw response:\n${lastRawResponse}`
              : "[corrector] No raw response recorded yet",
            "info",
          );
          break;
        }
        case "help": {
          ctx.ui.notify(
            [
              "/corrector status  — show config and stats",
              "/corrector toggle  — enable/disable",
              "/corrector mode open|closed — fail behavior",
              "/corrector debug   — toggle debug mode (show raw model responses)",
              "/corrector last    — show last raw model response",
              "/corrector help    — this message",
            ].join("\n"),
            "info",
          );
          break;
        }
        default:
          ctx.ui.notify(`Unknown: /corrector ${sub}. Use /corrector help`, "warning");
      }
    },
  });

  // --- Session lifecycle --------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    if (!config) {
      const created = ensureDefaultAgent();
      if (created) {
        config = loadConfig(ctx.cwd);
        if (config && ctx.hasUI) {
          ctx.ui.notify(`[input-corrector] Created default config at ${created}`, "info");
        }
      }
    }
    if (!config) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `[input-corrector] Could not load or create ~/.pi/agent/agents/${AGENT_FILENAME}`,
          "warning",
        );
      }
      return;
    }

    if (!config.enabled) return;

    try {
      const provider = ctx.modelRegistry.getProvider(config.providerId);
      if (!provider) {
        if (ctx.hasUI) ctx.ui.notify(`[input-corrector] Provider "${config.providerId}" not found`, "warning");
        return;
      }

      const baseUrl = provider.baseUrl;
      if (!baseUrl) {
        if (ctx.hasUI) ctx.ui.notify(`[input-corrector] Provider "${config.providerId}" has no base URL`, "warning");
        return;
      }

      const authResult = await ctx.modelRegistry.getProviderAuth(config.providerId);
      const resolvedAuth = authResult?.auth;
      const apiKey = resolvedAuth?.apiKey || (provider.auth as any)?.apiKey?.key;
      const headers: Record<string, string | undefined> = {
        ...(provider.headers as Record<string, string | undefined> | undefined),
        ...(resolvedAuth?.headers as Record<string, string | undefined> | undefined),
      };

      providerConn = { baseUrl, apiKey, headers };
    } catch (e) {
      console.warn("[input-corrector] Failed to resolve provider:", e);
      if (ctx.hasUI) ctx.ui.notify("[input-corrector] Failed to resolve provider", "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    config = null;
    providerConn = null;
    passThrough = false;
    checkSeq = 0;
    correctionsCount = 0;
    lastRawResponse = null;
    debugMode = false;
  });

  // --- Input interception ------------------------------------------------

  /** Handle a correction verdict result (shared by Chinese & English paths). */
  function handleVerdict(
    ctx: any,
    inputText: string,
    v: SubagentVerdict,
  ): void {
    lastRawResponse = v.rawResponse ?? null;

    if (v.verdict === "needs_correction" && v.suggestions?.length) {
      if (hasMeaningfulSuggestion(inputText, v.suggestions)) {
        showSuggestionsWidget(ctx, inputText, v.suggestions);
      } else {
        clearWidget(ctx);
      }
    } else if (v.failReason) {
      showErrorWidget(ctx, inputText, v.failReason, v.rawResponse);
    } else {
      // Model said "clear" or gave no suggestions
      clearWidget(ctx);
    }
  }

  pi.on("input", async (event, ctx) => {
    if (!config?.enabled || !providerConn) return { action: "continue" };
    if (!ctx.hasUI) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.text.startsWith("/") || event.text.startsWith("!"))
      return { action: "continue" };

    // After a correction cycle, the next input passes through without re-check
    if (passThrough) {
      passThrough = false;
      checkSeq++;
      clearWidget(ctx);
      return { action: "continue" };
    }

    // --- Chinese detected: fast path (non-blocking) ---
    if (/[\u4e00-\u9fff]/.test(event.text)) {
      correctionsCount++;
      passThrough = true;
      const seq = ++checkSeq;
      const inputText = event.text;

      ctx.ui.setEditorText(inputText);
      ctx.ui.setWidget(WIDGET_ID, [
        "-- Input Corrector ------------------------------",
        " Chinese detected. Generating suggestions...",
      ]);

      callCorrector(inputText, config, providerConn, ctx.signal)
        .then((v) => {
          if (seq !== checkSeq) return; // stale
          handleVerdict(ctx, inputText, v);
        })
        .catch(() => {
          if (seq === checkSeq) clearWidget(ctx);
        });

      return { action: "handled" };
    }

    // --- English: blocking check for unnatural phrasing ---
    ctx.ui.setStatus(WIDGET_ID, "[input-corrector] Checking...");

    let verdict: SubagentVerdict | null = null;
    try {
      verdict = await callCorrector(event.text, config, providerConn, ctx.signal);
      lastRawResponse = verdict.rawResponse ?? null;
    } catch (e) {
      console.warn("[input-corrector] Unexpected error:", e);
    }

    ctx.ui.setStatus(WIDGET_ID, undefined);

    // No verdict → apply fail mode
    if (!verdict) {
      if (config.failMode === "closed") {
        ctx.ui.notify("[input-corrector] Check failed - retry or fix agent config", "error");
        return { action: "handled" };
      }
      ctx.ui.notify("[input-corrector] Skipped (error), proceeding", "warning");
      clearWidget(ctx);
      return { action: "continue" };
    }

    // Clear English → pass through
    if (verdict.verdict === "clear") {
      ctx.ui.notify("✓ Natural English, proceeding", "success");
      clearWidget(ctx);
      return { action: "continue" };
    }

    // Needs correction → check if suggestions are meaningful
    const suggestions = verdict.suggestions ?? [];
    if (!hasMeaningfulSuggestion(event.text, suggestions)) {
      ctx.ui.notify("✓ Natural English, proceeding", "success");
      clearWidget(ctx);
      return { action: "continue" };
    }

    // Show correction UI
    passThrough = true;
    ctx.ui.setEditorText(event.text);

    if (suggestions.length) {
      showSuggestionsWidget(ctx, event.text, suggestions);
    } else {
      showErrorWidget(ctx, event.text, "No suggestions available");
    }

    return { action: "handled" };
  });
}
