import assert from "node:assert/strict";
import { fileTransferWidgetHtml } from "../dist/lib/file-transfer.js";

delete process.env.MCP_LIBRARY_SPOOL_BRIDGE;
delete process.env.MCP_RUNTIME_INSTANCE_ID;
const widget = fileTransferWidgetHtml();
assert.match(widget, /FILE_TRANSFER_NATIVE_RESOURCE/);
assert.doesNotMatch(widget, /<script>|uploadFile|setWidgetState|requestClose|toolResponseMetadata|ui\/notifications\/tool-result|notifyIntrinsicHeight|imageIds/);
console.log("PASS file_transfer_widget_lifecycle inert_compatibility=1 upload=0 state=0 close=0");

process.env.MCP_RUNTIME_INSTANCE_ID = "issue333-persistent-widget-compat-test";
process.env.MCP_LIBRARY_SPOOL_BRIDGE = "0";
const forcedOffWidget = fileTransferWidgetHtml();
assert.match(forcedOffWidget, /FILE_TRANSFER_NATIVE_RESOURCE/);
assert.doesNotMatch(forcedOffWidget, /<script>|uploadFile|setWidgetState/, "explicit bridge-off must override legacy instance-name inference");

process.env.MCP_LIBRARY_SPOOL_BRIDGE = "1";
const bridgeWidget = fileTransferWidgetHtml();
assert.match(bridgeWidget, /<img id="image" class="image"/);
assert.match(bridgeWidget, /uploadFile/);
assert.match(bridgeWidget, /setWidgetState/);
assert.doesNotMatch(bridgeWidget, /imageIds/);
console.log("PASS file_transfer_widget_model_isolation human_preview=1 model_image_ids=0");
