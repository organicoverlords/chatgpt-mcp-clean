import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ChatGPT can retain an MCP app template URI from a prior backend generation and
// fetch it after the connector has advanced to a newer backend. Keep historical
// template URIs readable so that a successful tool result does not degrade into
// "Failed to fetch template" during a generation handoff.
export const LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URI = "ui://process/library-upload-v2.html";

export function templateCompatibilityHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:transparent"><script>
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const m=event.data;if(m?.jsonrpc!=='2.0')return;if(m.id==='template-compat-init'&&('result'in m||'error'in m)){if(!m.error)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');}});
window.parent.postMessage({jsonrpc:'2.0',id:'template-compat-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'mcp-template-compat',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}},'*');
</script></body></html>`;
}

export function registerTemplateCompatibilityResources(server: McpServer): void {
  server.registerResource(
    "legacy-process-library-upload-widget-compat",
    LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URI,
    {},
    async () => ({
      contents: [{
        uri: LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URI,
        mimeType: "text/html;profile=mcp-app",
        text: templateCompatibilityHtml(),
      }],
    }),
  );
}
