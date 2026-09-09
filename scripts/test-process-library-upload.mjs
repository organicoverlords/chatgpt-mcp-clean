import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processLibraryUploadContent, processLibraryUploadFromOutput, processLibraryUploadMetadata, processLibraryUploadWidgetHtml } from "../dist/lib/process-library-upload.js";

const dir = await mkdtemp(join(tmpdir(), "mcp-process-upload-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const imagePath = join(dir, "proof.png");
await writeFile(imagePath, png);
const upload = await processLibraryUploadFromOutput({ stdout: `ok\nCHATGPT_LIBRARY_UPLOAD=${imagePath}\n` });
assert(upload);
assert.equal(Buffer.from(upload.data_base64, "base64").compare(png), 0, "typed image payload must preserve exact original bytes");
const content = processLibraryUploadContent(upload);
assert.equal(content?.type, "image");
assert.equal(content?.mimeType, "image/png");
assert.equal(Buffer.from(content.data, "base64").compare(png), 0);
assert.deepEqual(content.annotations.audience, ["assistant", "user"]);
const meta = processLibraryUploadMetadata(upload);
assert.equal(meta.file_name, "proof.png");
assert.equal(meta.bytes, png.length);
assert.equal(Object.hasOwn(meta, "data_base64"), false, "image bytes must not be duplicated into _meta");

const jsonPath = join(dir, "proof.json");
const json = Buffer.from("{\"ok\":true}", "utf8");
await writeFile(jsonPath, json);
const nonImage = await processLibraryUploadFromOutput({ stdout: `CHATGPT_LIBRARY_UPLOAD=${jsonPath}` });
assert(nonImage);
assert.equal(processLibraryUploadContent(nonImage), null);
assert.equal(processLibraryUploadMetadata(nonImage).data_base64, json.toString("base64"), "non-image Library uploads retain metadata bytes");

const widget = processLibraryUploadWidgetHtml();
assert.match(widget, /result\?\.content/);
assert.match(widget, /type==='image'/);
assert.match(widget, /URL\.createObjectURL\(blob\)/);
assert.match(widget, /uploadFile\(file,\{library:true\}\)/);
console.log("process library upload typed-image tests passed");
