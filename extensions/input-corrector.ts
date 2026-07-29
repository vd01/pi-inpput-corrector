/**
 * Input Corrector Extension
 *
 * A Pi extension that checks each user input for language quality.
 * Uses a configured sub-agent (direct API call) with minimal overhead.
 *
 * Requirements:
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
  /** Provider-qualified model name, e.g. "google/gemini-2.5-flash" */
  model: string;
  /** Provider ID extracted from model field (e.g. "google") */
  providerId: string;
  /** Model name extracted from model field (e.g. "gemini-2.5-flash") */
  modelName: string;
  /** "open" = pass through on error, "closed" = block on error */
  failMode: "open" | "closed";
  /** Master toggle */
  enabled: boolean;
  /** System prompt from agent file body */
  systemPrompt: string;
}

interface SubagentVerdict {
  verdict: "clear" | "needs_correction";
  suggestions?: string[];
}

/** Cached provider connection info resolved once at session start */
interface ProviderConnection {
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
}

// --- Constants --------------------------------------------------------------

const AGENT_FILENAME = "input-corrector.md";
const WIDGET_ID = "input-corrector";

// --- Config Loading ---------------------------------------------------------

function loadConfig(cwd: string): CorrectorConfig | null {
  // Search: user agent dir first, then project agent dirs
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
        console.warn(
          `[input-corrector] Agent file ${filePath} missing "model" field`,
        );
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

// --- Provider API Calls -----------------------------------------------------

/**
 * Build request payload for OpenAI-compatible API format.
 * Used for: openai, openrouter, together, groq, etc.
 */
function buildOpenAIPayload(
  modelName: string,
  systemPrompt: string,
  userInput: string,
): string {
  return JSON.stringify({
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ],
    max_tokens: 300,
    temperature: 0.1,
  });
}

/**
 * Build request payload for Google Gemini API format.
 */
function buildGeminiPayload(
  modelName: string,
  systemPrompt: string,
  userInput: string,
): string {
  return JSON.stringify({
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userInput }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 300,
      temperature: 0.1,
    },
  });
}

/**
 * Extract JSON from the LLM response text (handles markdown code fences).
 */
function extractJSON(text: string): string {
  const trimmed = text.trim();
  // Try to extract from ```json ... ``` block
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Try to extract from ``` ... ``` block (no language tag)
  const fenceAnyMatch = trimmed.match(/```\s*([\s\S]*?)```/);
  if (fenceAnyMatch) return fenceAnyMatch[1].trim();
  // Assume the whole text is JSON
  return trimmed;
}

/**
 * Parse the sub-agent's JSON response into a verdict.
 */
function parseVerdict(responseText: string): SubagentVerdict | null {
  try {
    const json = extractJSON(responseText);
    const parsed = JSON.parse(json);
    if (parsed.verdict === "clear") return { verdict: "clear" };
    if (parsed.verdict === "needs_correction") {
      return {
        verdict: "needs_correction",
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions.slice(0, 3)
          : [],
      };
    }
    return null;
  } catch {
    return null;
  }
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
): Promise<SubagentVerdict | null> {
  const isGemini = config.providerId === "google";

  let url: string;
  let body: string;
  const requestHeaders: Record<string, string> = { ...conn.headers };

  if (isGemini) {
    // Gemini API
    const baseUrl = conn.baseUrl.replace(/\/+$/, "");
    url = `${baseUrl}/v1/models/${config.modelName}:generateContent`;
    body = buildGeminiPayload(
      config.modelName,
      config.systemPrompt,
      userInput,
    );
    requestHeaders["Content-Type"] = "application/json";
    if (conn.apiKey && !requestHeaders["x-goog-api-key"]) {
      requestHeaders["x-goog-api-key"] = conn.apiKey;
    }
  } else {
    // OpenAI-compatible
    const baseUrl = conn.baseUrl.replace(/\/+$/, "");
    url = `${baseUrl}/chat/completions`;
    body = buildOpenAIPayload(
      config.modelName,
      config.systemPrompt,
      userInput,
    );
    requestHeaders["Content-Type"] = "application/json";
    if (conn.apiKey && !requestHeaders["Authorization"]) {
      requestHeaders["Authorization"] = `Bearer ${conn.apiKey}`;
    }
  }

  // Remove null-valued headers (suppression markers from provider config)
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (value === null || value === undefined) delete requestHeaders[key];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body,
      signal: signal
        ? anySignal(signal, controller.signal)
        : controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "(no body)");
      console.warn(
        `[input-corrector] API error ${response.status}: ${errorText}`,
      );
      return null;
    }

    const data = await response.json();

    // Extract text from response
    let responseText: string;
    if (isGemini) {
      responseText =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    } else {
      responseText = data?.choices?.[0]?.message?.content ?? "";
    }

    if (!responseText) return null;

    return parseVerdict(responseText);
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.warn("[input-corrector] Request timed out");
    } else {
      console.warn("[input-corrector] Request failed:", e);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Combine two AbortSignals: if either fires, the combined signal fires.
 */
function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), {
      once: true,
    });
  }
  return controller.signal;
}

