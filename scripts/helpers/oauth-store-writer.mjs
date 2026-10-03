import { LocalOAuthProvider } from "../../dist/lib/local-oauth-provider.js";

const [storePath, name, portText] = process.argv.slice(2);
const port = Number(portText);
const provider = new LocalOAuthProvider(new URL("https://example.test/mcp"), "owner", storePath);
const client = await provider.clientsStore.registerClient({
  redirect_uris: ["http://127.0.0.1:" + port + "/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: name,
});
process.stdout.write(client.client_id);
