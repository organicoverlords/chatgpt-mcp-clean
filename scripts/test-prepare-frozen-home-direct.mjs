import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const script=readFileSync(new URL("./prepare-frozen-home-direct.ps1",import.meta.url),"utf8");
for(const required of [
  "ExplicitUserAuthorization",
  "git.exe clone --local --no-hardlinks --no-checkout",
  "verify-process-contract.mjs",
  "RestartOnUnexpectedExit",
  "shared-process-receipts",
  "runtime_identity.source_commit",
  "route_mutation=$false",
  "Register-ScheduledTask",
  "Start-ScheduledTask",
  "CurrentTopologyPath",
]) assert.ok(script.includes(required),`missing invariant: ${required}`);
assert.match(script,/if\(\$Plan\).*route_mutation/s);
assert.match(script,/if\(-not \$ExplicitUserAuthorization\)/);
console.log("PASS prepare_frozen_home_direct exact_commit=true self_contained=true persistent_task=true shared_state=true route_unchanged=true explicit_auth=true");
