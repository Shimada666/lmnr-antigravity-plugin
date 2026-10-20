# Validation — 0.4.0 — 2026-10-20

## Environment

- Antigravity CLI 1.4.2 and 1.4.3 on Linux, Node.js 24.18.0 locally; CI runs Node.js 22.
- Self-hosted Laminar app-server v0.3.1.
- The global plugin was updated and exercised through actual CLI hooks.
- User transcripts and credentials remain private on the operator's machine. Only synthetic fixtures are committed.

## 0.4.0 incremental processing and native inputs

- Reviewed Laminar's official Codex and Claude Code plugin sources. Both use byte offsets; Codex explicitly documents at-least-once delivery. This adapter adopts append-only cursors but retains query reconciliation for ambiguous sends, because the deployed server does not provide an idempotency contract.
- All 32 regression and 22 lifecycle checks pass. New scenarios cover appended turns and cursor pruning, mutation of committed boundary bytes, idle-daemon skipping and heartbeat health, native system/history/tool request snapshots, repeated historical enrichment without additional LLM calls or token usage, and bounded native metadata waits.
- On the same long-running conversation, a warm manual worker pass used 0.346 CPU seconds versus 1.408 seconds before the change (75% lower), with wall time 0.332 versus 1.834 seconds and peak RSS 73,088 versus 203,800 KiB. An unchanged pass read 512 boundary-check bytes. A 30-second running-service sample used 1.016 CPU seconds (3.39% of one core); this is an observation under the sampled workload, not a throughput guarantee.
- Installed-plugin CLI 1.4.3 trial: session `a19822cc-b51c-4be6-8a8e-2ed162d01fc1`, first trace `599b63a6-d40c-7763-fd05-671a8310ebc3`. The server returned two unique spans, native input messages including the system prompt, and numeric TTFT 9.122233431 seconds. Billing and answer-text first-token timing were explicitly marked unavailable.
- Resuming that session produced trace `28f08b83-e198-46ac-4c46-822f032fb9d3`. Its six native input messages included both the previous and current user prompts. Both turns were independently exported without duplicate IDs.
- Actual CLI 1.4.3 embedded descriptors passed the native field projection check. The live long-running CLI's executable was also checked separately. The systemd installer pins the discovered agy executable path and waits for a heartbeat from the new service PID; a restricted-PATH doctor check passed.
- Historical enrichment added 129 distinct zero-duration DEFAULT children. The 132 original model spans were re-read and matched their pre-operation IDs and input/output token counts exactly. The 129 enrichment rows were unique and had zero input tokens, output tokens and costs. Two interrupted calls had no response step, and one had no persisted native timing; those three were not fabricated.
- No provider wire request, image/media payload, first-answer-text timestamp or actual subscription bill is claimed. Uncertain sends still require server-side idempotency to become safely and automatically retryable.

## Why 0.1.0 failed

The first version passed short synthetic conversations but parsed the entire transcript as DONE-only rows. Real background dispatches remain RUNNING in the transcript; completion arrives in later system messages. Old error/compaction records also blocked resumed conversations. Replay appended a new Stop, which could incorrectly consume a newer turn. A single short-wait lock also coupled hook capture to network uploads.

These were implementation defects. Validation now covers the real lifecycle, not just a successful POST.

## 0.3.1 thinking and native timing

- The native metadata reader was checked against an independent Python protobuf extraction for 1,038 real model records across two conversations. TTFT and streaming durations matched within one nanosecond. No prompt or credentials are included in the comparison artifact or committed fixtures.
- The lifecycle suite adds a real SQLite fixture with delayed generator/timing persistence. It checks that LLM spans wait for timing while the owner is alive, preserves fractional and zero durations as OTLP doubles, marks only the first model call per user turn, retains thinking as a separate output part, excludes thinking from reconstructed input history, and sends no duplicate spans.
- The reader uses exact field numbers and types from the CLI 1.4.2 embedded `exa.cortex_pb` descriptors. It does not treat HTTP response logs, hook duration, or time to first packet as TTFT. The metric is explicitly not time to first answer text.

- Fresh installed-plugin test: session `1b353fc2-b874-49b5-99b8-75b8570309b7`, trace `b77cb7ae-116f-297a-c594-65983e78d397`. Laminar stored native TTFT `21.671801287` seconds and streaming duration `5.77141055` seconds as numbers, along with a distinct thinking part containing 759 characters. The thinking text and input/output token counts matched the source transcript; the trace contained two unique spans.
- A separate simple arithmetic session had no thinking field. Laminar stored its TTFT `4.899759587` seconds and streaming duration `0.093617537` seconds without inventing thinking text. The documented project SQL average query was exercised against the stored native fields.
- All 32 regression and 16 worker lifecycle scenarios, type/format checks, build, and strict CLI plugin validation passed. Installed runtime bundles match the repository build.

## 0.3.0 worker validation

