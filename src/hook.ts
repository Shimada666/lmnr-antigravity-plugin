import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { hookPayload } from "./schema.js";
import {
  appendRecord,
  configPath,
  observeOwner,
  readConfig,
  sessionKey,
  stateRoot,
} from "./storage.js";

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
  assert(
    process.argv[3] === undefined,
    "Hooks only record events; use worker for retry/recovery",
  );
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
  const config = await readConfig();
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  const payload = hookPayload.parse({ ...JSON.parse(stdin), event });
  assert(isAbsolute(payload.transcriptPath), "transcriptPath must be absolute");
  await appendRecord(join(stateRoot, sessionKey(payload, config)), {
    at: new Date().toISOString(),
    payload,
    owner: observeOwner(),
  });
  console.log(JSON.stringify(reply));
}
void main();
