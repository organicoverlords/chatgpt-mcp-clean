import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

type FileExists = (path: string) => boolean;

function pathKey(environment: NodeJS.ProcessEnv): string {
  return Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH";
}

function enabled(value: string | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function alreadyPrefixed(currentPath: string, proxyDir: string): boolean {
  const first = currentPath.split(delimiter, 1)[0];
  if (!first) return false;
  try {
    return resolve(first).toLowerCase() === resolve(proxyDir).toLowerCase();
  } catch {
    return first.toLowerCase() === proxyDir.toLowerCase();
  }
}

export function processChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  fileExists: FileExists = existsSync,
  workingDirectory?: string,
): NodeJS.ProcessEnv {
  const child = { ...source };
  // MCP transports text as UTF-8. Force only Python's stdio encoding (not its file
  // default encoding) so generated Unicode output cannot fail under Windows cp1252.
  if (!child.PYTHONIOENCODING) child.PYTHONIOENCODING = "utf-8";
  const key = pathKey(child);
  const currentPath = child[key] || "";
  const localAppData = (source.LOCALAPPDATA || "").trim();

  // Resolve project-local command shims the same way mature process wrappers do, but only
  // when the directory actually exists. This prevents npm/npx/pytest-style local tools
  // from falling through to an unrelated global install.
  const localBin = workingDirectory ? join(workingDirectory, "node_modules", ".bin") : "";
  if (localBin && fileExists(localBin)) {
    const parts = (child[key] || "").split(delimiter).filter(Boolean);
    const containsLocalBin = parts.some((part) => {
      try { return resolve(part).toLowerCase() === resolve(localBin).toLowerCase(); }
      catch { return part.toLowerCase() === localBin.toLowerCase(); }
    });
    if (!containsLocalBin) child[key] = child[key] ? `${localBin}${delimiter}${child[key]}` : localBin;
  }

  // Android's platform-tools location is deterministic on the standard Windows SDK install.
  // Add it only when adb.exe is present; callers can still override with ANDROID_SDK_ROOT/HOME.
  const androidRoots = [source.ANDROID_SDK_ROOT, source.ANDROID_HOME, localAppData ? join(localAppData, "Android", "Sdk") : ""]
    .map((value) => (value || "").trim()).filter(Boolean);
  for (const sdkRoot of androidRoots) {
    const platformTools = join(sdkRoot, "platform-tools");
    if (!fileExists(join(platformTools, "adb.exe"))) continue;
    const parts = (child[key] || "").split(delimiter).filter(Boolean);
    const present = parts.some((part) => {
      try { return resolve(part).toLowerCase() === resolve(platformTools).toLowerCase(); }
      catch { return part.toLowerCase() === platformTools.toLowerCase(); }
    });
    if (!present) child[key] = child[key] ? `${platformTools}${delimiter}${child[key]}` : platformTools;
    break;
  }

  const busyCoordinatorDir = localAppData ? join(localAppData, "BusyCoordinator") : "";
  const busyCommand = busyCoordinatorDir ? join(busyCoordinatorDir, "busy-python.cmd") : "";
  if (busyCommand && fileExists(busyCommand)) {
    const parts = (child[key] || "").split(delimiter).filter(Boolean);
    const containsBusyDir = parts.some((part) => {
      try { return resolve(part).toLowerCase() === resolve(busyCoordinatorDir).toLowerCase(); }
      catch { return part.toLowerCase() === busyCoordinatorDir.toLowerCase(); }
    });
    if (!containsBusyDir) {
      const pathNow = child[key] || "";
      child[key] = pathNow ? `${pathNow}${delimiter}${busyCoordinatorDir}` : busyCoordinatorDir;
    }
  }

  if (!enabled(source.MCP_GHBUF_PROXY_ENABLED)) return child;

  const configured = (source.MCP_GHBUF_PROXY_DIR || "").trim();
  const profile = (source.USERPROFILE || "").trim();
  const proxyDir = configured || (profile ? join(profile, ".local", "bin", "gh-buffer-proxy") : "");
  if (!proxyDir) return child;

  const ghProxy = join(proxyDir, "gh.exe");
  const gitProxy = join(proxyDir, "git.exe");
  if (!fileExists(ghProxy) || !fileExists(gitProxy)) return child;

  const currentProxyPath = child[key] || "";
  if (!alreadyPrefixed(currentProxyPath, proxyDir)) {
    child[key] = currentProxyPath ? `${proxyDir}${delimiter}${currentProxyPath}` : proxyDir;
  }
  child.GHBUF_PROXY_DIR = proxyDir;
  return child;
}
