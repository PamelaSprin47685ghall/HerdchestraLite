import { afterAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { registerAuditModelSeed } from "../src/host/model-seed.mjs";
import {
	buildBwrapArgs,
	createHostEgressRelay,
	createHostHttpRelay,
	createSandboxedRunCommand,
	isAllowedModelRequest,
	isPublicAddress,
	modelProxyHeaders,
	prepareModelSeed,
	renderModelConfig,
	renderOmpWrapper,
	renderSecretEnv,
	resolveConfiguredEgressTarget,
	resolveCurrentModel,
	resolveEgressTarget,
	resolveModelAuth,
	resolvePrivateEgressTarget,
	resolvePublicEgressTarget,
	selectAuditTransport,
	selectModelTransport,
	writeAuditModelSeed,
} from "../src/sandbox/index.mjs";

const roots = [];
const FAKE_KEY = "sk-test-NOT-A-REAL-KEY-0123456789";

function tempRoot(prefix = "herd-net-test-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function fixture() {
	const root = tempRoot();
	const evidence = join(root, "plans", "demo", "evidence", "CASE-01");
	mkdirSync(evidence, { recursive: true });
	const auditTmp = mkdtempSync(join(tmpdir(), "herd-audit-net-"));
	roots.push(auditTmp);
	const socketDir = join(tmpdir(), `h-${randomBytes(4).toString("hex")}`);
	mkdirSync(socketDir, { mode: 0o700 });
	roots.push(socketDir);
	const fakeOmp = join(auditTmp, "fake-omp");
	writeFileSync(fakeOmp, '#!/bin/sh\nprintf %s "$MISTRAL_API_KEY" | sha256sum | cut -d" " -f1 > "$1"\n', {
		mode: 0o755,
	});
	const seed = prepareModelSeed({
		auditTmp,
		socketDir,
		model: { provider: "mistral", id: "deepseek-v4-1-flash-1017", baseUrl: "https://provider.test" },
		auth: { apiKey: FAKE_KEY, envVar: "MISTRAL_API_KEY", env: {} },
		target: { host: "provider.test", port: 443 },
		realOmp: fakeOmp,
	});
	return {
		root,
		evidenceRoot: evidence,
		auditTmp,
		socketDir,
		socketPath: join(socketDir, "s"),
		sessionName: "herd-demo-CASE-01",
		cwd: root,
		fakeOmp,
		seed,
	};
}

function listenTcp() {
	return new Promise((resolveListen) => {
		const server = net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
		server.listen(0, "127.0.0.1", () => resolveListen(server));
	});
}

function listenUnix(path) {
	return new Promise((resolveListen) => {
		const server = net.createServer((socket) => socket.end());
		server.listen(path, () => resolveListen(server));
	});
}

function modelEgress(socketDir) {
	return { host: "provider.test", port: 443, listenPort: 443, relaySocket: join(socketDir, "e") };
}

function buildModelArgs(data, command) {
	const egress = modelEgress(data.socketDir);
	const inner = buildBwrapArgs({
		...data,
		command,
		network: "model",
		modelSeed: data.seed,
		modelEgress: egress,
	});
	return { inner, argv: inner };
}

function requestUnix(socketPath, { method = "POST", path = "/", headers = {}, body = "" } = {}) {
	return new Promise((resolveRequest, rejectRequest) => {
		const request = http.request({ socketPath, method, path, headers }, (response) => {
			let text = "";
			response.on("data", (chunk) => (text += chunk));
			response.on("end", () => resolveRequest({ status: response.statusCode, body: text }));
		});
		request.on("error", rejectRequest);
		request.end(body);
	});
}

function runWorker(argv, data, allowedTcpPorts, modelEnv, stderrLog) {
	return new Promise((resolveWorker, rejectWorker) => {
		const worker = new Worker(new URL("../src/sandbox/model-worker.mjs", import.meta.url), {
			workerData: { argv, cwd: data.root, allowedTcpPorts, modelEnv, stderrLog, wait: true },
		});
		worker.once("message", (message) => {
			if (message?.error) rejectWorker(new Error(message.error));
			else resolveWorker(message);
		});
		worker.once("error", rejectWorker);
	});
}

function startWorkerNoWait(argv, data, allowedTcpPorts, modelEnv, stderrLog) {
	return new Promise((resolveWorker, rejectWorker) => {
		const worker = new Worker(new URL("../src/sandbox/model-worker.mjs", import.meta.url), {
			workerData: { argv, cwd: data.root, allowedTcpPorts, modelEnv, stderrLog, wait: false },
		});
		worker.once("message", (message) => {
			if (message?.error) {
				rejectWorker(new Error(message.error));
			} else if (Number.isInteger(message?.pid) && message.pid > 0) {
				resolveWorker({ worker, pid: message.pid });
			} else {
				rejectWorker(new Error("model sandbox worker returned no pid"));
			}
		});
		worker.once("error", rejectWorker);
	});
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error?.code !== "EPERM") return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state !== "Z" && state !== "X";
	} catch {
		return true;
	}
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("model seed from the public host API", () => {
	it("keeps the credential out of config and wrapper and pins the current model", async () => {
		const fakeModel = {
			provider: "mistral",
			id: "deepseek-v4-1-flash-1017",
			baseUrl: "https://api.mistral.ai/v1",
		};
		const registry = {
			find: (provider, id) => (provider === "mistral" && id === fakeModel.id ? fakeModel : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: FAKE_KEY }),
		};
		const canonical = { ...fakeModel, compat: { supportsStore: false } };
		const objectRegistry = { find: () => canonical };
		expect(
			resolveCurrentModel({
				model: { provider: "mistral", id: fakeModel.id, baseUrl: fakeModel.baseUrl },
				modelRegistry: objectRegistry,
			}),
		).toBe(canonical);
		const model = resolveCurrentModel({ model: "mistral/deepseek-v4-1-flash-1017:max", modelRegistry: registry });
		expect(model).toBe(fakeModel);
		const auth = await resolveModelAuth({ model, modelRegistry: registry });
		const target = resolveEgressTarget({ model, auth });
		expect(target).toEqual({
			host: "api.mistral.ai",
			port: 443,
			protocol: "https:",
			basePath: "/v1",
			explicitPrivate: false,
			requiresProxy: false,
		});
		const secret = renderSecretEnv(auth);
		expect(secret).toContain(FAKE_KEY);
		const config = renderModelConfig({ model });
		expect(config).toContain('default: "mistral/deepseek-v4-1-flash-1017"');
		expect(config).not.toContain(FAKE_KEY);
		const wrapper = renderOmpWrapper({ realOmp: "/usr/bin/omp", secretPath: "/tmp/secret.env" });
		expect(wrapper).not.toContain(FAKE_KEY);
		expect(wrapper).toContain("/tmp/secret.env");
	});

	it("marks explicit private targets and exposes header auth as proxy mode", async () => {
		const model = { provider: "mistral", id: "deepseek-v4-1-flash-1017", baseUrl: "https://127.0.0.1/v1" };
		const privateTarget = resolveEgressTarget({ model, auth: {} });
		expect(privateTarget.explicitPrivate).toBe(true);
		expect(privateTarget.host).toBe("127.0.0.1");
		const resolvedPrivate = await resolvePrivateEgressTarget({ host: "127.0.0.1", port: 11434 });
		expect(resolvedPrivate.address).toBe("127.0.0.1");
		const resolvedPrivateName = await resolveConfiguredEgressTarget({ host: "ip6-localhost", port: 11434 });
		expect(resolvedPrivateName.private).toBe(true);
		await expect(resolvePublicEgressTarget({ host: "ip6-localhost", port: 11434 })).rejects.toThrow();
		const privateNameTarget = resolveEgressTarget({
			model: { provider: "local", id: "m", baseUrl: "http://ip6-localhost:11434/v1" },
		});
		expect(privateNameTarget.explicitPrivate).toBe(false);
		expect(privateNameTarget.requiresProxy).toBe(false);
		expect(
			selectModelTransport({
				auth: { mode: "tls", apiKey: "k", envVar: "MISTRAL_API_KEY", headers: {} },
				target: privateNameTarget,
				resolved: resolvedPrivateName,
			}),
		).toBe("proxy");
		expect(
			selectModelTransport({
				auth: { mode: "tls", apiKey: "k", envVar: "MISTRAL_API_KEY", headers: {} },
				target: privateNameTarget,
				resolved: { private: false },
			}),
		).toBe("proxy");
		const ipv6Literal = resolveEgressTarget({
			model: { provider: "local", id: "m", baseUrl: "http://[::1]:11434/v1" },
		});
		expect(ipv6Literal.host).toBe("::1");
		expect(ipv6Literal.explicitPrivate).toBe(true);
		expect(ipv6Literal.requiresProxy).toBe(true);
		const publicModel = { ...model, baseUrl: "https://provider.test/v1" };
		const registry = {
			getApiKeyAndHeaders: async () => ({ ok: true, headers: { Authorization: "Bearer fake-host-token" } }),
		};
		const auth = await resolveModelAuth({ model: publicModel, modelRegistry: registry });
		expect(auth.mode).toBe("proxy");
		expect(auth.headers.authorization).toBe("Bearer fake-host-token");
		expect(auth.apiKey).toBe(null);
		const emptyRegistry = { getApiKeyAndHeaders: async () => ({ ok: true }) };
		await expect(resolveModelAuth({ model: publicModel, modelRegistry: emptyRegistry })).rejects.toThrow();
		const keylessRegistry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "N/A" }) };
		await expect(resolveModelAuth({ model: publicModel, modelRegistry: keylessRegistry })).rejects.toThrow();
		const keylessPrivate = await resolveModelAuth({
			model: publicModel,
			modelRegistry: keylessRegistry,
			allowNoAuth: true,
		});
		expect(keylessPrivate.apiKey).toBe(null);
		const noAuth = await resolveModelAuth({
			model: publicModel,
			modelRegistry: emptyRegistry,
			allowNoAuth: true,
		});
		expect(noAuth.mode).toBe("proxy");
		expect(noAuth.headers).toEqual({});
		const missingRegistry = { getApiKeyAndHeaders: async () => ({ ok: false }) };
		await expect(resolveModelAuth({ model: publicModel, modelRegistry: missingRegistry })).rejects.toThrow();
		const missingButPrivate = await resolveModelAuth({
			model: publicModel,
			modelRegistry: missingRegistry,
			allowNoAuth: true,
		});
		expect(missingButPrivate.mode).toBe("proxy");
		expect(missingButPrivate.headers).toEqual({});
		expect(
			selectModelTransport({
				auth: { mode: "tls", apiKey: "k", envVar: "MISTRAL_API_KEY" },
				target: { explicitPrivate: false, requiresProxy: false },
			}),
		).toBe("proxy");
		expect(
			selectModelTransport({
				auth: { mode: "proxy", apiKey: null, headers: {} },
				target: { explicitPrivate: false, requiresProxy: false },
			}),
		).toBe("proxy");
		expect(
			selectModelTransport({
				auth: { mode: "tls", apiKey: "k", envVar: "MISTRAL_API_KEY" },
				target: { explicitPrivate: true, requiresProxy: true },
			}),
		).toBe("proxy");
		expect(
			selectModelTransport({
				auth: { mode: "tls", apiKey: "k", envVar: undefined },
				target: { explicitPrivate: false, requiresProxy: false },
			}),
		).toBe("proxy");
		expect(modelProxyHeaders({ auth: { apiKey: "k", headers: {} }, api: "anthropic-messages" })).toEqual({
			"x-api-key": "k",
		});
		expect(modelProxyHeaders({ auth: { apiKey: "k", headers: {} }, api: "google-generative-ai" })).toEqual({
			"x-goog-api-key": "k",
		});
		expect(modelProxyHeaders({ auth: { apiKey: "k", headers: {} }, api: "openai-completions" })).toEqual({
			authorization: "Bearer k",
		});
		expect(modelProxyHeaders({ auth: { apiKey: null, headers: {} }, api: "openai-completions" })).toBe(null);
		expect(
			selectAuditTransport({
				auth: { mode: "proxy", apiKey: "k", headers: {}, env: {} },
				target: publicModel,
				resolved: { private: false },
				model: publicModel,
			}),
		).toBe("http-proxy");
		expect(() =>
			selectAuditTransport({
				auth: { mode: "tls", apiKey: null, headers: {}, env: { AWS_SECRET_ACCESS_KEY: "secret" } },
				target: publicModel,
				resolved: { private: false },
				model: publicModel,
			}),
		).toThrow();
		expect(() =>
			selectAuditTransport({
				auth: { mode: "tls", apiKey: null, headers: {}, env: { AWS_SECRET_ACCESS_KEY: "secret" } },
				target: publicModel,
				resolved: { private: true },
				model: publicModel,
			}),
		).toThrow();
	});
});

