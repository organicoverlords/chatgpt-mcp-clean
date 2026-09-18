import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("src/index.ts"), "utf8");
const middlewareStart = source.indexOf("app.use((req, res, next) => {");
const jsonParser = source.indexOf('app.use(express.json({ limit: "4mb" }))');
assert.ok(middlewareStart >= 0 && jsonParser > middlewareStart, "transport telemetry middleware boundary must remain discoverable");
const transportTelemetry = source.slice(middlewareStart, jsonParser);
assert.doesNotMatch(transportTelemetry, /req\.body|params\?*\.|arguments|stdin/i, "transport request/response telemetry must not inspect or persist MCP payload content");
assert.match(transportTelemetry, /event: "request_start"/);
assert.match(transportTelemetry, /event: "response_finish"/);
assert.match(transportTelemetry, /response_bytes: responseBytes/);

const classifierStart = source.indexOf('app.use(express.json({ limit: "4mb" }))');
const classifierEnd = source.indexOf('app.use("/authorize"', classifierStart);
assert.ok(classifierStart >= 0 && classifierEnd > classifierStart, "MCP classifier boundary must remain discoverable");
const classifier = source.slice(classifierStart, classifierEnd);
assert.match(classifier, /res\.locals\.mcpMethod/);
assert.match(classifier, /res\.locals\.mcpTool/);
assert.doesNotMatch(classifier, /transportLog\([^)]*(?:arguments|req\.body|params\.arguments)/s, "MCP tool classification must not log tool arguments or request bodies");

console.log("PASS transport_payload_privacy metadata_only=true request_body_logged=false tool_arguments_logged=false");
