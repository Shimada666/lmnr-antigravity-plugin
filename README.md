# Laminar Antigravity Plugin

Experimental, independent plugin that exports **Antigravity CLI user turns to Laminar** through OTLP/HTTP JSON. Not an official Google or Laminar integration.

**Prototype target: Antigravity CLI 1.4.2 on Linux, Node.js 22+.** App and IDE support have not been validated.

## What it records

- One trace per explicit user turn, grouped by Antigravity conversation ID.
- Model steps with visible input/output, actual model name, and token fields present in the transcript.
- Tool names, arguments, results, errors, and hook-observed timing.
- Separate traces for subsequent turns in a resumed conversation.

Model inputs are reconstructed from the **visible transcript within that turn**, not the exact provider request: hidden system instructions, previous-turn context, and internal reasoning are not reconstructed. Token counters use the observed CLI 1.4.2 convention: `input_tokens` is uncached input, while `cache_read_tokens` is separate. The OTLP total input is their sum, and both original counters are preserved as `antigravity.usage.*` attributes. Missing values are not invented, and the plugin does not calculate a cost.

The format was observed from `transcript_full.jsonl` supplied by real CLI hooks, rather than assuming the example filename in the documentation. This first version supports `USER_INPUT`, `PLANNER_RESPONSE`, `SYSTEM_MESSAGE`, and `GENERIC` tool-result rows. Unsupported kinds/statuses, injected inputs, missing hook pairs, or incomplete transcript lines cause a visible error and leave the checkpoint unchanged.

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

- Per-conversation locking serializes event capture and export.
- The full request is persisted to `pending.json` before sending.
- Only a successful response with no rejected spans advances `checkpoint.json`.
- A repeated completed Stop is skipped. Failed exports retry on the next fully-idle Stop, using the same frozen request and deterministic trace/span IDs.
- Delivery is **at least once**. A server accepting a request while its response is lost can cause re-delivery; no exactly-once claim is made.
- Failures are surfaced as nonzero hook exits with their stack traces. They are not swallowed, and this prototype does not promise that host hook errors are invisible to the agent.
- A standalone session that ends after an upload failure has no background retry daemon. To retry without another model call, replay its last recorded Stop payload:

```sh
# Select the state directory for the failed conversation (contains events.jsonl).
node scripts/retry.mjs /absolute/path/to/state/conversation/events.jsonl
```

Use the same configuration and state-directory environment overrides as the original run. The retry script prints no payload or credentials.

## Current limits

- New, ordinary CLI conversations only. Subagent parent/child linkage, browser/image artifacts, cancelled or compacted sessions, and arbitrary transcript row kinds are not yet supported.
- Hooks must be enabled before the first model invocation of the turn. Earlier unobserved turns are not backfilled.
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

The smoke exercise uses real hook subprocesses and a local OTLP receiver. It verifies trace hierarchy, tool output, model/tool timing boundaries, failed HTTP export, partial rejection, frozen retries, duplicate Stop, resumed turns, and unknown-schema rejection. It does not need credentials or call an LLM.

See [VALIDATION.md](VALIDATION.md) for the live trial and its limitations.

## References

- [Antigravity hooks](https://antigravity.google/docs/hooks)
- [Antigravity plugins](https://antigravity.google/docs/plugins)
- [Laminar Codex plugin](https://github.com/lmnr-ai/lmnr-codex-plugin) — reference for Laminar OTLP attribute conventions; this adapter is implemented separately.