describe("provider address policy", () => {
	it("rejects loopback, RFC1918, link-local, and mapped private addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"169.254.1.1",
			"100.64.0.1",
			"::1",
			"fc00::1",
			"fd12::1",
			"fe80::1",
			"::ffff:127.0.0.1",
			"::127.0.0.1",
		]) {
			expect(isPublicAddress(address)).toBe(false);
		}
		for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
			expect(isPublicAddress(address)).toBe(true);
		}
	});

	it("rejects localhost resolution and pins a public IP for an IP literal", async () => {
		await expect(resolvePublicEgressTarget({ host: "localhost", port: 443 })).rejects.toThrow();
		await expect(resolvePublicEgressTarget({ host: "127.0.0.1", port: 443 })).rejects.toThrow();
		const resolved = await resolvePublicEgressTarget({ host: "8.8.8.8", port: 443 });
		expect(resolved.address).toBe("8.8.8.8");
		expect(resolved.host).toBe("8.8.8.8");
		expect(resolved.port).toBe(443);
		const data = fixture();
		expect(() =>
			createHostEgressRelay({
				socketPath: join(data.socketDir, "e"),
				host: "provider.test",
				port: 443,
				address: "127.0.0.1",
			}),
		).toThrow();
	});
});

describe("audit model seed registration contract", () => {
	const catalogSource = (name) =>
		pathToFileURL(join(homedir(), "node_modules", "@oh-my-pi", "pi-catalog", "src", name)).href;

	it("registers the complete non-secret ModelSpec through the public extension API", async () => {
		const { buildModel } = await import(catalogSource("build.ts"));
		const base = {
			id: "custom-audit-model-7",
			name: "Custom Audit Model 7",
			api: "openai-completions",
			provider: "custom-audit",
			baseUrl: "https://custom.provider.test/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 65536,
			maxTokens: 8192,
			thinking: { mode: "effort", efforts: ["low", "high"] },
			compat: { supportsStore: false, requiresToolResultName: true },
		};
		const model = {
			...buildModel(base),
			identity: { class: "custom", family: "audit", revision: "7" },
		};
		const data = fixture();
		const seed = writeAuditModelSeed({
			auditTmp: data.auditTmp,
			model,
			baseUrl: "http://custom.provider.test:18443/v1",
			authEnvVar: "MISTRAL_API_KEY",
			apiKeyFallback: null,
		});
		const seedText = readFileSync(seed.seedPath, "utf8");
		expect(seedText).not.toContain("MISTRAL_API_KEY=");
		const seedJson = JSON.parse(seedText);
		expect(seedJson.provider).toBe("custom-audit");
		expect(seedJson.baseUrl).toBe("http://custom.provider.test:18443/v1");
		expect(seedJson.modelId).toBe("custom-audit-model-7");
		expect(seedJson.model).toBeUndefined();
		expect(seedJson.models).toHaveLength(1);
		const seeded = seedJson.models[0];
		expect(seeded.id).toBe("custom-audit-model-7");
		expect(seeded.api).toBe("openai-completions");
		expect(seeded.compat).toEqual(model.compat);
		expect(seeded.identity).toBeUndefined();
		expect(seeded.provider).toBeUndefined();
		expect(seeded.baseUrl).toBeUndefined();
		const fakePi = {
			calls: [],
			registerProvider(provider, config) {
				this.calls.push({ provider, config });
			},
		};
		const registered = registerAuditModelSeed(fakePi, {
			HERD_AUDIT_MODEL_SEED: seed.seedPath,
			MISTRAL_API_KEY: "fake-env-key",
		});
		expect(registered.registered).toBe(true);
		expect(fakePi.calls).toHaveLength(1);
		const config = fakePi.calls[0].config;
		expect(fakePi.calls[0].provider).toBe("custom-audit");
		expect(config.apiKey).toBe("fake-env-key");
		expect(config.baseUrl).toBe("http://custom.provider.test:18443/v1");
		expect(config.models).toHaveLength(1);
		expect(config.models[0].identity).toBeUndefined();
		expect(config.models[0].baseUrl).toBeUndefined();
		const resolved = buildModel({
			...config.models[0],
			provider: fakePi.calls[0].provider,
			baseUrl: config.baseUrl,
		});
		expect(resolved.input).toEqual(model.input);
		expect(resolved.api).toBe(model.api);
		const differences = Object.keys(model.compat).filter(
			(key) => JSON.stringify(model.compat[key]) !== JSON.stringify(resolved.compat[key]),
		);
		expect(differences).toEqual([]);
	});

	it("keeps host image input while the bundled catalog row is text-only", async () => {
		const { buildModel } = await import(catalogSource("build.ts"));
		const bundled = {
			id: "deepseek-v4-1-flash-1017",
			name: "DeepSeek V4.1 Flash 1017",
			api: "openai-completions",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 128000,
			thinking: { mode: "effort", efforts: ["low", "high", "max"] },
			compat: { supportsStore: false, toolStrictMode: "mixed", streamMarkupHealingPattern: "dsml" },
		};
		expect(bundled.input).toEqual(["text"]);
		const host = buildModel({ ...bundled, input: ["text", "image"] });
		expect(host.input).toEqual(["text", "image"]);
		const data = fixture();
		const seed = writeAuditModelSeed({
			auditTmp: data.auditTmp,
			model: host,
			baseUrl: "http://api.mistral.ai:18443/v1",
			authEnvVar: "MISTRAL_API_KEY",
			apiKeyFallback: null,
		});
		const calls = [];
		registerAuditModelSeed(
			{ registerProvider: (provider, config) => calls.push({ provider, config }) },
			{ HERD_AUDIT_MODEL_SEED: seed.seedPath, MISTRAL_API_KEY: "fake-env-key" },
		);
		const spec = calls[0].config.models[0];
		expect(spec.input).toEqual(["text", "image"]);
		expect(spec.identity).toBeUndefined();
		const rebuilt = buildModel({
			...spec,
			provider: calls[0].provider,
			baseUrl: calls[0].config.baseUrl,
		});
		expect(rebuilt.input).toEqual(["text", "image"]);
		expect(rebuilt.api).toBe(host.api);
		const differences = Object.keys(host.compat).filter(
			(key) => JSON.stringify(host.compat[key]) !== JSON.stringify(rebuilt.compat[key]),
		);
		expect(differences).toEqual([]);
	});

	it("strips hand-made identity, provider, route, and headers from a seed", () => {
		const data = fixture();
		const seedPath = join(data.auditTmp, "model-seed.json");
		writeFileSync(
			seedPath,
			JSON.stringify({
				provider: "custom-audit",
				modelId: "custom-audit-model-7",
				baseUrl: "http://relay.test/v1",
				api: "openai-completions",
				authEnvVar: "MISTRAL_API_KEY",
				models: [
					{
						id: "custom-audit-model-7",
						api: "openai-completions",
						identity: { class: "hand-made" },
						provider: "other-provider",
						baseUrl: "https://real.provider.test/v1",
						headers: { authorization: "secret" },
					},
				],
			}),
			{ mode: 0o600 },
		);
		const calls = [];
		registerAuditModelSeed(
			{ registerProvider: (provider, config) => calls.push({ provider, config }) },
			{ HERD_AUDIT_MODEL_SEED: seedPath, MISTRAL_API_KEY: "fake-env-key" },
		);
		expect(calls).toHaveLength(1);
		const spec = calls[0].config.models[0];
		expect(spec.identity).toBeUndefined();
		expect(spec.provider).toBeUndefined();
		expect(spec.baseUrl).toBeUndefined();
		expect(spec.headers).toBeUndefined();
		expect(calls[0].config.baseUrl).toBe("http://relay.test/v1");
	});
});

