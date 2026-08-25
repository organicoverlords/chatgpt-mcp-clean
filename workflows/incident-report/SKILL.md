---
name: incident-report
description: Capture and analyze assistant behavior, tool-routing, execution, correction, memory, response-quality, or project-control incidents for regression research while keeping the active task alive.
---

# Incident Report

Read the bundled incident-contract.md before creating or updating reports. Use the bundled verify_incident_capture.py before claiming a raw capture is complete, verified, or archived.

Do not turn incident capture into a postmortem wall or a substitute for repair. Freeze the inherited objective, live state, valid work, user corrections, constraints and completion condition, then continue repair/recovery whenever evidence supports it.

## Analysis 1 — before hindsight

Before full-source traversal, record the time-local fault direction: apparent objective/state, evidence then visible, assumptions or pressures, selected route, ignored alternatives/contradictions, and the next wrong substantive action. Separate observed facts from inference and uncertainty. Write PRIMARY as soon as this minimum evidence exists; raw capture may still be pending.

## Fresh priority capture

Immediately after Analysis 1, submit the exact Chat ID to the canonical priority queue at `%LOCALAPPDATA%/GigStackTools/memory-regression/gpt3/incident-priority-queue.jsonl`. Do not substitute an older transcript and do not create another queue. Failed or rate-limited acquisition remains pending.

Preserve a separate unchanged full raw export. Record exact source path/identity, Chat ID, byte size, SHA-256 and completeness state, and verify it before calling it complete.

## Analysis 2 — full context

Only after fresh raw capture is available, or evidenced exhaustion is recorded, read the entire source beginning to end. Reconstruct first divergence, next substantive action, available routes, hard exclusions, evidence versus hypothesis, and the correct next action. Keep Analysis 1 and Analysis 2 distinct and explicitly compare what changed; that difference is regression evidence.

Create a replay-ready fixture whose scoring rule evaluates the very next substantive action after the fault/correction, not merely the eventual final outcome.

Write SECONDARY only after capture is verified or evidenced exhaustion is recorded, using the same immutable incident ID. Store artifacts under the regression-research directory contract described in incident-contract.md.

## MCP boundary classification

For an MCP connection failure, connector disappearance, timeout, or apparent stall, record the exact local timestamp and classify only from the narrow matching transport window while MCP was the active control plane. First ask whether a matching `/mcp` request reached the local server boundary. If no request arrived, classify the incident as pre-dispatch/non-arrival only when the active-control-plane timing is proven; otherwise leave it `NOT_PROVEN`. If a request arrived, record whether it finished normally, closed early, aborted, or returned non-2xx and include request-local `response_bytes` when present. In the same window record localhost health and public/Funnel health plus any intentional revoke, listener restart, route switch, or process kill.

Use the durable classes from `evidence/issue7-incident-classification-20260825.md`: A pre-dispatch/non-arrival, B local listener stall, C public/Funnel path failure, D server-arrived abnormal MCP response, and E intentional bounded wait. Do not collapse these into a generic "MCP died" diagnosis, and do not infer a response-size, absolute-path, polling, or log-growth cause without correlated boundary evidence.

Repair directly supported defects and resume the original task. Do not delegate the incident writing/capture/verification, invent identifiers or evidence, or turn a failed route into a global blocker.
