import type { IncomingMessage, ServerResponse } from "node:http";

type RequestLifecycleOutcome =
  | { kind: "handled" }
  | { kind: "handler_error"; error: unknown }
  | { kind: "downstream_closed" };

export async function awaitRequestOrDisconnect(
  request: Pick<IncomingMessage, "aborted" | "once" | "off">,
  response: Pick<ServerResponse, "destroyed" | "writableEnded" | "once" | "off">,
  handler: () => Promise<void>,
): Promise<void> {
  if (request.aborted || response.destroyed) return;

  let resolveDisconnect!: () => void;
  const disconnected = new Promise<RequestLifecycleOutcome>((resolve) => {
    resolveDisconnect = () => resolve({ kind: "downstream_closed" });
  });
  const onRequestAborted = () => resolveDisconnect();
  const onResponseClose = () => {
    if (!response.writableEnded) resolveDisconnect();
  };

  request.once("aborted", onRequestAborted);
  response.once("close", onResponseClose);

  const handled: Promise<RequestLifecycleOutcome> = Promise.resolve()
    .then(handler)
    .then(() => ({ kind: "handled" } as const))
    .catch((error: unknown) => ({ kind: "handler_error", error } as const));

  try {
    const outcome = await Promise.race([handled, disconnected]);
    if (outcome.kind === "handler_error") throw outcome.error;
  } finally {
    request.off("aborted", onRequestAborted);
    response.off("close", onResponseClose);
  }
}
