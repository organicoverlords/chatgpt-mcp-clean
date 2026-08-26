import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const entries = changelog.split(/\r?\n/).filter((line) => /^- \[\d{4}-\d{2}-\d{2}\]/.test(line) && !/^\- \[\d{4}-\d{2}-\d{2}\] \[meta\]/.test(line)).slice(0, 5);
assert.equal(entries.length, 5, "CHANGELOG.md must contain at least five dated project entries");
const match = readme.match(/<!-- PROJECT-TIMELINE:BEGIN -->\r?\n## Project timeline\r?\n\r?\n([\s\S]*?)\r?\n\r?\nSee the canonical \[CHANGELOG\.md\]\(CHANGELOG\.md\) for the complete project timeline\.\r?\n<!-- PROJECT-TIMELINE:END -->/);
assert.ok(match, "README.md project timeline markers or canonical changelog link are missing");
assert.deepEqual(match[1].split(/\r?\n/), entries, "README.md project timeline is stale; copy the latest five non-meta CHANGELOG entries");
console.log("PASS readme_timeline latest=5 canonical_changelog_link=true");
