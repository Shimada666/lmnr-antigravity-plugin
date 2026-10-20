import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  ownerSchema,
  type HookPayload,
  type Owner,
  type EventRecord,
} from "./schema.js";

export const configPath =
  process.env.LMNR_ANTIGRAVITY_CONFIG ??
  join(homedir(), ".config/lmnr/antigravity-plugin.json");
export const stateRoot =
  process.env.LMNR_ANTIGRAVITY_STATE_DIR ??
  join(homedir(), ".local/state/lmnr/antigravity");
export const configSchema = z
  .object({
    projectApiKey: z.string().min(1),
    baseUrl: z.url(),
    maxChars: z.number().int().min(256).max(100_000).default(20_000),
    timeoutMs: z.number().int().min(100).max(15_000).default(5_000),
    captureNativeTiming: z.boolean().default(true),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export async function readConfig(): Promise<Config> {
  const config = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const base = new URL(config.baseUrl);
  assert(
    ["http:", "https:"].includes(base.protocol),
    "Laminar URL must be HTTP(S)",
  );
  assert(
    !base.username && !base.password && !base.search && !base.hash,
    "Invalid Laminar base URL",
  );
  return config;
}
export function sessionKey(payload: HookPayload, config: Config): string {
  return createHash("sha256")
    .update(
      `${payload.conversationId}\n${payload.transcriptPath}\n${config.baseUrl}\n${config.projectApiKey}`,
    )
    .digest("hex");
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export const journalLock = {
  realpath: false,
  retries: { retries: 40, minTimeout: 50, maxTimeout: 50 },
  stale: 30_000,
};
export async function appendRecord(
  directory: string,
  record: EventRecord,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "events.jsonl");
  const release = await lockfile.lock(path, journalLock);
  try {
    if (!existsSync(path))
      await atomicJson(join(directory, "ledger.json"), {
        version: 3,
        importedThroughStep: -1,
      });
    let recovered: EventRecord["journalRecovery"];
    if (existsSync(path)) {
      const prior = await open(path, "r+");
      try {
        const size = (await prior.stat()).size;
        const last = Buffer.alloc(1);
        if (size > 0) await prior.read(last, 0, 1, size - 1);
        if (size > 0 && last[0] !== 10) {
          const original = await readFile(path);
          const boundary = original.lastIndexOf(10) + 1;
          const tail = original.subarray(boundary);
          const fragmentHash = createHash("sha256").update(tail).digest("hex");
          await atomicJson(
            join(directory, `torn-journal-${fragmentHash}.json`),
            { offset: boundary, base64: tail.toString("base64") },
          );
          await prior.truncate(boundary);
          await prior.sync();
          recovered = { fragmentHash, bytes: tail.length };
          console.error(
            `lmnr-antigravity recovered_torn_journal bytes=${tail.length} fragment=${fragmentHash}`,
          );
        }
      } finally {
        await prior.close();
      }
    }
    const file = await open(path, "a", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          ...record,
          ...(recovered ? { journalRecovery: recovered } : {}),
        }) + "\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    await release();
  }
}

function proc(pid: number) {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = value
    .slice(value.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  assert(fields.length > 19, "Invalid Linux process stat");
  return {
    state: fields[0]!,
    parent: z.coerce.number().int().nonnegative().parse(fields[1]),
    startTicks: z.string().regex(/^\d+$/).parse(fields[19]),
  };
}
export function observeOwner(): Owner {
  assert(
    process.platform === "linux",
    "Process recovery currently requires Linux",
  );
  let pid = process.ppid;
  const requested =
    process.env.LMNR_ANTIGRAVITY_OWNER_PID === undefined
      ? undefined
      : z.coerce
          .number()
          .int()
          .positive()
          .parse(process.env.LMNR_ANTIGRAVITY_OWNER_PID);
  while (pid > 1) {
    const info = proc(pid);
    const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (requested === pid || (requested === undefined && name === "agy")) {
      return ownerSchema.parse({
        pid,
        startTicks: info.startTicks,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      });
    }
    pid = info.parent;
  }
  assert.fail("No Antigravity owner process found in hook ancestry");
}
export function ownerAlive(owner: Owner): boolean {
  if (
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !==
      owner.bootId ||
    !existsSync(`/proc/${owner.pid}/stat`)
  )
    return false;
  // If a process exits between existence check and read, let ENOENT surface;
  // the next worker pass observes absence. No access error is hidden as death.
  const info = proc(owner.pid);
  return (
    info.startTicks === owner.startTicks && !["Z", "X"].includes(info.state)
  );
}
