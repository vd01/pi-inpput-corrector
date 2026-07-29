# Input Corrector Extension

Checks each user input for language quality. For non-idiomatic English or Chinese/mixed input, suggests improvements and waits for a rewrite. One correction round per input.

## Setup

### 1. Create the agent file

Create `~/.pi/agent/agents/input-corrector.md`:

```yaml
---
name: input-corrector
description: Checks user input language quality and suggests natural alternatives
model: google/gemini-2.5-flash
x-fail-mode: open
x-enabled: true
---

Analyze the user input below. Output ONLY a JSON object with no other text.

Rules:
- If the input is clear, natural, idiomatic English: {"verdict":"clear"}
- If the input contains Chinese characters (even mixed with English): {"verdict":"needs_correction","suggestions":["...","..."]}
- If the input is unnatural, awkward, or impractical English: {"verdict":"needs_correction","suggestions":["...","..."]}

For "needs_correction", provide 1-3 idiomatic English alternatives.
Make suggestions concise and natural - what a fluent speaker would actually write.
```

### 2. Reload

Run `/reload` inside pi. The extension notifies you on startup if the agent file is missing.

## Frontmatter Fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | - | Agent name (must be `input-corrector`) |
| `description` | Yes | - | Description shown in agent listing |
| `model` | Yes | - | Model in `provider/model` format, e.g. `google/gemini-2.5-flash`, `openai/gpt-4o-mini` |
| `x-fail-mode` | No | `open` | `open` = pass through on error, `closed` = block on error |
| `x-enabled` | No | `true` | Set to `false` to disable correction |

### Supported providers

- **Google** (`google/`) - uses Gemini API format
- **OpenAI-compatible** (`openai/`, `openrouter/`, `together/`, `groq/`, etc.) - uses Chat Completions API format

## How it works

1. You type input
2. Extension intercepts via `input` event (skips `/commands` and `!bash`)
3. Calls the configured model with your system prompt + input
4. Model returns JSON verdict:
   - `{"verdict":"clear"}` -> pass through, brief notification
   - `{"verdict":"needs_correction","suggestions":["...","..."]}` -> show widget, wait for rewrite
5. You rewrite your input -> passes through without re-checking
