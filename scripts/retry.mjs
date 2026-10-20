import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const journalPath = process.argv[2];
assert(journalPath, "Usage: node scripts/retry.mjs /path/to/events.jsonl");
const records = (await readFile(journalPath, "utf8"))
  .trimEnd()
  .split("\n")
  .map(JSON.parse);
const stop = records.findLast(
  (record) => record.payload.event === "Stop" && record.payload.fullyIdle,
);
assert(stop, "No fully-idle Stop recorded");
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../dist/hook.cjs", import.meta.url)), "Stop"],
  { stdio: ["pipe", "inherit", "inherit"] },
);
child.stdin.end(JSON.stringify(stop.payload));
const [code, signal] = await once(child, "exit");
assert(signal === null, `Hook terminated by ${signal}`);
process.exitCode = code;
