import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const VISUAL_PROOF_WIDGET_URI = "ui://visual-proof/inline-v1.html";

export function registerVisualProofApp(server: McpServer): void {
  server.registerResource("visual-proof-widget", VISUAL_PROOF_WIDGET_URI, {}, async () => ({
    contents: [{uri: VISUAL_PROOF_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: visualProofWidgetHtml()}],
  }));
  server.registerTool("open_visual_proof", {
    description: "Open an existing indexed P3 or Tiny3D image by asset name or exact run ID. Returns the stored image for visual inspection and an inline viewer with identity and review state. Does not capture or regenerate assets.",
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    inputSchema: z.object({query: z.string().min(1).max(200), source: z.enum(["auto", "p3", "tiny3d"]).default("auto")}),
    _meta: {ui: {resourceUri: VISUAL_PROOF_WIDGET_URI}, "openai/outputTemplate": VISUAL_PROOF_WIDGET_URI},
  }, async ({query, source}) => visualProofToolResult(query, {source}));
}

const DEFAULT_P3_ROOT = "G:\\Oma Drive\\P3 Visual Evidence\\p3";
const DEFAULT_TINY3D_ROOT = "C:\\Users\\Lauri\\Desktop\\Tiny3D_LIBRARY";
const MAX_P3_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_TINY3D_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 1_250_000;
const MAX_VIDEO_BYTES = 1_000_000;
const MAX_TOTAL_BINARY_BYTES = 1_500_000;

const IMAGE_MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const VIDEO_MIME: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };

type JsonObject = Record<string, any>;
export type VisualProofSource = "auto" | "tiny3d" | "p3";

export interface VisualProofMetadata {
  schema: "chatgpt.visual-proof-inline.v1";
  query: string;
  source: "tiny3d" | "p3";
  identity: string;
  title: string;
  date: string | null;
  evidence_type: "durable_p3_proof" | "p3_archive" | "showcase" | "preview";
  independent_review_state: string;
  strongest_state: string | null;
  is_runtime_proof: boolean | null;
  capture_mode?: string | null;
  scope: string;
  claim: string | null;
  gaps: string[];
  image: { role: string; mime_type: string; bytes: number; sha256: string; stored_path: string };
  video: null | { role: string; mime_type: string; bytes: number; sha256: string; stored_path: string };
}

export interface VisualProofResolved {
  metadata: VisualProofMetadata;
  image: Buffer;
  video: Buffer | null;
}

function p3Root(override?: string): string {
  return resolve(override?.trim() || process.env.P3_VISUAL_EVIDENCE_ROOT?.trim() || DEFAULT_P3_ROOT);
}

