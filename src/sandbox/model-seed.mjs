/**
 * Build the non-secret model seed and the in-memory secret environment for
 * one auditor sandbox.
 *
 * Credentials come only from the public host `ModelRegistry` API
 * (`getApiKeyAndHeaders`). API-key auth uses proxy mode, so real headers stay
 * in the host HTTP relay and the sandbox receives only a non-secret
 * placeholder. Env-only providers can still use TLS mode for non-audit
 * callers: bwrap receives their environment on stdin and exposes it only as
 * an in-sandbox read-only file. The auditor session refuses that mode because
 * the file is readable by the auditor.
 * The config and hosts files are non-secret. They pin every model role to the
 * current main model; there is no fallback model and no silent switch.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { herdError } from "../util/errors.mjs";
import { isPublicAddress } from "./egress-relay.mjs";

const PROVIDER_ENV = Object.freeze({
	mistral: "MISTRAL_API_KEY",
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GOOGLE_GENERATIVE_AI_API_KEY",
	"google-vertex": "GOOGLE_CLOUD_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	xai: "XAI_API_KEY",
	zai: "ZAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	together: "TOGETHER_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	minimax: "MINIMAX_API_KEY",
});
// The host registry returns this sentinel for keyless providers.
const NO_AUTH_API_KEY = "N/A";

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function modelFromString(value, modelRegistry) {
	const text = value.trim();
	if (text.length === 0) return null;
	if (typeof modelRegistry?.find === "function") {
		const slash = text.indexOf("/");
		if (slash > 0) {
			const provider = text.slice(0, slash);
			const rest = text.slice(slash + 1);
			const id = rest.replace(/:(minimal|low|medium|high|xhigh|max)$/, "");
			const model = modelRegistry.find(provider, id);
			if (model) return model;
		}
	}
	return null;
}

/**
 * Resolve the current main model descriptor. Accepts the host `ctx.model`
 * object or a `provider/id` string. There is no default model.
 */
export function resolveCurrentModel({ model, modelRegistry } = {}) {
	if (model && typeof model === "object" && typeof model.provider === "string" && typeof model.id === "string") {
		if (typeof modelRegistry?.find === "function") {
			const canonical = modelRegistry.find(model.provider, model.id);
			if (canonical) return canonical;
		}
		return model;
	}
	if (typeof model === "string") {
		const resolved = modelFromString(model, modelRegistry);
		if (resolved) return resolved;
	}
	throw herdError("CAPABILITY_DENIED", "the current main model is not resolvable", {
		hasModel: model !== undefined,
		hasRegistry: typeof modelRegistry?.find === "function",
	});
}

/**
 * Resolve authentication through the public host API. The returned object is
 * kept in memory by the caller and must never be logged.
 */
export async function resolveModelAuth({ model, modelRegistry, allowNoAuth = false } = {}) {
	if (typeof modelRegistry?.getApiKeyAndHeaders !== "function") {
		throw herdError("CAPABILITY_DENIED", "the host ModelRegistry auth API is unavailable", {});
	}
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) {
		if (allowNoAuth) {
			return {
				mode: "proxy",
				apiKey: null,
				envVar: undefined,
				env: {},
				headers: {},
				baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
			};
		}
		throw herdError("CAPABILITY_DENIED", "the current main model has no usable host credential", {
			provider: model.provider,
			model: model.id,
		});
	}
	const rawHeaders = auth.headers ?? {};
	const headers = {};
	for (const [key, value] of Object.entries(rawHeaders)) {
		if (value !== null && value !== undefined) headers[key.toLowerCase()] = String(value);
	}
	const env = auth.env ?? {};
	const apiKey =
		typeof auth.apiKey === "string" && auth.apiKey.length > 0 && auth.apiKey !== NO_AUTH_API_KEY ? auth.apiKey : null;
	const envVar = PROVIDER_ENV[model.provider];
	if (apiKey === null && Object.keys(headers).length === 0 && Object.keys(env).length === 0) {
		if (allowNoAuth) {
			return {
				mode: "proxy",
				apiKey: null,
				envVar: undefined,
				env: {},
				headers: {},
				baseUrl: typeof auth.baseUrl === "string" ? auth.baseUrl : model.baseUrl,
			};
		}
		throw herdError("CAPABILITY_DENIED", "the host returned no model credential", {
			provider: model.provider,
			model: model.id,
		});
	}
	return {
		mode: Object.keys(headers).length > 0 ? "proxy" : "tls",
		apiKey,
		envVar,
		env,
		headers,
		baseUrl: typeof auth.baseUrl === "string" ? auth.baseUrl : model.baseUrl,
	};
}

/**
 * Resolve the single fixed TCP target the host relay may reach.
 */
