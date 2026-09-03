---
name: incident-report
description: Capture and analyze assistant behavior, tool-routing, execution, correction, memory, response-quality, or project-control incidents for regression research while keeping the active task alive.
---

# Incident Report

Use this workflow to preserve an incident without turning capture into a new project. Freeze the inherited objective, live state, valid work, user corrections, constraints, and completion condition, then continue repair/recovery whenever evidence supports it.

Read the bundled `incident-contract.md`. Use `verify_incident_capture.py` only before claiming a raw transcript/export capture is complete, verified, or archived. Raw capture is evidence enrichment; it is not a prerequisite for PRIMARY, Vault memory persistence, or continuing the user's task.

## Action path

1. **Analysis 1 immediately.** Record the time-local fault direction from evidence already available: apparent objective/state, evidence then visible, assumptions or pressures, selected route, ignored alternatives/contradictions, next wrong substantive action, user-visible impact, and the smallest supported causal model. Separate observed facts from inference and uncertainty.
2. **Write PRIMARY immediately.** Save the bounded incident report under the canonical Vault `01 Reports/` path as soon as Analysis 1 is sufficient. Do not wait for raw capture, a Chat ID, a priority-queue request, another memory writer, or a full-source traversal.
3. **Persist through the canonical Vault CLI.** From the current canonical Vault checkout, use `python tools\memory_bank.py append ...` (or `note` only for an explicitly quick note). Do not manually edit `memory/memory-bank.jsonl`. Do not pre-wait merely because another memory task or dirty writer exists; invoke the CLI once and let its own reconciliation/sync path handle concurrent publication. Treat only an actual CLI conflict/error as a blocker, and preserve the already-written report if that occurs.
4. **Keep the inherited task alive.** Incident capture must not displace repair, supervision, verification, or the user's original objective. If one incident step is waiting, use the time for useful non-conflicting work.
5. **Raw capture is optional enrichment.** If the exact current Chat ID is already available through a valid current surface, submit one fresh raw-capture request to the currently documented priority queue. If the Chat ID is not already available, record raw capture as pending and continue. Do **not** search browser history, session files, actor bindings, unrelated logs, or other surfaces merely to discover a Chat ID. Missing capture metadata never authorizes archaeology.
6. **Analysis 2 only when fresh raw source actually arrives.** Verify byte size/SHA-256/completeness with `verify_incident_capture.py`, read the complete source beginning to end, then reconstruct first divergence, next substantive action, available routes, hard exclusions, evidence versus hypothesis, and the correct next action. Keep Analysis 1 and Analysis 2 distinct so hindsight changes are visible.
7. **Replay fixture when useful.** Score the very next substantive action after the fault/correction, not merely the eventual outcome. A missing raw capture may leave the fixture pending; it does not invalidate PRIMARY or the memory-bank entry.

## Stop rules

- Never make exact Chat-ID acquisition a blocking prerequisite for PRIMARY, Vault persistence, repair, or task continuation.
- Never create a second memory store, incident queue, telemetry system, or logging daemon because one route is unavailable.
- Never repeat a known connector failure merely to strengthen the sample. Preserve the receipt, use one bounded recovery/reassociation when appropriate, then continue or switch route.
- Never wait idly on a shared writer when useful non-conflicting work or the canonical memory CLI remains available.
- Never claim raw capture is complete without verifier evidence.

## MCP boundary classification

For an MCP connection failure, connector disappearance, timeout, or apparent stall, record the exact local timestamp and classify only from the narrow matching transport window while MCP was the active control plane. First ask whether a matching `/mcp` request reached the local server boundary. If no request arrived, classify the incident as pre-dispatch/non-arrival only when the active-control-plane timing is proven; otherwise leave it `NOT_PROVEN`. If a request arrived, record whether it finished normally, closed early, aborted, or returned non-2xx and include request-local `response_bytes` when present. In the same window record localhost health and public/Funnel health plus any intentional revoke, listener restart, route switch, or process kill.

Use the durable classes from `evidence/issue7-incident-classification-20260825.md`: A pre-dispatch/non-arrival, B local listener stall, C public/Funnel path failure, D server-arrived abnormal MCP response, and E intentional bounded wait. Do not collapse these into a generic "MCP died" diagnosis, and do not infer a response-size, absolute-path, polling, or log-growth cause without correlated boundary evidence.

Repair directly supported defects and resume the original task. Do not delegate the incident writing/capture/verification, invent identifiers or evidence, or turn a failed route into a global blocker.
