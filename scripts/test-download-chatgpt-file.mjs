import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadChatgptFile } from "../dist/lib/file-transfer.js";

const dir = await mkdtemp(join(tmpdir(), "mcp-download-chatgpt-file-"));
const payload = Buffer.from("exact-chatgpt-file-bytes\n", "utf8");
const expectedSha = createHash("sha256").update(payload).digest("hex");
const file = {
  download_url: "https://files.example.test/file-123",
  file_id: "file_123",
  file_name: "source.bin",
  mime_type: "application/octet-stream",
};
const destination = join(dir, "saved.bin");
const fetchImpl = async () => new Response(payload, {
  status: 200,
  headers: { "content-length": String(payload.length), "content-encoding": "identity" },
});
const validateUrl = async (raw) => new URL(raw);

try {
  const saved = await downloadChatgptFile(file, destination, false, { fetchImpl, validateUrl });
  assert.equal(saved.status, "ok");
  assert.equal(saved.file_id, file.file_id);
  assert.equal(saved.bytes, payload.length);
  assert.equal(saved.sha256, expectedSha);
  assert.deepEqual(await readFile(destination), payload, "downloaded ChatGPT file must preserve exact bytes");

  await assert.rejects(
    () => downloadChatgptFile(file, destination, false, { fetchImpl, validateUrl }),
    /destination already exists/,
    "overwrite=false must preserve an existing destination",
  );

  await assert.rejects(
    () => downloadChatgptFile({ ...file, download_url: "https://127.0.0.1/private" }, join(dir, "private.bin")),
    /private address|non-public address/,
    "default URL validation must reject private-address downloads",
  );

  const encodedFetch = async () => new Response(payload, {
    status: 200,
    headers: { "content-length": String(payload.length), "content-encoding": "gzip" },
  });
  await assert.rejects(
    () => downloadChatgptFile(file, join(dir, "encoded.bin"), false, { fetchImpl: encodedFetch, validateUrl }),
    /unexpected content-encoding/,
    "exact-byte downloads must reject transformed content",
  );

  console.log("PASS download_chatgpt_file exact_bytes=true overwrite_guard=true private_url_blocked=true content_encoding_guard=true");
} finally {
  await rm(dir, { recursive: true, force: true });
}
