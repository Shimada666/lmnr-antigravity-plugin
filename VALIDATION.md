# Validation — 0.2.0 — 2026-10-20

## Environment

- Antigravity CLI 1.4.2 on Linux, Node.js 24.18.0 locally; CI runs Node.js 22.
- Self-hosted Laminar app-server v0.3.1.
- The global plugin was updated and exercised through actual CLI hooks.
- User transcripts and credentials remain private on the operator's machine. Only synthetic fixtures are committed.

## Why 0.1.0 failed

The first version passed short synthetic conversations but parsed the entire transcript as DONE-only rows. Real background dispatches remain RUNNING in the transcript; completion arrives in later system messages. Old error/compaction records also blocked resumed conversations. Replay appended a new Stop, which could incorrectly consume a newer turn. A single short-wait lock also coupled hook capture to network uploads.

These were implementation defects. Validation now covers the real lifecycle, not just a successful POST.

## Automated checks

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

This validates the CLI lifecycle above. It does not establish App/IDE integration, nested subagent linkage, browser/image artifacts, Windows/macOS behavior, pricing, hidden reasoning, or an exact full provider prompt. Compaction messages are supported; physically deleting observed transcript rows is not. Cancellation tests require the CLI to emit a Stop. A live headless permission-denial probe exited without PostInvocation/Stop, leaving only an incomplete journal; process kills/crashes have the same observability limit. No successful trace is invented for those cases.