describe("private network namespace", () => {
	it("uses bwrap's private network namespace and no shared host network", () => {
		const data = fixture();
		const { inner, argv } = buildModelArgs(data, "true");
		expect(inner).toContain("--unshare-net");
		expect(inner).toContain("--unshare-user");
		expect(inner).toContain("--uid");
		expect(inner).toContain("--ro-bind-data");
		expect(inner).toContain("CAP_NET_BIND_SERVICE");
		expect(argv).toBe(inner);
		const isolated = buildBwrapArgs({ ...data, command: "true", network: "isolated" });
		expect(isolated).toContain("--unshare-net");
	});

	it("keeps bwrap alive while its worker lives and kills it when the worker stops", async () => {
		const data = fixture();
		const { argv } = buildModelArgs(data, "sleep 3");
		const { worker, pid } = await startWorkerNoWait(argv, data, [443], null, join(data.auditTmp, "stderr.log"));
		try {
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
			expect(pidAlive(pid)).toBe(true);
		} finally {
			const stopped = new Promise((resolveStop) => {
				worker.once("message", (message) => {
					if (message?.stopped === true) resolveStop();
				});
			});
			worker.postMessage("shutdown");
			await Promise.race([stopped, new Promise((resolveSleep) => setTimeout(resolveSleep, 3000))]);
			await worker.terminate();
		}
		const deadline = Date.now() + 3000;
		while (pidAlive(pid) && Date.now() < deadline) {
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
		}
		expect(pidAlive(pid)).toBe(false);
	});

	it("denies a hardlink from the read-only repo in the model layer", async () => {
		const data = fixture();
		writeFileSync(join(data.root, "AGENTS.md"), "contract\n");
		const leakPath = join(data.auditTmp, "leak.txt");
		const linkArgs = buildModelArgs(data, `ln '${data.root}/AGENTS.md' '${leakPath}'`);
		const linked = await runWorker(linkArgs.argv, data, [443], data.seed.secretEnv, join(data.auditTmp, "link.log"));
		expect(linked.exitCode).not.toBe(0);
		expect(existsSync(leakPath)).toBe(false);
	});
});

