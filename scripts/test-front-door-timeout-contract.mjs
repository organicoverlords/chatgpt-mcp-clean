import assert from "node:assert/strict";
import { backendRequestTimeoutMs } from "../dist/lib/front-door-timeout.js";

assert.equal(backendRequestTimeoutMs({ tool: "start_process" }), 10_750);
assert.equal(backendRequestTimeoutMs({ tool: "start_process", waitMs: 0 }), 10_000);
assert.equal(backendRequestTimeoutMs({ tool: "start_process", waitMs: 60_000 }), 70_000, "explicit start waits retain their requested wait plus bounded transport margin");
assert.equal(backendRequestTimeoutMs({ tool: "start_process", waitMs: 240_000 }), 250_000, "maximum explicit start wait remains routable through the front door");
assert.equal(backendRequestTimeoutMs({ tool: "read_output" }), 70_000);
assert.equal(backendRequestTimeoutMs({ tool: "read_output", waitMs: 240_000 }), 250_000, "long resumable reads retain their requested wait plus bounded transport margin");
assert.equal(backendRequestTimeoutMs({ tool: "kill_process" }), 15_000);
assert.equal(backendRequestTimeoutMs({}), 35_000);
console.log("PASS front_door_timeout_contract start_bounded=true read_resumable=true kill_bounded=true default_bounded=true");