function tiny3dRoot(override?: string): string {
  return resolve(override?.trim() || process.env.TINY3D_LIBRARY_ROOT?.trim() || DEFAULT_TINY3D_ROOT);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveContained(root: string, rawPath: string): string {
  if (!rawPath || isAbsolute(rawPath)) throw new Error("visual proof path must be root-relative");
  const candidate = resolve(root, rawPath);
  if (!inside(root, candidate)) throw new Error("visual proof path escapes its durable root");
  return candidate;
}

async function readBounded(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!inside(actualRoot, actualPath)) throw new Error("visual proof real path escapes its durable root");
  const file = await open(actualPath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error("file is missing or exceeds byte ceiling");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes || length !== info.size) throw new Error("file size changed or exceeds byte ceiling");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

async function readJsonBounded(root: string, path: string, maxBytes: number): Promise<JsonObject> {
  return JSON.parse((await readBounded(root, path, maxBytes)).toString("utf8"));
}

async function readIndex(root: string, path: string, maxBytes: number): Promise<JsonObject | null> {
  try { return await readJsonBounded(root, path, maxBytes); }
  catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function queryMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return haystack.includes(query) || compact(haystack).includes(compact(query));
}

function mimeFor(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return IMAGE_MIME[ext] || VIDEO_MIME[ext] || null;
}

function isImage(path: string): boolean {
  return !!IMAGE_MIME[extname(path).toLowerCase()];
}

function isVideo(path: string): boolean {
  return !!VIDEO_MIME[extname(path).toLowerCase()];
}

async function readExactMedia(
  root: string,
  rawPath: string,
  expectedBytes: number | null,
  expectedSha: string | null,
  kind: "image" | "video",
): Promise<{ data: Buffer; path: string; bytes: number; sha256: string; mimeType: string }> {
  const path = resolveContained(root, rawPath);
  const max = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  const mimeType = mimeFor(rawPath);
  if (!mimeType || (kind === "image" ? !isImage(rawPath) : !isVideo(rawPath))) throw new Error(`unsupported ${kind} media type: ${rawPath}`);
  if (!expectedSha || !/^[a-f0-9]{64}$/i.test(expectedSha)) throw new Error(`${kind} has no valid stored SHA-256: ${rawPath}`);
  const data = await readBounded(root, path, max);
  if (expectedBytes != null && data.length !== expectedBytes) throw new Error(`${kind} size changed from its durable receipt/index: ${rawPath}`);
  const digest = sha256(data);
  if (expectedSha && digest !== expectedSha.toLowerCase()) throw new Error(`${kind} SHA-256 changed from its durable receipt/index: ${rawPath}`);
  return { data, path, bytes: data.length, sha256: digest, mimeType };
}

function reviewScore(state: string): number {
  if (state === "PROVEN") return 100;
  if (state === "NOT_RECORDED") return 20;
  if (state === "REJECTED") return -200;
  return 0;
}

function p3Rank(entry: JsonObject, query: string): number {
  if (String(entry.run_id || "").toLowerCase() === query) return 10000;
  const state = typeof entry.independent_review_state === "string" ? entry.independent_review_state : "NOT_RECORDED";
  let score = reviewScore(state);
  const q = compact(query);
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((x: unknown) => typeof x === "string") : [];
  if (tags.some((tag: string) => compact(tag) === q)) score += 500;
  const runId = String(entry.run_id || "").toLowerCase();
  const claim = String(entry.claim || "").toLowerCase();
  if (queryMatches(runId, query)) score += 50;
  if (queryMatches(claim, query)) score += 40;
  if (/runtime/i.test(runId)) score += 3;
  return score;
}

function p3Media(entry: JsonObject): { image: JsonObject | null; video: JsonObject | null } {
  const media = Array.isArray(entry.media) ? entry.media.filter((x: unknown) => x && typeof x === "object" && typeof (x as JsonObject).path === "string") as JsonObject[] : [];
  const images = media.filter((item) => isImage(item.path) && Number(item.bytes) > 0 && Number(item.bytes) <= MAX_IMAGE_BYTES);
  images.sort((a, b) => {
    const rank = (p: string) => /contact[-_ ]?sheet/i.test(p) ? 4 : /accepted/i.test(p) ? 3 : /screenshot|visible-content/i.test(p) ? 2 : 1;
    return rank(b.path) - rank(a.path) || String(a.path).localeCompare(String(b.path));
  });
  const videos = media.filter((item) => isVideo(item.path) && Number(item.bytes) > 0 && Number(item.bytes) <= MAX_VIDEO_BYTES)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { image: images[0] || null, video: videos[0] || null };
}

async function resolveP3(query: string, rootOverride?: string): Promise<VisualProofResolved | null> {
  const root = p3Root(rootOverride);
  const indexPath = resolve(root, "index-v1.json");
  const index = await readIndex(root, indexPath, MAX_P3_INDEX_BYTES);
  if (!index) return null;
  if (index.schema !== "p3.visual-evidence-index.v1" || !Array.isArray(index.entries)) throw new Error("P3 visual evidence index schema is invalid");
  const exactRunRequested = index.entries.some((entry: JsonObject) => String(entry.run_id || "").toLowerCase() === query);
  const queryTerms = (query.match(/[a-z0-9_]+/g) || []).filter(Boolean);
  const latestRequested = !exactRunRequested && queryTerms.includes("latest");
  const searchTerms = latestRequested ? queryTerms.filter((term) => term !== "latest") : queryTerms;
  const semanticQuery = searchTerms.join(" ");
  const candidates = index.entries
    .filter((entry: JsonObject) => String(entry.run_id || "").toLowerCase() === query ||
      (latestRequested && searchTerms.length === 0) ||
      (semanticQuery && typeof entry.search_text === "string" && queryMatches(entry.search_text, semanticQuery)))
    .map((entry: JsonObject) => ({ entry, media: p3Media(entry) }))
    .filter((item: { media: { image: JsonObject | null } }) => !!item.media.image)
    .sort((a: any, b: any) => {
      if (latestRequested) {
        return String(b.entry.evidence_utc || "").localeCompare(String(a.entry.evidence_utc || "")) ||
          String(b.entry.date || "").localeCompare(String(a.entry.date || "")) ||
          String(b.entry.run_id || "").localeCompare(String(a.entry.run_id || ""));
      }
      return p3Rank(b.entry, query) - p3Rank(a.entry, query) ||
        String(b.entry.date || "").localeCompare(String(a.entry.date || "")) ||
        String(a.entry.run_id).localeCompare(String(b.entry.run_id));
    });
  const selected = candidates[0];
  if (!selected) return null;
  const { entry, media } = selected;
  if (!media.image) return null;
  if (media.image.declared_size_matches === false) throw new Error("selected P3 image has a declared size mismatch");
  const image = await readExactMedia(root, media.image.path, Number(media.image.bytes), typeof media.image.declared_sha256 === "string" ? media.image.declared_sha256 : null, "image");
  let video: Awaited<ReturnType<typeof readExactMedia>> | null = null;
  if (media.video) {
    if (media.video.declared_size_matches === false) throw new Error("selected P3 video has a declared size mismatch");
    video = await readExactMedia(root, media.video.path, Number(media.video.bytes), typeof media.video.declared_sha256 === "string" ? media.video.declared_sha256 : null, "video");
  }
  if (image.bytes + (video?.bytes || 0) > MAX_TOTAL_BINARY_BYTES) video = null;
  const state = typeof entry.independent_review_state === "string" ? entry.independent_review_state : "NOT_RECORDED";
  const scope = state === "PROVEN"
    ? "Independently reviewed P3 visual evidence: PROVEN."
    : state === "REJECTED"
      ? "Independently reviewed P3 visual evidence: REJECTED. Do not present this capture as accepted proof."
      : state === "NOT_PROVEN"
        ? "Independently reviewed P3 visual evidence: NOT_PROVEN. This capture does not establish visual acceptance."
        : "P3 visual capture with independent review NOT_RECORDED. This is not visual acceptance.";
  const metadata: VisualProofMetadata = {
    schema: "chatgpt.visual-proof-inline.v1",
    query,
    source: "p3",
    identity: String(entry.run_id),
    title: String(entry.claim || entry.annotation_labels?.[0] || entry.run_id),
    date: typeof entry.date === "string" ? entry.date : null,
    evidence_type: "p3_archive",
    independent_review_state: state,
    strongest_state: null,
    is_runtime_proof: null,
    capture_mode: typeof entry.mode === "string" ? entry.mode : null,
    scope,
    claim: typeof entry.claim === "string" ? entry.claim : null,
    gaps: Array.isArray(entry.gaps) ? entry.gaps.filter((x: unknown) => typeof x === "string") : [],
    image: { role: /contact[-_ ]?sheet/i.test(media.image.path) ? "contact_sheet" : "capture", mime_type: image.mimeType, bytes: image.bytes, sha256: image.sha256, stored_path: media.image.path },
    video: video && media.video ? { role: "motion", mime_type: video.mimeType, bytes: video.bytes, sha256: video.sha256, stored_path: media.video.path } : null,
  };
  return { metadata, image: image.data, video: video?.data || null };
}

function tiny3dScore(record: JsonObject, assetId: string, query: string): number {
  let score = 0;
  const q = query.toLowerCase();
  if (assetId.toLowerCase() === q) score += 1000;
  if (queryMatches(String(record.display_name || ""), q)) score += 150;
  if (queryMatches(String(record.source?.name || ""), q)) score += 150;
  if (queryMatches(JSON.stringify(record), q)) score += 10;
  return score;
}

async function readOptionalJson(root: string, path: string): Promise<JsonObject | null> {
  try { return await readJsonBounded(root, path, MAX_RECEIPT_BYTES); } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveTiny3D(query: string, rootOverride?: string): Promise<VisualProofResolved | null> {
  const root = tiny3dRoot(rootOverride);
  const indexPath = resolve(root, ".tiny3d", "library", "index-v1.json");
  const index = await readIndex(root, indexPath, MAX_TINY3D_INDEX_BYTES);
  if (!index) return null;
  if (index.schema !== "tinylab.asset-library-cache.v1" || !index.entries || typeof index.entries !== "object" || Array.isArray(index.entries)) throw new Error("Tiny3D library cache schema is invalid");
  const matches = Object.entries(index.entries)
    .map(([assetId, raw]: [string, any]) => ({ assetId, record: raw?.record && typeof raw.record === "object" ? raw.record : raw }))
    .map((item) => ({ ...item, score: tiny3dScore(item.record || {}, item.assetId, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.record?.display_name || a.assetId).localeCompare(String(b.record?.display_name || b.assetId)));
  const selected = matches[0];
  if (!selected) return null;
  const { assetId, record } = selected;
  const assetDir = resolve(root, assetId);
  if (!inside(root, assetDir)) throw new Error("Tiny3D asset path escapes library root");
  if (!inside(await realpath(root), await realpath(assetDir))) throw new Error("Tiny3D asset real path escapes library root");
  const proof = record?.proof && typeof record.proof === "object" ? record.proof : {};
  const strongest = typeof proof.strongest_state === "string" ? proof.strongest_state : null;
  const reviewed = Array.isArray(proof.reviewed_visual_proof) ? proof.reviewed_visual_proof.filter((x: unknown) => x && typeof x === "object") as JsonObject[] : [];
  for (const item of reviewed) {
    const raw = typeof item.durable_path === "string" ? item.durable_path : null;
    if (!raw || !isImage(raw)) continue;
    const image = await readExactMedia(assetDir, raw, null, typeof item.sha256 === "string" ? item.sha256 : null, "image");
    let video: Awaited<ReturnType<typeof readExactMedia>> | null = null;
    if (typeof item.durable_motion_sequence_path === "string" && isVideo(item.durable_motion_sequence_path)) {
      video = await readExactMedia(assetDir, item.durable_motion_sequence_path, null, typeof item.motion_sequence_sha256 === "string" ? item.motion_sequence_sha256 : null, "video");
      if (image.bytes + video.bytes > MAX_TOTAL_BINARY_BYTES) video = null;
    }
    const state = typeof item.independent_review_state === "string" ? item.independent_review_state : "NOT_RECORDED";
    return {
      metadata: {
        schema: "chatgpt.visual-proof-inline.v1", query, source: "tiny3d", identity: assetId,
        title: String(record.display_name || record.source?.name || assetId), date: null, evidence_type: "durable_p3_proof",
        independent_review_state: state, strongest_state: strongest, is_runtime_proof: proof.states?.P3_RUNTIME_PROVEN === true,
        scope: state === "PROVEN" ? "Hash-verified asset-local durable P3 proof with independent review PROVEN." : "Hash-verified asset-local durable P3 proof; independent review is not recorded as PROVEN.",
        claim: null, gaps: Array.isArray(proof.metadata_gaps) ? proof.metadata_gaps : [],
        image: { role: "durable_reviewed", mime_type: image.mimeType, bytes: image.bytes, sha256: image.sha256, stored_path: raw },
        video: video ? { role: "durable_motion", mime_type: video.mimeType, bytes: video.bytes, sha256: video.sha256, stored_path: item.durable_motion_sequence_path } : null,
      }, image: image.data, video: video?.data || null,
    };
  }

  const showcasePath = resolve(assetDir, "receipts", "showcase_evidence.json");
  const showcase = await readOptionalJson(root, showcasePath);
  if (showcase?.schema === "tiny3d.showcase-evidence.v1" && Array.isArray(showcase.media)) {
    const imageItem = showcase.media.find((x: any) => typeof x?.path === "string" && isImage(x.path) && Number(x.bytes) <= MAX_IMAGE_BYTES);
    const videoItem = showcase.media.find((x: any) => typeof x?.path === "string" && isVideo(x.path) && Number(x.bytes) <= MAX_VIDEO_BYTES);
    if (imageItem) {
      const image = await readExactMedia(assetDir, imageItem.path, Number(imageItem.bytes), typeof imageItem.sha256 === "string" ? imageItem.sha256 : null, "image");
      let video: Awaited<ReturnType<typeof readExactMedia>> | null = null;
      if (videoItem) {
        video = await readExactMedia(assetDir, videoItem.path, Number(videoItem.bytes), typeof videoItem.sha256 === "string" ? videoItem.sha256 : null, "video");
        if (image.bytes + video.bytes > MAX_TOTAL_BINARY_BYTES) video = null;
      }
      return {
        metadata: {
          schema: "chatgpt.visual-proof-inline.v1", query, source: "tiny3d", identity: assetId,
          title: String(record.display_name || record.source?.name || assetId), date: null, evidence_type: "showcase",
          independent_review_state: "NOT_RECORDED", strongest_state: strongest, is_runtime_proof: false,
          scope: `${String(showcase.proof_scope || "Tiny3D showcase evidence")}; independent visual review NOT_RECORDED and P3 runtime is not implied.`,
          claim: null, gaps: ["independent_review_not_recorded", ...(showcase.claims?.p3_runtime === "NOT_PROVEN" ? ["p3_runtime_not_proven"] : [])],
          image: { role: "showcase_motion_image", mime_type: image.mimeType, bytes: image.bytes, sha256: image.sha256, stored_path: imageItem.path },
          video: video ? { role: "showcase_motion_video", mime_type: video.mimeType, bytes: video.bytes, sha256: video.sha256, stored_path: videoItem.path } : null,
        }, image: image.data, video: video?.data || null,
      };
    }
  }

  const thumb = record?.preview?.thumbnail;
  if (thumb?.status === "available" && typeof thumb.path === "string" && isImage(thumb.path)) {
    const image = await readExactMedia(assetDir, thumb.path, null, typeof thumb.sha256 === "string" ? thumb.sha256 : null, "image");
    return {
      metadata: {
        schema: "chatgpt.visual-proof-inline.v1", query, source: "tiny3d", identity: assetId,
        title: String(record.display_name || record.source?.name || assetId), date: null, evidence_type: "preview",
        independent_review_state: "NOT_RECORDED", strongest_state: strongest, is_runtime_proof: false,
        scope: "Verified Tiny3D library preview only; this is not P3 runtime proof or independent visual acceptance.",
        claim: null, gaps: ["independent_review_not_recorded", "runtime_proof_not_shown"],
        image: { role: "library_thumbnail", mime_type: image.mimeType, bytes: image.bytes, sha256: image.sha256, stored_path: thumb.path },
        video: null,
      }, image: image.data, video: null,
    };
  }
  return null;
}

export async function resolveVisualProof(
  query: string,
  options: { source?: VisualProofSource; p3Root?: string; tiny3dRoot?: string } = {},
): Promise<VisualProofResolved> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) throw new Error("visual proof query must not be empty");
  if (normalized.length > 200) throw new Error("visual proof query is too long");
  const source = options.source || "auto";
  if (source === "p3") {
    const result = await resolveP3(normalized, options.p3Root);
    if (!result) throw new Error(`No indexed P3 visual proof matches: ${normalized}`);
    return result;
  }
  if (source === "tiny3d") {
    const result = await resolveTiny3D(normalized, options.tiny3dRoot);
    if (!result) throw new Error(`No indexed Tiny3D visual proof matches: ${normalized}`);
    return result;
  }
  const runtimeTerms = ["spell", "meteor", "lane war", "lanewar", "battlefield", "map", "combat"];
  const resolvers = runtimeTerms.some((term) => normalized.includes(term))
    ? [() => resolveP3(normalized, options.p3Root), () => resolveTiny3D(normalized, options.tiny3dRoot)]
    : [() => resolveTiny3D(normalized, options.tiny3dRoot), () => resolveP3(normalized, options.p3Root)];
  for (const resolver of resolvers) {
    const result = await resolver();
    if (result) return result;
  }
  throw new Error(`No indexed visual proof matches: ${normalized}`);
}

export async function visualProofToolResult(
  query: string,
  options: { source?: VisualProofSource; p3Root?: string; tiny3dRoot?: string } = {},
) {
  const resolved = await resolveVisualProof(query, options);
  const summary = {
    ...resolved.metadata,
    image: { ...resolved.metadata.image },
    video: resolved.metadata.video ? { ...resolved.metadata.video } : null,
  };
  const content: any[] = [
    { type: "text" as const, text: JSON.stringify(summary) },
    { type: "image" as const, data: resolved.image.toString("base64"), mimeType: resolved.metadata.image.mime_type, annotations: { audience: ["assistant", "user"] as const } },
  ];
  if (resolved.video && resolved.metadata.video) {
    content.push({
      type: "resource" as const,
      resource: {
        uri: `proof://${resolved.metadata.source}/${encodeURIComponent(resolved.metadata.identity)}/video`,
        mimeType: resolved.metadata.video.mime_type,
        blob: resolved.video.toString("base64"),
      },
      annotations: { audience: ["user"] as const },
    });
  }
  return {
    content,
    structuredContent: summary,
    _meta: { "openai/outputTemplate": VISUAL_PROOF_WIDGET_URI, ui: { resourceUri: VISUAL_PROOF_WIDGET_URI } },
  };
}

export function visualProofWidgetHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark}body{margin:0;padding:12px;background:transparent}.card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:14px;overflow:hidden}.media{background:#101010;display:flex;align-items:center;justify-content:center;min-height:120px}.media img,.media video{display:block;max-width:100%;max-height:70vh}.meta{padding:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.badge{font-size:12px;font-weight:700;border:1px solid currentColor;border-radius:999px;padding:2px 8px}.title{font-weight:700}.scope{margin-top:8px;font-size:13px;opacity:.85}.hash{margin-top:8px;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;opacity:.7}.media .hidden{display:none}</style></head>
<body><div class="card"><div class="media"><img id="image" alt="Visual proof"><video id="video" class="hidden" controls loop muted playsinline></video></div><div class="meta"><div class="row"><span class="title" id="title">Visual proof</span><span class="badge" id="review"></span><span class="badge" id="kind"></span></div><div class="scope" id="scope"></div><div class="hash" id="identity"></div><div class="hash" id="hash"></div></div></div>
<script>
const $=id=>document.getElementById(id);
function render(result){
 const meta=result?.structuredContent||result?._meta?.structuredContent||{};
 const content=Array.isArray(result?.content)?result.content:[];
 const image=content.find(x=>x?.type==='image'&&x.data&&x.mimeType);
 const video=content.find(x=>x?.type==='resource'&&x.resource?.blob&&String(x.resource?.mimeType||'').startsWith('video/'));
 $('image').removeAttribute('src');$('image').classList.add('hidden');
 $('video').pause();$('video').removeAttribute('src');$('video').load();$('video').classList.add('hidden');
 $('title').textContent=meta.title||meta.identity||'Visual proof';
 $('review').textContent=meta.independent_review_state||'NOT_RECORDED';
 $('kind').textContent=meta.evidence_type||'';
 $('scope').textContent=meta.scope||'';
 $('identity').textContent=(meta.source?meta.source+' Â· ':'')+(meta.identity||'');
 $('hash').textContent=meta.image?.sha256?'image sha256 '+meta.image.sha256:'';
 if(image){$('image').src='data:'+image.mimeType+';base64,'+image.data;$('image').classList.remove('hidden');}
 if(video){$('video').src='data:'+video.resource.mimeType+';base64,'+video.resource.blob;$('video').classList.remove('hidden');}
}
window.addEventListener('message',event=>{
 if(event.source!==window.parent)return;const m=event.data;if(m?.jsonrpc!=='2.0')return;
 if(m.id==='visual-proof-init'&&('result' in m||'error' in m)){
  if(m.error||m.result?.protocolVersion!=='2026-01-26'){$('scope').textContent='Visual viewer initialization failed';return;}
  window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');return;
 }
 if(m.method==='ui/notifications/tool-result')render(m.params||{});
});
const envelope=window.openai?.toolResponseMetadata?.mcp_tool_result;
if(envelope)render(envelope);
else if(window.openai?.toolOutput)render({structuredContent:window.openai.toolOutput,content:[]});
window.parent.postMessage({jsonrpc:'2.0',id:'visual-proof-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'visual-proof',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}},'*');
</script></body></html>`;
}
