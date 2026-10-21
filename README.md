# Laminar Antigravity Plugin

Independent plugin that exports **Antigravity CLI user turns to Laminar** through OTLP/HTTP JSON. Not an official Google or Laminar integration.

**Validated target: Antigravity CLI 1.4.2–1.4.3 on Linux, Node.js 22.13+.** App and IDE support have not been validated.

## What it records

- One trace per explicit user turn, grouped by Antigravity conversation ID.
- Model steps with visible input/output, actual model name, and token fields present in the transcript.
- Tool names, arguments, results, errors, and hook-observed timing.
- Separate traces for subsequent turns in a resumed conversation.

New calls capture the CLI's **native request snapshot** from its read-only conversation database: system prompt, historical text messages and tool definitions. Hooks save this snapshot before the CLI erases old prompt fields. `antigravity.input_source=cli_sqlite_request_snapshot` identifies it; `antigravity.input_truncated` reports the per-field text limit. This is the CLI's text/tool representation, **not** the provider's wire envelope, image/media payloads, or signed thinking blocks.

When a native snapshot is unavailable (including calls made before installation), the existing visible turn representation is explicitly labeled `visible_turn_transcript_native_request_unavailable`; it is not presented as a full request. `captureNativeContext: false` explicitly selects transcript-only capture. The CLI-exposed thinking field is a separate output part and is not inserted into reconstructed input messages.

Token counters use the observed CLI convention: `input_tokens` is uncached input and `cache_read_tokens` is separate. Their sum is the OTLP total input; original counters remain in `antigravity.usage.*`. Actual billing is not exposed by the CLI: `antigravity.cost.status=billing_amount_not_exposed_by_cli` distinguishes unavailable billing from a zero bill. An explicitly recorded native `model_cost` is preserved as `antigravity.usage.native_model_cost`, without claiming its unit is USD. Any Laminar pricing estimate is separate from the subscription's actual bill.

The format was observed from `transcript_full.jsonl` supplied by real CLI hooks. It supports `USER_INPUT`, `PLANNER_RESPONSE`, `SYSTEM_MESSAGE`, `CHECKPOINT`, `ERROR_MESSAGE`, and `GENERIC` tool-result rows. Only the observed, previously unexported part of the conversation is exported; installing into a long existing conversation does not require its older steps to use the current format.

Background tools retain their `RUNNING` transcript status even after their dispatch hooks finish. These spans are labeled `background_dispatch`: their duration measures dispatch, not the background job's lifetime. Subsequent system messages carry the job completion output. `ERROR` and `INVALID` tool results produce error spans, including failures rejected before tool hooks fire; those use explicitly labeled transcript-only timing. Parallel tool results are paired by step and checked against the model's calls.

A `RUNNING` tool can return without a `PostToolUse` hook. When its corresponding `PostInvocation` is observed, the dispatch span ends at that boundary and is marked `antigravity.timing_source=post_invocation_dispatch_upper_bound` and `antigravity.duration_is_upper_bound=true`. This includes any time between dispatch and the invocation hook; it does not claim an exact tool completion time. Successful `DONE` tools still require their completion hook.

Cancellation and terminal errors with a recorded fully-idle Stop produce error traces. An interrupted invocation without a model response is marked incomplete and has no invented token counts. Unknown current kinds/statuses, injected inputs, and missing successful hook pairs fail visibly. A partial final transcript line is deferred; complete preceding lines remain eligible for export.

## Thinking and first-output timing

New LLM spans include the CLI-exposed thinking text in their output, separate from answer text and tool calls. The existing `maxChars` limit applies to each thinking field. Token counts remain the original CLI counters; thinking token counts are not guessed from text length.

The worker reads the CLI's local conversation SQLite database in read-only mode and joins `gen_metadata` to each exact transcript step. It exports these attributes:

| Attribute                                    | Meaning                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `antigravity.llm.ttft_seconds`               | Native CLI `time_to_first_token`, in seconds, including fractional precision |
| `antigravity.llm.streaming_duration_seconds` | Native duration of the subsequent streamed response, when recorded           |
| `antigravity.llm.ttft_scope`                 | `cli_first_output_including_thinking_not_first_answer_text`                  |
| `antigravity.llm.timing_source`              | `cli_sqlite_gen_metadata`                                                    |
| `antigravity.llm.timing_status`              | `recorded`, `not_recorded`, or `disabled`                                    |
| `antigravity.user_turn_first_call`           | Whether this is the first model call belonging to an explicit user turn      |

For average TTFT per user message, select LLM spans with `antigravity.user_turn_first_call=true` and `timing_status=recorded`. Averaging every LLM span instead measures every internal model/tool iteration. **This metric is not time to first answer text or UI rendering time.** Thinking-only generations can also carry native TTFT; the exact first stream-event boundary is not inferred from packets or hook timestamps.

