# Laminar Antigravity Plugin

Independent plugin that exports **Antigravity CLI user turns to Laminar** through OTLP/HTTP JSON. Not an official Google or Laminar integration.

**Validated target: Antigravity CLI 1.4.2 on Linux, Node.js 22+.** App and IDE support have not been validated.

## What it records

- One trace per explicit user turn, grouped by Antigravity conversation ID.
- Model steps with visible input/output, actual model name, and token fields present in the transcript.
- Tool names, arguments, results, errors, and hook-observed timing.
- Separate traces for subsequent turns in a resumed conversation.

Model inputs are reconstructed from the **visible transcript within that turn**, not the exact provider request: hidden system instructions, previous-turn context, and internal reasoning are not reconstructed. Token counters use the observed CLI 1.4.2 convention: `input_tokens` is uncached input, while `cache_read_tokens` is separate. The OTLP total input is their sum, and both original counters are preserved as `antigravity.usage.*` attributes. Missing values are not invented, and the plugin does not calculate a cost.

The format was observed from `transcript_full.jsonl` supplied by real CLI hooks. It supports `USER_INPUT`, `PLANNER_RESPONSE`, `SYSTEM_MESSAGE`, `CHECKPOINT`, `ERROR_MESSAGE`, and `GENERIC` tool-result rows. Only the observed, uncheckpointed part of the conversation is exported; installing into a long existing conversation does not require its older steps to use the current format.

Background tools retain their `RUNNING` transcript status even after their dispatch hooks finish. These spans are labeled `background_dispatch`: their duration measures dispatch, not the background job's lifetime. Subsequent system messages carry the job completion output. `ERROR` and `INVALID` tool results produce error spans, including failures rejected before tool hooks fire; those use explicitly labeled transcript-only timing. Parallel tool results are paired by step and checked against the model's calls.

Cancellation and terminal errors with a recorded fully-idle Stop produce error traces. An interrupted invocation without a model response is marked incomplete and has no invented token counts. Unknown current kinds/statuses, injected inputs, missing successful hook pairs, and incomplete transcript lines still fail visibly without advancing the checkpoint.

## Install

```sh
git clone https://github.com/Shimada666/lmnr-antigravity-plugin.git
cd lmnr-antigravity-plugin
agy plugin validate . --strict
agy plugin install .
```

The committed `dist/hook.cjs` includes runtime dependencies, so installation does not require npm. Restart the CLI after installation. The installed plugin is **disabled for collection until explicitly configured**; it does not inherit another Laminar plugin's key.

For a project-only trial, copy `plugin.json`, `hooks.json`, and `dist/` to `.agents/plugins/lmnr-antigravity/` inside a disposable workspace instead of installing globally. Hook commands run with the plugin directory as their working directory; this was verified on CLI 1.4.2.

## Configure and try

Create a private JSON file, for example `/absolute/path/to/antigravity-laminar.json`, with a project key from your Laminar instance:

```json
{
  "projectApiKey": "YOUR_PROJECT_API_KEY",
  "baseUrl": "http://localhost:8000"
}
```

`baseUrl` must be the **API/OTLP endpoint including its port**, not the frontend URL. No cloud endpoint is selected automatically. Keep the file outside the repository and restrict its permissions (`chmod 600`).

Launch only the intended session with that configuration:

```sh
LMNR_ANTIGRAVITY_CONFIG=/absolute/path/to/antigravity-laminar.json \
  agy -p 'Reply exactly HELLO_LAMINAR' --output-format json
```

For persistent opt-in, put the file at `~/.config/lmnr/antigravity-plugin.json`. Optional settings: `maxChars` (default 20000, per content field), `timeoutMs` (default 5000, per export request). `LMNR_ANTIGRAVITY_STATE_DIR` overrides `~/.local/state/lmnr/antigravity`.

**Collection includes prompt text, tool inputs/outputs, and local paths.** It is sent only to the configured Laminar instance. There is no automatic secret redaction; start with a synthetic session. Private local state retains hook events and failed upload payloads. Do not commit it or share it as a support bundle.

## Delivery and failure behavior

Pre/post hooks only journal events locally. `Stop` exports after `fullyIdle=true`. Tool authorization remains with Antigravity: the pre-tool hook returns `allow`, never `auto_approve`; stop hooks never force another agent turn.

- Separate per-conversation locks protect journal writes and exports. Slow HTTP uploads do not block recording model/tool hooks.
- The full request is persisted to `pending.json` before sending.
- Only a successful response with no rejected spans advances `checkpoint.json`.
- A repeated completed Stop is skipped. Failed exports retry on the next fully-idle Stop, using the same frozen request and deterministic trace/span IDs.
- Delivery is **at least once**. A server accepting a request while its response is lost can cause re-delivery; no exactly-once claim is made.
- Failures are surfaced as nonzero hook exits with their stack traces. They are not swallowed, and this prototype does not promise that host hook errors are invisible to the agent.
- A standalone session that ends after an upload failure has no background retry daemon. To retry without another model call, replay its last recorded fully-idle Stop. Replay does not append a synthetic Stop or finish a newer active turn:

```sh
# Select the state directory for the failed conversation (contains events.jsonl).
node scripts/retry.mjs /absolute/path/to/state/conversation/events.jsonl
```

Use the same configuration and state-directory environment overrides as the original run. The retry script prints no payload or credentials.

## Current limits

- CLI sessions, including resumed long conversations, asynchronous/parallel tools, recorded cancellation, and observed compaction messages. Subagent parent/child linkage and browser/image artifacts are not implemented.
- Hooks must be enabled before the first model invocation of the turn. Earlier unobserved turns are not backfilled. Transcript compaction that physically deletes earlier observed rows is not supported.
- The CLI must emit its hooks. A process kill/crash, or a headless permission denial that exits without PostInvocation/Stop, leaves an incomplete journal; the plugin does not invent completion for it.
- The complete transcript is parsed at Stop; very long sessions are not optimized yet.
- Times are observed at hook execution, not provider-server timestamps. In CLI 1.4.2, `PostInvocation` occurs after tools, so the LLM span ends at the first pre-tool hook when tools are present.
- Tool spans are siblings of LLM spans under the turn root. There is no guessed subagent hierarchy.
- There is no background exporter, retention policy, or automatic configuration/key provisioning.

## Development and validation

```sh
npm ci
npm run check
npm run build
npm run smoke
agy plugin validate . --strict
```

The smoke and regression exercises use real hook subprocesses and a local OTLP receiver. CI runs both. It verifies trace hierarchy, tool output, model/tool timing boundaries, failed HTTP export, partial rejection, frozen retries, duplicate Stop, resumed turns, and unknown-schema rejection. The regression suite additionally covers background and failed tools, parallel calls, historical/compaction records, cancellations, live-turn boundaries, malformed responses, auth/rate-limit failures, timeouts, concurrent retries, and event capture during blocked uploads. Neither suite needs credentials or calls an LLM.

See [VALIDATION.md](VALIDATION.md) for the live trial and its limitations.

## References

- [Antigravity hooks](https://antigravity.google/docs/hooks)
- [Antigravity plugins](https://antigravity.google/docs/plugins)
- [Laminar Codex plugin](https://github.com/lmnr-ai/lmnr-codex-plugin) — reference for Laminar OTLP attribute conventions; this adapter is implemented separately.
