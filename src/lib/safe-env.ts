export function safeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const deny = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API[_-]?KEY|AUTH|OPENAI|GITHUB|GH_|ANTHROPIC|AZURE|AWS|GOOGLE|TAILSCALE|CLOUDFLARE|NVIDIA|HUGGING|HF_|MCP_)/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !deny.test(key)) out[key] = value;
  }
  return { ...out, CI: "true", PAGER: "cat", GIT_PAGER: "cat", GH_PAGER: "cat", NO_COLOR: "1", ...extra };
}
