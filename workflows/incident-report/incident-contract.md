# Incident Contract

The incident workflow has two independent durability paths: immediate PRIMARY/Vault persistence, and optional fresh raw-source enrichment. Raw-source acquisition must never block the first path.

## PRIMARY and Vault persistence

PRIMARY preserves the incident identity when one is available, inherited objective, live state, valid work, user correction, constraints, completion condition, Analysis 1, directly observed failure evidence, causal hypotheses with uncertainty, and the correct next action. An exact Chat ID and queue request are optional metadata, not required PRIMARY fields.

Write PRIMARY as soon as Analysis 1 is sufficient. Store it under the canonical Vault `01 Reports/` directory, then persist a compact lesson/status through the canonical `tools/memory_bank.py` CLI. Do not manually edit the JSONL. The CLI owns reconciliation and publication; another live memory task is not by itself a reason to wait before invoking it.

If the CLI itself returns a real conflict/error, preserve the report and record memory persistence as pending. Do not create another memory store or wait idly when useful non-conflicting work is available.

## Fresh raw capture

The current priority download queue is `%LOCALAPPDATA%/GigStackTools/memory-regression/gpt3/incident-priority-queue.jsonl`. Use it only when the exact current Chat ID is already available from a valid current surface. Submit at most one canonical request. Never create a second queue.

If the Chat ID is unavailable, set raw capture to pending and continue the inherited task. Do not search browser history, browser session state, actor bindings, unrelated filesystem locations, or unrelated logs solely to recover a Chat ID. Missing capture metadata is not permission to widen the task.

Use `pending` when raw source is requested or desired but not verified. Use `captured` only when the unchanged full source exists and path, byte size, SHA-256, and completeness have been verified. Use `exhausted` only when independently valid capture routes were attempted for a reason relevant to the task and their failure evidence is recorded. Do not substitute an older conversation or partial transcript.

## Analysis 1 and Analysis 2

Analysis 1 is the immutable time-local decision trace made before full traversal. Analysis 2 is the full-context reconstruction after a fresh unchanged raw export is actually available and has been traversed beginning to end. Never collapse them into one hindsight narrative.

Analysis 2 adds verified raw-source metadata, explicit Analysis 1 versus Analysis 2 comparison, replay-readiness, corpus/issue routing, direct repairs, validation evidence, and resume state. Absence of Analysis 2 does not invalidate PRIMARY or the memory-bank entry.

## Replay fixture

The replay fixture preserves inherited task/live state, point before fault direction, wrong action, correction/falsifying evidence, both analyses when available, comparison, expected correct next action, valid state to preserve, hard exclusions, verification evidence, and completion condition. Score the very next substantive action. A fixture may remain pending when fresh raw capture is unavailable.

## Raw-capture verification

The words archived, verified, complete, and captured require a present source artifact, matching byte size, matching SHA-256, explicit completeness, and provenance evidence. `verify_incident_capture.py` is the gate for those claims. A tool response, filename, queue entry, PRIMARY report, or memory-bank entry alone is not proof of raw capture.

## Control rule

Incident capture is subordinate to the inherited user objective. Metadata acquisition, connector debugging, queue mechanics, or report infrastructure must not become the new primary task. Known transient route failures should be recorded/classified and bounded; they do not authorize repeated canaries or speculative debugging.
