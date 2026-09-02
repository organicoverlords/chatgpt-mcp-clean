import { mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export type BoundedJsonlOptions = {
  maxBytes?: number;
  maxAgeMs?: number;
  maxBackups?: number;
  now?: () => number;
  onError?: (error: Error) => void;
};

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BACKUPS = 3;

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
  private readonly maxBackups: number;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;

  constructor(private readonly path: string, options: BoundedJsonlOptions = {}) {
    this.maxBytes = requireInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_BYTES, 1);
    this.maxAgeMs = requireInteger("maxAgeMs", options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, 1);
    this.maxBackups = requireInteger("maxBackups", options.maxBackups ?? DEFAULT_MAX_BACKUPS, 0);
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

  private async moveIfPresent(source: string, target: string): Promise<void> {
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async rotate(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
    if (this.maxBackups === 0) {
      await rm(this.path, { force: true });
    } else {
      await rm(`${this.path}.${this.maxBackups}`, { force: true });
      for (let index = this.maxBackups - 1; index >= 1; index -= 1) {
        await this.moveIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      }
      await this.moveIfPresent(this.path, `${this.path}.1`);
    }
    this.size = 0;
    this.openedAt = this.now();
    await this.ensureOpen();
  }
}
