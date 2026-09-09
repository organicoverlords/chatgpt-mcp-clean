import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PROCESS_LIBRARY_UPLOAD_WIDGET_URI = "ui://process/library-upload-v1.html";
export const PROCESS_LIBRARY_UPLOAD_PREFIX = "CHATGPT_LIBRARY_UPLOAD=";

const MAX_LIBRARY_UPLOAD_BYTES = 20 * 1024 * 1024;

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
  data_base64: string;
};

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
    data_base64: data.toString("base64"),
  };
}

export function registerProcessLibraryUploadWidget(server: McpServer): void {
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
<style>:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark}body{margin:0;padding:0;background:transparent}.status{display:none;padding:8px 10px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}.status.on{display:block}</style></head>
<body><div id="status" class="status"></div>
<script>
const statusEl=document.getElementById('status');
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
  const file=new File([bytes],p.file_name,{type:p.mime_type});
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
