export type FrontDoorMcpCall = { tool?: string; processId?: string; waitMs?: number };

export function backendRequestTimeoutMs(call: FrontDoorMcpCall): number {
  if (call.tool === "start_process") return Math.min(20_000, (call.waitMs ?? 750) + 10_000);
  if (call.tool === "read_output") return Math.min(245_000, (call.waitMs ?? 0) + 5_000);
  if (call.tool === "kill_process") return 15_000;
  return 35_000;
}
