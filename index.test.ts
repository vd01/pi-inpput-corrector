import { describe, it, expect, vi } from "vitest";
import {
  tokenize,
  hasMeaningfulSuggestion,
  extractJSON,
  parseVerdict,
  extractOpenAIText,
  extractGeminiText,
  buildOpenAIPayload,
  buildGeminiPayload,
  showSuggestionsWidget,
  showErrorWidget,
} from "./index";

// ============================================================================
// tokenize
// ============================================================================
describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("splits on punctuation", () => {
    expect(tokenize("hello, world!")).toEqual(["hello", "world"]);
  });

  it("handles brackets and quotes", () => {
    expect(tokenize('[foo] (bar) "baz"')).toEqual(["foo", "bar", "baz"]);
  });

  it("drops empty tokens", () => {
    expect(tokenize("  hello   world  ")).toEqual(["hello", "world"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles punctuation-only input", () => {
    // Note: --- is not in the split charset, so it survives as a token
    expect(tokenize("... !!! ---")).toEqual(["---"]);
  });
});

// ============================================================================
// hasMeaningfulSuggestion
// ============================================================================
describe("hasMeaningfulSuggestion", () => {
  it("returns true when suggestion has novel content words", () => {
    expect(
      hasMeaningfulSuggestion("how to install python", [
        "how do I set up python",
      ]),
    ).toBe(true);
  });

  it("returns false when suggestion is identical", () => {
    expect(
      hasMeaningfulSuggestion("hello world", ["hello world"]),
    ).toBe(false);
  });

  it("returns false when suggestion only differs by stop words", () => {
    expect(
      hasMeaningfulSuggestion("how to install python", [
        "how to install the python",
      ]),
    ).toBe(false);
  });

  it("returns false when suggestion has only 1 novel content word", () => {
    expect(
      hasMeaningfulSuggestion("install python", ["install python3"]),
    ).toBe(false);
  });

  it("returns true when suggestion has 2+ novel content words", () => {
    expect(
      hasMeaningfulSuggestion("install python", [
        "set up the python environment",
      ]),
    ).toBe(true);
  });

  it("handles multiple suggestions (any one meaningful is enough)", () => {
    expect(
      hasMeaningfulSuggestion("install python", [
        "install the python", // trivial
        "set up python development environment", // meaningful
      ]),
    ).toBe(true);
  });

  it("returns false when all suggestions are trivial", () => {
    expect(
      hasMeaningfulSuggestion("install python", [
        "install the python",
        "install a python",
      ]),
    ).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(
      hasMeaningfulSuggestion("Install Python", [
        "set up python environment",
      ]),
    ).toBe(true);
  });
});

// ============================================================================
// extractJSON
// ============================================================================
describe("extractJSON", () => {
  it("returns raw text if it's already valid JSON", () => {
    expect(extractJSON('{"verdict":"clear"}')).toBe('{"verdict":"clear"}');
  });

  it("extracts from ```json code fence", () => {
    const input = '```json\n{"verdict":"clear"}\n```';
    expect(extractJSON(input)).toBe('{"verdict":"clear"}');
  });

  it("extracts from bare ``` code fence", () => {
    const input = '```\n{"verdict":"clear"}\n```';
    expect(extractJSON(input)).toBe('{"verdict":"clear"}');
  });

  it("extracts JSON surrounded by prose", () => {
    const input = 'Here is the result:\n{"verdict":"needs_correction","suggestions":["hello"]}\nHope this helps!';
    expect(extractJSON(input)).toBe('{"verdict":"needs_correction","suggestions":["hello"]}');
  });

  it("extracts JSON with leading prose and no trailing prose", () => {
    const input = 'Based on analysis:\n{"verdict":"clear"}';
    expect(extractJSON(input)).toBe('{"verdict":"clear"}');
  });

  it("extracts JSON with trailing prose only", () => {
    const input = '{"verdict":"clear"}\nDone.';
    expect(extractJSON(input)).toBe('{"verdict":"clear"}');
  });

  it("handles nested JSON objects", () => {
    const input = '{"verdict":"needs_correction","suggestions":["a","b","c"]}';
    expect(extractJSON(input)).toBe(input);
  });

  it("skips JSON objects without verdict key and finds the right one", () => {
    const input = '{"foo":1} {"verdict":"clear"}';
    expect(extractJSON(input)).toBe('{"verdict":"clear"}');
  });

  it("returns full text as fallback when no JSON found", () => {
    const input = "just plain text no json";
    expect(extractJSON(input)).toBe("just plain text no json");
  });

  it("trims whitespace", () => {
    expect(extractJSON('  {"verdict":"clear"}  ')).toBe('{"verdict":"clear"}');
  });
});

