/**
 * Host-side HTTP relay for header/OAuth model authentication.
 *
 * Some providers require request headers (OAuth, bearer tokens, gateway
 * headers) that the nested omp cannot safely receive. This relay terminates
 * the sandbox's plain-HTTP request, injects the exact auth headers resolved by
 * the public host `ModelRegistry`, and forwards over verified TLS/HTTP to the
 * fixed provider origin. The sandbox holds only a non-secret placeholder key.
 *
 * Paths are allowlisted to model endpoints (`chat/completions`, `messages`,
 * `responses`, `embeddings`, `models`, and token counting). A local provider's
 * admin/file endpoints cannot be reached through this relay. It runs in the
 * omp process, is per-auditor, and is closed with the sandbox.
 */

import { unlink } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { basename, dirname } from "node:path";
import { herdError } from "../util/errors.mjs";
import { isPublicAddress } from "./egress-relay.mjs";

const HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const AUTH_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"x-goog-api-key",
	"api-key",
	"cookie",
	"host",
]);
const POST_SUFFIXES = [
	"/chat/completions",
	"/completions",
	"/messages",
	"/messages/count_tokens",
	"/count_tokens",
	"/responses",
	"/embeddings",
	"/complete",
	"/converse",
	"/converse-stream",
	"/invoke",
];
const POST_COLON_SUFFIXES = [":generateContent", ":streamGenerateContent", ":countTokens"];

function assertSocketPath(socketPath) {
	if (typeof socketPath !== "string" || socketPath.length === 0) {
		throw herdError("INVALID_ARGUMENT", "HTTP relay needs a socket path", {});
	}
	if (!/^h-[0-9a-f]{8}$/.test(basename(dirname(socketPath)))) {
		throw herdError("INVALID_ARGUMENT", "HTTP relay socket must live in a private short directory", {
			socketPath,
		});
	}
}

export function isAllowedModelRequest(method, pathname) {
	if (typeof pathname !== "string") return false;
	if (method === "POST") {
		return (
			POST_SUFFIXES.some((suffix) => pathname.endsWith(suffix)) ||
			POST_COLON_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
		);
	}
	if (method === "GET") return /\/models(\/[^/]+)?$/.test(pathname);
	return false;
}

function validateTarget({ host, port, protocol }) {
	if (typeof host !== "string" || host.length === 0 || host.length > 253) {
		throw herdError("INVALID_ARGUMENT", "HTTP relay needs a provider host", { host });
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw herdError("INVALID_ARGUMENT", "HTTP relay needs a provider port", { port });
	}
	if (protocol !== "https:" && protocol !== "http:") {
		throw herdError("INVALID_ARGUMENT", "HTTP relay needs an HTTP(S) provider", { protocol });
	}
	return { host, port, protocol };
}

function normalizeHeaders(headers) {
	const normalized = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value === null || value === undefined) continue;
		normalized[key.toLowerCase()] = String(value);
	}
	return normalized;
}

