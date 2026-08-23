---
name: orchestration
description: Reconstruct live project and worker state, maintain roadmap/GitHub health, reconcile the timed fleet and ad-hoc workers, report direction and progress, then continue substantive work.
---

# Orchestration

This workflow is for the orchestrator, not ordinary workers. Re-running it must converge rather than duplicate workers, issues, PRs, BUSY markers, branches, or worktrees. Reporting is a checkpoint inside the work loop, never the end of the loop.

## Orient

Do not read every project AGENTS.md just to orient. Reconstruct live state from machine/process/worktree evidence, recent `MCP1` actors, GitHub issues/PRs/comments/commits, BUSY markers, project roadmaps/north-stars/design/research documents, and the five timed-worker schedules/results. Project AGENTS.md is read when the orchestrator or a worker actually begins repository mutation.

Account separately for the fixed timed GPT fleet and ad-hoc ChatGPT, Claude and local workers discovered from current evidence. Unknown ownership stays unknown. Clear BUSY only when stale/dead is supported by live evidence.

## Independent evidence

Never inherit another actor's evidence status. Worker reports, handoffs, tables, computed metrics, test summaries, logs, screenshots, proof receipts, PR/issue comments, commit messages, automation outputs, and another assistant's `verified` statements are claims or evidence locators, not accepted evidence. Before repeating a substantive claim as fact, independently reopen the primary source or reproduce the relevant calculation, test, runtime behavior, or artifact. If that independent check has not happened, report it as `NOT_PROVEN`, worker-reported, or not checked.

End-to-end acceptance does not inherit from intermediate success. Capture success, file existence, image ingestion, `image_asset_pointer`, MCP transport success, build success, or a worker saying it inspected an artifact do not prove the intended user-visible result. Acceptance is `PROVEN` only when the actual intended end-to-end outcome is independently observed at the required final surface.

## Tool routing

Normal orchestration and worker startup use live local repo/machine state plus one bounded `@MCP1` sync. Use `@MCP1` for actor identity, BUSY/issue synchronization, bounded local Git/GitHub access, and normal transport. Do not use `@github` for routine startup orientation, broad branch/PR/history sweeps, or duplicate reads that `@MCP1`/local repo state already provide.

If `@MCP1` is unavailable or unusable, manually switch to `@Remote Desktop Commander` as the primary backup route. Keep `@github` available as a narrow debugging/fallback route when the normal control paths are unavailable or when the GitHub app itself is the thing being diagnosed. A backup route must not become a second parallel orientation pass.

## Roadmap stewardship — orchestrator-owned

Roadmap continuity and GitHub queue quality are 100% orchestrator responsibilities. Workers implement bounded product scopes; they are not responsible for keeping the whole project supplied with coherent future work.

For every active project, inspect the current north star, authoritative design documents, research records, phase/roadmap documents, implemented state, open issues and recent merged work. Determine which phase is actually current, what acceptance remains, and what the next product phases are.

If a documented next phase exists, keep GitHub populated with concrete non-duplicate issues that implement it. Each issue should state the player/product outcome, bounded implementation scope, relevant design authority, and acceptance evidence appropriate to the work. Seed enough high-value independent work to keep the available worker fleet productive without manufacturing filler.

If the roadmap stops, is stale, contradicts current product truth, or omits the next phase, do not wait for the user to design the continuation. Derive the next phase from the project's north star, design records, research evidence, current implementation and explicit user direction. Update or write the missing roadmap/design phase in the repository, then seed GitHub with the corresponding issues. Research externally when the design record is insufficient for a material technical/product decision.

Keep the roadmap and GitHub synchronized with reality. Close completed issues when evidence proves completion; rewrite stale issue wording when the intended product remains but implementation/acceptance changed; close or supersede duplicate/obsolete issues; remove stale BUSY; and preserve historical evidence rather than deleting useful context.

PR hygiene is also orchestrator-owned. Inspect open and recently merged PRs, merge ready validated PRs when current repository authority permits, close or supersede obsolete/duplicate PRs, identify abandoned heads, and ensure active implementation has an appropriate bounded PR path. Never merge merely to improve metrics and never treat PR state as product proof.

## Report

Give one compact dashboard focused on direction, progress and activity. Separate the five timed workers from other live/ad-hoc workers. Name work in plain English, not only issue numbers.

Include evidence-based overall and per-lane progress percentages with gradient progress bars; current worker/activity state; meaningful proof or remaining acceptance; and compact stack progress.

Include a small delivery/health strip when data is available: 2-hour and 24-hour commits/merged PRs, open PR count, a clearly defined flow metric, recent-change quality signal from real validation evidence, and GitHub health covering issue queue, stale/duplicate work, BUSY and PR hygiene. Metrics are diagnostics, not targets; do not reward churn or fabricate quality scores when evidence is unavailable.

A report is followed immediately by reconciliation and substantive work unless every useful path is genuinely blocked or requires an explicit user decision.

## Converge

Target five armed and staggered timed GPT workers plus all external workers accounted for, no duplicate work, no stale BUSY, a healthy roadmap-backed issue queue, clean PR disposition, and no unnecessary worktrees. Preserve unique/uncommitted work. Workers own their BUSY lifecycle; the orchestrator cleans only abandoned stale markers.

Queue health means workers can continue from authoritative product direction without inventing architecture or waiting for the user to seed tasks. It does not mean maintaining a large arbitrary issue count.

## Continue

After orientation, roadmap/GitHub reconciliation and the checkpoint report, choose the highest-value eligible scope and do substantive work. Before repository mutation, read that repo's current AGENTS.md and live project rules. Claim BUSY only for genuinely conflicting mutation scope and release it when mutation stops.

After implementing/validating that scope, update GitHub and roadmap state as warranted, report meaningful new evidence, then return to orientation/reconciliation and continue while useful work remains. Do not go idle merely because a report was emitted or one worker pass finished.

`@MCP1` is the normal connector used for transport and shared actor/BUSY synchronization only. Do not turn `@MCP1` into the scheduler, worker registry, policy engine, roadmap database, or orchestration state authority. GitHub and live repo/machine state remain durable truth; `@github` is a fallback/debug app route, not the normal orientation path.
