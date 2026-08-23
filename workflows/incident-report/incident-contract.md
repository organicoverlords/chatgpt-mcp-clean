# Incident Contract

The canonical priority download queue is `%LOCALAPPDATA%/GigStackTools/memory-regression/gpt3/incident-priority-queue.jsonl`. It is mandatory after Analysis 1 and before full traversal and Analysis 2. Each request carries request_id, conversation_id, optional incident_id, requested_at, and status pending. Successful capture updates the same record with captured state, raw path, SHA-256 and completion time. Failed or rate-limited requests remain pending. Never create a second queue.

Use pending when raw source is requested but not verified. Use captured only when the unchanged full source exists and path, byte size, SHA-256 and completeness have been verified. Use exhausted only when independent valid capture routes were attempted and their failure evidence is recorded. Do not write SECONDARY while capture is pending.

PRIMARY preserves incident ID, Chat ID, inherited objective, live state, valid work, user correction, constraints, completion condition, Analysis 1, queue request, capture state and directly observed failure evidence. SECONDARY reuses the incident ID and adds verified raw-source metadata, Analysis 2, explicit Analysis 1 versus Analysis 2 comparison, replay-readiness, corpus/issue routing, direct repairs, validation evidence and resume state.

Analysis 1 is the immutable time-local decision trace made before full traversal. Analysis 2 is the full-context reconstruction after the unchanged raw export has been traversed beginning to end. Never collapse them into one hindsight narrative.

The replay fixture preserves inherited task/live state, point before fault direction, wrong action, correction/falsifying evidence, both analyses, comparison, expected correct next action, valid state to preserve, hard exclusions, verification evidence and completion condition. Score the very next substantive action.

Store under `/Regression Research/`: `01 Reports/`, `02 Evidence/`, `03 Fixtures and Experiments/`, `04 Operating Contracts/`, `90 Raw Transcripts/`, `99 Duplicate Archive/`. Mark manifest/corpus provenance with INCIDENT and incident ID.

The words archived, verified and complete require a present source artifact, matching byte size, matching SHA-256, explicit completeness, manifest provenance and corpus evidence. A tool response, filename or queue entry alone is not proof.
