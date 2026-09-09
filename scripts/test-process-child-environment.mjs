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

console.log("PASS process-child-environment ghbuf_child_only=true parent_unchanged=true fallback_safe=true");