describe("controlled model egress", () => {
	it("reaches only the fixed provider relay and blocks host services", async () => {
		const data = fixture();
		const echo = await listenTcp();
		const echoPort = echo.address().port;
		const egress = modelEgress(data.socketDir);
		const relay = createHostEgressRelay({
			socketPath: egress.relaySocket,
			host: "127.0.0.1",
			port: echoPort,
			address: "127.0.0.1",
			allowNonPublic: true,
		});
		await relay.start();
		try {
			const script = join(data.auditTmp, "client.py");
			const netResult = join(data.auditTmp, "net.json");
			writeFileSync(
				script,
				[
					"import json, socket, sys",
					"relay_port, direct_port, result = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]",
					"out = {}",
					"def try_tcp(host, port, payload):",
					"    s = socket.socket(); s.settimeout(4)",
					"    try:",
					"        s.connect((host, port)); s.sendall(payload); data = s.recv(64)",
					"        return 'ok:' + data.decode('utf-8', 'replace')",
					"    except OSError as e:",
					"        return 'denied:' + str(e.errno)",
					"    finally:",
					"        s.close()",
					"out['provider'] = try_tcp('provider.test', relay_port, b'ping')",
					"out['host_service'] = try_tcp('127.0.0.1', direct_port, b'ping')",
					"open(result, 'w').write(json.dumps(out, sort_keys=True))",
					"",
				].join("\n"),
			);
			const { argv } = buildModelArgs(data, `python3 ${script} 443 ${echoPort} ${netResult}`);
			const worker = await runWorker(argv, data, [443], data.seed.secretEnv, join(data.auditTmp, "stderr.log"));
			expect(worker.exitCode).toBe(0);
			const result = JSON.parse(readFileSync(netResult, "utf8"));
			expect(result.provider).toBe("ok:ping");
			expect(result.host_service.startsWith("denied:")).toBe(true);
		} finally {
			await relay.stop();
			echo.close();
		}
	});

	it("seeds the public model credential into omp without writing it to config or evidence", async () => {
		const data = fixture();
		const echo = await listenTcp();
		const relay = createHostEgressRelay({
			socketPath: modelEgress(data.socketDir).relaySocket,
			host: "127.0.0.1",
			port: echo.address().port,
			address: "127.0.0.1",
			allowNonPublic: true,
		});
		await relay.start();
		try {
			const credResult = join(data.auditTmp, "cred.txt");
			const { argv } = buildModelArgs(data, `omp ${credResult}`);
			const worker = await runWorker(argv, data, [443], data.seed.secretEnv, join(data.auditTmp, "stderr.log"));
			expect(worker.exitCode).toBe(0);
			const expected = createHash("sha256").update(FAKE_KEY).digest("hex");
			expect(readFileSync(credResult, "utf8").trim()).toBe(expected);
			expect(readFileSync(data.seed.configPath, "utf8")).not.toContain(FAKE_KEY);
			expect(readFileSync(data.seed.wrapperPath, "utf8")).not.toContain(FAKE_KEY);
		} finally {
			await relay.stop();
			echo.close();
		}
	});
});