Native timing is enabled by default and requires the original CLI transcript/database directory layout. Missing database/schema errors remain visible. If a generator record or its timing has not yet been persisted while its owner is alive, the span waits for a later worker pass; the pending count appears in `worker-status.json`. The collection wait is bounded by `nativeTimingWaitMs` (default 120000). Timing still absent at that deadline, after owner exit, or with no recorded owner is explicitly labeled rather than invented; a later explicit backfill can add it. Set `captureNativeTiming: false` to opt out of SQLite timing collection (also useful for offline synthetic journals).

For example, Laminar's project SQL API can calculate the mean for newly instrumented user turns:

```sql
SELECT count() AS messages,
       avg(JSONExtractFloat(attributes, 'antigravity.llm.ttft_seconds')) AS mean_ttft_seconds
FROM spans
WHERE span_type = 'LLM'
  AND JSONExtractBool(attributes, 'antigravity.user_turn_first_call') = true
  AND JSONExtractString(attributes, 'antigravity.llm.timing_status') = 'recorded'
```

Already queued/uploaded spans are immutable. Historical enrichment adds a separately named, zero-duration `DEFAULT` child span under the original LLM span, with no token/cost usage. It does not resend or rewrite the original model call. See the backfill command below.

`antigravity.llm.answer_ttft_status=not_exposed_by_cli` explicitly records the absence of an answer-text first-token timestamp. No duration is estimated from the thinking text, packet timing, or hook completion.

## Install

```sh
git clone https://github.com/Shimada666/lmnr-antigravity-plugin.git
cd lmnr-antigravity-plugin
agy plugin validate . --strict
agy plugin install .
# Configure the project key below, then install the independent exporter:
node scripts/install-worker.mjs
```

The committed `dist/hook.cjs` and `dist/worker.cjs` include runtime dependencies, so installation does not require npm. Restart the CLI after installation. The installed plugin is **disabled for collection until explicitly configured**; it does not inherit another Laminar plugin's key.

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

The worker and CLI must use the same configuration and state directory. With a custom configuration, install the service using `LMNR_ANTIGRAVITY_CONFIG=/absolute/path/to/antigravity-laminar.json node scripts/install-worker.mjs`. Then launch the intended session:

```sh
LMNR_ANTIGRAVITY_CONFIG=/absolute/path/to/antigravity-laminar.json \
  agy -p 'Reply exactly HELLO_LAMINAR' --output-format json
```

For persistent opt-in, put the file at `~/.config/lmnr/antigravity-plugin.json`. Optional settings: `maxChars` (default 20000, per content field), `timeoutMs` (default 5000, per export request), `queryTimeoutMs` (default 15000, per read-only reconciliation/backfill query). `LMNR_ANTIGRAVITY_STATE_DIR` overrides `~/.local/state/lmnr/antigravity`.

**Collection includes prompt text, tool inputs/outputs, and local paths.** It is sent only to the configured Laminar instance. There is no automatic secret redaction; start with a synthetic session. Private local state retains hook events and failed upload payloads. Do not commit it or share it as a support bundle.

## Delivery and failure behavior

All hooks, including Stop, append durable local events and capture available native request snapshots locally. They never upload over HTTP. A separate Linux user service checks source changes every second and exports completed model/tool spans while the CLI continues running. Byte cursors read appended data only; completed turns are discarded from the working buffer. Unchanged sessions do not launch an exporter. The turn root is finalized on a fully-idle Stop, an observed next turn, or verified owner-process exit. Tool authorization remains with Antigravity: pre-tool hooks return `allow`, never `auto_approve`.

- Separate locks isolate journal writes from network uploads. Each immutable span payload and delivery receipt is persisted with fsync before sending.
- Owner identity includes Linux boot ID, PID, and process start ticks. Silence or a paused process is not treated as death. Recovery timestamps mark when exit was observed, not an invented exact crash time; incomplete calls do not receive invented tokens.
- HTTP acceptance is recorded and never resent. Stored spans are verified through Laminar's project-scoped SQL API. Each span is sent separately to allow reconciliation.
- Connection refusal/DNS failures and HTTP 429 retry with backoff. Invalid requests/auth failures remain visibly rejected. A lost acknowledgement, timeout, server failure, or interrupted send is uncertain: the worker queries for the span but **does not blindly resend when it is absent**. Laminar v0.3.1 ingestion is not idempotent; deterministic IDs alone do not prevent duplicate token aggregation. This avoids unsafe retries but does not guarantee automatic delivery of every ambiguous request.
- Exceptions retain their stack traces in service logs and mark the session unhealthy. Failed sessions retry with a delay; a failing session does not stop other sessions. Uncertain/rejected deliveries produce attention logs and a nonzero `--health` result.
- The daemon maintains a heartbeat. `--health` reports stale heartbeats, worker failures, ambiguous/rejected deliveries and delayed native timing. `--retry-rejected` is limited to definite server rejections after the underlying problem is fixed; it writes a recovery audit. Ambiguous requests remain query-only because absence from a read API cannot prove the async write was rejected.
- The installer preserves old completed checkpoints and imports old pending requests as uncertain. It waits for already-running old hook exporters before migrating. Historical sessions without owner identity cannot be declared dead merely because their journal is quiet.

