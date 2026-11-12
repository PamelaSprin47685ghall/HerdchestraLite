/**
 * Host-side controlled egress relay for one auditor.
 *
 * The listener is a UNIX socket in the auditor's short private socket
 * directory. Every accepted connection is connected to one fixed provider
 * `host:port`; the relay never accepts a caller-chosen target and never
 * inspects payload bytes. It lives in the omp process and is closed with the
 * auditor, so it is not a cross-mission service.
 *
 * The sandbox itself runs in a private network namespace and cannot reach any
 * host TCP service. This relay is the only bridge, and its fixed target is the
 * current model provider.
 */

import { lookup } from "node:dns/promises";
import { unlinkSync } from "node:fs";
import net, { isIP } from "node:net";
import { basename, dirname } from "node:path";
import { herdError } from "../util/errors.mjs";

function ipv4Public(address) {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = parts;
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return false;
	if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	if (a >= 224) return false;
	return true;
}

/**
 * Return true only for global unicast addresses that can be a public model
 * provider. Loopback, RFC1918, link-local, CGNAT, documentation, benchmark,
 * multicast, reserved, and IPv4-mapped/6to4/NAT64 forms that carry private
 * IPv4 addresses are rejected. This is deliberately conservative.
 */
function isUsablePrivateAddress(address) {
	if (isIP(address) === 4) {
		const first = Number(address.split(".")[0]);
		return first !== 0 && first < 224;
	}
	if (isIP(address) === 6) {
		const value = address.toLowerCase();
		return value !== "::" && !value.startsWith("ff");
	}
	return false;
}

export function isPublicAddress(address) {
	if (isIP(address) === 4) return ipv4Public(address);
	if (isIP(address) !== 6) return false;
	const value = address.toLowerCase();
	if (value === "::" || value === "::1") return false;
	if (value.startsWith("::ffff:") || value.startsWith("2002:")) return false;
	// Deprecated IPv4-compatible forms such as ::127.0.0.1 carry a loopback or
	// private IPv4 target but do not spell it with the ::ffff: prefix.
	if (value.startsWith("::")) return false;
	if (value.startsWith("64:ff9b:")) {
		const embedded = value.slice("64:ff9b:".length);
		return isIP(embedded) === 4 ? ipv4Public(embedded) : false;
	}
	if (value.startsWith("fc") || value.startsWith("fd")) return false;
	if (/^fe[89ab]/.test(value)) return false;
	if (value.startsWith("ff")) return false;
	if (value.startsWith("2001:db8")) return false;
	return true;
}

/**
 * Resolve the provider hostname once and pin a public address. A private or
 * mixed answer is rejected: it could be a DNS rebinding attempt or a local
 * service. The returned address is what the relay connects to; the sandbox's
 * TLS SNI remains the original hostname because the relay is a byte pipe.
 */
async function resolvePinned({ host, port, mode }) {
	const target = validateTarget(host, port);
	let records;
	try {
		records = await lookup(target.host, { all: true, verbatim: true });
	} catch (error) {
		throw herdError("CAPABILITY_DENIED", "provider hostname did not resolve", {
			host: target.host,
			cause: error?.code ?? "lookup-failed",
		});
	}
	if (!Array.isArray(records) || records.length === 0) {
		throw herdError("CAPABILITY_DENIED", "provider hostname did not resolve", { host: target.host });
	}
	const addresses = records.map((record) => record.address);
	const allPublic = addresses.every((address) => isPublicAddress(address));
	const allPrivate = addresses.every((address) => !isPublicAddress(address));
	if (mode === "public" && !allPublic) {
		throw herdError("CAPABILITY_DENIED", "provider hostname resolves to a non-public address", {
			host: target.host,
			port: target.port,
			addresses,
		});
	}
	if (mode === "private" && !allPrivate) {
		throw herdError("CAPABILITY_DENIED", "private provider hostname resolves to a public address", {
			host: target.host,
			port: target.port,
			addresses,
		});
	}
	if (mode === "auto" && !allPublic && !allPrivate) {
		throw herdError("CAPABILITY_DENIED", "provider hostname resolves to mixed public/private addresses", {
			host: target.host,
			port: target.port,
			addresses,
		});
	}
	if (!allPublic) {
		const unusable = addresses.filter((address) => !isUsablePrivateAddress(address));
		if (unusable.length > 0) {
			throw herdError("CAPABILITY_DENIED", "private provider resolves to an unusable address", {
				host: target.host,
				port: target.port,
				addresses,
			});
		}
	}
	const chosen = records.find((record) => record.family === 4) ?? records[0];
	return { host: target.host, port: target.port, address: chosen.address, addresses, private: allPrivate };
}

