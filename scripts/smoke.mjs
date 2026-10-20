// End-to-end protocol exercise: real hook processes and a local OTLP receiver.
// Synthetic data mirrors the wire format observed in agy 1.4.2.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "lmnr-agy-smoke-"));
const requests = [];
let status = 503;
let responseBody = "{}";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  assert.equal(request.url, "/v1/traces");
  assert.equal(request.headers.authorization, "Bearer synthetic-test-key");
  requests.push(JSON.parse(body));
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(responseBody);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const configPath = join(directory, "config.json");
const transcriptPath = join(directory, "transcript_full.jsonl");
const stateRoot = join(directory, "state");
const base = {
  conversationId: "12345678-1234-4234-8234-123456789012",
  transcriptPath,
  artifactDirectoryPath: directory,
  workspacePaths: [directory],
  modelName: "synthetic-model",
};
const stop = {
  executionNum: 0,
  terminationReason: "NO_TOOL_CALL",
  fullyIdle: true,
  error: "",
};
const call = { name: "read_file", args: { Path: "/synthetic/probe.txt" } };
const now = new Date().toISOString();
const rows = [
  {
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: now,
    content: "Read the synthetic probe.",
  },
  {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: now,
    input_tokens: 100,
    cache_read_tokens: 20,
    output_tokens: 10,
    tool_calls: [call],
  },
  {
    step_index: 2,
    source: "MODEL",
    type: "GENERIC",
    status: "DONE",
    created_at: now,
    content: "LMNR_SMOKE_OK",
  },
  {
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: now,
    input_tokens: 120,
    cache_read_tokens: 30,
    output_tokens: 8,
    content: "LMNR_SMOKE_OK",
  },
];
async function hook(event, details) {
  const child = spawn(process.execPath, [resolve("dist/hook.cjs"), event], {
    env: {
      ...process.env,
      LMNR_ANTIGRAVITY_CONFIG: configPath,
      LMNR_ANTIGRAVITY_STATE_DIR: stateRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify({ ...base, ...details }));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}
async function ok(event, details) {
  const result = await hook(event, details);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    event === "PreToolUse"
      ? { decision: "allow" }
      : event === "Stop"
        ? { decision: "stop" }
        : {},
  );
}
async function saveTranscript() {
  await writeFile(
    transcriptPath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}
try {
  await writeFile(
    configPath,
    JSON.stringify({
      projectApiKey: "synthetic-test-key",
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  await saveTranscript();
  await ok("PreInvocation", { invocationNum: 0, initialNumSteps: 1 });
  await ok("PreToolUse", { stepIdx: 2, toolCall: call });
  await ok("PostToolUse", { stepIdx: 2, toolCall: call, error: "" });
  await ok("PostInvocation", { invocationNum: 0, initialNumSteps: 1 });
  await ok("PreInvocation", { invocationNum: 1, initialNumSteps: 3 });
  await ok("PostInvocation", { invocationNum: 1, initialNumSteps: 3 });
  assert.notEqual((await hook("Stop", stop)).code, 0, "503 must fail visibly");
  const stateDir = join(stateRoot, (await readdir(stateRoot))[0]);
  assert((await readdir(stateDir)).includes("pending.json"));
  assert(!(await readdir(stateDir)).includes("checkpoint.json"));
  status = 200;
  responseBody = JSON.stringify({
    partialSuccess: { rejectedSpans: "1", errorMessage: "synthetic rejection" },
  });
  assert.notEqual(
    (await hook("Stop", stop)).code,
    0,
    "Partial rejection must not checkpoint",
  );
  assert(!(await readdir(stateDir)).includes("checkpoint.json"));
  responseBody = "{}";
  await ok("Stop", stop);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests[0],
    requests[2],
    "Retry must preserve exact request and span IDs",
  );
  assert.equal(
    JSON.parse(await readFile(join(stateDir, "checkpoint.json"), "utf8"))
      .throughStep,
    3,
  );
  const spans = requests[2].resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 4);
  const root = spans.find((span) => !span.parentSpanId);
  assert(root);
  for (const span of spans.filter((span) => span !== root)) {
    assert.equal(span.parentSpanId, root.spanId);
    assert.equal(span.traceId, root.traceId);
    assert(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
  }
  const tool = spans.find((span) => span.name === "read_file");
  assert(
    tool.attributes.some(
      (a) =>
        a.key === "lmnr.span.output" &&
        a.value.stringValue.includes("LMNR_SMOKE_OK"),
    ),
  );
  const firstModel = spans.find((span) => span.name === "LLM 1");
  assert.equal(
    firstModel.attributes.find((a) => a.key === "gen_ai.usage.input_tokens")
      .value.intValue,
    "120",
  );
  assert.equal(
    firstModel.attributes.find(
      (a) => a.key === "gen_ai.usage.cache_read_input_tokens",
    ).value.intValue,
    "20",
  );
  assert.equal(
    firstModel.endTimeUnixNano,
    tool.startTimeUnixNano,
    "Model span must not include tool duration",
  );
  await ok("Stop", stop);
  assert.equal(requests.length, 3, "Repeated Stop must not re-export");

  // Resume the same conversation for another turn without replaying turn one.
  const later = new Date().toISOString();
  rows.push(
    {
      step_index: 4,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: later,
      content: "Say SECOND.",
    },
    {
      step_index: 5,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: later,
      content: "Session resumed.",
    },
    {
      step_index: 6,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: later,
      content: "SECOND",
      input_tokens: 50,
      cache_read_tokens: 0,
      output_tokens: 2,
    },
  );
  await saveTranscript();
  await ok("PreInvocation", { invocationNum: 2, initialNumSteps: 5 });
  await ok("PostInvocation", { invocationNum: 2, initialNumSteps: 5 });
  await ok("Stop", { ...stop, executionNum: 1 });
  assert.equal(requests.length, 4);
  const resumed = requests[3].resourceSpans[0].scopeSpans[0].spans;
  assert.equal(resumed.length, 2);
  assert.notEqual(resumed[0].traceId, root.traceId);

  rows.push({
    step_index: 7,
    source: "MODEL",
    type: "UNRECOGNIZED_STEP",
    status: "DONE",
    created_at: later,
  });
  await saveTranscript();
  assert.notEqual((await hook("Stop", { ...stop, executionNum: 2 })).code, 0);
  assert.equal(requests.length, 4);
  assert.equal(
    JSON.parse(await readFile(join(stateDir, "checkpoint.json"), "utf8"))
      .throughStep,
    6,
  );
  console.log(
    "PASS: turn hierarchy, tool output, token schema, timing, 503 retry, partial rejection, stable IDs, duplicate Stop, resumed turn, unknown schema failure",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