// ============================================================================
// parseVerdict
// ============================================================================
describe("parseVerdict", () => {
  it("parses clear verdict", () => {
    expect(parseVerdict('{"verdict":"clear"}')).toEqual({ verdict: "clear" });
  });

  it("parses needs_correction with suggestions", () => {
    expect(
      parseVerdict('{"verdict":"needs_correction","suggestions":["hello","world"]}'),
    ).toEqual({
      verdict: "needs_correction",
      suggestions: ["hello", "world"],
    });
  });

  it("limits suggestions to 3", () => {
    expect(
      parseVerdict('{"verdict":"needs_correction","suggestions":["a","b","c","d"]}'),
    ).toEqual({
      verdict: "needs_correction",
      suggestions: ["a", "b", "c"],
    });
  });

  it("handles empty suggestions array", () => {
    expect(
      parseVerdict('{"verdict":"needs_correction","suggestions":[]}'),
    ).toEqual({
      verdict: "needs_correction",
      suggestions: [],
    });
  });

  it("handles missing suggestions field", () => {
    expect(
      parseVerdict('{"verdict":"needs_correction"}'),
    ).toEqual({
      verdict: "needs_correction",
      suggestions: [],
    });
  });

  it("returns null for unknown verdict", () => {
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseVerdict("")).toBeNull();
  });

  it("parses verdict wrapped in code fence", () => {
    expect(parseVerdict('```json\n{"verdict":"clear"}\n```')).toEqual({
      verdict: "clear",
    });
  });

  it("parses verdict surrounded by prose", () => {
    expect(
      parseVerdict('Here is my analysis:\n{"verdict":"clear"}\nDone!'),
    ).toEqual({ verdict: "clear" });
  });

  it("handles non-array suggestions gracefully", () => {
    expect(
      parseVerdict('{"verdict":"needs_correction","suggestions":"not an array"}'),
    ).toEqual({
      verdict: "needs_correction",
      suggestions: [],
    });
  });
});

// ============================================================================
// extractOpenAIText
// ============================================================================
describe("extractOpenAIText", () => {
  it("extracts content from standard OpenAI response", () => {
    const data = {
      choices: [{ message: { content: '{"verdict":"clear"}' } }],
    };
    expect(extractOpenAIText(data)).toBe('{"verdict":"clear"}');
  });

  it("returns empty string for missing content", () => {
    expect(extractOpenAIText({ choices: [{ message: {} }] })).toBe("");
  });

  it("returns empty string for empty response", () => {
    expect(extractOpenAIText({})).toBe("");
  });

  it("falls back to reasoning_content for DeepSeek models", () => {
    const data = {
      choices: [
        {
          message: {
            content: "",
            reasoning_content:
              'Let me think... {"verdict":"clear"} ...done',
          },
        },
      ],
    };
    expect(extractOpenAIText(data)).toBe('{"verdict":"clear"}');
  });

  it("prefers content over reasoning_content", () => {
    const data = {
      choices: [
        {
          message: {
            content: '{"verdict":"clear"}',
            reasoning_content: "some reasoning",
          },
        },
      ],
    };
    expect(extractOpenAIText(data)).toBe('{"verdict":"clear"}');
  });

  it("returns empty string when reasoning_content has no JSON", () => {
    const data = {
      choices: [{ message: { content: "", reasoning_content: "no json here" } }],
    };
    expect(extractOpenAIText(data)).toBe("");
  });
});