export function resolveEgressTarget({ model, auth } = {}) {
	const raw = typeof auth?.baseUrl === "string" ? auth.baseUrl : model?.baseUrl;
	if (typeof raw !== "string" || raw.length === 0) {
		throw herdError("CAPABILITY_DENIED", "the current model has no base URL", {
			provider: model?.provider,
			model: model?.id,
		});
	}
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw herdError("CAPABILITY_DENIED", "the current model base URL is invalid", {});
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw herdError("CAPABILITY_DENIED", "the current model base URL must use HTTP or HTTPS", {
			protocol: url.protocol,
		});
	}
	const rawHost = url.hostname;
	const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw herdError("CAPABILITY_DENIED", "the current model base URL has an invalid port", {});
	}
	const explicitPrivate =
		host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && !isPublicAddress(host));
	const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
	return { host, port, protocol: url.protocol, basePath, explicitPrivate, requiresProxy: isIP(host) !== 0 };
}

export function selectModelTransport({ auth, target, resolved } = {}) {
	if (
		resolved?.private === true ||
		auth?.mode === "proxy" ||
		target?.explicitPrivate === true ||
		target?.requiresProxy === true ||
		auth?.apiKey != null
	) {
		return "proxy";
	}
	return "tls";
}

/**
 * Auditor policy on top of `selectModelTransport`. Env-only credentials cannot
 * be proxied as fixed headers, and exposing them to the nested session would
 * let the auditor read and export them. Refuse that configuration instead of
 * pretending the sandbox keeps the credential host-side.
 */
export function selectAuditTransport({ auth, target, resolved, model } = {}) {
	const envOnly =
		auth?.apiKey == null && Object.keys(auth?.headers ?? {}).length === 0 && Object.keys(auth?.env ?? {}).length > 0;
	if (envOnly) {
		throw herdError("CAPABILITY_DENIED", "audit sandbox requires host-proxied model auth", {
			provider: model?.provider,
			model: model?.id,
			next: "configure an API-key or header-based credential for the main model; env-only credentials cannot be proxied and would enter the sandbox",
		});
	}
	if (selectModelTransport({ auth, target, resolved }) !== "proxy") {
		throw herdError("CAPABILITY_DENIED", "audit sandbox requires host-proxied model auth", {
			provider: model?.provider,
			model: model?.id,
			next: "configure an API-key or header-based credential for the main model",
		});
	}
	return "http-proxy";
}

export function modelProxyHeaders({ auth, api } = {}) {
	if (auth !== null && typeof auth === "object" && Object.keys(auth.headers ?? {}).length > 0) {
		return auth.headers;
	}
	if (typeof auth?.apiKey !== "string" || auth.apiKey.length === 0 || auth.apiKey === NO_AUTH_API_KEY) return null;
	const value = auth.apiKey;
	if (/anthropic/i.test(api ?? "")) return { "x-api-key": value };
	if (/google|gemini|vertex/i.test(api ?? "")) return { "x-goog-api-key": value };
	return { authorization: `Bearer ${value}` };
}

export function renderModelConfig({ model, providerId = model.provider } = {}) {
	const pattern = JSON.stringify(`${providerId}/${model.id}`);
	return [
		"setupVersion: 3",
		"modelRoles:",
		`  default: ${pattern}`,
		`  smol: ${pattern}`,
		`  slow: ${pattern}`,
		`  vision: ${pattern}`,
		`  task: ${pattern}`,
		"tools:",
		"  approvalMode: yolo",
		"",
	].join("\n");
}

export function renderOmpWrapper({ realOmp, secretPath } = {}) {
	return [
		"#!/bin/sh",
		"set -eu",
		`set -a`,
		`. ${shellQuote(secretPath)}`,
		`set +a`,
		`exec ${shellQuote(realOmp)} "$@"`,
		"",
	].join("\n");
}

/**
 * Render the secret environment file. Kept in memory and written only to
 * bwrap's stdin; never to auditTmp, evidence, plans, or logs.
 */
