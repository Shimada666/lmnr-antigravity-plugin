import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  checkpoint,
  eventRecord,
  hookPayload,
  pendingExport,
  transcriptRow,
  type ExportRequest,
} from "./schema.js";
import { buildExport } from "./traces.js";

const configSchema = z
  .object({
    projectApiKey: z.string().min(1),
    baseUrl: z.url(),
    maxChars: z.number().int().min(256).max(100_000).default(20_000),
    timeoutMs: z.number().int().min(100).max(15_000).default(5_000),
  })
  .strict();
const configPath =
  process.env.LMNR_ANTIGRAVITY_CONFIG ??
  join(homedir(), ".config/lmnr/antigravity-plugin.json");
const stateRoot =
  process.env.LMNR_ANTIGRAVITY_STATE_DIR ??
  join(homedir(), ".local/state/lmnr/antigravity");

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

async function upload(
  request: ExportRequest,
  config: z.infer<typeof configSchema>,
): Promise<void> {
  const base = new URL(config.baseUrl);
  assert(
    ["http:", "https:"].includes(base.protocol),
    "Laminar URL must be HTTP(S)",
  );
  assert(
    !base.username && !base.password && !base.search && !base.hash,
    "Invalid Laminar base URL",
  );
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/v1/traces`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.projectApiKey}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    },
  );
  assert(response.ok, `Laminar OTLP export failed: HTTP ${response.status}`);
  const body = await response.text();
  const result = z
    .object({
      partialSuccess: z
        .object({
          rejectedSpans: z
            .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
            .optional(),
          errorMessage: z.string().optional(),
        })
        .optional(),
    })
    .strict()
    .parse(body === "" ? {} : JSON.parse(body));
  assert(
    !result.partialSuccess?.rejectedSpans ||
      Number(result.partialSuccess.rejectedSpans) === 0,
    "Laminar rejected spans; retaining pending export",
  );
}

async function main(): Promise<void> {
  const event = z
    .enum([
      "PreInvocation",
      "PostInvocation",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ])
    .parse(process.argv[2]);
  // An unconfigured installation is explicitly disabled. No project key is
  // inherited from another plugin and no transcript is read or sent.
  const reply =
    event === "PreToolUse"
      ? { decision: "allow" }
      : event === "Stop"
        ? { decision: "stop" }
        : {};
  if (!existsSync(configPath)) {
    assert(
      process.env.LMNR_ANTIGRAVITY_CONFIG === undefined,
      "Explicit Laminar config path does not exist",
    );
    console.log(JSON.stringify(reply));
    return;
  }
  const config = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  const payload = hookPayload.parse({ ...JSON.parse(stdin), event });
  assert(isAbsolute(payload.transcriptPath), "transcriptPath must be absolute");
  const key = createHash("sha256")
    .update(
      `${payload.conversationId}\n${payload.transcriptPath}\n${config.baseUrl}\n${config.projectApiKey}`,
    )
    .digest("hex");
  const directory = join(stateRoot, key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    retries: { retries: 3, minTimeout: 50, maxTimeout: 250 },
    stale: 30_000,
  });
  try {
    const journalPath = join(directory, "events.jsonl");
    await appendFile(
      journalPath,
      JSON.stringify({ at: new Date().toISOString(), payload }) + "\n",
      { mode: 0o600 },
    );
    if (payload.event !== "Stop" || !payload.fullyIdle) {
      console.log(JSON.stringify(reply));
      return;
    }
    const checkpointPath = join(directory, "checkpoint.json");
    const pendingPath = join(directory, "pending.json");
    let throughStep = existsSync(checkpointPath)
      ? checkpoint.parse(JSON.parse(await readFile(checkpointPath, "utf8")))
          .throughStep
      : -1;
    // Retry the frozen previous request first. Deterministic IDs make uncertain
    // delivery identifiable; transport is at-least-once, not exactly-once.
    if (existsSync(pendingPath)) {
      const pending = pendingExport.parse(
        JSON.parse(await readFile(pendingPath, "utf8")),
      );
      if (pending.throughStep > throughStep) {
        await upload(pending.request, config);
        throughStep = pending.throughStep;
        await atomicJson(checkpointPath, { throughStep });
      }
      await rm(pendingPath);
    }
    const raw = await readFile(payload.transcriptPath, "utf8");
    assert(
      raw.endsWith("\n"),
      "Transcript has a partial trailing line; retry after it flushes",
    );
    const rows = raw
      .trimEnd()
      .split("\n")
      .map((line) => transcriptRow.parse(JSON.parse(line)));
    for (let i = 1; i < rows.length; i++) {
      assert(
        rows[i]!.step_index > rows[i - 1]!.step_index,
        "Transcript steps must be strictly increasing",
      );
    }
    const events = (await readFile(journalPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => eventRecord.parse(JSON.parse(line)));
    const pending = buildExport(
      rows,
      events,
      payload,
      throughStep,
      config.maxChars,
    );
    if (pending !== null) {
      await atomicJson(pendingPath, pending);
      await upload(pending.request, config);
      await atomicJson(checkpointPath, { throughStep: pending.throughStep });
      await rm(pendingPath);
      console.error(
        `lmnr-antigravity exported conversation=${payload.conversationId} through_step=${pending.throughStep}`,
      );
    }
    console.log(JSON.stringify(reply));
  } finally {
    await release();
  }
}

void main();