export async function resolvePublicEgressTarget({ host, port }) {
	return resolvePinned({ host, port, mode: "public" });
}

/** Explicit private/loopback providers use the path-allowlisted HTTP proxy. */
export async function resolvePrivateEgressTarget({ host, port }) {
	return resolvePinned({ host, port, mode: "private" });
}

/**
 * Configured hostname resolution: public, private, or localhost is accepted
 * based on the resolved addresses, not the hostname spelling. Mixed answers
 * are rejected because the pinned target would be ambiguous. The resolved
 * address is what the relay connects to; Host/SNI stay the original hostname.
 */
export async function resolveConfiguredEgressTarget({ host, port }) {
	return resolvePinned({ host, port, mode: "auto" });
}

function validateTarget(host, port) {
	if (typeof host !== "string" || host.length === 0 || host.length > 253) {
		throw herdError("INVALID_ARGUMENT", "egress relay needs a provider host", { host });
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw herdError("INVALID_ARGUMENT", "egress relay needs a provider port", { port });
	}
	return { host, port };
}

/**
 * Create (but do not start) the relay. `start()` binds the UNIX socket;
 * `stop()` closes every connection and removes the socket.
 */
export function createHostEgressRelay({ socketPath, host, port, address, allowNonPublic = false }) {
	if (typeof socketPath !== "string" || socketPath.length === 0) {
		throw herdError("INVALID_ARGUMENT", "egress relay needs a socket path", {});
	}
	if (!/^h-[0-9a-f]{8}$/.test(basename(dirname(socketPath)))) {
		throw herdError("INVALID_ARGUMENT", "egress relay socket must live in a private short directory", {
			socketPath,
		});
	}
	const target = validateTarget(host, port);
	if (typeof address !== "string" || isIP(address) === 0) {
		throw herdError("INVALID_ARGUMENT", "egress relay needs a pinned IP address", { address });
	}
	if (!allowNonPublic && !isPublicAddress(address)) {
		throw herdError("CAPABILITY_DENIED", "egress relay refuses a non-public pinned address", { address });
	}
	const connections = new Set();
	let server = null;
	let started = false;
	let stopped = false;

	function track(socket) {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		return socket;
	}

	const listener = net.createServer((client) => {
		track(client);
		const upstream = track(net.connect({ host: address, port: target.port }));
		client.pipe(upstream).pipe(client);
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	listener.maxConnections = 64;

	async function start() {
		if (started) return { socketPath, host: target.host, port: target.port, address };
		if (stopped) throw herdError("CAPABILITY_DENIED", "egress relay was already stopped", {});
		started = true;
		try {
			unlinkSync(socketPath);
		} catch {
			// The path is private and normally absent.
		}
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				listener.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				listener.off("error", onError);
				resolve();
			};
			listener.once("error", onError);
			listener.once("listening", onListening);
			listener.listen(socketPath);
		});
		if (stopped) {
			await new Promise((resolveClose) => {
				listener.close(() => resolveClose());
				setTimeout(resolveClose, 250).unref?.();
			});
			try {
				unlinkSync(socketPath);
			} catch {
				// Already gone.
			}
			throw herdError("CAPABILITY_DENIED", "egress relay was stopped while starting", {});
		}
		server = listener;
		server.unref?.();
		return { socketPath, host: target.host, port: target.port, address };
	}

	async function stop() {
		if (stopped && server === null) return;
		stopped = true;
		for (const socket of connections) {
			try {
				socket.destroy();
			} catch {
				// Best effort.
			}
		}
		connections.clear();
		if (server !== null) {
			await new Promise((resolve) => {
				server.close(() => resolve());
				setTimeout(resolve, 250).unref?.();
			});
			server = null;
		}
		try {
			unlinkSync(socketPath);
		} catch {
			// Already gone.
		}
	}

	return {
		socketPath,
		host: target.host,
		port: target.port,
		address,
		start,
		stop,
	};
}
