import { readFileSync } from "node:fs";
import { createServer } from "node:tls";
import { connect } from "node:net";

function value(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const certPath = value("--cert", "");
const keyPath = value("--key", "");
const listenHost = value("--listen-host", "127.0.0.1");
const listenPort = Number(value("--listen-port", "3443"));
const targetHost = value("--target-host", "127.0.0.1");
const targetPort = Number(value("--target-port", "3003"));
if (!certPath || !keyPath || !Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  throw new Error("usage: tls-bridge.mjs --cert <path> --key <path> [--listen-port 3443] [--target-port 3003]");
}

const server = createServer({
  cert: readFileSync(certPath),
  key: readFileSync(keyPath),
  minVersion: "TLSv1.2",
}, (client) => {
  const upstream = connect({ host: targetHost, port: targetPort });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("tlsClientError", () => {});
server.listen(listenPort, listenHost, () => {
  console.log(`tls-bridge ${listenHost}:${listenPort}->${targetHost}:${targetPort}`);
});
