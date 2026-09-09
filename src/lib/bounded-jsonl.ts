import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type BoundedJsonlOptions = {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
  batchDelayMs?: number;
  maxBatchBytes?: number;
};

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_DELAY_MS = 15;
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireInteger(name: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

export class BoundedJsonlWriter {
  private handle: FileHandle | undefined;
  private size = 0;
  private openedAt = 0;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private queuedLines: string[] = [];
  private queuedBytes = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private drainScheduled = false;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly batchDelayMs: number;
  private readonly maxBatchBytes: number;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;

  constructor(private readonly path: string, options: BoundedJsonlOptions = {}) {
    this.maxBytes = requireInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_BYTES, 1);
    this.maxAgeMs = requireInteger("maxAgeMs", options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 1);
    this.batchDelayMs = requireInteger("batchDelayMs", options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS, 0);
    this.maxBatchBytes = requireInteger("maxBatchBytes", options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES, 1);
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  writeJson(event: Record<string, unknown>): void {
    this.writeLine(`${JSON.stringify(event)}\n`);
  }

  writeLine(line: string): void {
    if (this.closed) return;
    this.queuedLines.push(line);
    this.queuedBytes += Buffer.byteLength(line, "utf8");
    if (this.queuedBytes >= this.maxBatchBytes || this.batchDelayMs === 0) {
      this.clearFlushTimer();
      this.scheduleDrain();
      return;
    }
    this.armFlushTimer();
  }

  async flush(): Promise<void> {
    this.clearFlushTimer();
    this.scheduleDrain();
    await this.pending;
    if (this.queuedLines.length) {
      this.scheduleDrain();
      await this.pending;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.pending;
      return;
    }
    this.closed = true;
    this.clearFlushTimer();
    this.scheduleDrain();
    await this.pending;
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
  }

  private armFlushTimer(): void {
    if (this.closed || this.flushTimer || this.drainScheduled) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.scheduleDrain();
    }, this.batchDelayMs);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.queuedLines.length === 0) return;
    this.drainScheduled = true;
    this.pending = this.pending
      .then(() => this.drainQueued())
      .catch((error) => this.onError(asError(error)))
      .finally(() => {
        this.drainScheduled = false;
        if (this.queuedLines.length) {
          if (this.closed) this.scheduleDrain();
          else this.armFlushTimer();
        }
      });
  }

  private async drainQueued(): Promise<void> {
    while (this.queuedLines.length) {
      const lines = this.queuedLines.splice(0, this.queuedLines.length);
      this.queuedBytes = 0;
      await this.writeBatch(lines);
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.handle = await open(this.path, "a");
    const stats = await this.handle.stat();
    this.size = stats.size;
    this.openedAt = stats.size > 0 ? stats.mtimeMs : this.now();
  }

  private async writeBatch(lines: string[]): Promise<void> {
    await this.ensureOpen();
    let chunk = "";
    let chunkBytes = 0;

    const flushChunk = async (): Promise<void> => {
      if (!chunk) return;
      await this.handle!.write(chunk);
      this.size += chunkBytes;
      chunk = "";
      chunkBytes = 0;
    };

    for (const line of lines) {
      const bytes = Buffer.byteLength(line, "utf8");
      const ageExpired = () => this.size > 0 && this.now() - this.openedAt >= this.maxAgeMs;
      if (this.size + chunkBytes > 0 && (this.size + chunkBytes + bytes > this.maxBytes || ageExpired())) {
        await flushChunk();
        if (this.size > 0 && (this.size + bytes > this.maxBytes || ageExpired())) await this.rotate();
      }
      if (chunkBytes > 0 && chunkBytes + bytes > this.maxBatchBytes) await flushChunk();
      chunk += line;
      chunkBytes += bytes;
    }
    await flushChunk();
  }

  private archiveDirectory(): string {
    return `${this.path}.archive`;
  }

  private archivePath(): string {
    const timestamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    return join(this.archiveDirectory(), `${basename(this.path)}.${timestamp}.${randomUUID()}.jsonl`);
  }

  private async rotate(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
    await mkdir(this.archiveDirectory(), { recursive: true });
    try {
      await rename(this.path, this.archivePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.size = 0;
    this.openedAt = this.now();
    await this.ensureOpen();
  }
}
