import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "lmnr-regression-"));
const requests = [];
const stored = new Map();
const owner = {
  pid: process.pid,
  startTicks: readFileSync(`/proc/${process.pid}/stat`, "utf8")
    .split(") ")[1]
    .split(" ")[19],
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
};
let httpStatus = 200;
let httpBody = "{}";
let httpDelay = 0;
let uploadGate;
let requestStarted;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const decoded = JSON.parse(body);
  if (request.url === "/v1/sql/query") {
    const sid = decoded.query
      .match(/span_id = '([0-9a-f-]+)'/)[1]
      .replaceAll("-", "")
      .slice(16);
    const tid = decoded.query
      .match(/trace_id = '([0-9a-f-]+)'/)[1]
      .replaceAll("-", "");
    response.end(
      JSON.stringify({ data: [{ copies: stored.get(`${tid}-${sid}`) ?? 0 }] }),
    );
    return;
  }
  assert.equal(request.url, "/v1/traces");
  requests.push(decoded);
  if (httpStatus === 200)
    for (const r of decoded.resourceSpans)
      for (const scope of r.scopeSpans)
        for (const span of scope.spans) {
          const k = `${span.traceId}-${span.spanId}`;
          stored.set(k, (stored.get(k) ?? 0) + 1);
        }
  requestStarted?.();
  if (uploadGate) await uploadGate;
  if (httpDelay) await new Promise((r) => setTimeout(r, httpDelay));
  response.writeHead(httpStatus).end(httpBody);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const config = join(directory, "config.json");
await writeFile(
  config,
  JSON.stringify({ baseUrl, projectApiKey: "synthetic", timeoutMs: 1000 }),
);
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const row = (step_index, type, content, extra = {}) => ({
  step_index,
  type,
  content,
  source:
    type === "USER_INPUT"
      ? "USER_EXPLICIT"
      : ["SYSTEM_MESSAGE", "CHECKPOINT", "ERROR_MESSAGE"].includes(type)
        ? "SYSTEM"
        : "MODEL",
  status: "DONE",
  created_at: at(step_index),
  ...extra,
});
const call = { name: "run_command", args: { CommandLine: "synthetic" } };
const event = (n, event, extra = {}) => ({
  at: at(n),
  payload: { event, ...extra },
});
const pre = (n, initialNumSteps, invocationNum = 0) =>
  event(n, "PreInvocation", { initialNumSteps, invocationNum });
const post = (n, initialNumSteps, invocationNum = 0) =>
  event(n, "PostInvocation", { initialNumSteps, invocationNum });
const stop = (n, extra = {}) =>
  event(n, "Stop", {
    executionNum: 0,
    fullyIdle: true,
    terminationReason: "NO_TOOL_CALL",
    error: "",
    ...extra,
  });
const toolPre = (n, stepIdx, toolCall = call) =>
  event(n, "PreToolUse", { stepIdx, toolCall });
const toolPost = (n, stepIdx, error = "", toolCall = call) =>
  event(n, "PostToolUse", { stepIdx, toolCall, error });