describe("header/OAuth proxy mode", () => {
	it("injects host-only headers and rejects admin paths", async () => {
		const data = fixture();
		const seen = [];
		const upstream = http.createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				seen.push({ path: request.url, auth: request.headers.authorization, host: request.headers.host, body });
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: true }));
			});
		});
		const upstreamPort = await new Promise((resolveListen) => {
			upstream.listen(0, "127.0.0.1", () => resolveListen(upstream.address().port));
		});
		const socketPath = join(data.socketDir, "h");
		let refreshCount = 0;
		const relay = createHostHttpRelay({
			socketPath,
			host: "upstream.test",
			port: upstreamPort,
			address: "127.0.0.1",
			protocol: "http:",
			headers: {},
			headersProvider: async () => {
				refreshCount += 1;
				return { authorization: "Bearer host-secret" };
			},
			allowNonPublic: true,
		});
		await relay.start();
		try {
			const allowed = await requestUnix(socketPath, {
				method: "POST",
				path: "/v1/chat/completions",
				headers: { authorization: "Bearer sandbox-dummy", "content-type": "application/json" },
				body: '{"probe":true}',
			});
			expect(allowed.status).toBe(200);
			expect(seen).toHaveLength(1);
			expect(refreshCount).toBe(1);
			expect(seen[0].auth).toBe("Bearer host-secret");
			expect(seen[0].host).toBe(`upstream.test:${upstreamPort}`);
			expect(seen[0].path).toBe("/v1/chat/completions");
			expect(seen[0].body).toBe('{"probe":true}');
			const denied = await requestUnix(socketPath, { method: "POST", path: "/v1/admin/delete", body: "{}" });
			expect(denied.status).toBe(403);
			const traversal = await requestUnix(socketPath, {
				method: "POST",
				path: "/v1/../admin/chat/completions",
				body: "{}",
			});
			expect(traversal.status).toBe(403);
			expect(seen).toHaveLength(1);
			expect(isAllowedModelRequest("GET", "/v1/models")).toBe(true);
			expect(isAllowedModelRequest("POST", "/v1/messages")).toBe(true);
			expect(isAllowedModelRequest("POST", "/v1/files")).toBe(false);
		} finally {
			await relay.stop();
			upstream.close();
		}
	});

	it("runs a sandbox HTTP request through the relay without real auth in the sandbox", async () => {
		const data = fixture();
		let seen = null;
		const upstream = http.createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				seen = { path: request.url, auth: request.headers.authorization, body };
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: true }));
			});
		});
		const upstreamPort = await new Promise((resolveListen) => {
			upstream.listen(0, "127.0.0.1", () => resolveListen(upstream.address().port));
		});
		const listenPort = 18443;
		const relaySocket = join(data.socketDir, "e");
		const relay = createHostHttpRelay({
			socketPath: relaySocket,
			host: "upstream.test",
			port: upstreamPort,
			address: "127.0.0.1",
			protocol: "http:",
			headers: { authorization: "Bearer host-secret" },
			allowNonPublic: true,
		});
		await relay.start();
		try {
			const proxySeed = prepareModelSeed({
				auditTmp: data.auditTmp,
				socketDir: data.socketDir,
				model: {
					provider: "mistral",
					id: "deepseek-v4-1-flash-1017",
					api: "openai-completions",
					contextWindow: 1000,
					maxTokens: 100,
					compat: { supportsStore: false },
				},
				auth: { apiKey: "host-secret-not-used", envVar: "MISTRAL_API_KEY", env: {}, headers: {} },
				target: { host: "provider.test", port: 443 },
				realOmp: data.fakeOmp,
				proxy: { localBaseUrl: `http://provider.test:${listenPort}/v1` },
			});
			expect(proxySeed.secretEnv).toContain("MISTRAL_API_KEY");
			expect(proxySeed.secretEnv).toContain("herd-local-placeholder");
			expect(proxySeed.secretEnv).not.toContain("host-secret-not-used");
			expect(readFileSync(proxySeed.configPath, "utf8")).toContain("mistral/deepseek-v4-1-flash-1017");
			expect(existsSync(join(data.auditTmp, "home", ".omp", "agent", "models.yml"))).toBe(false);
			const seedJson = JSON.parse(readFileSync(proxySeed.modelSeedPath, "utf8"));
			expect(seedJson.provider).toBe("mistral");
			expect(seedJson.modelId).toBe("deepseek-v4-1-flash-1017");
			expect(seedJson.baseUrl).toBe(`http://provider.test:${listenPort}/v1`);
			expect(seedJson.model).toBeUndefined();
			expect(seedJson.authEnvVar).toBe("MISTRAL_API_KEY");
			expect(seedJson.apiKeyFallback).toBe("herd-local-placeholder");
			const script = join(data.auditTmp, "http-client.py");
			const resultPath = join(data.auditTmp, "http-result.json");
			writeFileSync(
				script,
				[
					"import http.client, json, sys",
					"conn = http.client.HTTPConnection('127.0.0.1', int(sys.argv[1]), timeout=5)",
					"conn.request('POST', '/v1/chat/completions', body='{\"probe\":true}', headers={'Authorization': 'Bearer sandbox-dummy', 'Content-Type': 'application/json'})",
					"resp = conn.getresponse(); text = resp.read().decode()",
					"open(sys.argv[2], 'w').write(json.dumps({'status': resp.status, 'body': json.loads(text)}))",
					"conn.close()",
					"",
				].join("\n"),
			);
			const egress = { host: "127.0.0.1", port: listenPort, listenPort, relaySocket };
			const inner = buildBwrapArgs({
				...data,
				command: `python3 ${script} ${listenPort} ${resultPath}`,
				network: "model",
				modelSeed: proxySeed,
				modelEgress: egress,
			});
			const worker = await runWorker(inner, data, [listenPort], proxySeed.secretEnv, join(data.auditTmp, "stderr.log"));
			expect(worker.exitCode, readFileSync(join(data.auditTmp, "stderr.log"), "utf8")).toBe(0);
			const result = JSON.parse(readFileSync(resultPath, "utf8"));
			expect(result.status).toBe(200);
			expect(result.body.ok).toBe(true);
			expect(seen.auth).toBe("Bearer host-secret");
			expect(seen.path).toBe("/v1/chat/completions");
			expect(readFileSync(proxySeed.configPath, "utf8")).not.toContain("host-secret");
			expect(readFileSync(proxySeed.modelSeedPath, "utf8")).not.toContain("host-secret");
		} finally {
			await relay.stop();
			upstream.close();
		}
	});
});

