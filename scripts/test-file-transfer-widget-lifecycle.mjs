import assert from "node:assert/strict";
import { fileTransferWidgetHtml } from "../dist/lib/file-transfer.js";

const widget = fileTransferWidgetHtml();
assert.match(widget, /FILE_TRANSFER_NATIVE_RESOURCE/);
assert.doesNotMatch(widget, /<script>|uploadFile|setWidgetState|requestClose|toolResponseMetadata|ui\/notifications\/tool-result|notifyIntrinsicHeight|imageIds/);
console.log("PASS file_transfer_widget_lifecycle inert_compatibility=1 upload=0 state=0 close=0");
