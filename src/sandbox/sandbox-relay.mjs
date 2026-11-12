/**
 * TCP-to-UNIX relay that runs inside an auditor sandbox.
 *
 * The sandbox has its own network namespace and no route to the host. The
 * nested omp still expects a TCP provider endpoint, so this relay listens on
 * the provider's loopback host:port and forwards each connection through the
 * host-side egress relay's UNIX socket. The relay never interprets TLS or
 * model payloads; it is a byte pipe.
 *
 * It writes a readiness marker after `listen(2)` succeeds. The session
 * bootstrap waits for that marker before starting tmux, so a broken relay
 * fails the sandbox instead of silently producing an offline session.
 */

import { writeFileSync } from "node:fs";
import net from "node:net";

const [socketPath, listenPort, readyPath] = process.argv.slice(2);
if (!socketPath || !listenPort || !readyPath) {
	process.stderr.write("sandbox relay needs <socket> <port> <ready-file>\n");
	process.exit(2);
}

const server = net.createServer((client) => {
	const upstream = net.connect(socketPath);
	client.pipe(upstream).pipe(client);
	client.on("error", () => upstream.destroy());
	upstream.on("error", () => client.destroy());
	client.on("close", () => upstream.destroy());
	upstream.on("close", () => client.destroy());
});

server.once("error", () => process.exit(1));
server.listen(Number(listenPort), "127.0.0.1", () => {
	try {
		writeFileSync(readyPath, "ready\n", { mode: 0o600 });
	} catch {
		process.exit(1);
	}
});

for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		server.close();
		process.exit(0);
	});
}