function fixture() {
  return {
    rows: [
      row(0, "USER_INPUT", "test"),
      row(1, "PLANNER_RESPONSE", "", {
        tool_calls: [call],
        input_tokens: 10,
        cache_read_tokens: 20,
        output_tokens: 3,
      }),
      row(2, "GENERIC", "output"),
      row(3, "PLANNER_RESPONSE", "complete"),
    ],
    events: [
      pre(1, 1),
      toolPre(2, 2),
      toolPost(3, 2),
      post(4, 1),
      pre(5, 3, 1),
      post(6, 3, 1),
      stop(7),
    ],
  };
}
const attr = (s, key) => {
  const v = s.attributes.find((a) => a.key === key)?.value;
  return v?.stringValue ?? v?.intValue ?? v?.boolValue;
};
let count = 0;
async function run(name, data, verify, failure) {
  const work = join(directory, String(count++));
  await mkdir(work);
  const transcriptPath = join(work, "transcript.jsonl");
  const base = {
    conversationId: "12345678-1234-4234-8234-123456789012",
    transcriptPath,
    artifactDirectoryPath: work,
    workspacePaths: [work],
    modelName: "synthetic",
  };
  const records = data.events.map((e) => ({
    owner,
    at: e.at,
    payload: { ...base, ...e.payload },
  }));
  const journal = records.map(JSON.stringify).join("\n") + "\n";
  const key = createHash("sha256")
    .update(`${base.conversationId}\n${transcriptPath}\n${baseUrl}\nsynthetic`)
    .digest("hex");
  const state = join(work, "state", key);
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "ledger.json"),
    JSON.stringify({ version: 3, importedThroughStep: -1 }),
  );
  stored.clear();
  await writeFile(join(state, "events.jsonl"), journal);
  await writeFile(
    transcriptPath,
    data.rows.map(JSON.stringify).join("\n") +
      (data.partial ? '\n{"step_index":' : "\n"),
  );
  if (data.checkpoint !== undefined)
    await writeFile(
      join(state, "checkpoint.json"),
      JSON.stringify({ throughStep: data.checkpoint }),
    );
  const payload = records.findLast(
    (e) => e.payload.event === "Stop" && e.payload.fullyIdle,
  ).payload;
  async function invoke(event = "Stop", input = payload) {
    const child = spawn(
      process.execPath,
      event === "Stop"
        ? [resolve("dist/worker.cjs"), "--session", state]
        : [resolve("dist/hook.cjs"), event],
      {
        env: {
          ...process.env,
          LMNR_ANTIGRAVITY_OWNER_PID: String(process.pid),
          LMNR_ANTIGRAVITY_CONFIG: config,
          LMNR_ANTIGRAVITY_STATE_DIR: join(work, "state"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.resume();
    child.stdin.end(JSON.stringify(input));
    const [code] = await once(child, "exit");
    return { code, stderr };
  }
  await writeFile(
    config,
    JSON.stringify({
      baseUrl,
      projectApiKey: "synthetic",
      timeoutMs: data.timeoutMs ?? 1000,
    }),
  );
  const before = requests.length;
  httpStatus = data.httpStatus ?? 200;
  httpBody = data.httpBody ?? "{}";
  httpDelay = data.httpDelay ?? 0;
  let releaseUpload;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  uploadGate = data.captureDuringUpload
    ? new Promise((resolve) => {
        releaseUpload = resolve;
      })
    : undefined;
  if (data.captureDuringUpload)
    await writeFile(
      config,
      JSON.stringify({ baseUrl, projectApiKey: "synthetic", timeoutMs: 5000 }),
    );
  const pending = Promise.all(
    Array.from({ length: data.parallel ?? 1 }, () => invoke()),
  );
  if (data.captureDuringUpload) {
    await started;
    try {
      const captured = await invoke("PreInvocation", {
        ...base,
        initialNumSteps: 100,
        invocationNum: 0,
      });
      assert.equal(captured.code, 0, captured.stderr);
      // The upload is still blocked here: event capture must be independent.
    } finally {
      releaseUpload();
    }
  }
  const results = await pending;
  uploadGate = undefined;
  requestStarted = undefined;
  await writeFile(
    config,
    JSON.stringify({ baseUrl, projectApiKey: "synthetic", timeoutMs: 1000 }),
  );
  const result = results[0];
  if (!failure) for (const r of results) assert.equal(r.code, 0, r.stderr);
  const afterJournal = await readFile(join(state, "events.jsonl"), "utf8");
  if (data.captureDuringUpload) {
    assert(afterJournal.startsWith(journal));
    assert.equal(afterJournal.trim().split("\n").length, records.length + 1);
  } else
    assert.equal(
      afterJournal,
      journal,
      "Replay must not append a fabricated Stop",
    );
  if (failure) {
    assert.notEqual(result.code, 0, name);
    assert.match(result.stderr, failure);
    assert.equal(requests.length, before + (data.delivery ? 1 : 0));
    if (data.checkpoint === undefined)
      assert(!(await readdir(state)).includes("checkpoint.json"));
  } else {
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    const spans = requests
      .slice(before)
      .flatMap((r) => r.resourceSpans[0].scopeSpans[0].spans);
    for (const s of spans) {
      assert(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
      assert.equal(s.events.length, s.status.code === 2 ? 1 : 0);
      if (s.status.code === 2) {
        assert.equal(s.events[0].name, "exception");
        assert.equal(attr(s.events[0], "exception.message"), s.status.message);
      }
    }
    verify(spans);
    const after = requests.length;
    assert.equal((await invoke()).code, 0);
    assert.equal(
      requests.length,
      after,
      "Second replay must not send duplicates",
    );
  }
  console.log(`PASS: ${name}`);
}
try {
  let f = fixture();
  f.rows[2].status = "RUNNING";
  await run(
    "background dispatch retains RUNNING and hook duration",
    f,
    (spans) => {
      const t = spans.find((s) => s.name === call.name);
      assert.equal(attr(t, "antigravity.tool_scope"), "background_dispatch");
      assert.equal(t.status.code, 1);
    },
  );
  for (const status of ["ERROR", "INVALID"]) {
    f = fixture();
    f.rows[2].status = status;
    f.rows[2].error = "explicit tool failure";
    await run(`${status} tool with hooks`, f, (spans) =>
      assert.equal(spans.find((s) => s.name === call.name).status.code, 2),
    );
    f.events = f.events.filter(
      (e) => !["PreToolUse", "PostToolUse"].includes(e.payload.event),
    );
    await run(`${status} rejected before tool hooks`, f, (spans) => {
      const t = spans.find((s) => s.name === call.name);
      assert.equal(t.status.code, 2);
      assert.equal(
        attr(t, "antigravity.timing_source"),
        "transcript_timestamp_only",
      );
    });
  }
  // Large unobserved history is validated only as an envelope, not as new work.
  f = fixture();
  f.rows = [
    ...Array.from({ length: 2000 }, (_, i) =>
      row(i, "HISTORIC_FORMAT", "old", {
        status: "HISTORIC_STATUS",
        created_at: at(0),
      }),
    ),
    ...f.rows.map((r) => ({ ...r, step_index: r.step_index + 2000 })),
  ];
  f.events = f.events.map((e) => ({
    ...e,
    payload: {
      ...e.payload,
      ...(e.payload.initialNumSteps !== undefined
        ? { initialNumSteps: e.payload.initialNumSteps + 2000 }
        : {}),
      ...(e.payload.stepIdx !== undefined
        ? { stepIdx: e.payload.stepIdx + 2000 }
        : {}),
    },
  }));
  await run("2000 historical rows cannot block observed turn", f, (spans) =>
    assert.equal(spans.length, 4),
  );
  for (const type of ["SYSTEM_MESSAGE", "CHECKPOINT", "ERROR_MESSAGE"]) {
    f = fixture();
    f.rows[3] = row(
      3,
      type,
      type === "ERROR_MESSAGE" ? undefined : "system context",
      type === "ERROR_MESSAGE" ? { error: "transient API error" } : {},
    );
    f.rows.push(row(4, "PLANNER_RESPONSE", "complete"));
    f.events[4].payload.initialNumSteps = 4;
    f.events[5].payload.initialNumSteps = 4;
    await run(
      `${type} is visible to following model even before PreInvocation`,
      f,
      (spans) =>
        assert.match(
          attr(
            spans.find((s) => s.name === "LLM 2"),
            "gen_ai.input.messages",
          ),
          /system context|transient API error/,
        ),
    );
  }
  f = fixture();
  f.rows.push(
    row(4, "USER_INPUT", "next", { created_at: at(8) }),
    row(5, "PLANNER_RESPONSE", "unfinished", {
      created_at: at(9),
      status: "RUNNING",
    }),
  );
  f.events.push(pre(9, 5));
  await run("replay excludes a live next invocation", f, (spans) =>
    assert.equal(spans.length, 4),
  );
  f = fixture();
  f.rows.push(row(4, "USER_INPUT", "queued", { created_at: at(7) }));
  await run(
    "queued input at Stop timestamp does not block previous turn",
    f,
    (spans) => assert.equal(spans.length, 4),
  );
  f = fixture();
  f.events.splice(3, 0, stop(4, { fullyIdle: false }));
  await run("non-idle Stop does not finish background turn", f, (spans) =>
    assert.equal(
      spans.find((s) => !s.parentSpanId).endTimeUnixNano,
      (BigInt(Date.parse(at(7))) * 1000000n).toString(),
    ),
  );
  for (const terminationReason of [
    "USER_CANCELED",
    "ERROR",
    "MAX_INVOCATIONS",
  ]) {
    f = {
      rows: [row(0, "USER_INPUT", "test")],
      events: [pre(1, 1), stop(2, { terminationReason })],
    };
    await run(
      `${terminationReason} before first model response`,
      f,
      (spans) => {
        assert.equal(spans.length, 2);
        assert(spans.every((s) => s.status.code === 2));
        assert.equal(
          attr(
            spans.find((s) => s.parentSpanId),
            "gen_ai.usage.input_tokens",
          ),
          undefined,
        );
      },
    );
  }
  f = fixture();
  f.rows = f.rows.slice(0, 3);
  f.events = [
    pre(1, 1),
    toolPre(2, 2),
    stop(5, { terminationReason: "USER_CANCELED" }),
  ];
  await run(
    "cancelled tool preserves completed model and interrupted tool",
    f,
    (spans) => {
      assert.equal(
        spans.find((s) => attr(s, "lmnr.span.type") === "LLM").status.code,
        1,
      );
      assert.equal(
        spans.find((s) => attr(s, "lmnr.span.type") === "TOOL").status.code,
        2,
      );
    },
  );
  f = fixture();
  f.rows[1].tool_calls.push({ name: "read_file", args: { Path: "synthetic" } });
  f.rows.splice(3, 0, row(3, "GENERIC", "second tool"));
  f.rows[4].step_index = 4;
  f.events = [
    pre(1, 1),
    toolPre(2, 2),
    toolPre(2, 3, f.rows[1].tool_calls[1]),
    toolPost(3, 3, "", f.rows[1].tool_calls[1]),
    toolPost(4, 2),
    post(5, 1),
    pre(6, 4, 1),
    post(7, 4, 1),
    stop(8),
  ];
  await run(
    "parallel tools pair by step despite reversed completion",
    f,
    (spans) =>
      assert.equal(
        spans.filter((s) => attr(s, "lmnr.span.type") === "TOOL").length,
        2,
      ),
  );
  f = fixture();
  f.rows[2].status = "FUTURE_STATUS";
  await run("unknown current status fails visibly", f, null, /Invalid/);
  f = fixture();
  f.rows[2].type = "FUTURE_TYPE";
  await run("unknown current type fails visibly", f, null, /Invalid/);
  f = fixture();
  f.events = f.events.filter((e) => e.payload.event !== "PostToolUse");
  await run(
    "missing successful tool hook is not silently skipped",
    f,
    null,
    /Missing PostToolUse/,
  );
  f = fixture();
  f.events[1].payload.toolCall = { name: "wrong_tool", args: {} };
  await run("tool-call content mismatch fails", f, null, /deep-equal/);
  f = fixture();
  f.events = f.events.filter(
    (e) =>
      !(e.payload.event === "PreInvocation" && e.payload.initialNumSteps === 3),
  );
  await run(
    "missing model hook cannot borrow a prior invocation",
    f,
    null,
    /Multiple model responses/,
  );
  f = fixture();
  f.partial = true;
  await run(
    "partial trailing line preserves complete records with explicit flag",
    f,
    (spans) =>
      assert.equal(
        attr(
          spans.find((s) => !s.parentSpanId),
          "antigravity.partial_transcript",
        ),
        true,
      ),
  );
  f = fixture();
  f.rows[2].status = "ERROR";
  await run(
    "error status requires its actual error",
    f,
    null,
    /retain its error/,
  );
  f = fixture();
  f.rows[1].cache_read_tokens = undefined;
  await run(
    "token normalization cannot invent missing cache count",
    f,
    null,
    /cache counter/,
  );
  for (const httpStatus of [401, 429, 503]) {
    f = fixture();
    Object.assign(f, { httpStatus, delivery: true });
    await run(`HTTP ${httpStatus} never advances checkpoint`, f, null, /HTTP/);
  }
  f = fixture();
  Object.assign(f, { httpBody: "not json", delivery: true });
  await run(
    "malformed OTLP response never advances checkpoint",
    f,
    null,
    /JSON/,
  );
  f = fixture();
  Object.assign(f, { httpDelay: 400, timeoutMs: 100, delivery: true });
  await run("network timeout retains pending payload", f, null, /Timeout/);
  f = fixture();
  f.parallel = 8;
  await run("eight concurrent retries produce one upload", f, (spans) =>
    assert.equal(spans.length, 4),
  );
  f = fixture();
  f.captureDuringUpload = true;
  await run(
    "event capture continues while HTTP upload is blocked",
    f,
    (spans) => assert.equal(spans.length, 4),
  );
  console.log(`${count} regression scenarios passed`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
