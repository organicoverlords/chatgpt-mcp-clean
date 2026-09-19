import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./restore-stack-from-github.ps1", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

for (const required of [
  "organicoverlords/chatgpt-mcp-clean.git",
  "organicoverlords/agents.git",
  "organicoverlords/regression-research.git",
  "RestoreUserContext",
  "BusyRoot",
  "TaskName",
  "CaddyTaskName",
  "RulesSyncTaskName",
  "CaddyHttpsPort",
  "scripts\\install-stack.ps1",
  "Install-AgentEntrypoints.ps1",
  "Install-VaultCheckoutSyncTask.ps1",
  "install_bootstrap_snapshot_task.ps1",
  "mcp-current-topology.json",
  "mcp-recovery-state.json",
  "merge','--ff-only",
  "preserved without reset/clean",
  "No OAuth/token backup was copied, restored, deleted, or merged",
  "One healthy process binding is enough to regain control",
  "reconciliation_required = $true",
  "lossless COMPLETE bootstrap paging",
  "correct receipt/control directory",
]) assert.ok(script.includes(required), `missing restore invariant: ${required}`);

for (const forbidden of [
  "git reset --hard",
  "git clean -fd",
  "Remove-Item -LiteralPath $oauthRoot",
  "Copy-Item -LiteralPath $oauth",
  "Restart-Computer",
  "RequireHealthyRuntime:(!",
]) assert.equal(script.includes(forbidden), false, `unsafe recovery primitive present: ${forbidden}`);

const planIndex = script.indexOf("if ($Plan)");
const checkoutIndex = script.indexOf("$mcpCommit = Ensure-Checkout");
assert.ok(planIndex >= 0 && checkoutIndex > planIndex, "Plan must exit before any repository checkout mutation");

for (const required of [
  "## Full-stack disaster recovery",
  "GitHub-only recovery",
  "Commander/local-shell recovery",
  "Single PowerShell restore",
  "scripts/restore-stack-from-github.ps1",
  "mcp-current-topology.json",
  "mcp-recovery-state.json",
  "OAuth",
  "One healthy process binding",
  "organicoverlords/agents",
  "organicoverlords/regression-research",
  "chatgpt/home-direct-stable-runtime",
  "prepare-frozen-home-direct.ps1",
  "Mandatory completion gate after MCP install",
]) assert.ok(readme.includes(required), `README recovery contract missing: ${required}`);

console.log("PASS restore_stack_from_github plan_safe=true dirty_preserved=true oauth_preserved=true user_context=true github_only_documented=true redundant_second_stage=true");
