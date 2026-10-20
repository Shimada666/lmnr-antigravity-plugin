// Install/update the independent user service after validating the plugin build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = JSON.parse(command("agy", ["plugin", "list", "--json"])).find(
  (p) => p.name === "lmnr-antigravity",
);
assert(
  installed?.enabled === true && typeof installed.path === "string",
  "Install and enable lmnr-antigravity with agy before installing its worker",
);
const target = installed.path;
const unitPath = join(
  homedir(),
  ".config/systemd/user/lmnr-antigravity-worker.service",
);
if (existsSync(unitPath))
  command("systemctl", ["--user", "stop", "lmnr-antigravity-worker.service"]);
const startTicks = (pid) =>
  readFileSync(`/proc/${pid}/stat`, "utf8")
    .split(") ")[1]
    .trim()
    .split(/\s+/)[19];
const priorHooks = command("ps", [
  "-u",
  String(userInfo().uid),
  "-o",
  "pid=,comm=,args=",
])
  .trim()
  .split("\n")
  .flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+node\s+.*\bdist\/hook\.cjs\b/);
    return match && existsSync(`/proc/${match[1]}/stat`)
      ? [{ pid: Number(match[1]), start: startTicks(match[1]) }]
      : [];
  });
for (const name of [
  "dist/hook.cjs",
  "dist/worker.cjs",
  "hooks.json",
  "plugin.json",
]) {
  const output = join(target, name);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.install-${process.pid}`;
  await copyFile(join(source, name), temporary);
  await rename(temporary, output);
}
// New hooks only append. Let already-running v0.2 exporters finish before their
// last checkpoint is migrated, so no previously-uploaded spans are re-queued.
const deadline = Date.now() + 90_000;
while (
  priorHooks.some(
    (p) => existsSync(`/proc/${p.pid}/stat`) && startTicks(p.pid) === p.start,
  )
) {
  assert(
    Date.now() < deadline,
    "An earlier hook is still running; rerun installer after it exits",
  );
  await new Promise((r) => setTimeout(r, 100));
}
command(process.execPath, [join(target, "dist/worker.cjs"), "--migrate"]);
const unitDir = join(homedir(), ".config/systemd/user");
await mkdir(unitDir, { recursive: true });
const quote = (s) =>
  '"' +
  s.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"') +
  '"';
const agyExecutable = process.env.PATH.split(delimiter)
  .map((entry) => join(entry, "agy"))
  .find(existsSync);
assert(
  agyExecutable,
  "Antigravity executable not found while installing the worker",
);
const environment = ["LMNR_ANTIGRAVITY_BINARY=" + resolve(agyExecutable)]
  .map((entry) => `Environment=${quote(entry)}`)
  .concat(
    ["LMNR_ANTIGRAVITY_CONFIG", "LMNR_ANTIGRAVITY_STATE_DIR"]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => `Environment=${quote(`${k}=${process.env[k]}`)}`),
  )
  .join("\n");
const unit = `[Unit]\nDescription=Laminar Antigravity durable background exporter\n\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(join(target, "dist/worker.cjs"))} --daemon\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=10\nKillMode=control-group\nUMask=0077\n${environment}\n\n[Install]\nWantedBy=default.target\n`;
await writeFile(join(unitDir, "lmnr-antigravity-worker.service"), unit, {
  mode: 0o600,
});
command("systemctl", ["--user", "daemon-reload"]);
command("systemctl", ["--user", "enable", "lmnr-antigravity-worker.service"]);
command("systemctl", ["--user", "restart", "lmnr-antigravity-worker.service"]);
assert.equal(
  command("systemctl", [
    "--user",
    "is-active",
    "lmnr-antigravity-worker.service",
  ]).trim(),
  "active",
);
const stateDirectory =
  process.env.LMNR_ANTIGRAVITY_STATE_DIR ??
  join(homedir(), ".local/state/lmnr/antigravity");
const heartbeatPath = join(stateDirectory, "heartbeat.json");
const readinessDeadline = Date.now() + 60_000;
while (true) {
  assert.equal(
    command("systemctl", [
      "--user",
      "is-active",
      "lmnr-antigravity-worker.service",
    ]).trim(),
    "active",
    "Worker exited before readiness; inspect its journal",
  );
  const pid = Number(
    command("systemctl", [
      "--user",
      "show",
      "lmnr-antigravity-worker.service",
      "--property=MainPID",
      "--value",
    ]).trim(),
  );
  if (
    existsSync(heartbeatPath) &&
    JSON.parse(readFileSync(heartbeatPath, "utf8")).pid === pid
  )
    break;
  assert(
    Date.now() < readinessDeadline,
    "Worker did not publish a readiness heartbeat; inspect its journal",
  );
  await new Promise((r) => setTimeout(r, 250));
}
console.log(
  "Worker installed, enabled and ready. Check pending delivery with node dist/worker.cjs --health.",
);
const linger = command("loginctl", [
  "show-user",
  userInfo().username,
  "--property=Linger",
  "--value",
]).trim();
console.log(
  `User lingering: ${linger}. ${linger === "yes" ? "Worker can run without an interactive login." : "Enable lingering to start the worker before login."}`,
);
