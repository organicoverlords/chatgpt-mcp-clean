-client-recovery | 362 | 3.31 | 5,013.8 ms | 0 | 362 | 8,250 |

## Findings

The foreground generation contains all **1,880** observed `execute_command` calls. After the last observed `execute_command` completion at `2026-08-23T20:50:03.339Z`, the tool surface shifts to `start_process` plus bounded `read_output`. That is an observed runtime transition, not an inference from commit dates alone.

The apparent Aug-25 "10 second latency" spike is dominated by intentional long polling. `read_output` explicitly permits `wait_ms` up to **10,000 ms**. The bounded-wait and response-byte generations have p95 values of 10,014.5 ms and 10,013.6 ms respectively, tightly matching that configured wait ceiling. Treat those calls as client-requested waiting unless separate evidence shows server processing delay.

The later stable pinned/OAuth generations are a counterexample to "high polling ratio means slow MCP": read/start rises to 6.38 and 6.50 while `read_output` p95 is only 3.6 ms and 3.2 ms. Polling amplification is therefore a workload/control-plane cost metric, not by itself a transport-latency defect.

Response-byte telemetry begins only in the later Aug-25 generation. Across the fixed snapshot, measured MCP tool responses are: `read_output` 591 responses, mean ~3,472 bytes, max **13,012** bytes; all other measured MCP tool responses are <=402 bytes. The 13,012-byte HTTP response is compatible with two independently capped 6,000-character stdout/stderr streams plus MCP/JSON framing; it does not show the per-stream 6,000-character cap was bypassed.
The data rejects a simple "MCP got slower and caused the regression" explanation. It supports a multi-class model already documented on issue #8: transport defects, caller/workload amplification, and public/control-plane failures must be analyzed separately. High call volume and high read/start ratios can coexist with low server-side read latency.

## Confidence / limitations

`PROVEN`: tool counts, status counts, measured response bytes where present, observed last `execute_command`, runtime PID windows, and the 10-second `read_output` contract.

`SUPPORTED`: the Aug-25 ~10-second cluster is primarily intentional long-poll waiting because its distribution matches the configured maximum and disappears in later generations without reducing read/start ratio.

`NOT_PROVEN`: that polling amplification itself caused user-visible regression, that the growing JSONL file caused stalls, or that HTTP response size above 12 KB is a delivery failure. Older generations lack response-byte telemetry, so cross-generation byte comparisons remain unavailable.

The companion behavioral/yield conclusions belong in `organicoverlords/regression-research#28`; this artifact intentionally limits itself to MCP transport/process evidence.