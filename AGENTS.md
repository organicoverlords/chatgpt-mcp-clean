# Local shell MCP infrastructure

This repository serves one native MCP server at `127.0.0.1:3000/mcp`.

- Do not use, launch, register, or proxy Serena, MCP1, Desktop Commander, Docker, or port 9121.
- The native server owns the MCP Streamable HTTP session and exposes exactly these tools: `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`.
- There is no foreground command runner. Start long or uncertain work with `start_process`, inspect it with `read_output`, and stop it with `kill_process`; a transport timeout or disconnect is UNKNOWN until output/process evidence is read.
- Tailscale Funnel, when enabled, may forward the public HTTPS origin to `http://127.0.0.1:3000`; it must not add another MCP proxy or alter MCP bodies.
- Keep the server bound to loopback only. Do not add files, Git, project activation, workspace scanning, skills, routing, orchestration, or scheduler features.
- `.env` and `.state` remain untracked. Never print or commit OAuth credentials.
- Validate with `npm test` before deployment and verify the live `/mcp` handshake and exact tool list.
