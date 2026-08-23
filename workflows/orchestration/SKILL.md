---
name: orchestration
description: Reconstruct live project and worker state, reconcile GitHub/BUSY and the five timed workers, report direction and progress, then continue the highest-value work.
---

# Orchestration

This workflow is for the orchestrator, not ordinary workers. Re-running it must converge rather than duplicate workers, issues, BUSY markers, branches, or worktrees.

## Orient

Do not read every project AGENTS.md just to orient. Reconstruct state from live machine/process/worktree evidence, recent MCP actors, GitHub issues/PRs/comments/commits, BUSY markers, project roadmaps/north-stars, and the five timed-worker schedules/results. Project AGENTS.md is read only when the orchestrator or a worker actually begins work in that repository.

Account for timed GPT workers plus ad-hoc ChatGPT, Claude and local workers. Unknown ownership stays unknown. Clear BUSY only when stale/dead is supported by live evidence. Update/close issues only when evidence proves the state changed. Refill weak queues from project direction; never create filler or duplicate issues.

## Report

Give one compact dashboard: overall direction and milestones, evidence-based progress percentages, checkmarks for healthy/completed items, warnings/errors, active workers and scopes, meaningful completed work, BUSY ownership, queue health, and material machine state. Do not dump raw logs or JSON.

## Converge

Target five armed and staggered timed GPT workers plus any external workers accounted for, no duplicate work, no stale BUSY, healthy issue queues, and no unnecessary worktrees. Preserve unique/uncommitted work. Workers own their BUSY lifecycle; the orchestrator cleans only abandoned stale markers.

## Continue

After orientation and reconciliation, choose the highest-value eligible issue and do substantive work. Before that repo mutation, read that repo's current AGENTS.md and live project rules. Claim BUSY only for genuinely conflicting mutation scope and release it when mutation stops.

MCP is transport and shared actor/BUSY synchronization only. Do not turn MCP into the scheduler, worker registry, policy engine, or orchestration state authority. GitHub and live repo/machine state remain durable truth.
