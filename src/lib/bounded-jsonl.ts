import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type BoundedJsonlOptions = {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
};

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;

  constructor(private readonly path: string, options: BoundedJsonlOptions = {}) {
    this.maxBytes = requireInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_BYTES, 1);
    this.maxAgeMs = requireInteger("maxAgeMs", options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 1);
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
  }

  writeJson(event: Record<string, unknown>): void {
    this.writeLine(`${JSON.stringify(event)}\n`);
  }

  writeLine(line: string): void {
    if (this.closed) return;
    this.pending = this.pending.then(() => this.writeInternal(line)).catch((error) => this.onError(asError(error)));
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.pending;
      return;
    }
    this.closed = true;
    await this.pending;
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
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

  private async writeInternal(line: string): Promise<void> {
    await this.ensureOpen();
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.size > 0 && (this.size + bytes > this.maxBytes || this.now() - this.openedAt >= this.maxAgeMs)) {
      await this.rotate();
    }
    await this.handle!.write(line);
    this.size += bytes;
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
