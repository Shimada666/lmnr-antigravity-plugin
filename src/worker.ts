import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, open, rename } from "node:fs/promises";
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
import { buildSpans, pack } from "./traces.js";
import { deliver } from "./delivery.js";

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
    const path = join(directory, "events.jsonl");
    const releaseJournal = await lockfile.lock(path, journalLock);
    let journalText: string;
    try {
      journalText = await readFile(path, "utf8");
    } finally {
      await releaseJournal();
    }
    const journal = lines(journalText);
    const events = journal.lines.map((line) =>
      eventRecord.parse(JSON.parse(line)),
    );
    if (events.length === 0) return;
    assert(
      sessionKey(events[0]!.payload, config) === basename(directory),
      "Session belongs to a different endpoint or project credential; refusing to reroute it",
    );
    const raw = lines(
      await readFile(events[0]!.payload.transcriptPath, "utf8"),
    );
    const envelopes = raw.lines.map((line) =>
      transcriptEnvelope.parse(JSON.parse(line)),
    );
    for (let i = 1; i < envelopes.length; i++)
      assert(
        envelopes[i]!.step_index > envelopes[i - 1]!.step_index,
        "Transcript indices must strictly increase",
      );
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
      );
    }
    const outbox = join(directory, "outbox");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    for (const span of spans) {
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
    let attempted = 0;
    for (const name of (await readdir(outbox))
      .filter((n) => n.endsWith(".json") && !n.endsWith(".receipt.json"))
      .sort()) {
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
      if (
        ["confirmed", "rejected"].includes(receipt.state) ||
        receipt.retryAt > Date.now()
      )
        continue;
      if (attempted++ === 20) break;
      await deliver(join(outbox, name), receiptPath, config);
    }
    await atomicJson(join(directory, "worker-status.json"), {
      checkedAt: new Date().toISOString(),
      partialTranscript: raw.partial,
      partialJournal: journal.partial,
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
    .enum(["--once", "--session", "--status", "--migrate", "--daemon"])
    .parse(process.argv[2]);
  const config = await readConfig();
  if (mode === "--session") {
    assert(process.argv[3]);
    await session(resolve(process.argv[3]), config);
    return;
  }
  if (mode === "--migrate") {
    for (const dir of await directories()) await migrate(dir);
    return;
  }
  if (mode === "--status") {
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
      console.log(
        JSON.stringify({
          session: record?.payload.conversationId,
          counts,
          ownerAlive: record?.owner ? ownerAlive(record.owner) : null,
          partialJournal: data.partial,
        }),
      );
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
  do {
    failures = 0;
    for (const dir of await directories()) {
      const child = spawn(
        process.execPath,
        [process.argv[1]!, "--session", dir],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      const [code] = await once(child, "exit");
      if (code !== 0) {
        failures++;
        console.error(
          `lmnr-antigravity worker_failed session=${basename(dir)} exit=${code}`,
        );
      }
    }
    if (mode !== "--daemon") break;
    if (running) await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (running);
  if (mode === "--once" && failures) process.exitCode = 1;
}
void main();
