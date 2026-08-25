# MCP transport generation evidence — 2026-08-25

Snapshot: first 59,467,516 bytes of `.state/transport.jsonl`, SHA-256 `97884c18711be5e9f2fa1a612b9b4b6581300e1a9a718a05175eeb6156c7c8c5`.

| Generation | Responses | read/start | read p95 | reads >=9s | byte coverage | max bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| foreground-era | 24,306 | 3.98 | 60.5 ms | 0 | 0 | n/a |
| background-only | 63,369 | 1.82 | 41.5 ms | 25 | 0 | n/a |
| bounded-wait-pre-byte-telemetry | 1,547 | 2.03 | 10,014.5 ms | 47 | 3 | 116 |
| response-byte-telemetry | 6,329 | 1.46 | 10,013.6 ms | 39 | 6,329 | 13,012 |
| stable-pinned-baseline | 329 | 6.38 | 3.6 ms | 0 | 329 | 6,838 |
| oauth-retention | 515 | 6.50 | 3.2 ms | 0 | 515 | 6,838 |
| stale-client-recovery | 362 | 3.31 | 5,013.8 ms | 0 | 362 | 8,250 |

## Findings

The foreground generation contains all **1,880** observed `execute_command` calls. The last observed completion is `2026-08-23T20:50:03.339Z`; after that the tool surface shifts to `start_process` plus bounded `read_output`.

The Aug-25 ~10 second p95 cluster matches the configured `read_output.wait_ms <= 10,000` contract. Treat those calls primarily as intentional client long-poll waiting unless separate evidence proves server processing delay.

Later stable/OAuth generations falsify the simple claim that a high read/start ratio implies slow MCP: ratios reach 6.38 and 6.50 while read p95 is only 3.6 ms and 3.2 ms. Polling amplification is therefore a workload/control-plane cost metric, not by itself a transport-latency defect.

Response-byte telemetry is unavailable for older generations. In measured generations the largest HTTP response is 13,012 bytes, compatible with two separately capped 6,000-character stdout/stderr streams plus MCP/JSON framing; this does not prove a cap bypass or a 12 KB delivery failure.

`PROVEN`: counts, observed tool-surface transition, runtime PID windows, measured bytes where present, and the 10-second read contract. `SUPPORTED`: most Aug-25 ~10-second reads are intentional long polls. `NOT_PROVEN`: polling caused the user-visible regression, JSONL growth caused stalls, or >12 KB responses fail delivery.
