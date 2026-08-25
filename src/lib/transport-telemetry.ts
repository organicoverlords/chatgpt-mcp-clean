import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Socket } from "node:net";

export type TelemetryContext = {
  request_id?: string;
  caller_id?: string;
  connection_id?: string;
  session_id?: string | null;
};

type TelemetrySink = (event: Record<string, unknown>) => void;
type SocketState = {
  id: string;
  openedAt: bigint;
  ended: boolean;
  errorCode?: string;
};

const contextStorage = new AsyncLocalStorage<TelemetryContext>();
const sockets = new WeakMap<Socket, SocketState>();
let sink: TelemetrySink | undefined;

export function setTelemetrySink(next: TelemetrySink | undefined): void {
  sink = next;
}

export function currentTelemetryContext(): TelemetryContext {
  return contextStorage.getStore() ?? {};
}

export function withTelemetryContext<T>(context: TelemetryContext, action: () => T): T {
  return contextStorage.run(context, action);
}

export function emitTelemetry(event: Record<string, unknown>, context: TelemetryContext = currentTelemetryContext()): void {
  sink?.({ ...context, ...event });
}

export function sessionFingerprint(value: string | undefined): string | null {
  if (!value) return null;
  return `session_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function observeSocket(socket: Socket): string {
  const existing = sockets.get(socket);
  if (existing) return existing.id;

  const state: SocketState = {
    id: `connection_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    openedAt: process.hrtime.bigint(),
    ended: false,
  };
  sockets.set(socket, state);
  emitTelemetry({
    event: "connection_open",
    connection_id: state.id,
    remote_address: socket.remoteAddress ?? null,
    remote_port: socket.remotePort ?? null,
    local_address: socket.localAddress ?? null,
    local_port: socket.localPort ?? null,
  }, {});

  socket.once("end", () => {
    state.ended = true;
    emitTelemetry({ event: "connection_end", connection_id: state.id }, {});
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    state.errorCode = error.code ?? error.name;
    emitTelemetry({
      event: "connection_error",
      connection_id: state.id,
      error_code: state.errorCode,
      error_message: error.message,
    }, {});
  });
  socket.once("close", (hadError) => {
    const durationMs = Number(process.hrtime.bigint() - state.openedAt) / 1_000_000;
    emitTelemetry({
      event: "connection_close",
      connection_id: state.id,
      had_error: hadError,
      ended: state.ended,
      error_code: state.errorCode ?? null,
      bytes_read: socket.bytesRead,
      bytes_written: socket.bytesWritten,
      duration_ms: Number(durationMs.toFixed(3)),
    }, {});
  });
  return state.id;
}
