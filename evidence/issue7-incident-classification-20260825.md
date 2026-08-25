# Issue #7 incident classification — 2026-08-25

This table separates failures that reached the local MCP boundary from failures that did not. It is intentionally evidence-first: a user-visible `Connection failed`, connector disappearance, timeout, or stall is not assigned to a class without matching boundary evidence.

| Class | Boundary evidence | Interpretation | Status |
| --- | --- | --- | --- |
| A. Pre-dispatch / non-arrival | User-visible failure with no matching `/mcp` request in transport telemetry while the relevant MCP control plane was active | Failure occurred before the local MCP server boundary: client, authorization, routing, or upstream control plane | `SUPPORTED` as a recurring class; specific incidents require timestamp correlation |
| B. Local listener stall | Supervisor/local probe records a timeout or failed localhost health request | Local server or machine-side listener path stalled and is independently observable | `PROVEN` to have occurred in historical windows |
| C. Public/Funnel path failure | Localhost health is healthy while public/Funnel health fails | Public forwarding/network/control-plane path failed while the listener remained healthy | `PROVEN` to have occurred in historical windows |
| D. Server-arrived abnormal MCP response | Matching `/mcp` request reaches the server and telemetry records non-2xx, `response_close_early`, or abort | Local/server-side request handling failure; diagnose from the corresponding request/caller/process evidence | `PROVEN` but rare in the measured corpus |
| E. Intentional bounded wait | `read_output` completes near the configured wait bound with normal HTTP completion | Expected long-poll behavior, not transport latency by itself | `PROVEN` by generation telemetry |

## Hypothesis ledger

| Hypothesis | Current result | Evidence |
| --- | --- | --- |
| Hard ~6 KB response-delivery ceiling | `REJECTED` | Successful tool responses exceeded 6 KB; later per-response telemetry measured HTTP responses up to 13,012 bytes. |
| Fixed N-calls/session limit | `REJECTED` | Individual caller IDs completed hundreds of calls; the observed maxima exceeded 790 calls. |
| ~12 KB response threshold | `NOT_PROVEN` | Per-response telemetry now exists, but measured >12 KB responses have completed successfully; no correlated delivery failure establishes a threshold. |
| Absolute paths trigger the failure | `NOT_PROVEN` | No timestamp-correlated boundary evidence isolates absolute paths as causal. |
| Transport-log growth causes multi-second stalls | `NOT_PROVEN` | Logging/probe amplification is measured waste, but current healthy listener measurements do not establish the JSONL size as causal. |
| One local MCP implementation defect explains all connector-loss episodes | `REJECTED` | User-visible disappearance/non-arrival spans multiple historical transport/server generations, while local transport defects form separately observable classes. |
| Upstream/client pre-dispatch routing or authorization failure exists as a distinct class | `SUPPORTED` | Repeated user-visible failures lack corresponding server-arrived abnormal MCP traffic; classification still requires an MCP-active correlated incident window. |

## Durable observations

- The current telemetry corpus contains overwhelmingly normal server-observed MCP completions. Historical analysis found only a small set of abnormal tool responses compared with tens of thousands of successful requests.
- Commander had its own independently measured transport-failure/reconnect cycles. Those prove a separate transport instability but cannot explain MCP calls that never reached the MCP server.
- Per-response byte telemetry shipped in `cd3be1b`; future `response_finish` / `response_close_early` records can be evaluated by request-local response size instead of socket-cumulative bytes.
- OAuth registration retention shipped in `fd6fa36`; subsequent live smoke verified the exact seven-tool surface without resetting the OAuth store.
- The stable pinned SDK 1.24.3 recovery path was live-smoked successfully with local/public health 200, bounded output, process-tree kill, concurrent work, and cross-session BUSY behavior.
- Generation telemetry in `evidence/issue8-generation-report-20260825.md` shows that ~10 second `read_output` clusters align with the configured bounded-wait contract, while later high read/start ratios coexist with millisecond p95 reads. Polling intensity alone is therefore not a latency diagnosis.

## Incident capture contract

For the next user-visible MCP failure during an MCP-active interval, preserve the exact local timestamp and classify it only after checking the narrow matching telemetry window:

1. Was there a matching `/mcp` request at the server boundary?
2. If yes, did it finish normally, close early, abort, or return non-2xx, and what was `response_bytes`?
3. What were localhost and public/Funnel health states in the same window?
4. Was there an intentional control-plane switch, revoke, listener restart, or process kill that explains the gap?
5. Only after those checks assign A/B/C/D/E; otherwise leave the incident `NOT_PROVEN`.

This keeps local listener failures, public-path failures, expected bounded waits, and upstream pre-dispatch/non-arrival failures from being collapsed into the same "MCP died" label.
