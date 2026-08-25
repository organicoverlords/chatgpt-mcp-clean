# Local shell MCP infrastructure

This repository serves one native MCP server at `127.0.0.1:3000/mcp`.

- Do not use, launch, register, or proxy Serena, MCP1, Desktop Commander, Docker, or port 9121.
- The native server owns the MCP Streamable HTTP session and exposes exactly these tools: `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`.
- `view_image` is model-only visual QA: it returns an image block to the calling model and does not attach or display the file in the user's chat. Call it at most once per artifact, never retry it as a delivery mechanism, and treat a successful call as inspection evidence only. User-facing pictures or animations require a separate conversation-file/attachment route, not this tool.
- There is no foreground command runner. Start long or uncertain work with `start_process`, inspect it with `read_output`, and stop it with `kill_process`; a transport timeout or disconnect is UNKNOWN until output/process evidence is read.
- Long-running queues, batch runs, and background servers MUST NOT run as direct `start_process` children. A child spawned by this server holds the listener's stdout/stderr pipes and dies with it - measured 2026-08-25: an identically spawned child was gone within 6 seconds of its parent being killed - so the listener can never be updated or restarted while one is running. Launch that work from a script that detaches it (`Start-Process -WindowStyle Hidden -RedirectStandardOutput <log>`, or a scheduled task) and use `start_process`/`read_output` only to tail the log. A detached process survives a listener restart, measured in the same run.
- A transport drop is not task completion or task failure. Preserve the current task, BUSY claim, and `process_id`; after reconnect, use one bounded `busy_list`/`read_output` check and resume the exact interrupted step. Do not start a replacement, switch to unrelated fallback work, or release BUSY without evidence that the original process or mutation ended.
- `read_output` is capped at 6,000 characters per stream and marks truncated output; do not print base64, raw binary, or oversized stdout.
- Each live tool result and transport record includes a short pseudonymous `caller_id`; raw authentication values are never logged or returned.
- Tailscale Funnel, when enabled, may forward the public HTTPS origin to `http://127.0.0.1:3000`; it must not add another MCP proxy or alter MCP bodies.
- Keep the server bound to loopback only. Do not add files, Git, project activation, workspace scanning, skills, routing, orchestration, or scheduler features.
- `.env` and `.state` remain untracked. Never print or commit OAuth credentials.
- Validate with `npm test` before deployment and verify the live `/mcp` handshake and exact tool list.
