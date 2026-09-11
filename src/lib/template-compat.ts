import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ChatGPT can retain an MCP app template URI from a prior backend generation and
// fetch it after the connector has advanced to a newer backend. Keep historical
// template URIs readable so successful tool execution cannot degrade solely because
// an older ChatGPT-side template reference outlives the generation that created it.
export const LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URIS = [
  "ui://process/library-upload-v1.html",
  "ui://process/library-upload-v2.html",
] as const;
export const LEGACY_VISUAL_PROOF_WIDGET_URI = "ui://visual-proof/inline-v1.html";

export function templateCompatibilityHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:transparent"><script>
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const m=event.data;if(m?.jsonrpc!=='2.0')return;if(m.id==='template-compat-init'&&('result'in m||'error'in m)){if(!m.error)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');}});
window.parent.postMessage({jsonrpc:'2.0',id:'template-compat-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'mcp-template-compat',version:'1.1.0'},appCapabilities:{availableDisplayModes:['inline']}}},'*');
</script></body></html>`;
}

function registerCompatResource(server: McpServer, name: string, uri: string): void {
  server.registerResource(name, uri, {}, async () => ({
    contents: [{
      uri,
      mimeType: "text/html;profile=mcp-app",
      text: templateCompatibilityHtml(),
    }],
  }));
}

export function registerTemplateCompatibilityResources(server: McpServer): void {
  LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URIS.forEach((uri, index) =>
    registerCompatResource(server, `legacy-process-library-upload-widget-v${index + 1}-compat`, uri));

  // The full visual-proof profile registers the real resource later in index.ts.
  // Process/file-transfer profiles still keep the historical visual URI readable.
  const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
  const realVisualAppWillRegister = toolProfile === "full" && process.env.MCP_VISUAL_PROOF_UI === "1";
  if (!realVisualAppWillRegister) {
    registerCompatResource(server, "legacy-visual-proof-widget-compat", LEGACY_VISUAL_PROOF_WIDGET_URI);
  }
}