describe("UNIX socket boundaries", () => {
	it("blocks host abstract and pathname sockets but keeps the audit tree reachable", async () => {
		const data = fixture();
		const deniedPath = join(data.root, "denied.sock");
		const allowedPath = join(data.auditTmp, "allowed.sock");
		const abstractName = `herd-net-abs-${process.pid}-${randomBytes(4).toString("hex")}`;
		const deniedServer = await listenUnix(deniedPath);
		const allowedServer = await listenUnix(allowedPath);
		const abstractServer = await listenUnix(`\0${abstractName}`);
		const echo = await listenTcp();
		const relay = createHostEgressRelay({
			socketPath: modelEgress(data.socketDir).relaySocket,
			host: "127.0.0.1",
			port: echo.address().port,
			address: "127.0.0.1",
			allowNonPublic: true,
		});
		await relay.start();
		try {
			const script = join(data.auditTmp, "unix-check.py");
			const resultPath = join(data.auditTmp, "unix-result.json");
			writeFileSync(
				script,
				[
					"import json, socket, sys",
					"denied, allowed, abstract, result = sys.argv[1:5]",
					"out = {}",
					"def unix(path, name):",
					"    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(2)",
					"    try:",
					"        s.connect(path); out[name] = 'ok'",
					"    except OSError as e:",
					"        out[name] = 'denied:' + str(e.errno)",
					"    finally:",
					"        s.close()",
					"unix(denied, 'pathname_denied')",
					"unix(allowed, 'pathname_allowed')",
					"unix('\\\\0' + abstract, 'abstract_denied')",
					"open(result, 'w').write(json.dumps(out, sort_keys=True))",
					"",
				].join("\n"),
			);
			const { argv } = buildModelArgs(
				data,
				`python3 ${script} '${deniedPath}' '${allowedPath}' '${abstractName}' '${resultPath}'`,
			);
			const worker = await runWorker(argv, data, [443], data.seed.secretEnv, join(data.auditTmp, "stderr.log"));
			expect(worker.exitCode, readFileSync(join(data.auditTmp, "stderr.log"), "utf8")).toBe(0);
			const result = JSON.parse(readFileSync(resultPath, "utf8"));
			expect(result.pathname_allowed).toBe("ok");
			expect(result.pathname_denied.startsWith("denied:")).toBe(true);
			expect(result.abstract_denied.startsWith("denied:")).toBe(true);
		} finally {
			deniedServer.close();
			allowedServer.close();
			abstractServer.close();
			echo.close();
			await relay.stop();
		}
	});

	it("keeps per-call commands offline and denies host pathname sockets", async () => {
		const data = fixture();
		const tcp = await listenTcp();
		const deniedServer = await listenUnix(join(data.root, "call-denied.sock"));
		const allowedServer = await listenUnix(join(data.auditTmp, "call-allowed.sock"));
		try {
			const script = join(data.auditTmp, "call-check.py");
			const resultPath = join(data.auditTmp, "call-result.json");
			writeFileSync(
				script,
				[
					"import json, socket, sys",
					"port, denied, allowed, result = sys.argv[1:5]",
					"out = {}",
					"s = socket.socket(); s.settimeout(2)",
					"try:",
					"    s.connect(('127.0.0.1', int(port))); out['tcp'] = 'ok'",
					"except OSError as e:",
					"    out['tcp'] = 'denied:' + str(e.errno)",
					"finally:",
					"    s.close()",
					"for name, path in (('pathname_denied', denied), ('pathname_allowed', allowed)):",
					"    u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); u.settimeout(2)",
					"    try:",
					"        u.connect(path); out[name] = 'ok'",
					"    except OSError as e:",
					"        out[name] = 'denied:' + str(e.errno)",
					"    finally:",
					"        u.close()",
					"open(result, 'w').write(json.dumps(out, sort_keys=True))",
					"",
				].join("\n"),
			);
			const run = createSandboxedRunCommand(data);
			const execution = await run(
				`python3 '${script}' ${tcp.address().port} '${join(data.root, "call-denied.sock")}' '${join(data.auditTmp, "call-allowed.sock")}' '${resultPath}'`,
				{ cwd: data.root, signal: null, maxBytes: 1 << 20 },
			);
			expect(execution.exitCode).toBe(0);
			const outcome = JSON.parse(readFileSync(resultPath, "utf8"));
			expect(outcome.tcp.startsWith("denied:")).toBe(true);
			expect(outcome.pathname_denied.startsWith("denied:")).toBe(true);
			expect(outcome.pathname_allowed).toBe("ok");
		} finally {
			tcp.close();
			deniedServer.close();
			allowedServer.close();
		}
	});
});

describe("sandbox naming", () => {
	it("keeps the spec temp path and session name free of the batch id", async () => {
		const data = fixture();
		const { createAuditorSandbox } = await import("../src/sandbox/index.mjs");
		const sandbox = createAuditorSandbox({
			root: data.root,
			slug: "demo",
			batchId: "audit-demo-token",
			caseId: "CASE-01",
			evidenceRoot: data.evidenceRoot,
		});
		expect(sandbox.sessionName).toBe("herd-demo-CASE-01");
		const auditTmpRoot = tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		expect(sandbox.auditTmp).toMatch(
			new RegExp(
				`^${auditTmpRoot}/herd-audit-demo-CASE-01-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
			),
		);
		expect(sandbox.auditTmp).not.toContain("audit-demo-token");
		await sandbox.stop();
		rmSync(sandbox.auditTmp, { recursive: true, force: true });
	});
});
