import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = "@modelcontextprotocol/sdk";
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.MCP_DEPENDENCY_CONTRACT_ROOT || scriptRoot);

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "INVALID_JSON";
    throw new Error(`${label} unreadable (${code})`);
  }
}

function exactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
}

export function verifyDependencyContract(contractRoot = root) {
  const packageJson = readJson(resolve(contractRoot, "package.json"), "package.json");
  const lock = readJson(resolve(contractRoot, "package-lock.json"), "package-lock.json");
  const expectedRaw = packageJson?.dependencies?.[SDK];
  const expected = exactVersion(expectedRaw);
  if (!expected) {
    throw new Error(`root dependency ${SDK} must be exact, observed=${JSON.stringify(expectedRaw)}`);
  }

  const lockRoot = lock?.packages?.[""]?.dependencies?.[SDK];
  const lockResolved = lock?.packages?.[`node_modules/${SDK}`]?.version;
  if (lockRoot !== expected || lockResolved !== expected) {
    throw new Error(
      `lock mismatch expected=${expected} root_lock=${String(lockRoot ?? "missing")} resolved_lock=${String(lockResolved ?? "missing")}`,
    );
  }

  let installed = "missing";
  try {
    installed = readJson(resolve(contractRoot, "node_modules", SDK, "package.json"), `${SDK} install`).version || "missing";
  } catch (error) {
    if (!String(error?.message || error).includes("ENOENT")) throw error;
  }
  if (installed !== expected) {
    throw new Error(`installed SDK drift expected=${expected} installed=${installed}`);
  }

  return { sdk: SDK, expected, lock: lockResolved, installed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyDependencyContract();
    console.log(`PASS dependency_contract sdk=${result.sdk} version=${result.installed}`);
  } catch (error) {
    console.error(`DEPENDENCY_CONTRACT_FAILED ${String(error?.message || error)}`);
    console.error("Run npm ci only in an appropriately isolated or change-controlled checkout before build/test; this verifier never mutates dependencies.");
    process.exitCode = 1;
  }
}