export function createHostHttpRelay({
	socketPath,
	host,
	port,
	address,
	protocol = "https:",
	headers = {},
	apiKey = null,
	headersProvider = null,
	allowNonPublic = false,
}) {
	assertSocketPath(socketPath);
	const target = validateTarget({ host, port, protocol });
	if (typeof address !== "string" || isIP(address) === 0) {
		throw herdError("INVALID_ARGUMENT", "HTTP relay needs a pinned IP address", { address });
	}
	if (!allowNonPublic && !isPublicAddress(address)) {
		throw herdError("CAPABILITY_DENIED", "HTTP relay refuses a non-public pinned address", { address });
	}
	const initialHeaders = normalizeHeaders(headers);
	if (apiKey !== null && initialHeaders.authorization === undefined) {
		initialHeaders.authorization = `Bearer ${apiKey}`;
	}
	const authorityHost = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
	const hostHeader =
		target.port === (target.protocol === "https:" ? 443 : 80) ? authorityHost : `${authorityHost}:${target.port}`;
	const sockets = new Set();
	let server = null;
	let started = false;
	let stopped = false;

	const handler = async (req, res) => {
		const rawUrl = typeof req.url === "string" ? req.url : "/";
		const rawPath = rawUrl.split("?")[0];
		let pathname = "/";
		try {
			pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
		} catch {
			pathname = "/";
		}
		if (
			!isAllowedModelRequest(req.method, pathname) ||
			rawPath.split("/").some((segment) => segment === "..") ||
			rawPath.includes("\\") ||
			/%2e/i.test(rawPath)
		) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
			res.end("model path not allowed");
			return;
		}
		const headersOut = {};
		for (const [key, value] of Object.entries(req.headers)) {
			const normalizedKey = key.toLowerCase();
			if (HOP_HEADERS.has(normalizedKey) || AUTH_HEADERS.has(normalizedKey)) continue;
			if (/(^|[-_])(auth|token|api[-_]?key|cookie|secret)([-_]|$)/.test(normalizedKey)) continue;
			headersOut[normalizedKey] = value;
		}
		let injected = initialHeaders;
		if (typeof headersProvider === "function") {
			try {
				injected = normalizeHeaders(await headersProvider());
			} catch {
				if (!res.headersSent) {
					res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
					res.end("model auth refresh unavailable");
				} else {
					res.destroy();
				}
				return;
			}
		}
		Object.assign(headersOut, injected);
		headersOut.host = hostHeader;
		let requestPath = typeof req.url === "string" && req.url.startsWith("/") ? req.url : `/${req.url ?? ""}`;
		try {
			const parsed = new URL(requestPath, "http://127.0.0.1");
			for (const key of ["key", "api_key", "api-key", "access_token", "token"]) parsed.searchParams.delete(key);
			requestPath = `${parsed.pathname}${parsed.search}`;
		} catch {
			// Keep the original path; the allowlist already checked it.
		}
		const client = target.protocol === "https:" ? https : http;
		const upstream = client.request({
			protocol: target.protocol,
			hostname: address,
			port: target.port,
			path: requestPath,
			method: req.method,
			headers: headersOut,
			servername: target.protocol === "https:" && isIP(target.host) === 0 ? target.host : undefined,
		});
		upstream.on("response", (upstreamResponse) => {
			if (res.destroyed) {
				upstreamResponse.destroy();
				return;
			}
			const responseHeaders = {};
			for (const [key, value] of Object.entries(upstreamResponse.headers)) {
				if (HOP_HEADERS.has(key)) continue;
				responseHeaders[key] = value;
			}
			res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
			upstreamResponse.on("error", () => res.destroy());
			upstreamResponse.pipe(res);
		});
		upstream.on("error", () => {
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end("model upstream unavailable");
			} else {
				res.destroy();
			}
		});
		req.on("aborted", () => upstream.destroy());
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	};

	async function start() {
		if (started) return { socketPath, host: target.host, port: target.port, address };
		if (stopped) throw herdError("CAPABILITY_DENIED", "HTTP relay was already stopped", {});
		started = true;
		try {
			await unlink(socketPath);
		} catch {
			// The path is private and normally absent.
		}
		server = http.createServer((request, response) => {
			void handler(request, response).catch(() => {
				if (!response.headersSent) {
					response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
					response.end("model relay unavailable");
				} else {
					response.destroy();
				}
			});
		});
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server?.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server?.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(socketPath);
		});
		if (stopped) {
			await new Promise((resolveClose) => {
				server?.close(() => resolveClose());
				setTimeout(resolveClose, 250).unref?.();
			});
			server = null;
			try {
				await unlink(socketPath);
			} catch {
				// Already gone.
			}
			throw herdError("CAPABILITY_DENIED", "HTTP relay was stopped while starting", {});
		}
		server.unref?.();
		return { socketPath, host: target.host, port: target.port, address };
	}

	async function stop() {
		if (stopped && server === null) return;
		stopped = true;
		for (const socket of sockets) {
			try {
				socket.destroy();
			} catch {
				// Best effort.
			}
		}
		sockets.clear();
		if (server !== null) {
			await new Promise((resolve) => {
				server.close(() => resolve());
				setTimeout(resolve, 250).unref?.();
			});
			server = null;
		}
		try {
			await unlink(socketPath);
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
