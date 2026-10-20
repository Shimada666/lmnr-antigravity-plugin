// Worker lifecycle integration: real processes, disk journals and HTTP transport.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
  rm,
  utimes,
  cp,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

const temp = await mkdtemp("/tmp/lmnr-worker-test-");
let action = "normal",
  received = 0,
  firstRequest;
const stored = new Map();
const bodySpans = (body) =>
  body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
const key = (s) => `${s.traceId}-${s.spanId}`;
const attributes = (s) =>
  Object.fromEntries(
    s.attributes.map((a) => [
      a.key,
      a.value.stringValue ??
        a.value.intValue ??
        a.value.boolValue ??
        a.value.doubleValue,
    ]),
  );
const handler = async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, "Bearer synthetic");
  if (req.url === "/v1/sql/query") {
    if (body.query.startsWith("SELECT trace_id, span_id, attributes")) {
      const uuid = (s) =>
        `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
      res.end(
        JSON.stringify({
          data: [...stored.values()]
            .map((v) => v.span)
            .filter(
              (span) =>
                attributes(span)["lmnr.span.type"] === "LLM" ||
                attributes(span)["antigravity.enrichment.type"] ===
                  "native_metadata",
            )
            .map((span) => ({
              trace_id: uuid(span.traceId),
              span_type: attributes(span)["lmnr.span.type"],
              span_id: uuid("0000000000000000" + span.spanId),
              end_ns: span.endTimeUnixNano,
              attributes: JSON.stringify(
                Object.fromEntries(
                  span.attributes.map((a) => [
                    a.key,
                    "intValue" in a.value
                      ? Number(a.value.intValue)
                      : (a.value.stringValue ??
                        a.value.doubleValue ??
                        a.value.boolValue),
                  ]),
                ),
              ),
            })),
        }),
      );
      return;
    }
    const sid = body.query
      .match(/span_id = '([0-9a-f-]+)'/)[1]
      .replaceAll("-", "")
      .slice(16);
    const tid = body.query
      .match(/trace_id = '([0-9a-f-]+)'/)[1]
      .replaceAll("-", "");
    res.end(
      JSON.stringify({
        data: [{ copies: stored.get(`${tid}-${sid}`)?.copies ?? 0 }],
      }),
    );
    return;
  }
  assert.equal(req.url, "/v1/traces");
  received++;
  const mode = action;
  action = "normal";
  if (mode === "429") {
    res.writeHead(429).end();
    return;
  }
  if (mode !== "lost-unaccepted")
    for (const span of bodySpans(body)) {
      const old = stored.get(key(span));
      stored.set(key(span), { span, copies: (old?.copies ?? 0) + 1 });
    }
  firstRequest?.();
  if (mode === "hold") return;
  if (mode.startsWith("lost")) {
    res.destroy();
    return;
  }
  if (mode === "partial") {
    res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 1 } }));
    return;
  }
  res.end("{}");
};
const server = createServer(handler);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const identity = (pid) => ({
  pid,
  bootId: boot,
  startTicks: readFileSync(`/proc/${pid}/stat`, "utf8")
    .split(") ")[1]
    .trim()
    .split(/\s+/)[19],
});
const owner = identity(process.pid);
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const row = (step_index, type, content, extra = {}) => ({
  step_index,
  type,
  content,
  source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL",
  status: "DONE",
  created_at: at(step_index),
  ...extra,
});
const ev = (n, event, extra = {}) => ({
  at: at(n),
  owner,
  payload: { event, ...extra },
});
const call = { name: "run_command", args: { CommandLine: "synthetic" } };
function full() {
  return {
    rows: [
      row(0, "USER_INPUT", "test"),
      row(1, "PLANNER_RESPONSE", "", {
        tool_calls: [call],
        input_tokens: 10,
        cache_read_tokens: 20,
        output_tokens: 3,
      }),
      row(2, "GENERIC", "tool result"),
      row(3, "PLANNER_RESPONSE", "done", {
        input_tokens: 20,
        cache_read_tokens: 0,
        output_tokens: 2,
      }),
    ],
    events: [
      ev(1, "PreInvocation", { initialNumSteps: 1, invocationNum: 0 }),
      ev(2, "PreToolUse", { stepIdx: 2, toolCall: call }),
      ev(3, "PostToolUse", { stepIdx: 2, toolCall: call, error: "" }),
      ev(4, "PostInvocation", { initialNumSteps: 1, invocationNum: 0 }),
      ev(5, "PreInvocation", { initialNumSteps: 3, invocationNum: 1 }),
      ev(6, "PostInvocation", { initialNumSteps: 3, invocationNum: 1 }),
      ev(7, "Stop", {
        fullyIdle: true,
        executionNum: 0,
        terminationReason: "NO_TOOL_CALL",
        error: "",
      }),
    ],
  };
}
async function fixture(data = full(), baseUrl = url, nativeTiming = false) {
  const dir = await mkdtemp(join(temp, "session-"));
  const conversationId = randomUUID();
  const transcriptPath = nativeTiming
    ? join(
        dir,
        "cli",
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      )
    : join(dir, "transcript.jsonl");
  await mkdir(dirname(transcriptPath), { recursive: true });
  const base = {
    conversationId,
    transcriptPath,
    workspacePaths: [dir],
    artifactDirectoryPath: dir,
    modelName: "synthetic",
  };
  const hash = createHash("sha256")
    .update(`${base.conversationId}\n${transcriptPath}\n${baseUrl}\nsynthetic`)
    .digest("hex");
  const root = join(dir, "state"),
    state = join(root, hash),
    config = join(dir, "config.json");
  await mkdir(state, { recursive: true });
  const records = data.events.map((e) => ({
    ...e,
    payload: { ...base, ...e.payload },
  }));
  await writeFile(
    config,
    JSON.stringify({
      baseUrl,
      projectApiKey: "synthetic",
      captureNativeTiming: nativeTiming,
      validateNativeSchema: false,
      timeoutMs: 1000,
    }),
  );
  await writeFile(
    join(state, "ledger.json"),
    JSON.stringify({ version: 3, importedThroughStep: -1 }),
  );
  await writeFile(
    join(state, "events.jsonl"),
    records.map(JSON.stringify).join("\n") + (records.length ? "\n" : ""),
  );
  await writeFile(
    transcriptPath,
    data.rows.map(JSON.stringify).join("\n") + "\n",
  );
  return { dir, root, state, config, base, rows: data.rows, events: records };
}
function launch(f, args = ["--session", f.state], hook) {
  const child = spawn(
    process.execPath,
    [resolve(hook ? "dist/hook.cjs" : "dist/worker.cjs"), ...args],
    {
      env: {
        ...process.env,
        LMNR_ANTIGRAVITY_CONFIG: f.config,
        LMNR_ANTIGRAVITY_STATE_DIR: f.root,
        LMNR_ANTIGRAVITY_OWNER_PID: String(process.pid),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(hook ? JSON.stringify({ ...f.base, ...hook }) : undefined);
  const done = once(child, "exit").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
  return { child, done };
}
async function run(f, ok = true, args) {
  const result = await launch(f, args).done;
  if (ok) assert.equal(result.code, 0, result.stderr);
  else assert.notEqual(result.code, 0);
  return result;
}
async function receipts(f) {
  const p = join(f.state, "outbox");
  return (await readdir(p))
    .filter((n) => n.endsWith(".receipt.json"))
    .map((n) => join(p, n));
}
async function due(f) {
  for (const p of await receipts(f)) {
    const r = JSON.parse(await readFile(p, "utf8"));
    r.retryAt = 0;
    await writeFile(p, JSON.stringify(r));
  }
}
const entries = () => [...stored.values()].map((v) => v.span);
const unique = () =>
  assert(
    [...stored.values()].every((v) => v.copies === 1),
    "No span can be counted twice",
  );
let count = 0;
const pass = (name) => {
  count++;
  console.log(`PASS: ${name}`);
};
try {
  let data = full();
  data.rows = data.rows.slice(0, 3);
  data.events = data.events.slice(0, 3);
  let f = await fixture(data);
  await run(f);
  assert.equal(stored.size, 2);
  assert(entries().every((s) => s.parentSpanId));
  pass("completed model and tool uploaded before PostInvocation or Stop");
  const finished = full();
  f.rows = finished.rows;
  await writeFile(
    f.base.transcriptPath,
    f.rows.map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    join(f.state, "events.jsonl"),
    finished.events
      .slice(0, 6)
      .map((e) =>
        JSON.stringify({ ...e, payload: { ...f.base, ...e.payload } }),
      )
      .join("\n") + "\n",
  );
  await run(f);
  assert.equal(stored.size, 3);
  assert(entries().every((s) => s.parentSpanId));
  await writeFile(
    join(f.state, "events.jsonl"),
    finished.events
      .map((e) =>
        JSON.stringify({ ...e, payload: { ...f.base, ...e.payload } }),
      )
      .join("\n") + "\n",
  );
  await run(f);
  await run(f);
  unique();
  assert.equal(stored.size, 4);
  assert.equal(entries().filter((s) => !s.parentSpanId).length, 1);
  assert.equal(
    entries().reduce(
      (n, s) => n + Number(attributes(s)["gen_ai.usage.input_tokens"] ?? 0),
      0,
    ),
    50,
  );
  pass("root finalized once; incremental uploads do not double token totals");
  stored.clear();
  received = 0;
  action = "lost-accepted";
  f = await fixture();
  await run(f, false);
  assert.equal(received, 1);
  await due(f);
  await run(f);
  await run(f);
  unique();
  assert.equal(received, 4);
  assert.equal(stored.size, 4);
  pass("lost acknowledgement reconciled without retransmission");
  stored.clear();
  received = 0;
  action = "lost-unaccepted";
  f = await fixture();
  await run(f, false);
  await due(f);
  await run(f);
  await due(f);
  await run(f);
  assert.equal(received, 4);
  assert.equal(stored.size, 3);
  const uncertain = await Promise.all(
    (await receipts(f)).map(async (p) => JSON.parse(await readFile(p, "utf8"))),
  );
  assert.equal(uncertain.filter((r) => r.state === "uncertain").length, 1);
  pass("ambiguous absent write stays visible and never blindly resends");
  stored.clear();
  received = 0;
  action = "429";
  f = await fixture();
  await run(f, false);
  await due(f);
  await run(f);
  await run(f);
  unique();
  assert.equal(received, 5);
  assert.equal(stored.size, 4);
  pass("definite rate-limit rejection retries automatically");
  stored.clear();
  received = 0;
  action = "partial";
  f = await fixture();
  await run(f, false);
  await due(f);
  await run(f);
  await run(f);
  unique();
  assert.equal(received, 4);
  pass("partial rejection reconciles accepted IDs without duplicates");
  stored.clear();
  received = 0;
  action = "hold";
  f = await fixture();
  let notify;
  const started = new Promise((r) => (notify = r));
  firstRequest = notify;
  const pending = launch(f);
  await started;
  pending.child.kill("SIGKILL");
  await pending.done;
  firstRequest = undefined;
  await utimes(`${f.state}.lock`, new Date(0), new Date(0));
  await run(f);
  await run(f);
  unique();
  assert.equal(stored.size, 4);
  assert.equal(received, 4);
  pass("worker SIGKILL after acceptance recovers sending receipt safely");
  stored.clear();
  received = 0;
  const closed = createServer(handler);
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  f = await fixture(full(), `http://127.0.0.1:${port}`);
  await run(f, false);
  const r0 = await Promise.all(
    (await receipts(f)).map(async (p) => JSON.parse(await readFile(p, "utf8"))),
  );
  assert(r0.some((r) => r.state === "ready" && r.attempts === 1));
  const reopened = createServer(handler);
  reopened.listen(port, "127.0.0.1");
  await once(reopened, "listening");
  try {
    await due(f);
    await run(f);
    await run(f);
    unique();
    assert.equal(stored.size, 4);
  } finally {
    reopened.closeAllConnections();
    await new Promise((r) => reopened.close(r));
  }
  pass("connection refusal retains payload and retries after service returns");
  stored.clear();
  const held = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  data = {
    rows: [row(0, "USER_INPUT", "unfinished")],
    events: [
      {
        ...ev(1, "PreInvocation", { initialNumSteps: 1, invocationNum: 0 }),
        owner: identity(held.pid),
      },
    ],
  };
  f = await fixture(data);
  await run(f);
  assert.equal(stored.size, 0);
  held.kill("SIGSTOP");
  await run(f);
  assert.equal(stored.size, 0);
  held.kill("SIGCONT");
  held.kill("SIGKILL");
  await once(held, "exit");
  await run(f);
  await run(f);
  unique();
  assert.equal(stored.size, 2);
  assert(entries().every((s) => s.status.code === 2));
  assert(
    entries().every(
      (s) => attributes(s)["gen_ai.usage.input_tokens"] === undefined,
    ),
  );
  pass(
    "quiet and stopped processes stay active; actual process death recovers incomplete spans",
  );
  stored.clear();
  data = {
    rows: [row(0, "USER_INPUT", "reused pid")],
    events: [
      {
        ...ev(1, "PreInvocation", { initialNumSteps: 1, invocationNum: 0 }),
        owner: { ...owner, startTicks: String(BigInt(owner.startTicks) + 1n) },
      },
    ],
  };
  f = await fixture(data);
  await run(f);
  assert.equal(stored.size, 2);
  pass("PID reuse cannot impersonate the original process");
  stored.clear();
  data.events[0].owner = { ...owner, bootId: randomUUID() };
  f = await fixture(data);
  await run(f);
  assert.equal(stored.size, 2);
  pass("host reboot identity recovers prior-boot calls");
  stored.clear();
  const beforeNative = received;
  f = await fixture({
    rows: [row(0, "USER_INPUT", "native hook")],
    events: [],
  });
  const h = await launch(f, ["PreInvocation"], {
    initialNumSteps: 1,
    invocationNum: 0,
  }).done;
  assert.equal(h.code, 0, h.stderr);
  assert.deepEqual(JSON.parse(h.stdout), {});
  const journal = JSON.parse(
    (await readFile(join(f.state, "events.jsonl"), "utf8")).trim(),
  );
  assert.deepEqual(journal.owner, owner);
  assert.equal(received, beforeNative);
  pass("native hook persists owner identity without making HTTP requests");
  await writeFile(join(f.state, "events.jsonl"), '{"torn":', { flag: "a" });
  const repaired = await launch(f, ["PreInvocation"], {
    initialNumSteps: 1,
    invocationNum: 0,
  }).done;
  assert.equal(repaired.code, 0, repaired.stderr);
  const repairedRows = (await readFile(join(f.state, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(repairedRows.length, 2);
  assert.equal(repairedRows[1].journalRecovery.bytes, 8);
  const fragment = JSON.parse(
    await readFile(
      join(
        f.state,
        `torn-journal-${repairedRows[1].journalRecovery.fragmentHash}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(Buffer.from(fragment.base64, "base64").toString(), '{"torn":');
  pass(
    "torn journal tail is preserved before the next hook repairs append boundary",
  );

  stored.clear();
  f = await fixture();
  await rm(join(f.state, "ledger.json"));
  await writeFile(
    join(f.state, "checkpoint.json"),
    JSON.stringify({ throughStep: 3 }),
  );
  await writeFile(
    join(f.state, "events.jsonl"),
    f.events.map(({ owner, ...rest }) => JSON.stringify(rest)).join("\n") +
      "\n",
  );
  await run(f, true, ["--migrate"]);
  await run(f);
  assert.equal(stored.size, 0);
  assert.equal(
    JSON.parse(await readFile(join(f.state, "ledger.json"), "utf8"))
      .importedThroughStep,
    3,
  );
  pass("explicit migration preserves already-uploaded v0.2 history");
  stored.clear();
  const bad = await fixture();
  bad.rows[1].type = "UNSUPPORTED";
  await writeFile(
    bad.base.transcriptPath,
    bad.rows.map(JSON.stringify).join("\n") + "\n",
  );
  const good = await fixture();
  await cp(good.state, join(bad.root, good.state.split("/").at(-1)), {
    recursive: true,
  });
  await run(bad, false, ["--once"]);
  assert.equal(stored.size, 4);
  pass("one corrupt session cannot starve other sessions");
  stored.clear();
  const nativeData = full();
  nativeData.rows[1].thinking = "Synthetic visible thinking";
  f = await fixture(nativeData, url, true);
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(join(f.dir, "cli", "conversations"));
  const nativeDb = new DatabaseSync(
    join(f.dir, "cli", "conversations", `${f.base.conversationId}.db`),
  );
  nativeDb.exec(
    "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)",
  );
  nativeDb
    .prepare("INSERT INTO gen_metadata VALUES (?, ?)")
    .run(0, Buffer.from("120101", "hex"));
  await run(f);
  assert.equal(
    entries().filter((s) => attributes(s)["lmnr.span.type"] === "LLM").length,
    0,
  );
  assert.equal(
    JSON.parse(await readFile(join(f.state, "worker-status.json"), "utf8"))
      .pendingNativeTiming,
    2,
  );
  // Independently encoded protobuf fixtures: 125 ms / 750 ms, then 0 s / 1 s.
  const insertMetadata = nativeDb.prepare(
    "INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)",
  );
  insertMetadata.run(
    0,
    Buffer.from("0a0f5a0510c0b2cd3b62061080afd0e502120101", "hex"),
  );
  insertMetadata.run(1, Buffer.from("0a065a0062020801120103", "hex"));
  // Include a native request snapshot independent of the visible turn transcript.
  const varint = (n) => {
    const bytes = [];
    do {
      bytes.push((n & 127) | (n > 127 ? 128 : 0));
      n >>>= 7;
    } while (n);
    return Buffer.from(bytes);
  };
  const wire = (field, bytes) =>
    Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
  const stringField = (field, value) => wire(field, Buffer.from(value));
  const nativePrompt = Buffer.concat([
    Buffer.from([16, 1]),
    stringField(3, "Earlier user context not in this transcript turn"),
  ]);
  const nativeTool = Buffer.concat([
    stringField(1, "native_tool"),
    stringField(2, "Synthetic tool definition"),
    stringField(3, '{"type":"object"}'),
  ]);
  const nativeChat = Buffer.concat([
    stringField(1, "Synthetic native system instruction"),
    wire(2, nativePrompt),
    wire(8, nativeTool),
    Buffer.from("5a0510c0b2cd3b62061080afd0e502", "hex"),
  ]);
  insertMetadata.run(
    0,
    Buffer.concat([wire(1, nativeChat), Buffer.from("120101", "hex")]),
  );
  nativeDb.close();
  await run(f);
  const nativeModels = entries()
    .filter((s) => attributes(s)["lmnr.span.type"] === "LLM")
    .sort(
      (a, b) =>
        Number(attributes(a)["antigravity.step_index"]) -
        Number(attributes(b)["antigravity.step_index"]),
    );
  assert.equal(nativeModels.length, 2);
  const firstNative = attributes(nativeModels[0]),
    secondNative = attributes(nativeModels[1]);
  assert.equal(firstNative["antigravity.llm.ttft_seconds"], 0.125);
  assert.equal(firstNative["antigravity.llm.streaming_duration_seconds"], 0.75);
  assert.equal(firstNative["antigravity.user_turn_first_call"], true);
  assert.equal(secondNative["antigravity.llm.ttft_seconds"], 0);
  assert.equal(secondNative["antigravity.llm.streaming_duration_seconds"], 1);
  assert.equal(secondNative["antigravity.user_turn_first_call"], false);
  assert.equal(
    JSON.parse(firstNative["gen_ai.output.messages"])[0].parts[0].type,
    "thinking",
  );
  assert(
    !secondNative["gen_ai.input.messages"].includes(
      "Synthetic visible thinking",
    ),
  );
  await run(f);
  unique();
  assert.equal(entries().length, 4);
  pass(
    "native SQLite timing waits for metadata, preserves fractional/zero durations and exports thinking separately without duplicates",
  );
  const snapshotInput = JSON.parse(firstNative["gen_ai.input.messages"]);
  assert.equal(snapshotInput[0].role, "system");
  assert.equal(snapshotInput[0].content, "Synthetic native system instruction");
  assert.equal(
    snapshotInput[1].content,
    "Earlier user context not in this transcript turn",
  );
  assert.equal(
    JSON.parse(firstNative["gen_ai.tool.definitions"])[0].name,
    "native_tool",
  );
  assert.equal(
    firstNative["antigravity.input_source"],
    "cli_sqlite_request_snapshot",
  );
  assert.equal(
    firstNative["antigravity.llm.answer_ttft_status"],
    "not_exposed_by_cli",
  );
  assert.equal(
    firstNative["antigravity.cost.status"],
    "billing_amount_not_exposed_by_cli",
  );
  pass(
    "native request snapshot supplies system/history/tools with explicit metric availability",
  );
  const tokensBefore = entries().reduce(
    (n, s) =>
      n +
      Number(attributes(s)["gen_ai.usage.input_tokens"] ?? 0) +
      Number(attributes(s)["gen_ai.usage.output_tokens"] ?? 0),
    0,
  );
  for (const value of stored.values())
    if (attributes(value.span)["lmnr.span.type"] === "LLM")
      value.span.attributes = value.span.attributes.filter(
        (a) => !a.key.startsWith("antigravity.llm."),
      );
  await run(f, true, ["--backfill", f.state]);
  await run(f);
  unique();
  assert.equal(entries().length, 6);
  assert.equal(
    entries().filter((s) => attributes(s)["lmnr.span.type"] === "LLM").length,
    2,
  );
  assert.equal(
    entries().reduce(
      (n, s) =>
        n +
        Number(attributes(s)["gen_ai.usage.input_tokens"] ?? 0) +
        Number(attributes(s)["gen_ai.usage.output_tokens"] ?? 0),
      0,
    ),
    tokensBefore,
  );
  assert.equal(
    entries().filter(
      (s) => attributes(s)["antigravity.enrichment.type"] === "native_metadata",
    ).length,
    2,
  );
  await run(f, true, ["--backfill", f.state]);
  unique();
  assert.equal(entries().length, 6);
  pass(
    "historical enrichment is repeatable without new LLM calls or duplicate token totals",
  );

  stored.clear();
  f = await fixture(full(), url, true);
  await mkdir(join(f.dir, "cli", "conversations"));
  const absentDb = new DatabaseSync(
    join(f.dir, "cli", "conversations", `${f.base.conversationId}.db`),
  );
  absentDb.exec(
    "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)",
  );
  absentDb.close();
  await run(f);
  const waitFile = join(f.state, "native-waits.json");
  const waiting = JSON.parse(await readFile(waitFile, "utf8"));
  assert.equal(Object.keys(waiting).length, 2);
  for (const id of Object.keys(waiting)) waiting[id] = Date.now() - 120001;
  await writeFile(waitFile, JSON.stringify(waiting));
  await run(f);
  assert.equal(entries().length, 4);
  for (const span of entries().filter(
    (s) => attributes(s)["lmnr.span.type"] === "LLM",
  )) {
    assert.equal(
      attributes(span)["antigravity.llm.timing_status"],
      "not_recorded",
    );
    assert.equal(
      attributes(span)["antigravity.llm.timing_unavailable_reason"],
      "native_metadata_wait_expired",
    );
  }
  pass(
    "missing native timing has a bounded wait and cannot hold the original turn forever",
  );

  // An appended turn must not rebuild/reupload the completed turn; only new bytes are read.
  stored.clear();
  f = await fixture();
  await run(f);
  await run(f);
  const extraRows = [
    row(4, "USER_INPUT", "second turn"),
    row(5, "PLANNER_RESPONSE", "second answer", {
      input_tokens: 2,
      cache_read_tokens: 0,
      output_tokens: 1,
    }),
  ];
  const extraEvents = [
    ev(8, "PreInvocation", { initialNumSteps: 5, invocationNum: 0 }),
    ev(9, "PostInvocation", { initialNumSteps: 5, invocationNum: 0 }),
    ev(10, "Stop", {
      fullyIdle: true,
      executionNum: 1,
      terminationReason: "NO_TOOL_CALL",
    }),
  ].map((e) => ({ ...e, payload: { ...f.base, ...e.payload } }));
  await appendFile(
    f.base.transcriptPath,
    extraRows.map(JSON.stringify).join("\n") + "\n",
  );
  await appendFile(
    join(f.state, "events.jsonl"),
    extraEvents.map(JSON.stringify).join("\n") + "\n",
  );
  await run(f);
  await run(f);
  unique();
  assert.equal(entries().length, 6);
  let status = JSON.parse(
    await readFile(join(f.state, "worker-status.json"), "utf8"),
  );
  assert(status.sourceBytesRead <= 512);
  assert.equal(status.bufferedRows, 2);
  pass(
    "byte cursors export an appended turn once and discard completed history",
  );
  const original = await readFile(f.base.transcriptPath, "utf8");
  await writeFile(
    f.base.transcriptPath,
    original.replace("second answer", "edited answer"),
  );
  const changedSource = await run(f, false);
  assert(changedSource.stderr.includes("Committed source bytes changed"));
  pass(
    "mutated committed source fails visibly instead of silently skipping changed bytes",
  );
  await writeFile(f.base.transcriptPath, original);
  const daemon = launch(f, ["--daemon"]);
  await new Promise((r) => setTimeout(r, 4000));
  const checked = JSON.parse(
    await readFile(join(f.state, "worker-status.json"), "utf8"),
  ).checkedAt;
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(
    JSON.parse(await readFile(join(f.state, "worker-status.json"), "utf8"))
      .checkedAt,
    checked,
  );
  await run(f, true, ["--health"]);
  daemon.child.kill("SIGTERM");
  await daemon.done;
  pass(
    "idle daemon skips unchanged sessions while maintaining a healthy heartbeat",
  );
  console.log(`${count} worker lifecycle scenarios passed`);
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
