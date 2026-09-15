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
  "LocalFileToolName",
  "MCP_LOCAL_FILE_TOOL_NAME",
  "LibrarySpoolBridge",
  "MCP_LIBRARY_SPOOL_BRIDGE",
  "library_spool_bridge",
  "mount_visual_proof_bridge",
  "read_local_file",
  "shared-process-receipts",
  "receipt_store_relative",
  "runtime_identity.source_commit",
  "route_mutation=$false",
  "Register-ScheduledTask",
  "Start-ScheduledTask",
  "CurrentTopologyPath",
]) assert.ok(script.includes(required),`missing invariant: ${required}`);
assert.match(script,/if\(\$Plan\).*route_mutation/s);
assert.match(script,/if\(-not \$ExplicitUserAuthorization\)/);
assert.match(script,/MCP_LIBRARY_SPOOL_BRIDGE='\$librarySpoolBridgeValue'/,"frozen launcher must pin bridge enablement instead of inheriting ambient env");
assert.match(script,/\$env:MCP_LIBRARY_SPOOL_BRIDGE=\$librarySpoolBridgeValue[\s\S]*verify-process-contract\.mjs/,"frozen verifier must validate the same bridge profile that the launcher will serve");
assert.match(script,/Push-Location -LiteralPath \$runtime[\s\S]*verify-process-contract\.mjs[\s\S]*finally \{[\s\S]*Pop-Location/,"frozen verifier must run with cwd bound to the frozen runtime even when prepare is launched elsewhere");
console.log("PASS prepare_frozen_home_direct exact_commit=true self_contained=true persistent_task=true shared_state=true oauth_existing_required=true route_unchanged=true explicit_auth=true verifier_runtime_cwd=true bridge_profile_pinned=true");
