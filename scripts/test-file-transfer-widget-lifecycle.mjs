import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { fileTransferWidgetHtml } from "../dist/lib/file-transfer.js";

const script = fileTransferWidgetHtml().match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "file-transfer widget script must exist");
const bytes = Buffer.from("widget-lifecycle-proof");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const toolResult = { _meta: { file_transfer: { direction: "local_to_chatgpt", delivery_mode: "library_upload", file_name: "proof.png", mime_type: "image/png", bytes: bytes.length, sha256, transfer_url: "https://mcp.example.test/file" } } };

async function mount(widgetState = null, failUpload = false) {
  const listeners = new Map();
  const counts = { upload: 0, state: 0, close: 0 };
  let state = widgetState;
  const status = { textContent: "" };
  const parent = { postMessage() {} };
  const openai = {
    widgetState: state,
    toolResponseMetadata: { mcp_tool_result: toolResult },
    uploadFile: async () => {
      counts.upload += 1;
      if (failUpload) throw new Error("synthetic upload failure");
      return { fileId: "file_proof" };
    },
    setWidgetState(value) {
      counts.state += 1;
      state = value;
      openai.widgetState = value;
    },
    async requestClose() { counts.close += 1; },
  };
  const window = { openai, parent, addEventListener: (name, fn) => listeners.set(name, fn) };
  vm.runInNewContext(script, {
    window,
    document: { getElementById: () => status },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
    crypto: webcrypto,
    Blob,
    File,
    Uint8Array,
    console,
    setTimeout,
    clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { counts, state, status: status.textContent };
}

const first = await mount();
assert.deepEqual(first.counts, { upload: 1, state: 1, close: 1 }, "first mount uploads once, persists state, and closes once");
assert.equal(first.state.privateContent.file_transfer.sha256, sha256);
const remount = await mount(first.state);
assert.deepEqual(remount.counts, { upload: 0, state: 0, close: 1 }, "completed remount closes without a second upload or state write");
const failed = await mount(null, true);
assert.deepEqual(failed.counts, { upload: 1, state: 0, close: 0 }, "failed upload stays open and never records false success");
assert.match(failed.status, /^FILE_TRANSFER_ERROR /);
console.log("PASS file_transfer_widget_lifecycle first_upload=1 remount_upload=0 terminal_close=1 failed_close=0");