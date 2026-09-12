import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { processChildEnvironment } from "../dist/lib/process-child-environment.js";

const profile = "C:\\Users\\TestUser";
const defaultProxy = join(profile, ".local", "bin", "gh-buffer-proxy");
const files = new Set([join(defaultProxy, "gh.exe"), join(defaultProxy, "git.exe")]);
const exists = (path) => files.has(path);

const parent = { USERPROFILE: profile, Path: "C:\\Windows;C:\\Tools", KEEP: "same" };
const child = processChildEnvironment(parent, exists);
assert.equal(parent.Path, "C:\\Windows;C:\\Tools", "parent environment must not be mutated");
assert.equal(parent.GHBUF_PROXY_DIR, undefined, "parent must not gain gh-buffer state");
assert.equal(child.Path, `${defaultProxy}${delimiter}C:\\Windows;C:\\Tools`);
assert.equal(child.GHBUF_PROXY_DIR, defaultProxy);
assert.equal(child.KEEP, "same");

const already = processChildEnvironment({ ...parent, Path: `${defaultProxy}${delimiter}C:\\Windows` }, exists);
assert.equal(already.Path, `${defaultProxy}${delimiter}C:\\Windows`, "proxy path must not duplicate");

const disabled = processChildEnvironment({ ...parent, MCP_GHBUF_PROXY_ENABLED: "0" }, exists);
assert.equal(disabled.Path, parent.Path);
assert.equal(disabled.GHBUF_PROXY_DIR, undefined);

const localAppData = "C:\\Users\\TestUser\\AppData\\Local";
const busyDir = join(localAppData, "BusyCoordinator");
const busyCommand = join(busyDir, "busy-python.cmd");
const withBusy = processChildEnvironment(
  { PATH: "C:\\Windows;C:\\Tools", LOCALAPPDATA: localAppData, MCP_GHBUF_PROXY_ENABLED: "0" },
  (path) => path === busyCommand,
);
assert.equal(withBusy.PATH, `C:\\Windows;C:\\Tools${delimiter}${busyDir}`, "BusyCoordinator must be appended without shadowing existing PATH commands");
const withBusyAlready = processChildEnvironment(
  { PATH: `C:\\Windows${delimiter}${busyDir}`, LOCALAPPDATA: localAppData, MCP_GHBUF_PROXY_ENABLED: "0" },
  (path) => path === busyCommand,
);
assert.equal(withBusyAlready.PATH, `C:\\Windows${delimiter}${busyDir}`, "BusyCoordinator PATH entry must not duplicate");

const missing = processChildEnvironment(parent, () => false);
assert.equal(missing.Path, parent.Path);
assert.equal(missing.GHBUF_PROXY_DIR, undefined);

const override = "D:\\Local\\ghbuf-proxy";
const overrideFiles = new Set([join(override, "gh.exe"), join(override, "git.exe")]);
const overridden = processChildEnvironment(
  { PATH: "C:\\Windows", MCP_GHBUF_PROXY_DIR: override },
  (path) => overrideFiles.has(path),
);
assert.equal(overridden.PATH, `${override}${delimiter}C:\\Windows`);
assert.equal(overridden.GHBUF_PROXY_DIR, override);

const noProfile = processChildEnvironment({ PATH: "C:\\Windows" }, () => true);
assert.equal(noProfile.PATH, "C:\\Windows");

const projectRoot = "C:\\repo";
const projectBin = join(projectRoot, "node_modules", ".bin");
const withProjectBin = processChildEnvironment(
  { PATH: "C:\\Windows", MCP_GHBUF_PROXY_ENABLED: "0" },
  (path) => path === projectBin,
  projectRoot,
);
assert.equal(withProjectBin.PATH, `${projectBin}${delimiter}C:\\Windows`, "project-local node_modules/.bin must be preferred when present");

const androidRoot = join(localAppData, "Android", "Sdk");
const platformTools = join(androidRoot, "platform-tools");
const withAndroid = processChildEnvironment(
  { PATH: "C:\\Windows", LOCALAPPDATA: localAppData, MCP_GHBUF_PROXY_ENABLED: "0" },
  (path) => path === join(platformTools, "adb.exe"),
);
assert.equal(withAndroid.PATH, `${platformTools}${delimiter}C:\\Windows`, "standard Android platform-tools must be added when adb.exe exists");

console.log("PASS process-child-environment ghbuf_child_only=true parent_unchanged=true fallback_safe=true");
