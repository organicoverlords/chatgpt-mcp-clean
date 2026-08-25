import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ProcessManager } from "../dist/lib/process-manager.js";

let telemetry = null;
try {
  telemetry = await import("../dist/lib/transport-telemetry.js");
} catch {
  // RED until the production telemetry boundary exists.
}

assert.ok(telemetry, "transport telemetry module must exist");

const events = [];
telemetry.setTelemetrySink((event) => events.push(event));

const socket = Object.assign(new EventEmitter(), {
  remoteAddress: "127.0.0.1",
  remotePort: 54321,
  localAddress: "127.0.0.1",
  localPort: 3000,
  bytesRead: 120,
  bytesWritten: 240,
});
const connectionId = telemetry.observeSocket(socket);
assert.match(connectionId, /^connection_[a-f0-9]{12}$/);
socket.emit("end");
socket.emit("close", false);

const rawSession = "secret-session-value-that-must-not-be-logged";
const sessionId = telemetry.sessionFingerprint(rawSession);
assert.match(sessionId, /^session_[a-f0-9]{12}$/);
const rawBearer = "Bearer secret-bearer-value-that-must-not-be-logged";
telemetry.sessionFingerprint(rawBearer);

const manager = new ProcessManager();
const rawCommand = "Write-Output 'TELEMETRY_OK'";
let started;
await telemetry.withTelemetryContext({
  request_id: "request_start",
  caller_id: "caller_owner",
  connection_id: connectionId,
  session_id: sessionId,
}, async () => {
  started = manager.start(rawCommand, undefined, "caller_owner");
});

const deadline = Date.now() + 10_000;
let state;
do {
  await telemetry.withTelemetryContext({
    request_id: "request_read",
    caller_id: "caller_reconnected",
    connection_id: "connection_reconnected",
    session_id: "session_reconnected",
  }, async () => {
    state = manager.read(started.process_id);
  });
  if (!state.running) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
} while (Date.now() < deadline);

assert.equal(state.running, false, "telemetry test process must finish");
assert.match(state.stdout, /TELEMETRY_OK/);

const opened = events.find((event) => event.event === "connection_open");
const closed = events.find((event) => event.event === "connection_close");
const processStarted = events.find((event) => event.event === "process_started");
const processRead = events.find((event) => event.event === "process_read");
const processExited = events.find((event) => event.event === "process_exit_observed");

assert.equal(opened.connection_id, connectionId);
assert.equal(closed.connection_id, connectionId);
assert.equal(closed.had_error, false);
assert.equal(processStarted.process_id, started.process_id);
assert.equal(processStarted.owner_caller_id, "caller_owner");
assert.equal(processStarted.request_id, "request_start");
assert.equal(processStarted.command_hash, undefined, "guessable command fingerprints must not enter telemetry");
assert.equal(processStarted.command, undefined, "raw commands must not enter telemetry");
assert.equal(processRead.owner_caller_id, "caller_owner");
assert.equal(processRead.caller_id, "caller_reconnected");
assert.equal(processRead.reassociated, true);
assert.equal(processExited.process_id, started.process_id);

const serializedEvents = JSON.stringify(events);
for (const forbidden of [rawSession, rawBearer, rawCommand]) {
  assert.ok(!serializedEvents.includes(forbidden), `telemetry must not contain sensitive input: ${forbidden}`);
}

telemetry.setTelemetrySink(undefined);
console.log("PASS transport telemetry correlates sockets, sessions, requests, and process ownership without raw secrets");
