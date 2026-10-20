# Prototype validation — 2026-10-20

## Verified environment

- Antigravity CLI 1.4.2, Linux.
- Node.js 24.18.0 locally; CI targets Node.js 22.
- Self-hosted Laminar app-server v0.3.1.
- Project-local plugin only; no global tracing was enabled.
- Only synthetic prompts and a synthetic local text file were sent to Laminar. Credentials, infrastructure addresses, and raw user sessions are not included in this repository.

## Live end-to-end result

A fresh conversation read one synthetic file and returned its contents, then was resumed for a second text-only turn. Both turns exported automatically through the plugin's actual Stop hook.

Server-side SQL confirmed:

- One session containing two distinct traces.
- First turn: one root, two LLM spans, one `read_file` span.
- Second turn: one root and one LLM span.
- Six spans total, correct parent/child IDs, tool output present.
- Each LLM's input/output counters matched the source transcript after normalizing cached input.

Synthetic-session trace IDs for checking the trial instance:

- `963bf01e-5e15-7b21-595c-0a5cfed1d190`
- `fbe56a2f-802b-51d2-6948-d5487ff40977`

## Wire details discovered through live runs

1. Hooks supply `transcript_full.jsonl`, rather than the documentation's example `transcript.jsonl`.
2. Plugin hooks execute from the plugin directory. Relative `node dist/hook.cjs ...` works without hard-coded installation paths.
3. `PostInvocation` fires after tool execution. Model span duration must stop at the first pre-tool hook when applicable.
4. On resume, a `SYSTEM_MESSAGE` may be inserted after `initialNumSteps`, before the next `PLANNER_RESPONSE`. Invocation numbering resets across execution attempts; step boundaries are used for association.
5. CLI `input_tokens` and `cache_read_tokens` are separate counters. Laminar's OTLP input-token attribute expects their combined total. Original counters are retained separately.

The initial exploratory run exposed items 4 and 5. Those early trial traces are not acceptance evidence. The fresh two-turn run above used the corrected implementation and was checked against persisted server data.

## Repeatable local exercise

`npm run smoke` executes real hook subprocesses against a local HTTP receiver. It checks normal spans, token normalization, tool timing, HTTP 503, OTLP partial rejection, persisted retries with stable IDs, duplicate Stop suppression, resume with a system-message insertion, and unknown-schema failure without checkpoint advancement.

`npm run check`, `npm run build`, and `agy plugin validate . --strict --json` passed locally. The strict plugin validator reported zero findings.

## Not established

App/IDE behavior, subagent nesting, parallel/background tool execution, interrupted/compacted transcripts, a full provider prompt, hidden reasoning, pricing accuracy, Windows/macOS behavior, and long-session performance are not established by these trials. This is an experimental adapter for ordinary CLI sessions, not a general-purpose production exporter.
