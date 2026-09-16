import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const script=readFileSync(new URL("./prepare-frozen-home-direct.ps1",import.meta.url),"utf8");
for(const required of [
  "ExplicitUserAuthorization",
  "git.exe clone --local --no-hardlinks --no-checkout",
  "verify-process-contract.mjs",
  "RestartOnUnexpectedExit",
  "RequireExistingOAuthState",
  "ReceiptStoreRelative",
  "shared-process-receipts",
  "receipt_store_relative",
  "runtime_identity.source_commit",
  "route_mutation=$false",
  "Register-ScheduledTask",
  "Start-ScheduledTask",
  "CurrentTopologyPath",
  "preserved_previous_routes",
  "currently_listening",
  "rollback_port=$rollbackPort",
  "rollback_instance=$rollbackInstance",
  "$toolContract=@('start_process','read_output','kill_process','download_chatgpt_file')",
]) assert.ok(script.includes(required),`missing invariant: ${required}`);
for(const forbidden of [
  "LocalFileToolName",
  "MCP_LOCAL_FILE_TOOL_NAME",
  "LibrarySpoolBridge",
  "MCP_LIBRARY_SPOOL_BRIDGE",
  "library_spool_bridge",
  "mount_visual_proof_bridge",
  "read_local_file",
  "upload_local_file",
  "view_image",
]) assert.equal(script.includes(forbidden),false,`retired MCP surface leaked into frozen deployment generator: ${forbidden}`);
assert.match(script,/if\(\$Plan\).*route_mutation/s);
assert.match(script,/if\(-not \$ExplicitUserAuthorization\)/);
assert.match(script,/Push-Location -LiteralPath \$runtime[\s\S]*verify-process-contract\.mjs[\s\S]*finally \{[^}]*Pop-Location/,"frozen verifier must run with cwd bound to the frozen runtime even when prepare is launched elsewhere");
console.log("PASS prepare_frozen_home_direct exact_commit=true self_contained=true persistent_task=true shared_state=true oauth_existing_required=true route_unchanged=true explicit_auth=true verifier_runtime_cwd=true fixed_four_tool_surface=true");
