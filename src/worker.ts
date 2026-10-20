import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  open,
  rename,
  stat,
} from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  deliverySchema,
  eventRecord,
  ledgerSchema,
  outboxSchema,
  transcriptEnvelope,
  transcriptRow,
  type Span,
} from "./schema.js";
import {
  atomicJson,
  journalLock,
  ownerAlive,
  readConfig,
  sessionKey,
  stateRoot,
  type Config,
} from "./storage.js";
import { backfill } from "./backfill.js";
import { verifyNativeSchema } from "./compatibility.js";
import { cursorSchema, readAppended } from "./incremental.js";
import { enrichNativeInput } from "./native-input.js";
import { buildSpans, pack } from "./traces.js";
import { deliver } from "./delivery.js";
import {
  captureNativeContext,
  readNativeContexts,
  readNativeTimings,
  type NativeTiming,
  type NativeContext,
} from "./native-timing.js";

function lines(raw: string): { lines: string[]; partial: boolean } {
  const end = raw.lastIndexOf("\n");
  return {
    lines: end < 0 ? [] : raw.slice(0, end).split("\n").filter(Boolean),
    partial: end !== raw.length - 1,
  };
}

async function session(directory: string, config: Config): Promise<void> {
  const release = await lockfile.lock(directory, {
    retries: { retries: 200, minTimeout: 100, maxTimeout: 100 },
    stale: 30_000,
  });
  try {
    assert(
      existsSync(join(directory, "ledger.json")),
      "Run worker --migrate before processing v0.2 state",
    );
    const ledger = ledgerSchema.parse(
      JSON.parse(await readFile(join(directory, "ledger.json"), "utf8")),
    );
    const snapshotPath = join(directory, "cursor.json");
    const snapshotSchema = z
      .object({
        journal: cursorSchema,
        transcript: cursorSchema,
        events: z.array(eventRecord),
        rows: z.array(transcriptEnvelope),
        completedTurns: z.array(z.number().int().nonnegative()),
        settledReceipts: z.array(z.string()),
      })
      .strict();
    const snapshot = existsSync(snapshotPath)
      ? snapshotSchema.parse(JSON.parse(await readFile(snapshotPath, "utf8")))
      : undefined;
    const path = join(directory, "events.jsonl");
    const releaseJournal = await lockfile.lock(path, journalLock);
    let journal: Awaited<ReturnType<typeof readAppended>>;
    try {
      journal = await readAppended(path, snapshot?.journal);
    } finally {
      await releaseJournal();
    }
    let events = [
      ...(snapshot?.events ?? []),
      ...journal.lines.map((line) => eventRecord.parse(JSON.parse(line))),
    ];
    if (events.length === 0) return;
    assert(
      sessionKey(events[0]!.payload, config) === basename(directory),
      "Session belongs to a different endpoint or project credential; refusing to reroute it",
    );
    const transcriptPath = events[0]!.payload.transcriptPath;
    const raw = await readAppended(transcriptPath, snapshot?.transcript);
    let envelopes = [
      ...(snapshot?.rows ?? []),
      ...raw.lines.map((line) => transcriptEnvelope.parse(JSON.parse(line))),
    ];
    for (let i = 1; i < envelopes.length; i++)
      assert(
        envelopes[i]!.step_index > envelopes[i - 1]!.step_index,
        "Transcript indices must strictly increase",
      );
    const completedTurns = new Set(snapshot?.completedTurns ?? []);
    const settledReceipts = new Set(snapshot?.settledReceipts ?? []);
    const first = events.find(
      (e) =>
        e.payload.event === "PreInvocation" &&
        e.payload.initialNumSteps > ledger.importedThroughStep,
    );
    let spans: Span[] = [];
    if (first) {
      assert(first.payload.event === "PreInvocation");
      const initial = first.payload.initialNumSteps;
      const user = envelopes.findLast(
        (r) =>
          r.type === "USER_INPUT" &&
          r.source === "USER_EXPLICIT" &&
          r.step_index < initial,
      );
      assert(user, "No explicit user input before first observed invocation");
      const rows = envelopes
        .filter(
          (r) =>
            r.step_index >= user.step_index &&
            r.step_index > ledger.importedThroughStep,
        )
        .map((r) => transcriptRow.parse(r));
      spans = buildSpans(
        rows,
        events,
        ledger.importedThroughStep,
        config.maxChars,
        new Date().toISOString(),
        ownerAlive,
        raw.partial || journal.partial,
        completedTurns,
      );
    }
    const outbox = join(directory, "outbox");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    const newModels = spans.filter(
      (span) =>
        span.attributes.some(
          (a) =>
            a.key === "lmnr.span.type" &&
            "stringValue" in a.value &&
            a.value.stringValue === "LLM",
        ) && !existsSync(join(outbox, `${span.traceId}-${span.spanId}.json`)),
    );
    const stepOf = (span: Span) =>
      z
        .object({ intValue: z.coerce.number().int().nonnegative() })
        .parse(
          span.attributes.find((a) => a.key === "antigravity.step_index")!
            .value,
        ).intValue;
    // An interrupted call with no response has no transcript step or native
    // generation to join. Completed response spans carry the exact step index.
    const modelSteps = newModels.filter((span) =>
      span.attributes.some((a) => a.key === "antigravity.step_index"),
    );
    if (
      config.validateNativeSchema &&
      (config.captureNativeContext || config.captureNativeTiming)
    ) {
      const recordedOwner = events.findLast((e) => e.owner !== null)?.owner;
      // Synthetic/offline fixtures have no real CLI owner; live sessions verify
      // the actual executable, including an older binary still running after upgrade.
      if (recordedOwner && ownerAlive(recordedOwner))
        await verifyNativeSchema(`/proc/${recordedOwner.pid}/exe`);
    }
    if (config.captureNativeContext)
      await captureNativeContext(
        transcriptPath,
        events[0]!.payload.conversationId,
        directory,
      );
    const contexts = config.captureNativeContext
      ? await readNativeContexts(directory, modelSteps.map(stepOf))
      : new Map<number, NativeContext>();
    const timings = config.captureNativeTiming
      ? await readNativeTimings(
          events[0]!.payload.transcriptPath,
          events[0]!.payload.conversationId,
          modelSteps.map(stepOf),
        )
      : new Map<number, NativeTiming | null>();
    const waitPath = join(directory, "native-waits.json");
    const waits = existsSync(waitPath)
      ? z
          .record(z.string(), z.number().nonnegative())
          .parse(JSON.parse(await readFile(waitPath, "utf8")))
      : {};
    const waitsBefore = JSON.stringify(waits);
    const pendingNativeTiming = new Set<string>();
    let oldestPendingTimingSeconds = 0;
    for (const span of modelSteps) {
      const context = contexts.get(stepOf(span));
      if (context) enrichNativeInput(span, context, config.maxChars);
      else
        span.attributes.push({
          key: "antigravity.input_source",
          value: {
            stringValue: config.captureNativeContext
              ? "visible_turn_transcript_native_request_unavailable"
              : "visible_turn_transcript",
          },
        });
      span.attributes.push(
        {
          key: "antigravity.llm.answer_ttft_status",
          value: { stringValue: "not_exposed_by_cli" },
        },
        {
          key: "antigravity.cost.status",
          value: { stringValue: "billing_amount_not_exposed_by_cli" },
        },
      );
      const timing = timings.get(stepOf(span));
      if (config.captureNativeTiming && timing == null) {
        const lastOwner = events.findLast((e) => e.owner !== null)?.owner;
        if (lastOwner && ownerAlive(lastOwner)) {
          waits[span.spanId] ??= Date.now();
          const waitingSeconds = (Date.now() - waits[span.spanId]!) / 1000;
          if (waitingSeconds * 1000 < config.nativeTimingWaitMs) {
            oldestPendingTimingSeconds = Math.max(
              oldestPendingTimingSeconds,
              waitingSeconds,
            );
            pendingNativeTiming.add(span.spanId);
            continue;
          }
          span.attributes.push({
            key: "antigravity.llm.timing_unavailable_reason",
            value: { stringValue: "native_metadata_wait_expired" },
          });
        }
      }
      delete waits[span.spanId];
      span.attributes.push({
        key: "antigravity.llm.timing_status",
        value: {
          stringValue: !config.captureNativeTiming
            ? "disabled"
            : timing
              ? "recorded"
              : "not_recorded",
        },
      });
      if (timing) {
        if (timing.nativeModelCost !== undefined)
          span.attributes.push({
            key: "antigravity.usage.native_model_cost",
            value: { doubleValue: timing.nativeModelCost },
          });
        span.attributes.push(
          {
            key: "antigravity.llm.ttft_seconds",
            value: { doubleValue: timing.ttftSeconds },
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
        );
        if (timing.streamingSeconds !== undefined)
          span.attributes.push({
            key: "antigravity.llm.streaming_duration_seconds",
            value: { doubleValue: timing.streamingSeconds },
          });
      }
    }
    if (JSON.stringify(waits) !== waitsBefore)
      await atomicJson(waitPath, waits);
    for (const span of spans) {
      if (pendingNativeTiming.has(span.spanId)) continue;
      // Do not close/checkpoint a turn before all its native-enriched children are queued.
      if (
        !span.parentSpanId &&
        spans.some(
          (child) =>
            child.traceId === span.traceId &&
            pendingNativeTiming.has(child.spanId),
        )
      )
        continue;
      const name = `${span.traceId}-${span.spanId}`;
      const itemPath = join(outbox, `${name}.json`),
        receiptPath = join(outbox, `${name}.receipt.json`);
      // Once queued, a span's payload is immutable, including recovery timing.
      if (!existsSync(itemPath))
        await atomicJson(itemPath, { span, request: pack([span]) });
      if (!existsSync(receiptPath))
        await atomicJson(receiptPath, {
          state: "ready",
          attempts: 0,
          retryAt: 0,
        });
    }
    for (const span of spans) {
      if (
        !span.parentSpanId &&
        !spans.some(
          (child) =>
            child.traceId === span.traceId &&
            pendingNativeTiming.has(child.spanId),
        ) &&
        existsSync(join(outbox, `${span.traceId}-${span.spanId}.json`))
      ) {
        const userStep = span.attributes.find(
          (a) => a.key === "antigravity.user_step",
        )!;
        assert("intValue" in userStep.value);
        completedTurns.add(Number(userStep.value.intValue));
      }
    }
    let attempted = 0;
    let nextDeliveryAt = Infinity;
    let oldestUnconfirmedSeconds = 0;
    const counts: Record<string, number> = {};

    for (const name of (await readdir(outbox))
      .filter((n) => n.endsWith(".json") && !n.endsWith(".receipt.json"))
      .sort()) {
      if (settledReceipts.has(name)) continue;
      const receiptPath = join(
        outbox,
        name.replace(/\.json$/, ".receipt.json"),
      );
      // A crash after writing an item but before its receipt cannot have sent it.
      if (!existsSync(receiptPath))
        await atomicJson(receiptPath, {
          state: "ready",
          attempts: 0,
          retryAt: 0,
        });
      const receipt = deliverySchema.parse(
        JSON.parse(await readFile(receiptPath, "utf8")),
      );
      if (receipt.state === "confirmed") {
        settledReceipts.add(name);
        continue;
      }
      if (
        receipt.state !== "rejected" &&
        receipt.retryAt <= Date.now() &&
        attempted < 20
      ) {
        attempted++;
        await deliver(join(outbox, name), receiptPath, config);
      }
      const current = deliverySchema.parse(
        JSON.parse(await readFile(receiptPath, "utf8")),
      );
      counts[current.state] = (counts[current.state] ?? 0) + 1;
      if (current.state !== "confirmed") {
        const itemStat = await stat(join(outbox, name));
        oldestUnconfirmedSeconds = Math.max(
          oldestUnconfirmedSeconds,
          (Date.now() - itemStat.mtimeMs) / 1000,
        );
      }
      if (current.state === "confirmed") settledReceipts.add(name);
      else if (current.state !== "rejected")
        nextDeliveryAt = Math.min(nextDeliveryAt, current.retryAt);
    }
    // Keep only the first unfinished turn onward. The last completed turn is
    // retained until its successor exists, so an arriving invocation always has its user row.
    const users = envelopes.filter(
      (r) => r.type === "USER_INPUT" && r.source === "USER_EXPLICIT",
    );
    const keep =
      users.find(
        (r) =>
          !completedTurns.has(r.step_index) &&
          r.step_index > ledger.importedThroughStep,
      ) ?? users.at(-1);
    if (keep) {
      const firstKept = events.find(
        (e) =>
          e.payload.event === "PreInvocation" &&
          e.payload.initialNumSteps > keep.step_index,
      );
      if (firstKept) {
        envelopes = envelopes.filter((r) => r.step_index >= keep.step_index);
        events = events.filter((e) => e.at >= firstKept.at);
        for (const step of completedTurns)
          if (step < keep.step_index) completedTurns.delete(step);
      }
    }
    await atomicJson(snapshotPath, {
      journal: journal.cursor,
      transcript: raw.cursor,
      events,
      rows: envelopes,
      completedTurns: [...completedTurns],
      settledReceipts: [...settledReceipts],
    });
    if (counts.uncertain || counts.rejected || oldestPendingTimingSeconds > 120)
      console.error(
        `lmnr-antigravity attention session=${events[0]!.payload.conversationId} uncertain=${counts.uncertain ?? 0} rejected=${counts.rejected ?? 0} pending_native=${pendingNativeTiming.size} oldest_native_seconds=${Math.round(oldestPendingTimingSeconds)}`,
      );
    await atomicJson(join(directory, "worker-status.json"), {
      checkedAt: new Date().toISOString(),
      partialTranscript: raw.partial,
      partialJournal: journal.partial,
      pendingNativeTiming: pendingNativeTiming.size,
      oldestPendingTimingSeconds,
      oldestUnconfirmedSeconds,
      sourceBytesRead: journal.bytesRead + raw.bytesRead,
      bufferedRows: envelopes.length,
      bufferedEvents: events.length,
      confirmed: settledReceipts.size,
      deliveries: counts,
      nextDeliveryAt: Number.isFinite(nextDeliveryAt) ? nextDeliveryAt : null,
      transcriptPath,
      owner: events.findLast((e) => e.owner !== null)?.owner ?? null,
      ownerAlive: events.findLast((e) => e.owner !== null)?.owner
        ? ownerAlive(events.findLast((e) => e.owner !== null)!.owner!)
        : null,
    });
  } finally {
    await release();
  }
}

async function migrate(directory: string): Promise<void> {
  const release = await lockfile.lock(directory, {
    retries: { retries: 200, minTimeout: 100, maxTimeout: 100 },
    stale: 30_000,
  });
  try {
    if (existsSync(join(directory, "ledger.json"))) return;
    const journal = join(directory, "events.jsonl");
    const releaseJournal = await lockfile.lock(journal, journalLock);
    try {
      const original = await readFile(journal, "utf8");
      assert(
        original.endsWith("\n"),
        "Repair partial legacy journal before migration",
      );
      const migrated = original
        .trimEnd()
        .split("\n")
        .map((line) => {
          const old = eventRecord
            .omit({ owner: true })
            .extend({ owner: eventRecord.shape.owner.optional() })
            .parse(JSON.parse(line));
          return eventRecord.parse({ ...old, owner: old.owner ?? null });
        });
      const checkpointPath = join(directory, "checkpoint.json");
      const baseline = existsSync(checkpointPath)
        ? z
            .object({ throughStep: z.number().int().min(-1) })
            .parse(JSON.parse(await readFile(checkpointPath, "utf8")))
            .throughStep
        : -1;
      await atomicJson(join(directory, "v02-backup.json"), {
        events: original,
        checkpoint: baseline,
      });
      const file = await open(`${journal}.migrate`, "w", 0o600);
      try {
        await file.writeFile(
          migrated.map((value) => JSON.stringify(value)).join("\n") + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(`${journal}.migrate`, journal);
      const pendingPath = join(directory, "pending.json");
      if (existsSync(pendingPath)) {
        const pending = z
          .object({ request: outboxSchema.shape.request })
          .parse(JSON.parse(await readFile(pendingPath, "utf8")));
        const outbox = join(directory, "outbox");
        await mkdir(outbox, { recursive: true, mode: 0o700 });
        for (const resource of pending.request.resourceSpans)
          for (const scope of resource.scopeSpans)
            for (const span of scope.spans) {
              const name = `${span.traceId}-${span.spanId}`;
              await atomicJson(join(outbox, `${name}.json`), {
                span,
                request: pack([span]),
              });
              await atomicJson(join(outbox, `${name}.receipt.json`), {
                state: "uncertain",
                attempts: 1,
                retryAt: 0,
                error:
                  "Imported v0.2 pending upload; server acknowledgement unknown",
              });
            }
        await atomicJson(join(directory, "v02-pending-backup.json"), pending);
        await rm(pendingPath);
      }
      await atomicJson(join(directory, "ledger.json"), {
        version: 3,
        importedThroughStep: baseline,
      });
      if (existsSync(checkpointPath)) await rm(checkpointPath);
    } finally {
      await releaseJournal();
    }
  } finally {
    await release();
  }
}

async function directories(): Promise<string[]> {
  if (!existsSync(stateRoot)) return [];
  const entries = await readdir(stateRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name))
    .map((e) => join(stateRoot, e.name));
}
async function main(): Promise<void> {
  const mode = z
    .enum([
      "--once",
      "--session",
      "--status",
      "--health",
      "--doctor",
      "--backfill",
      "--retry-rejected",
      "--migrate",
      "--daemon",
    ])
    .parse(process.argv[2]);
  const config = await readConfig();
  if (mode === "--doctor") {
    console.log(
      JSON.stringify({
        native: await verifyNativeSchema(),
        capabilities: {
          firstOutputTiming: "native_including_thinking",
          firstAnswerTextTiming: "not_exposed",
          request: "native_text_and_tools_snapshot",
          billing: "not_exposed",
          exactlyOnceIngestion: "requires_server_idempotency",
        },
      }),
    );
    return;
  }
  if (
    mode === "--daemon" &&
    config.validateNativeSchema &&
    (config.captureNativeTiming || config.captureNativeContext)
  )
    await verifyNativeSchema();
  if (mode === "--session") {
    assert(process.argv[3]);
    await session(resolve(process.argv[3]), config);
    return;
  }
  if (mode === "--retry-rejected") {
    assert(process.argv[3], "Provide one session directory for retry-rejected");
    const dir = resolve(process.argv[3]);
    const release = await lockfile.lock(dir, {
      retries: { retries: 200, minTimeout: 100, maxTimeout: 100 },
      stale: 30_000,
    });
    try {
      const first = eventRecord.parse(
        JSON.parse(
          (await readFile(join(dir, "events.jsonl"), "utf8")).split("\n")[0]!,
        ),
      );
      assert.equal(
        sessionKey(first.payload, config),
        basename(dir),
        "Retry project scope mismatch",
      );
      for (const name of await readdir(join(dir, "outbox"))) {
        if (!name.endsWith(".receipt.json")) continue;
        const path = join(dir, "outbox", name);
        const receipt = deliverySchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (receipt.state !== "rejected") continue;
        assert(
          /^HTTP (400|401|403|404|405|413|415): request rejected$/.test(
            receipt.error!,
          ),
          "Only definite server rejections can be retried",
        );
        await mkdir(join(dir, "recovery-audit"), {
          recursive: true,
          mode: 0o700,
        });
        await atomicJson(join(dir, "recovery-audit", `${Date.now()}-${name}`), {
          action: "retry_definite_rejection",
          previous: receipt,
        });
        await atomicJson(path, {
          state: "ready",
          attempts: receipt.attempts,
          retryAt: 0,
        });
      }
    } finally {
      await release();
    }
    await session(dir, config);
    return;
  }
  if (mode === "--backfill") {
    const selected = process.argv[3]
      ? [resolve(process.argv[3])]
      : await directories();
    for (const dir of selected) {
      console.log(JSON.stringify(await backfill(dir, config)));
      await session(dir, config);
    }
    return;
  }
  if (mode === "--migrate") {
    for (const dir of await directories()) await migrate(dir);
    return;
  }
  if (mode === "--status" || mode === "--health") {
    const problems: string[] = [];
    for (const dir of await directories()) {
      const counts: Record<string, number> = {};
      const outbox = join(dir, "outbox");
      if (existsSync(outbox))
        for (const name of await readdir(outbox))
          if (name.endsWith(".receipt.json")) {
            const r = deliverySchema.parse(
              JSON.parse(await readFile(join(outbox, name), "utf8")),
            );
            counts[r.state] = (counts[r.state] ?? 0) + 1;
          }
      const data = lines(await readFile(join(dir, "events.jsonl"), "utf8"));
      const last = data.lines.at(-1);
      const record = last ? eventRecord.parse(JSON.parse(last)) : undefined;
      const statusPath = join(dir, "worker-status.json");
      const status = existsSync(statusPath)
        ? z
            .object({
              checkedAt: z.string(),
              pendingNativeTiming: z.number(),
              oldestPendingTimingSeconds: z.number().optional(),
              oldestUnconfirmedSeconds: z.number().optional(),
              sourceBytesRead: z.number().optional(),
              bufferedRows: z.number().optional(),
            })
            .parse(JSON.parse(await readFile(statusPath, "utf8")))
        : undefined;
      if (counts.uncertain || counts.rejected || counts.sending)
        problems.push(`${record?.payload.conversationId}: unresolved delivery`);
      if ((status?.oldestPendingTimingSeconds ?? 0) > 120)
        problems.push(
          `${record?.payload.conversationId}: native metadata delayed`,
        );
      if ((status?.oldestUnconfirmedSeconds ?? 0) > 300)
        problems.push(
          `${record?.payload.conversationId}: delivery not confirmed for five minutes`,
        );
      if (existsSync(join(dir, "worker-error.json")))
        problems.push(
          `${record?.payload.conversationId}: worker failure; inspect journal`,
        );
      console.log(
        JSON.stringify({
          session: record?.payload.conversationId,
          ...status,
          counts,
          ownerAlive: record?.owner ? ownerAlive(record.owner) : null,
          partialJournal: data.partial,
        }),
      );
    }
    if (mode === "--health") {
      const heartbeatPath = join(stateRoot, "heartbeat.json");
      if (!existsSync(heartbeatPath)) problems.push("daemon heartbeat absent");
      else {
        const heartbeat = z
          .object({ at: z.string() })
          .parse(JSON.parse(await readFile(heartbeatPath, "utf8")));
        if (Date.now() - Date.parse(heartbeat.at) > 60_000)
          problems.push("daemon heartbeat stale");
      }
      console.log(JSON.stringify({ healthy: problems.length === 0, problems }));
      if (problems.length) process.exitCode = 1;
    }
    return;
  }
  let running = true;
  process.on("SIGTERM", () => {
    running = false;
  });
  process.on("SIGINT", () => {
    running = false;
  });
  let failures = 0;
  const lastInputs = new Map<string, string>();
  const failedUntil = new Map<string, number>();
  let heartbeatAt = 0;
  do {
    failures = 0;
    for (const dir of await directories()) {
      if (!running) break;
      const statusPath = join(dir, "worker-status.json");
      const status = existsSync(statusPath)
        ? z
            .object({
              transcriptPath: z.string().optional(),
              pendingNativeTiming: z.number(),
              nextDeliveryAt: z.number().nullable().optional(),
              owner: eventRecord.shape.owner.optional(),
              ownerAlive: z.boolean().nullable().optional(),
            })
            .parse(JSON.parse(await readFile(statusPath, "utf8")))
        : undefined;
      const journalStat = await stat(join(dir, "events.jsonl"), {
        bigint: true,
      });
      const transcriptStat = status?.transcriptPath
        ? await stat(status.transcriptPath, { bigint: true })
        : undefined;
      const outboxStat = existsSync(join(dir, "outbox"))
        ? await stat(join(dir, "outbox"), { bigint: true })
        : undefined;
      const live = status?.owner ? ownerAlive(status.owner) : null;
      const signature = [
        journalStat.size,
        journalStat.mtimeNs,
        transcriptStat?.size,
        transcriptStat?.mtimeNs,
        outboxStat?.mtimeNs,
        live,
      ].join(":");
      const changed = lastInputs.get(dir) !== signature;
      const due =
        status?.nextDeliveryAt !== null &&
        status?.nextDeliveryAt !== undefined &&
        status.nextDeliveryAt <= Date.now();
      if (
        mode === "--daemon" &&
        !changed &&
        !due &&
        !status?.pendingNativeTiming &&
        !failedUntil.has(dir)
      )
        continue;
      if ((failedUntil.get(dir) ?? 0) > Date.now() && !changed) continue;
      lastInputs.set(dir, signature);
      const child = spawn(
        process.execPath,
        [process.argv[1]!, "--session", dir],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      const [code] = await once(child, "exit");
      if (!running) break;
      if (code !== 0) {
        failures++;
        failedUntil.set(dir, Date.now() + 60_000);
        await atomicJson(join(dir, "worker-error.json"), {
          at: new Date().toISOString(),
          exitCode: code,
        });
        console.error(
          `lmnr-antigravity worker_failed session=${basename(dir)} exit=${code}`,
        );
      } else {
        failedUntil.delete(dir);
        if (existsSync(join(dir, "worker-error.json")))
          await rm(join(dir, "worker-error.json"));
      }
    }
    if (mode !== "--daemon") break;
    if (Date.now() - heartbeatAt > 15_000) {
      await atomicJson(join(stateRoot, "heartbeat.json"), {
        at: new Date().toISOString(),
        pid: process.pid,
      });
      heartbeatAt = Date.now();
    }
    if (running) await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (running);
  if (mode === "--once" && failures) process.exitCode = 1;
}
void main();
