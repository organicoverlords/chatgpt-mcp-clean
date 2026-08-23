import http from "node:http";
import assert from "node:assert/strict";

const gateway = process.env.GATEWAY || "http://127.0.0.1:3000";
const serena = process.env.SERENA || "http://127.0.0.1:9121";

function request(base, method, body, headers = {}) {
  const u = new URL("/mcp", base);
  return new Promise((resolve, reject) => {
    const req = http.request(u, { method, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.end(body); else req.end();
  });
}

const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity-probe", version: "1" } } }));
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(payload.length) };

const direct = await request(serena, "POST", payload, headers);
assert.equal(direct.status, 200, `direct Serena initialize failed: ${direct.status} ${direct.body}`);
console.log(`DIRECT_STATUS=${direct.status}`);
console.log(`DIRECT_TYPE=${direct.headers["content-type"]}`);
console.log(`DIRECT_BYTES=${direct.body.length}`);
console.log(direct.body.toString("utf8"));
