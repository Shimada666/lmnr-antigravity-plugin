import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
assert(
  process.argv[2],
  "Usage: node scripts/retry.mjs /path/to/session/events.jsonl",
);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../dist/worker.cjs", import.meta.url)),
    "--session",
    dirname(process.argv[2]),
  ],
  { stdio: "inherit" },
);
const [code, signal] = await once(child, "exit");
assert(signal === null, `Worker terminated by ${signal}`);
process.exitCode = code;
