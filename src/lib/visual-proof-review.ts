import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VISUAL_PROOF_WIDGET_URI } from "./visual-proof-app.js";

const execFileAsync = promisify(execFile);
const DEFAULT_STAGING_ROOT = "C:\\P3Proofs";
const DEFAULT_P3_REPO_ROOT = "C:\\Users\\Lauri\\Documents\\Unreal Projects\\p3";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REVIEW_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 1_250_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type JsonObject = Record<string, any>;

export interface StagingProofResolved {
  root: string;
  runPath: string;
  manifestPath: string;
  reviewedPath: string;
  manifest: JsonObject;
  reviewed: JsonObject | null;
  imagePath: string;
  image: Buffer;
  imageSha256: string;
  imageMimeType: string;
  imageRole: "primary" | "contact_sheet";
}

export interface StagingProofSummary extends Record<string, unknown> {
  source: "p3-staging";
  identity: string;
  claim: string | null;
  map: string | null;
  producer: string | null;
  independent_review_state: string;
  review_present: boolean;
  image: {
    filename: string;
    role: "primary" | "contact_sheet";
    bytes: number;
    sha256: string;
    mime_type: string;
  };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function cleanRunId(runId: string): string {
  const value = runId.trim();
  if (!RUN_ID.test(value) || value === "." || value === "..") throw new Error("P3_VISUAL_REVIEW_RUN_ID_INVALID");
  return value;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`P3_VISUAL_REVIEW_NOT_FILE path=${path}`);
    if (info.size <= 0 || info.size > maxBytes) throw new Error(`P3_VISUAL_REVIEW_FILE_SIZE path=${path} bytes=${info.size} max=${maxBytes}`);
    return Buffer.from(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function readJsonBounded(path: string, maxBytes: number): Promise<JsonObject> {
  const text = (await readBounded(path, maxBytes)).toString("utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as JsonObject;
}

async function existingJson(path: string, maxBytes: number): Promise<JsonObject | null> {
  try { return await readJsonBounded(path, maxBytes); }
  catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function expectedSha(holder: JsonObject | undefined, field: string): string {
  const value = String(holder?.[field] || "").trim().toLowerCase();
  if (!SHA256.test(value)) throw new Error(`P3_VISUAL_REVIEW_SHA_REQUIRED field=${field}`);
  return value;
}

async function containedExisting(rootReal: string, candidate: string, label: string): Promise<string> {
  const candidateReal = await realpath(candidate);
  if (!inside(rootReal, candidateReal)) throw new Error(`P3_VISUAL_REVIEW_PATH_ESCAPE name=${label}`);
  return candidateReal;
}

export async function resolveStagingProof(
  runId: string,
  options: { stagingRoot?: string } = {},
): Promise<StagingProofResolved> {
  const identity = cleanRunId(runId);
  const root = resolve(options.stagingRoot || process.env.P3_VISUAL_PROOF_STAGING_ROOT || DEFAULT_STAGING_ROOT);
  const rootReal = await realpath(root);
  const runPath = await containedExisting(rootReal, resolve(root, identity), "run");
  const runRelative = relative(rootReal, runPath);
  if (!runRelative || runRelative.includes("\\") || runRelative.includes("/")) throw new Error("P3_VISUAL_REVIEW_RUN_NOT_DIRECT_CHILD");
  const runInfo = await stat(runPath);
  if (!runInfo.isDirectory()) throw new Error("P3_VISUAL_REVIEW_RUN_NOT_DIRECTORY");

  const manifestPath = await containedExisting(rootReal, resolve(runPath, "manifest.json"), "manifest");
  const manifest = await readJsonBounded(manifestPath, MAX_MANIFEST_BYTES);
  const mode = String(manifest.mode || "").toLowerCase();
  let imageRaw = String(manifest?.primary?.path || "");
  let imageExpected = expectedSha(manifest?.primary, "sha256");
  let imageRole: "primary" | "contact_sheet" = "primary";
  if (mode === "video" && manifest?.review?.contact_sheet) {
    imageRaw = String(manifest.review.contact_sheet);
    imageExpected = expectedSha(manifest.review, "contact_sheet_sha256");
    imageRole = "contact_sheet";
  }
  if (!imageRaw.trim()) throw new Error("P3_VISUAL_REVIEW_IMAGE_PATH_REQUIRED");
  const filename = basename(imageRaw);
  if (!filename || filename === "." || filename === "..") throw new Error("P3_VISUAL_REVIEW_IMAGE_NAME_INVALID");
  const imagePath = await containedExisting(runPath, resolve(runPath, filename), "image");
  const mime = IMAGE_MIME[extname(imagePath).toLowerCase()];
  if (!mime) throw new Error(`P3_VISUAL_REVIEW_IMAGE_TYPE_UNSUPPORTED file=${filename}`);
  const image = await readBounded(imagePath, MAX_IMAGE_BYTES);
  const actual = sha256(image);
  if (actual !== imageExpected) throw new Error(`P3_VISUAL_REVIEW_IMAGE_HASH_MISMATCH expected=${imageExpected} actual=${actual}`);

  const declaredBytes = imageRole === "primary" ? Number(manifest?.primary?.bytes || 0) : Number(manifest?.review?.contact_sheet_bytes || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > 0 && declaredBytes !== image.length) {
    throw new Error(`P3_VISUAL_REVIEW_IMAGE_SIZE_MISMATCH expected=${declaredBytes} actual=${image.length}`);
  }

  const reviewedPath = resolve(runPath, "reviewed.json");
  const reviewed = await existingJson(reviewedPath, MAX_REVIEW_BYTES);
  if (reviewed) {
    const reviewedImageSha = String(reviewed.reviewed_image_sha256 || "").trim().toLowerCase();
    if (!SHA256.test(reviewedImageSha) || reviewedImageSha !== actual) {
      throw new Error(`P3_VISUAL_REVIEW_RECORDED_IMAGE_MISMATCH expected=${actual} actual=${reviewedImageSha || "missing"}`);
    }
  }
  return { root: rootReal, runPath, manifestPath, reviewedPath, manifest, reviewed, imagePath, image, imageSha256: actual, imageMimeType: mime, imageRole };
}

export function stagingProofSummary(runId: string, resolved: StagingProofResolved): StagingProofSummary {
  return {
    source: "p3-staging",
    identity: cleanRunId(runId),
    claim: resolved.manifest?.claim ? String(resolved.manifest.claim) : null,
    map: resolved.manifest?.map ? String(resolved.manifest.map) : null,
    producer: resolved.manifest?.actor ? String(resolved.manifest.actor) : null,
    independent_review_state: resolved.reviewed ? String(resolved.reviewed.review_status || "NOT_RECORDED") : "PENDING_REVIEW",
    review_present: Boolean(resolved.reviewed),
    image: {
      filename: basename(resolved.imagePath), role: resolved.imageRole, bytes: resolved.image.length,
      sha256: resolved.imageSha256, mime_type: resolved.imageMimeType,
    },
  };
}

export async function stagingProofToolResult(runId: string, options: { stagingRoot?: string } = {}) {
  const resolved = await resolveStagingProof(runId, options);
  const summary = stagingProofSummary(runId, resolved);
  const content: any[] = [
    { type: "text" as const, text: JSON.stringify(summary) },
    { type: "image" as const, data: resolved.image.toString("base64"), mimeType: resolved.imageMimeType, annotations: { audience: ["assistant", "user"] as const } },
  ];
  return {
    content,
    structuredContent: summary,
    _meta: { "openai/outputTemplate": VISUAL_PROOF_WIDGET_URI, ui: { resourceUri: VISUAL_PROOF_WIDGET_URI } },
  };
}

export interface RecordReviewInput {
  run_id: string;
  expected_image_sha256: string;
  observed_label: string;
  reviewer: string;
  expected_map?: string;
  claim?: string;
  evidence_window?: string;
  visual_verdict: "PROVEN" | "NOT_PROVEN" | "REJECTED";
  inspection_mode: "WATCHED_VIDEO" | "INSPECTED_FRAME_SEQUENCE";
  identity_check: "MATCH" | "MISMATCH" | "UNCLEAR";
  quality_check: "GOOD" | "DEFECTIVE" | "UNCLEAR";
  visual_findings: string;
}

function addArg(args: string[], name: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  args.push(name, value);
}

export async function recordStagingReview(
  input: RecordReviewInput,
  options: { stagingRoot?: string; p3RepoRoot?: string; powershell?: string; publishScript?: string; publisherRunner?: (args: string[]) => Promise<string> } = {},
): Promise<JsonObject> {
  const expected = input.expected_image_sha256.trim().toLowerCase();
  if (!SHA256.test(expected)) throw new Error("P3_VISUAL_REVIEW_EXPECTED_SHA_INVALID");
  const before = await resolveStagingProof(input.run_id, { stagingRoot: options.stagingRoot });
  if (before.imageSha256 !== expected) throw new Error(`P3_VISUAL_REVIEW_EXPECTED_SHA_MISMATCH expected=${expected} actual=${before.imageSha256}`);
  if (before.reviewed) throw new Error(`P3_VISUAL_REVIEW_ALREADY_RECORDED status=${before.reviewed.review_status || "UNKNOWN"}`);

  const repoRoot = resolve(options.p3RepoRoot || process.env.P3_REPO_ROOT || DEFAULT_P3_REPO_ROOT);
  const publishScript = resolve(options.publishScript || repoRoot, options.publishScript ? "" : "scripts/Publish-P3ReviewedVisualEvidence.ps1");
  const repoReal = await realpath(repoRoot);
  const scriptReal = await realpath(publishScript);
  if (!inside(repoReal, scriptReal)) throw new Error("P3_VISUAL_REVIEW_PUBLISHER_OUTSIDE_REPO");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptReal,
    "-ProofRoot", before.root, "-RunPath", before.runPath,
    "-ObservedLabel", input.observed_label, "-Reviewer", input.reviewer,
    "-VisualVerdict", input.visual_verdict, "-InspectionMode", input.inspection_mode,
    "-IdentityCheck", input.identity_check, "-QualityCheck", input.quality_check,
    "-VisualFindings", input.visual_findings,
  ];
  addArg(args, "-ExpectedMap", input.expected_map);
  addArg(args, "-Claim", input.claim);
  addArg(args, "-EvidenceWindow", input.evidence_window);
  const executable = options.powershell || process.env.MCP_POWERSHELL || "powershell.exe";
  const stdout = options.publisherRunner
    ? await options.publisherRunner(args)
    : (await execFileAsync(executable, args, { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
  const record = JSON.parse(stdout.trim()) as JsonObject;
  if (String(record.schema || "") !== "p3.visual-evidence-review.v3") throw new Error("P3_VISUAL_REVIEW_PUBLISHER_SCHEMA_MISMATCH");

  const after = await resolveStagingProof(input.run_id, { stagingRoot: options.stagingRoot });
  if (!after.reviewed) throw new Error("P3_VISUAL_REVIEW_WRITE_MISSING");
  if (after.imageSha256 !== expected) throw new Error("P3_VISUAL_REVIEW_IMAGE_CHANGED_DURING_WRITE");
  if (String(after.reviewed.reviewed_image_sha256 || "").toLowerCase() !== expected) throw new Error("P3_VISUAL_REVIEW_WRITTEN_SHA_MISMATCH");
  if (String(after.reviewed.review_status || "") !== input.visual_verdict) throw new Error("P3_VISUAL_REVIEW_WRITTEN_VERDICT_MISMATCH");
  return after.reviewed;
}

export function registerVisualProofReviewTools(server: McpServer, _callerId: string): void {
  server.registerTool("open_visual_proof_run", {
    description: "Open one exact write-once P3 staging run from C:\\P3Proofs by run ID. Returns its hash-verified original screenshot/contact sheet as typed MCP image content. No scan, capture, copy, or re-encode.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: z.object({ run_id: z.string().min(1).max(160) }),
    _meta: { ui: { resourceUri: VISUAL_PROOF_WIDGET_URI }, "openai/outputTemplate": VISUAL_PROOF_WIDGET_URI },
  }, async ({ run_id }) => stagingProofToolResult(run_id));

  server.registerTool("record_visual_proof_review", {
    description: "Record an independent verdict for one exact P3 staging run after visual inspection. Requires the exact image SHA from open_visual_proof_run and delegates to P3's canonical reviewed.json publisher. Existing reviews are never overwritten.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    inputSchema: z.object({
      run_id: z.string().min(1).max(160),
      expected_image_sha256: z.string().regex(SHA256),
      observed_label: z.string().min(1).max(160),
      reviewer: z.string().min(1).max(160),
      expected_map: z.string().max(300).optional(),
      claim: z.string().max(1000).optional(),
      evidence_window: z.string().max(300).optional(),
      visual_verdict: z.enum(["PROVEN", "NOT_PROVEN", "REJECTED"]),
      inspection_mode: z.enum(["WATCHED_VIDEO", "INSPECTED_FRAME_SEQUENCE"]),
      identity_check: z.enum(["MATCH", "MISMATCH", "UNCLEAR"]),
      quality_check: z.enum(["GOOD", "DEFECTIVE", "UNCLEAR"]),
      visual_findings: z.string().min(20).max(4000),
    }),
  }, async (input) => {
    const reviewed = await recordStagingReview(input as RecordReviewInput);
    const summary = {
      source: "p3-staging", identity: cleanRunId(input.run_id), review_status: String(reviewed.review_status || ""),
      reviewed_utc: String(reviewed.reviewed_utc || ""), reviewer: String(reviewed.reviewer || ""),
      reviewed_image_sha256: String(reviewed.reviewed_image_sha256 || ""),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], structuredContent: summary };
  });
}

