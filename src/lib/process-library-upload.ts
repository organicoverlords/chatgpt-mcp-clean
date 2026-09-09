import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PROCESS_LIBRARY_UPLOAD_WIDGET_URI = "ui://process/library-upload-v1.html";
export const PROCESS_LIBRARY_UPLOAD_PREFIX = "CHATGPT_LIBRARY_UPLOAD=";

const MAX_LIBRARY_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_RESOURCE_REGISTRY_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_REGISTRY_ENTRIES = 16;

const MIME_BY_EXT: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
};

export type ProcessLibraryUpload = {
  file_name: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  resource_id: string;
  data_base64: string;
};

const resourceRegistry = new Map<string, ProcessLibraryUpload>();
let resourceRegistryBytes = 0;

function rememberProcessLibraryUpload(upload: ProcessLibraryUpload): void {
  if (resourceRegistry.has(upload.resource_id)) return;
  resourceRegistry.set(upload.resource_id, upload);
  resourceRegistryBytes += upload.bytes;
  while (resourceRegistry.size > MAX_RESOURCE_REGISTRY_ENTRIES || resourceRegistryBytes > MAX_RESOURCE_REGISTRY_BYTES) {
    const oldest = resourceRegistry.entries().next().value as [string, ProcessLibraryUpload] | undefined;
    if (!oldest) break;
    resourceRegistry.delete(oldest[0]);
    resourceRegistryBytes -= oldest[1].bytes;
  }
}

export function processLibraryUploadResourceContents(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "mcp-upload:" || parsed.hostname !== "process") throw new Error("unsupported process upload resource URI");
  const resourceId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const upload = resourceRegistry.get(resourceId);
  if (!upload) throw new Error("process upload resource is unavailable or expired");
  return { uri, mimeType: upload.mime_type, blob: upload.data_base64 };
}

export function processLibraryUploadContent(upload: ProcessLibraryUpload) {
  if (!upload.mime_type.startsWith("image/")) return null;
  rememberProcessLibraryUpload(upload);
  return {
    type: "resource_link" as const,
    uri: `mcp-upload://process/${upload.resource_id}`,
    name: upload.file_name,
    title: upload.file_name,
    description: "Exact local file requested by CHATGPT_LIBRARY_UPLOAD",
    mimeType: upload.mime_type,
    size: upload.bytes,
    annotations: { audience: ["assistant", "user"] as ("assistant" | "user")[] },
  };
}

export function processLibraryUploadMetadata(upload: ProcessLibraryUpload) {
  const metadata = { file_name: upload.file_name, mime_type: upload.mime_type, bytes: upload.bytes };
  return upload.mime_type.startsWith("image/") ? metadata : { ...metadata, data_base64: upload.data_base64 };
}

export async function processLibraryUploadFromOutput(value: unknown): Promise<ProcessLibraryUpload | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stdout = (value as Record<string, unknown>).stdout;
  if (typeof stdout !== "string") return null;
  const marker = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith(PROCESS_LIBRARY_UPLOAD_PREFIX));
  if (!marker) return null;

  const path = marker.slice(PROCESS_LIBRARY_UPLOAD_PREFIX.length).trim();
  if (!path || !isAbsolute(path)) throw new Error("CHATGPT_LIBRARY_UPLOAD must name an absolute local file path");
  const mimeType = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`CHATGPT_LIBRARY_UPLOAD unsupported file type: ${extname(path) || "(none)"}`);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_LIBRARY_UPLOAD_BYTES) {
    throw new Error(`CHATGPT_LIBRARY_UPLOAD file must be 1..${MAX_LIBRARY_UPLOAD_BYTES} bytes`);
  }
  const data = await readFile(path);
  if (data.length !== info.size) throw new Error("CHATGPT_LIBRARY_UPLOAD file size changed while reading");
  return {
    file_name: basename(path),
    mime_type: mimeType,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    resource_id: randomUUID(),
    data_base64: data.toString("base64"),
  };
}

export function registerProcessLibraryUploadWidget(server: McpServer): void {
  server.registerResource(
    "process-local-upload",
    new ResourceTemplate("mcp-upload://process/{resource_id}", { list: undefined }),
    { title: "Process local upload", description: "Exact local file explicitly requested by a process output marker" },
    async (uri) => ({ contents: [processLibraryUploadResourceContents(uri.href)] }),
  );
  server.registerResource("process-library-upload-widget", PROCESS_LIBRARY_UPLOAD_WIDGET_URI, {}, async () => ({
    contents: [{
      uri: PROCESS_LIBRARY_UPLOAD_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: processLibraryUploadWidgetHtml(),
    }],
  }));
}

export function processLibraryUploadWidgetHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark}body{margin:0;padding:0;background:transparent}.image{display:none;max-width:100%;height:auto;border-radius:8px}.image.on{display:block}.status{display:none;padding:8px 10px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}.status.on{display:block}</style></head>
<body><img id="image" class="image" alt="Local image"><div id="status" class="status"></div>
<script>
const statusEl=document.getElementById('status'); const imageEl=document.getElementById('image');
let startedKey='';
function setStatus(text){statusEl.textContent=text;statusEl.classList.add('on');window.openai?.notifyIntrinsicHeight?.();}
function payloadFrom(result){return result?._meta?.chatgpt_library_upload||null;}
async function render(result){
 const p=payloadFrom(result); if(!p?.data_base64||!p?.file_name||!p?.mime_type)return;
 const key=p.file_name+':'+p.bytes; if(startedKey===key)return; startedKey=key;
 if(typeof window.openai?.uploadFile!=='function'){setStatus('LIBRARY_UPLOAD_UNAVAILABLE');return;}
 setStatus('LIBRARY_UPLOAD_RUNNING '+p.file_name);
 try{
  const raw=atob(p.data_base64); const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  const blob=new Blob([bytes],{type:p.mime_type});
  if(p.mime_type.startsWith('image/')){imageEl.src=URL.createObjectURL(blob);imageEl.classList.add('on');window.openai?.notifyIntrinsicHeight?.();}
  const file=new File([blob],p.file_name,{type:p.mime_type});
  const result=await window.openai.uploadFile(file,{library:true});
  const fileId=result?.fileId||'';
  setStatus('LIBRARY_UPLOAD_OK '+fileId+' '+p.file_name);
  window.openai?.setWidgetState?.({library_upload:{status:'ok',fileId,fileName:p.file_name,bytes:p.bytes}});
 }catch(error){setStatus('LIBRARY_UPLOAD_ERROR '+String(error?.message||error));}
}
window.addEventListener('message',event=>{
 if(event.source!==window.parent)return; const m=event.data; if(m?.jsonrpc!=='2.0')return;
 if(m.id==='process-library-init'&&('result' in m||'error' in m)){
  if(!m.error)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*'); return;
 }
 if(m.method==='ui/notifications/tool-result')render(m.params||{});
});
const envelope=window.openai?.toolResponseMetadata?.mcp_tool_result;
if(envelope)render(envelope);
window.parent.postMessage({jsonrpc:'2.0',id:'process-library-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'process-library-upload',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}},'*');
</script></body></html>`;
}
