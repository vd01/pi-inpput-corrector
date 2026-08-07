# Agents

## input-corrector

Checks user input language quality. Suggests natural English alternatives for Chinese/mixed/unnatural input.

| Field | Value |
|---|---|
| Model | `deepseek/deepseek-v4-flash` |
| Fail mode | `open` (pass through on error) |
| Config | `~/.pi/agent/agents/input-corrector.md` |

### Commands

| Command | Description |
|---|---|
| `/corrector status` | Show config and stats |
| `/corrector toggle` | Enable/disable |
| `/corrector mode open\|closed` | Fail behavior |
| `/corrector debug` | Toggle debug mode (show raw model responses) |
| `/corrector last` | Show last raw model response |
| `/corrector help` | Show help |

### Behavior

1. Chinese detected → put input in editor, generate suggestions in background
2. English → blocking check for unnatural phrasing
3. Meaningful suggestions shown → user rewrites, passes through without re-check
4. Trivial/cosmetic suggestions → treated as clear, pass through
5. Parse failure → fail-open with raw response shown in widget