export function renderSecretEnv({ apiKey, envVar, env } = {}) {
	const lines = [];
	if (typeof apiKey === "string" && apiKey.length > 0 && typeof envVar === "string") {
		lines.push(`export ${envVar}=${shellQuote(apiKey)}`);
	}
	for (const [key, value] of Object.entries(env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		if (typeof value !== "string" || value.length === 0) continue;
		lines.push(`export ${key}=${shellQuote(value)}`);
	}
	if (lines.length === 0) {
		throw herdError("CAPABILITY_DENIED", "the model seed would contain no credential", {});
	}
	return `${lines.join("\n")}\n`;
}

export function renderHosts({ host, existing } = {}) {
	const base = typeof existing === "string" ? existing.replace(/\s+$/, "") : "";
	if (isIP(host) !== 0) return `${base}\n`;
	return `127.0.0.1 ${host}\n${base}\n`;
}

/**
 * Model fields that must not cross into the seed:
 * - `provider` is the registration name, not spec data.
 * - `baseUrl` is replaced by the relay URL.
 * - `headers` may carry credentials.
 * - `identity` comes from the host registry, never from a hand-made spec.
 * - `transport` would bypass the relay.
 * - the rest are derived or introspection-only fields.
 */
const SEED_MODEL_OMIT = new Set([
	"provider",
	"baseUrl",
	"headers",
	"identity",
	"compatConfig",
	"supportsComputerUseConfig",
	"transport",
]);

/**
 * Copy the non-secret ModelSpec fields from the host-built model. The host
 * registry rebuilds the Model (including identity) from this spec.
 */
function seedModelSpec(model) {
	const spec = {};
	for (const [key, value] of Object.entries(model ?? {})) {
		if (SEED_MODEL_OMIT.has(key) || typeof value === "function" || value === undefined) continue;
		spec[key] = value;
	}
	return spec;
}

/**
 * Write the non-secret model registration seed for the nested omp extension.
 * The seed carries the complete current ModelSpec so the isolated session
 * registers the host model exactly, bundled or not. Only the baseUrl is
 * replaced by the relay. Identity stays out: the host registry constructs it
 * from the spec. Headers/credentials are never written: the seed carries an
 * env-var name (or a non-secret placeholder fallback for the host HTTP relay).
 */
export async function writeAuditModelSeed({ auditTmp, model, baseUrl, authEnvVar, apiKeyFallback } = {}) {
	const seedPath = join(auditTmp, "model-seed.json");
	const seed = {
		provider: model.provider,
		modelId: model.id,
		baseUrl,
		api: model.api ?? "openai-completions",
		authEnvVar: typeof authEnvVar === "string" ? authEnvVar : null,
		apiKeyFallback: typeof apiKeyFallback === "string" ? apiKeyFallback : null,
		models: [seedModelSpec(model)],
	};
	await writeFile(seedPath, JSON.stringify(seed), { mode: 0o600 });
	return { seedPath, provider: model.provider, modelId: model.id, baseUrl, modelCount: 1 };
}

function renderProxyEnv(envVar) {
	if (typeof envVar !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) return "";
	return `export ${envVar}='herd-local-placeholder'\n`;
}

/**
 * Write the non-secret seed and return the paths bwrap must bind. The secret
 * string is returned separately and must stay in memory.
 */
export async function prepareModelSeed({ auditTmp, socketDir, model, auth, target, realOmp, proxy } = {}) {
	const seedDir = join(auditTmp, "seed");
	const binDir = join(auditTmp, "bin");
	const homeDir = join(auditTmp, "home");
	const agentDir = join(homeDir, ".omp", "agent");
	await mkdir(seedDir, { recursive: true, mode: 0o700 });
	await mkdir(binDir, { recursive: true, mode: 0o700 });
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	const configPath = join(agentDir, "config.yml");
	const wrapperPath = join(seedDir, "omp");
	const hostsPath = join(seedDir, "hosts");
	const configDest = configPath;
	const wrapperDest = join(binDir, "omp");
	const secretDest = join(socketDir, ".model.env");
	const relayScriptDest = join(socketDir, "relay.mjs");
	const providerId = model.provider;
	await writeFile(configPath, renderModelConfig({ model, providerId }), { mode: 0o600 });
	const modelBaseUrl = proxy ? proxy.localBaseUrl : typeof auth.baseUrl === "string" ? auth.baseUrl : model.baseUrl;
	const authEnvVar = auth.envVar ?? PROVIDER_ENV[model.provider] ?? null;
	const seed = await writeAuditModelSeed({
		auditTmp,
		model,
		baseUrl: modelBaseUrl,
		authEnvVar,
		apiKeyFallback: proxy ? "herd-local-placeholder" : null,
	});
	await writeFile(wrapperPath, renderOmpWrapper({ realOmp, secretPath: secretDest }), { mode: 0o700 });
	await chmod(wrapperPath, 0o700);
	let existingHosts = "";
	try {
		existingHosts = await readFile("/etc/hosts", "utf8");
	} catch {
		existingHosts = "127.0.0.1 localhost\n";
	}
	await writeFile(hostsPath, renderHosts({ host: target.host, existing: existingHosts }), { mode: 0o600 });
	const secretEnv = proxy
		? renderProxyEnv(auth.envVar ?? PROVIDER_ENV[model.provider])
		: renderSecretEnv({ apiKey: auth.apiKey, envVar: auth.envVar, env: auth.env });
	return {
		seedDir,
		binDir,
		configPath,
		configDest,
		wrapperPath,
		wrapperDest,
		hostsPath,
		relayScriptDest,
		secretDest,
		secretEnv,
		providerId,
		modelSeedPath: seed.seedPath,
	};
}
