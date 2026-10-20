import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { atomicJson, sessionKey, type Config } from "./storage.js";
import { eventRecord, transcriptEnvelope, type Span } from "./schema.js";
import { readNativeTimings } from "./native-timing.js";
import { pack } from "./traces.js";

/** Historical metadata is a distinct, zero-usage child; never resend an LLM. */
export async function backfill(directory: string, config: Config) {
  const release = await lockfile.lock(directory, {
    retries: { retries: 200, minTimeout: 100, maxTimeout: 100 },
    stale: 30_000,
  });
  try {
    const first = eventRecord.parse(
      JSON.parse(
        (await readFile(join(directory, "events.jsonl"), "utf8")).split(
          "\n",
        )[0]!,
      ),
    );
    assert.equal(
      sessionKey(first.payload, config),
      directory.split("/").at(-1),
      "Backfill project scope mismatch",
    );
    const cid = first.payload.conversationId;
    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/v1/sql/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.projectApiKey}`,
        },
        body: JSON.stringify({
          query: `SELECT trace_id, span_id, attributes, span_type, toString(toUnixTimestamp64Nano(end_time)) AS end_ns FROM spans WHERE (span_type = 'LLM' OR JSONExtractString(attributes, 'antigravity.enrichment.type') = 'native_metadata') AND JSONExtractString(attributes, 'lmnr.association.properties.session_id') = '${cid}' ORDER BY start_time LIMIT 10001`,
        }),
        signal: AbortSignal.timeout(config.queryTimeoutMs),
        redirect: "error",
      },
    );
    assert(response.ok, `Backfill lookup failed: HTTP ${response.status}`);
    const rows = z
      .object({
        data: z.array(
          z.object({
            trace_id: z.guid(),
            span_type: z.enum(["LLM", "DEFAULT"]),
            span_id: z.guid(),
            attributes: z
              .string()
              .transform((s) =>
                z.record(z.string(), z.json()).parse(JSON.parse(s)),
              ),
            end_ns: z.string().regex(/^\d+$/),
          }),
        ),
      })
      .parse(await response.json()).data;
    assert(
      rows.length <= 10000,
      "Backfill exceeds 10000 spans; narrow the session explicitly",
    );
    const sourceText = await readFile(first.payload.transcriptPath, "utf8");
    const source = sourceText
      .slice(0, sourceText.lastIndexOf("\n"))
      .split("\n")
      .filter(Boolean)
      .map((line) => transcriptEnvelope.parse(JSON.parse(line)));
    const models = new Map(
      source
        .filter((r) => r.type === "PLANNER_RESPONSE")
        .map((r) => [r.step_index, r]),
    );
    const candidates = rows.filter(
      (r) =>
        r.span_type === "LLM" &&
        r.attributes["antigravity.llm.timing_status"] !== "recorded" &&
        typeof r.attributes["antigravity.step_index"] === "number",
    );
    const steps = candidates.map((r) =>
      z
        .number()
        .int()
        .nonnegative()
        .parse(r.attributes["antigravity.step_index"]),
    );
    const timings = await readNativeTimings(
      first.payload.transcriptPath,
      cid,
      steps,
    );
    const storedIds = new Set(
      rows.map(
        (r) =>
          r.trace_id.replaceAll("-", "") +
          "-" +
          r.span_id.replaceAll("-", "").slice(-16),
      ),
    );
    let queued = 0,
      unavailable = 0,
      existing = 0;
    const outbox = join(directory, "outbox");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    for (const [index, row] of candidates.entries()) {
      const step = steps[index]!;
      const timing = timings.get(step);
      const model = models.get(step);
      if (!timing || !model) {
        unavailable++;
        continue;
      }
      const traceId = row.trace_id.replaceAll("-", "");
      const parentSpanId = row.span_id.replaceAll("-", "").slice(-16);
      const spanId = createHash("sha256")
        .update(`antigravity:native-enrichment:v1:${traceId}:${parentSpanId}`)
        .digest("hex")
        .slice(0, 16);
      const name = `${traceId}-${spanId}`;
      if (storedIds.has(name) || existsSync(join(outbox, `${name}.json`))) {
        existing++;
        continue;
      }
      const priorUser = source.findLast(
        (r) =>
          r.type === "USER_INPUT" &&
          r.source === "USER_EXPLICIT" &&
          r.step_index < step,
      );
      const firstCall =
        priorUser !== undefined &&
        source.find(
          (r) =>
            r.type === "PLANNER_RESPONSE" &&
            r.step_index > priorUser.step_index,
        )?.step_index === step;
      const span: Span = {
        traceId,
        spanId,
        parentSpanId,
        name: "Native metadata (historical)",
        kind: 1,
        startTimeUnixNano: row.end_ns,
        endTimeUnixNano: row.end_ns,
        status: { code: 1 },
        attributes: [
          { key: "lmnr.span.type", value: { stringValue: "DEFAULT" } },
          {
            key: "lmnr.association.properties.session_id",
            value: { stringValue: cid },
          },
          {
            key: "antigravity.enrichment.type",
            value: { stringValue: "native_metadata" },
          },
          {
            key: "antigravity.enrichment.original_span_id",
            value: { stringValue: row.span_id },
          },
          { key: "antigravity.step_index", value: { intValue: String(step) } },
          {
            key: "antigravity.user_turn_first_call",
            value: { boolValue: firstCall },
          },
          {
            key: "antigravity.llm.ttft_seconds",
            value: { doubleValue: timing.ttftSeconds },
          },
          {
            key: "antigravity.llm.timing_status",
            value: { stringValue: "recorded" },
          },
          {
            key: "antigravity.llm.timing_source",
            value: { stringValue: "cli_sqlite_gen_metadata" },
          },
          {
            key: "antigravity.llm.ttft_scope",
            value: {
              stringValue:
                "cli_first_output_including_thinking_not_first_answer_text",
            },
          },
        ],
      };
      if (timing.streamingSeconds !== undefined)
        span.attributes.push({
          key: "antigravity.llm.streaming_duration_seconds",
          value: { doubleValue: timing.streamingSeconds },
        });
      if (model.thinking !== undefined) {
        const thinking = z.string().parse(model.thinking);
        span.attributes.push({
          key: "lmnr.span.output",
          value: {
            stringValue: JSON.stringify({
              thinking:
                thinking.length > config.maxChars
                  ? thinking.slice(0, config.maxChars) +
                    "\n[truncated by lmnr-antigravity]"
                  : thinking,
            }),
          },
        });
      }
      await atomicJson(join(outbox, `${name}.json`), {
        span,
        request: pack([span]),
      });
      await atomicJson(join(outbox, `${name}.receipt.json`), {
        state: "ready",
        attempts: 0,
        retryAt: 0,
      });
      queued++;
    }
    return {
      conversationId: cid,
      llmSpans: rows.filter((r) => r.span_type === "LLM").length,
      queued,
      existing,
      unavailable,
    };
  } finally {
    await release();
  }
}
