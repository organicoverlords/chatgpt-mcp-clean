import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/capture-edge-fanout.mjs [--lines <100-20000>] [--since <iso>] [--until <iso>] [--input <local-jsonl>]");
  process.exit(2);
}

let lines = 5000;
let since;
let until;
let inputPath;
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  const value = args.shift();
  if (!value) usage(`missing value for ${flag}`);
  if (flag === "--lines") {
    lines = Number(value);
    if (!Number.isInteger(lines) || lines < 100 || lines > 20_000) usage("--lines must be an integer from 100 through 20000");
  } else if (flag === "--since" || flag === "--until") {
    if (!Number.isFinite(Date.parse(value))) usage(`${flag} must be an ISO timestamp`);
    if (flag === "--since") since = value;
    else until = value;
  } else if (flag === "--input") {
    inputPath = value;
  } else {
    usage(`unknown argument: ${flag}`);
  }
}
if (since && until && Date.parse(until) < Date.parse(since)) usage("--until must not precede --since");

const analyzer = fileURLToPath(new URL("./analyze-edge-fanout.mjs", import.meta.url));
const analyzerArgs = [analyzer, "-"];
if (since) analyzerArgs.push("--since", since);
if (until) analyzerArgs.push("--until", until);

function collect(stream, limit = 64_000) {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    if (text.length > limit) text = text.slice(-limit);
  });
  return () => text;
}

function waitChild(child, name) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ name, code, signal }));
  });
}

const analyzerChild = spawn(process.execPath, analyzerArgs, {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const analyzerStdout = collect(analyzerChild.stdout);
const analyzerStderr = collect(analyzerChild.stderr);
let sourcePromise;
let sourceStderr = () => "";

if (inputPath) {
  if (!existsSync(inputPath)) usage(`input file does not exist: ${inputPath}`);
  const input = createReadStream(inputPath);
  input.on("error", (error) => analyzerChild.stdin.destroy(error));
  input.pipe(analyzerChild.stdin);
  sourcePromise = Promise.resolve({ name: "input", code: 0, signal: null });
} else {
  if (process.platform !== "win32") throw new Error("edge capture wrapper currently requires the registered Windows edge control route");
  const ssh = "C:\\Program Files\\Git\\usr\\bin\\ssh.exe";
  const key = join(homedir(), ".ssh", "tietokettu_edge");
  if (!existsSync(ssh) || !existsSync(key)) throw new Error("registered edge SSH control route is unavailable");
  const remoteCommand = `tail -n ${lines} /var/log/caddy/mcp-edge-access.log`;
  const source = spawn(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", key, "root@5.61.91.127", remoteCommand], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  sourceStderr = collect(source.stderr);
  source.stdout.pipe(analyzerChild.stdin);
  sourcePromise = waitChild(source, "edge-ssh");
}

const [sourceResult, analyzerResult] = await Promise.all([sourcePromise, waitChild(analyzerChild, "analyzer")]);
if (sourceResult.code !== 0) throw new Error(`bounded edge read failed: exit=${sourceResult.code} signal=${sourceResult.signal ?? "none"}; stderr=${sourceStderr().slice(-2000)}`);
if (analyzerResult.code !== 0) throw new Error(`aggregate edge analyzer failed: exit=${analyzerResult.code} signal=${analyzerResult.signal ?? "none"}; stderr=${analyzerStderr().slice(-2000)}`);

let report;
try {
  report = JSON.parse(analyzerStdout());
} catch {
  throw new Error(`aggregate edge analyzer returned invalid JSON: ${analyzerStdout().slice(-2000)}`);
}
if (report?.privacy?.raw_identifiers_emitted !== false) throw new Error("aggregate edge analyzer did not assert identifier-safe output");
console.log(JSON.stringify(report, null, 2));
