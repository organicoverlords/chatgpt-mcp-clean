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
): NodeJS.ProcessEnv {
  const child = { ...source };
  if (!enabled(source.MCP_GHBUF_PROXY_ENABLED)) return child;

  const configured = (source.MCP_GHBUF_PROXY_DIR || "").trim();
  const profile = (source.USERPROFILE || "").trim();
  const proxyDir = configured || (profile ? join(profile, ".local", "bin", "gh-buffer-proxy") : "");
  if (!proxyDir) return child;

  const ghProxy = join(proxyDir, "gh.exe");
  const gitProxy = join(proxyDir, "git.exe");
  if (!fileExists(ghProxy) || !fileExists(gitProxy)) return child;

  const key = pathKey(child);
  const currentPath = child[key] || "";
  if (!alreadyPrefixed(currentPath, proxyDir)) {
    child[key] = currentPath ? `${proxyDir}${delimiter}${currentPath}` : proxyDir;
  }
  child.GHBUF_PROXY_DIR = proxyDir;
  return child;
}