// ============================================================================
// extractGeminiText
// ============================================================================
describe("extractGeminiText", () => {
  it("extracts text from Gemini response", () => {
    const data = {
      candidates: [{ content: { parts: [{ text: '{"verdict":"clear"}' }] } }],
    };
    expect(extractGeminiText(data)).toBe('{"verdict":"clear"}');
  });

  it("returns empty string for missing parts", () => {
    expect(extractGeminiText({ candidates: [{ content: { parts: [] } }] })).toBe("");
  });

  it("returns empty string for empty response", () => {
    expect(extractGeminiText({})).toBe("");
  });

  it("returns empty string for null candidates", () => {
    expect(extractGeminiText({ candidates: [] })).toBe("");
  });
});

// ============================================================================
// buildOpenAIPayload
// ============================================================================
describe("buildOpenAIPayload", () => {
  it("builds correct structure", () => {
    const payload = buildOpenAIPayload("gpt-4o-mini", "system prompt", "user input");
    expect(payload).toEqual({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "user input" },
      ],
      max_tokens: 300,
      temperature: 0.1,
      response_format: { type: "json_object" },
      reasoning_effort: "none",
    });
  });

  it("includes reasoning_effort: none to disable thinking", () => {
    const payload = buildOpenAIPayload("model", "sys", "usr");
    expect(payload).toHaveProperty("reasoning_effort", "none");
  });

  it("includes response_format for JSON mode", () => {
    const payload = buildOpenAIPayload("model", "sys", "usr");
    expect(payload).toHaveProperty("response_format", { type: "json_object" });
  });
});

// ============================================================================
// buildGeminiPayload
// ============================================================================
describe("buildGeminiPayload", () => {
  it("builds correct structure", () => {
    const payload = buildGeminiPayload("gemini-2.5-flash", "system prompt", "user input");
    expect(payload).toEqual({
      system_instruction: { parts: [{ text: "system prompt" }] },
      contents: [{ role: "user", parts: [{ text: "user input" }] }],
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it("includes responseMimeType for JSON mode", () => {
    const payload = buildGeminiPayload("model", "sys", "usr");
    const genConfig = (payload as any).generationConfig;
    expect(genConfig.responseMimeType).toBe("application/json");
  });

  it("includes thinkingBudget: 0 to disable reasoning", () => {
    const payload = buildGeminiPayload("model", "sys", "usr");
    expect(payload).toHaveProperty("thinkingConfig", { thinkingBudget: 0 });
  });
});

// ============================================================================
// showSuggestionsWidget
// ============================================================================
describe("showSuggestionsWidget", () => {
  it("calls setWidget with correct lines", () => {
    const setWidget = vi.fn();
    const ctx = { ui: { setWidget } };

    showSuggestionsWidget(ctx, "original input", ["suggestion 1", "suggestion 2"]);

    expect(setWidget).toHaveBeenCalledWith("input-corrector", [
      "-- Input Corrector ------------------------------",
      " Your input:",
      " > original input",
      "",
      " Suggestions:",
      " 1. suggestion 1",
      " 2. suggestion 2",
      "",
      " Please rewrite your input above. --------------",
    ]);
  });
});

// ============================================================================
// showErrorWidget
// ============================================================================
describe("showErrorWidget", () => {
  it("calls setWidget with error lines (no raw response)", () => {
    const setWidget = vi.fn();
    const ctx = { ui: { setWidget } };

    showErrorWidget(ctx, "my input", "API error 429");

    expect(setWidget).toHaveBeenCalledWith("input-corrector", [
      "-- Input Corrector ------------------------------",
      " Your input:",
      " > my input",
      "",
      " Could not generate suggestions (API error 429).",
      "",
      " Press Enter to send your input as-is.",
    ]);
  });

  it("includes raw response when provided", () => {
    const setWidget = vi.fn();
    const ctx = { ui: { setWidget } };

    showErrorWidget(ctx, "my input", "parse error", "model said: blah blah");

    const calledWith = setWidget.mock.calls[0][1];
    expect(calledWith).toContain(" Model raw response:");
    expect(calledWith).toContain(" > model said: blah blah");
  });
});