```sh
systemctl --user status lmnr-antigravity-worker
journalctl --user -u lmnr-antigravity-worker
node dist/worker.cjs --status
node dist/worker.cjs --health # nonzero for actionable problems
node dist/worker.cjs --doctor # validates native protobuf field numbers/types against agy
# After fixing an explicit HTTP rejection, retry one session (never uncertain writes):
node dist/worker.cjs --retry-rejected /absolute/path/to/state/conversation
# Add historical TTFT/thinking metadata to already-stored LLM spans:
node dist/worker.cjs --backfill /absolute/path/to/state/conversation
# Process one conversation immediately, without appending a synthetic Stop:
node scripts/retry.mjs /absolute/path/to/state/conversation/events.jsonl
```

The service uses the installed plugin's bundles. Run `node scripts/install-worker.mjs` after updating the repository/build. User lingering is needed to run without an interactive login; the installer reports its status. Use the same configuration and state-directory overrides for manual commands.

## Current limits

- CLI sessions, including resumed long conversations, asynchronous/parallel tools, recorded cancellation, and observed compaction messages. Subagent parent/child linkage and browser/image artifacts are not implemented.
- Hooks must be enabled before the first model invocation of the turn. Earlier unobserved turns are not backfilled. Transcript compaction that physically deletes earlier observed rows is not supported.
- The CLI must emit its first hook. New sessions can recover after process exit even without Stop; there is no recovery for completely unobserved invocations.
- Byte cursors validate committed boundary bytes and fail visibly on truncation or changed committed bytes. They do not silently restart and duplicate history. A partial trailing UTF-8/JSON line is reread after completion.
- Adjacent transcript rows that repeat the same step with identical parsed content are processed once, including repeats across incremental reads. Conflicting content for the same step or decreasing step indices still fails visibly. The original transcript is never rewritten.
- Native protobuf projections are verified against the actual running CLI executable and cached by file identity and projection hash. Upgrades trigger verification again; unknown field types fail visibly. `validateNativeSchema: false` is only for synthetic/offline fixtures, not normal collection.
- Span boundaries are observed at hook execution, not provider-server timestamps. Native TTFT/streaming attributes retain the separate CLI measurements. In CLI 1.4.2, `PostInvocation` occurs after tools, so the LLM span ends at the first pre-tool hook when tools are present.
- Tool spans are siblings of LLM spans under the turn root. There is no guessed subagent hierarchy.
- There is no retention policy or automatic configuration/key provisioning. Linux systemd user services are the supported background runtime.

## Historical metrics and native compatibility

Backfill is explicit and project scoped. It enriches only existing LLM spans missing native timing, verifies their transcript step, and uses deterministic enrichment IDs plus the same durable delivery receipts. Repeating the command does not duplicate enrichment. Earlier prompts already erased by the CLI cannot be recovered.

To include historical metadata in a per-message TTFT report without counting an extra model call:

```sql
SELECT count() AS messages,
       avg(JSONExtractFloat(attributes, 'antigravity.llm.ttft_seconds')) AS mean_ttft_seconds
FROM spans
WHERE (span_type = 'LLM' OR JSONExtractString(attributes, 'antigravity.enrichment.type') = 'native_metadata')
  AND JSONExtractBool(attributes, 'antigravity.user_turn_first_call') = true
  AND JSONExtractString(attributes, 'antigravity.llm.timing_status') = 'recorded'
```

Native snapshots and diagnostic state stay in the same private state directory. Metrics that the CLI does not expose remain explicitly unavailable. Guaranteed retry of an ambiguous ingestion requires a server-side idempotency contract; neither deterministic client IDs nor a second relay creates that guarantee.

## Development and validation

```sh
npm ci
npm run check
npm run build
npm test
agy plugin validate . --strict
```

The smoke and regression exercises use real hook subprocesses and a local OTLP receiver. CI runs both. It verifies trace hierarchy, tool output, model/tool timing boundaries, failed HTTP export, partial rejection, immutable payloads, duplicate Stop, resumed turns, and unknown-schema rejection. The regression suite additionally covers background and failed tools, parallel calls, historical/compaction records, cancellations, live-turn boundaries, malformed responses, auth/rate-limit failures, timeouts, concurrent retries, and event capture during blocked uploads. Neither suite needs credentials or calls an LLM.

See [VALIDATION.md](VALIDATION.md) for the live trial and its limitations.

## References

- [Antigravity hooks](https://antigravity.google/docs/hooks)
- [Antigravity plugins](https://antigravity.google/docs/plugins)
- [Laminar Codex plugin](https://github.com/lmnr-ai/lmnr-codex-plugin) — byte-offset reading and Laminar OTLP conventions. The official plugin documents at-least-once delivery, which can duplicate exports.
- [Laminar Claude Code plugin](https://github.com/lmnr-ai/lmnr-claude-code-plugin) — byte-offset transcript reading, turn assembly and deferred subagent handling. The Antigravity adapter is implemented separately.
