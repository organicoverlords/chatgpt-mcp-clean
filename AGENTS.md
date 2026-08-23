# Local shell MCP infrastructure

This repository serves one native MCP server at `127.0.0.1:3000/mcp`.

- Do not use, launch, register, or proxy Serena, MCP1, Desktop Commander, Docker, or port 9121.
- The native server owns the MCP Streamable HTTP session and exposes exactly these tools: `execute_command`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`.
- Tailscale Funnel, when enabled, may forward the public HTTPS origin to `http://127.0.0.1:3000`; it must not add another MCP proxy or alter MCP bodies.
- Keep the server bound to loopback only. Do not add files, Git, project activation, workspace scanning, skills, routing, orchestration, or scheduler features.
- `.env` and `.state` remain untracked. Never print or commit OAuth credentials.
- Validate with `npm test` before deployment and verify the live `/mcp` handshake and exact tool list.