The local receiver exercises incremental export before Stop, final root token aggregation, lost acknowledgements both with and without server acceptance, rate-limit retry, partial rejection, killing the worker during an accepted request, connection-refusal recovery, owner pause versus real exit, PID reuse, boot identity changes, journal-only native hooks, v0.2 checkpoint migration, and isolation of corrupt sessions. Ambiguous unaccepted requests remain uncertain rather than being blindly resent.

The following real Laminar evidence was collected for 0.2.0; new worker runtime validation is recorded separately below.

## 0.3.0 live acceptance

- 32 regression scenarios and 15 worker lifecycle scenarios pass, including preservation and repair of a torn journal tail. Type/format checks, bundle build, and strict CLI plugin validation pass.
- Two private long-conversation journals replayed against a local receiver: 126 spans, 63 model spans, no duplicate IDs. All exported model token counters were compared with the source transcripts. No replay payload was sent to the real project.
- Installed the worker as an enabled, active systemd user service; user lingering is enabled. Existing v0.2 completed checkpoints were migrated without replaying their completed spans.
- Fresh streaming session `0214c9e1-fe33-4bcb-b4a8-20379d0d0da8`: a project SQL query returned the completed LLM span while the CLI was alive and before fully-idle Stop. Final trace `cba1791f-129b-f22a-76bd-68fb4eb3da56` contains five unique spans with a successful root.
- Fresh interrupted session `518047a4-d910-434b-86be-523abc16b20a`: the test CLI was killed after PreToolUse and before Stop. The independent service finalized trace `6570b38c-11ea-f0cb-a997-6527e123e6a5` with three unique spans: successful completed LLM, interrupted tool, and error root. Model tokens match the transcript in both fresh traces.
- Existing business CLI processes were not restarted or terminated. The process-kill check targeted only the disposable test session, after verifying PID/start identity.

## Earlier automated checks

`npm test` runs real hook subprocesses against a local HTTP receiver:

- The original smoke suite: hierarchy, tool content, cached-token normalization, model/tool timing, HTTP 503, partial rejection, frozen retries, duplicate suppression, resumed turns, and unknown-schema failures.
- 32 regression scenarios: background dispatch, ERROR/INVALID tools with and without hooks, 2,000 pre-install history rows, completion/system/compaction/error messages, active next-turn exclusion, queued input, non-idle Stops, cancellation/error/budget termination without a model response, interrupted tools, parallel completion order, strict mismatches, partial transcripts, missing error/token fields, HTTP 401/429/503, invalid responses, timeouts, eight simultaneous retries, and hook capture while HTTP is deliberately blocked.
- Every error span must carry both an OTLP error status and an `exception` event. Laminar v0.3.1 derives stored error status from the event; checking only the outbound status code is insufficient.
- Replaying an unchanged completed journal must send no additional requests or append fabricated Stops.

`npm run check`, `npm run build`, `agy plugin validate . --strict`, and both test suites passed. CI runs type/format checks, reproducible bundle verification, and both test suites.

## Real-session recovery

Two existing CLI conversations were replayed locally before upload, then recovered into their configured Laminar project:

| Conversation | Recovered turns | Spans | LLM spans | Tool spans |
| ------------ | --------------: | ----: | --------: | ---------: |
| futures      |               2 |    26 |        14 |         10 |
| thesis       |               5 |    61 |        28 |         28 |

All 42 model input/output counters were compared with the original transcripts. Input counts include the separately reported cache reads. No unobserved older turns were fabricated. The first recovery exposed Laminar's exception-event requirement; the two affected real tool spans and their trace status metadata were corrected in place, without duplicating spans or changing token counts.

## Fresh CLI integration checks

A new synthetic conversation launched a background shell command, attempted a deliberately missing file read, received the background completion message, and returned the marker. A second turn resumed it successfully. Server queries checked parent IDs, normalized tokens, and span counts (two traces, eight spans).

After adding exception events, a separate fresh session repeated the background/error test:

- Trace `175a3eab-03c5-cc09-4f32-0f037af00876`.
- Six spans: root, three model calls, background command dispatch, failed file read.
- Server-side command status: success; file-read status: error, with the actual `exception.message` retained.
- Captured `RUNNING` status is labeled background_dispatch, not misrepresented as the full task runtime.

Earlier exploratory traces are not acceptance evidence for corrected error-status handling.

## Boundaries

This validates the CLI lifecycle above. It does not establish App/IDE integration, nested subagent linkage, browser/image artifacts, Windows/macOS behavior, pricing, hidden reasoning, or an exact full provider prompt. Compaction messages are supported; physically deleting observed transcript rows is not. The earlier headless permission-denial probe exited without PostInvocation/Stop. Version 0.3.0 records process identity on new hooks and can finalize such interrupted turns after verified exit. Legacy journals without owner identity retain their observability limit. No successful completion is invented for those cases.
