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

Repair directly supported defects and resume the original task. Do not delegate the incident writing/capture/verification, invent identifiers or evidence, or turn a failed route into a global blocker.
