// Worker lifecycle integration: real processes, disk journals and HTTP transport.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  utimes,
  cp,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

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
      a.value.stringValue ?? a.value.intValue ?? a.value.boolValue,
    ]),
  );
const handler = async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  assert.equal(req.headers.authorization, "Bearer synthetic");
  if (req.url === "/v1/sql/query") {
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
async function fixture(data = full(), baseUrl = url) {
  const dir = await mkdtemp(join(temp, "session-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  const base = {
    conversationId: randomUUID(),
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
    JSON.stringify({ baseUrl, projectApiKey: "synthetic", timeoutMs: 1000 }),
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
  console.log(`${count} worker lifecycle scenarios passed`);
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