// --- UI Helpers -------------------------------------------------------------

function showSuggestionsWidget(
  ctx: any,
  originalInput: string,
  suggestions: string[],
) {
  const lines: string[] = [];
  lines.push("-- Input Corrector ------------------------------");
  lines.push(" Your input:");
  lines.push(` > ${originalInput}`);
  lines.push("");
  lines.push(" Suggestions:");
  suggestions.forEach((s, i) => {
    lines.push(` ${i + 1}. ${s}`);
  });
  lines.push("");
  lines.push(" Please rewrite your input above. -------------- ");
  ctx.ui.setWidget(WIDGET_ID, lines);
}

function clearWidget(ctx: any) {
  ctx.ui.setWidget(WIDGET_ID, undefined);
}

// --- Extension Entry Point --------------------------------------------------

export default function (pi: ExtensionAPI) {
  let config: CorrectorConfig | null = null;
  let providerConn: ProviderConnection | null = null;
  let awaitingRewrite = false;
  let passThrough = false;
  let lastPlacedText = "";
  let lastOriginalInput = "";

  // --- Undo shortcut: restore original input in editor ---
  pi.registerShortcut("alt+backspace", {
    description: "Undo correction: restore original input",
    handler: async (ctx) => {
      if (!lastOriginalInput) return;
      ctx.ui.setEditorText(lastOriginalInput);
      awaitingRewrite = false;
      const og = lastOriginalInput;
      lastOriginalInput = "";
      lastPlacedText = og;
      ctx.ui.setWidget(WIDGET_ID, [
        "-- Input Corrector ------------------------------",
        " Original input restored. Press Enter to re-check.",
      ]);
    },
  });

  // --- Stats ---
  let correctionsCount = 0;

  // --- Commands ---
  pi.registerCommand("corrector", {
    description: "Input Corrector: status, toggle, mode, help",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "status";

      if (sub === "status") {
        const lines = [
          "Input Corrector Status",
          "",
          `  Enabled: ${config?.enabled ?? false}`,
          `  Model: ${config?.model ?? "N/A"}`,
          `  Fail mode: ${config?.failMode ?? "N/A"}`,
          `  Provider: ${config?.providerId ?? "N/A"}`,
          `  Corrections this session: ${correctionsCount}`,
          `  Status: ${providerConn ? "Connected" : "Not connected"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "toggle") {
        if (!config) {
          ctx.ui.notify("[corrector] Not configured", "warning");
          return;
        }
        config.enabled = !config.enabled;
        ctx.ui.notify(
          `[corrector] ${config.enabled ? "Enabled" : "Disabled"}`,
          config.enabled ? "success" : "warning",
        );
        return;
      }

      if (sub === "mode") {
        if (!config) {
          ctx.ui.notify("[corrector] Not configured", "warning");
          return;
        }
        const mode = parts[1];
        if (mode === "open" || mode === "closed") {
          config.failMode = mode;
          ctx.ui.notify(`[corrector] Fail mode set to ${mode}`, "info");
        } else {
          ctx.ui.notify("Usage: /corrector mode open|closed", "warning");
        }
        return;
      }

      if (sub === "help") {
        ctx.ui.notify(
          [
            "/corrector status  — show config and stats",
            "/corrector toggle  — enable/disable",
            "/corrector mode open|closed — fail behavior",
            "/corrector help    — this message",
          ].join("\n"),
          "info",
        );
        return;
      }

      ctx.ui.notify(`Unknown: /corrector ${sub}. Use /corrector help`, "warning");
    },
  });

  // --- Session lifecycle --------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    if (!config) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `[input-corrector] Create ~/.pi/agent/agents/${AGENT_FILENAME} to enable`,
          "warning",
        );
      }
      return;
    }

    if (!config.enabled) return;

    // Resolve provider: get baseUrl from Provider, apiKey+headers from Auth
    try {
      const provider = ctx.modelRegistry.getProvider(config.providerId);
      if (!provider) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[input-corrector] Provider "${config.providerId}" not found`,
            "warning",
          );
        }
        return;
      }

      const baseUrl = provider.baseUrl;
      if (!baseUrl) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[input-corrector] Provider "${config.providerId}" has no base URL configured`,
            "warning",
          );
        }
        return;
      }

      // Get resolved auth (API key + credential headers)
      const authResult = await ctx.modelRegistry.getProviderAuth(config.providerId);
      const resolvedAuth = authResult?.auth;

      // apiKey: from auth resolution or provider config
      const apiKey = resolvedAuth?.apiKey || (provider.auth as any)?.apiKey?.key;

      // headers: merge provider headers + resolved auth headers
      const headers: Record<string, string> = {
        ...(provider.headers as Record<string, string> | undefined),
        ...(resolvedAuth?.headers as Record<string, string> | undefined),
      };

      providerConn = { baseUrl, apiKey, headers };
    } catch (e) {
      console.warn("[input-corrector] Failed to resolve provider:", e);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "[input-corrector] Failed to resolve provider",
          "warning",
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    config = null;
    providerConn = null;
    awaitingRewrite = false;
    passThrough = false;
    lastPlacedText = "";
    lastOriginalInput = "";
    correctionsCount = 0;
  });

  // --- Input interception ------------------------------------------------

  pi.on("input", async (event, ctx) => {
    // Skip if not fully configured
    if (!config?.enabled || !providerConn) return { action: "continue" };

    // Skip extension-injected messages
    if (event.source === "extension") return { action: "continue" };

    // Skip commands and bash escapes
    if (event.text.startsWith("/") || event.text.startsWith("!"))
      return { action: "continue" };

    // --- After a correction cycle, the next user input passes through ---
    if (passThrough) {
      passThrough = false;
      lastPlacedText = "";
      clearWidget(ctx);
      return { action: "continue" };
    }

    // --- Quick heuristic: detect Chinese chars instantly ---
    const hasChinese = /[\u4e00-\u9fff]/.test(event.text);

    if (hasChinese) {
      // Chinese detected — no delay, put input in editor immediately
      correctionsCount++;
      lastPlacedText = event.text;
      lastOriginalInput = event.text;
      passThrough = true;
      if (ctx.hasUI) {
        
        ctx.ui.setWidget(WIDGET_ID, [
          "-- Input Corrector ------------------------------",
          " Chinese detected. Generating suggestions...",
        ]);
        // Generate suggestions in background
        callCorrector(event.text, config, providerConn, ctx.signal).then((v) => {
          if (v?.verdict === "needs_correction" && v.suggestions?.length) {
            showSuggestionsWidget(ctx, event.text, v.suggestions!);
          }
        });
      }
      return { action: "handled" };
    }

    // --- No Chinese — call LLM for unnatural English check ---
    if (ctx.hasUI) {
      ctx.ui.setStatus(WIDGET_ID, "[input-corrector] Checking...");
    }
    let verdict: SubagentVerdict | null = null;
    try {
      verdict = await callCorrector(
        event.text,
        config,
        providerConn,
        ctx.signal,
      );
    } catch (e) {
      console.warn("[input-corrector] Unexpected error:", e);
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(WIDGET_ID, undefined);
    }

    // --- Error / no verdict -> apply fail mode ---
    if (!verdict) {
      if (config.failMode === "closed") {
        ctx.ui.notify(
          "[input-corrector] Check failed - retry or fix agent config",
          "error",
        );
        return { action: "handled" };
      }
      // fail-open: pass through silently (or notify in TUI)
      if (ctx.hasUI) {
        ctx.ui.notify(
          "[input-corrector] Skipped (error), proceeding",
          "warning",
        );
      }
      clearWidget(ctx);
      return { action: "continue" };
    }

    // --- Verdict: clear English ---
    if (verdict.verdict === "clear") {
      if (ctx.hasUI) {
        ctx.ui.notify("✓ Natural English, proceeding", "success");
      }
      clearWidget(ctx);
      return { action: "continue" };
    }

    // --- Verdict: needs correction ---
    correctionsCount++;
    // Place original text in editor so user can edit it directly
    const suggestions = verdict.suggestions ?? [];
    lastPlacedText = event.text;
    lastOriginalInput = event.text;
    passThrough = true;

    if (ctx.hasUI) {
        
      showSuggestionsWidget(ctx, event.text, suggestions);
    } else {
      console.error(
        "[input-corrector] Suggestions:",
        suggestions.join(" | "),
      );
    }

    return { action: "handled" };
  });
}
