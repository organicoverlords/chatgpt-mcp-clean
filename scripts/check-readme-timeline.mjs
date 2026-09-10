import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const entries = changelog.split(/\r?\n/).filter((line) => /^- \[\d{4}-\d{2}-\d{2}\]/.test(line) && !/^\- \[\d{4}-\d{2}-\d{2}\] \[meta\]/.test(line)).slice(0, 5);
assert.equal(entries.length, 5, "CHANGELOG.md must contain at least five dated project entries");
const match = readme.match(/<!-- PROJECT-TIMELINE:BEGIN -->\r?\n## Project timeline\r?\n\r?\n([\s\S]*?)\r?\n\r?\nSee the canonical \[CHANGELOG\.md\]\(CHANGELOG\.md\) for the complete project timeline\.\r?\n<!-- PROJECT-TIMELINE:END -->/);
assert.ok(match, "README.md project timeline markers or canonical changelog link are missing");
assert.deepEqual(match[1].split(/\r?\n/), entries, "README.md project timeline is stale; copy the latest five non-meta CHANGELOG entries");
assert.ok(readme.includes("The default ChatGPT connector contract is `MCP_TOOL_PROFILE=process`, exposing exactly `start_process`, `read_output`, `kill_process`, `upload_local_file`, and `download_chatgpt_file`."), "README.md must identify the five-tool connector profile as the default ChatGPT connector surface");
assert.ok(readme.includes("`MCP_TOOL_PROFILE=full` must be selected explicitly for internal/local tests."), "README.md must mark the full profile explicit-only");
assert.equal(readme.includes("The default full worker-visible contract is exactly"), false, "README.md must not describe the internal full profile as the default connector surface");
assert.equal(readme.includes("The default `full` profile remains unchanged."), false, "README.md contains stale pre-#135 profile guidance");
console.log("PASS readme_timeline latest=5 canonical_changelog_link=true process_profile_default=true full_profile_explicit_only=true");
