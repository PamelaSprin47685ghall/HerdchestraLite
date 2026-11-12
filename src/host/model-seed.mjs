/**
 * Register the audit model through the host's public extension API.
 *
 * `src/bootstrap-main.mjs` runs inside the nested omp. When the auditor
 * sandbox provides `HERD_AUDIT_MODEL_SEED`, this module reads that non-secret
 * seed and calls `pi.registerProvider()` with the relay/auth override and the
 * complete non-secret ModelSpec for the current model. The host registry
 * builds the Model and its identity from that spec. Credentials are resolved
 * from the environment at registration time and never written to the seed,
 * logs, or evidence.
 */

import { readFileSync } from "node:fs";

function seedError(message, data = {}) {
	const error = new Error(message);
	error.code = ":AUDIT_MODEL_SEED_INVALID";
	error.data = data;
	return error;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Register the seed when its environment variable is present. Calling this in
 * the host main process (no seed env) is a no-op. A malformed seed throws; the
 * bootstrap records the failure and keeps the host process alive.
 */
export function registerAuditModelSeed(pi, env = process.env) {
	const seedPath = env.HERD_AUDIT_MODEL_SEED;
	if (typeof seedPath !== "string" || seedPath.length === 0) {
		return { registered: false, reason: "no-seed" };
	}
	let seed;
	try {
		seed = JSON.parse(readFileSync(seedPath, "utf8"));
	} catch (error) {
		throw seedError("audit model seed is not readable JSON", {
			path: seedPath,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	if (!isRecord(seed)) throw seedError("audit model seed must be an object", { path: seedPath });
	if (typeof seed.provider !== "string" || seed.provider.length === 0) {
		throw seedError("audit model seed needs a provider", { path: seedPath });
	}
	if (typeof seed.baseUrl !== "string" || seed.baseUrl.length === 0) {
		throw seedError("audit model seed needs a baseUrl", { provider: seed.provider });
	}
	if (typeof seed.modelId !== "string" || seed.modelId.length === 0) {
		throw seedError("audit model seed needs a model id", { provider: seed.provider });
	}
	if (typeof seed.api !== "string" || seed.api.length === 0) {
		throw seedError("audit model seed needs an api", { provider: seed.provider });
	}
	if (!Array.isArray(seed.models) || seed.models.length === 0) {
		throw seedError("audit model seed needs a ModelSpec", { provider: seed.provider });
	}
	const models = seed.models.map((spec) => {
		if (!isRecord(spec)) {
			throw seedError("audit model seed ModelSpec must be an object", { provider: seed.provider });
		}
		if (typeof spec.id !== "string" || spec.id.length === 0) {
			throw seedError("audit model seed ModelSpec needs an id", { provider: seed.provider });
		}
		// The registry owns identity and the relay owns the route. Drop any
		// stale hand-made values instead of letting them override the host.
		const clean = { ...spec };
		for (const key of ["identity", "provider", "baseUrl", "headers"]) delete clean[key];
		return clean;
	});
	if (!models.some((spec) => spec.id === seed.modelId)) {
		throw seedError("audit model seed ModelSpec does not match the model id", {
			provider: seed.provider,
			modelId: seed.modelId,
		});
	}
	const apiKey =
		typeof seed.authEnvVar === "string" && seed.authEnvVar.length > 0 ? env[seed.authEnvVar] : seed.apiKeyFallback;
	if (typeof apiKey !== "string" || apiKey.length === 0) {
		throw seedError("audit model seed credential is unavailable", {
			provider: seed.provider,
			authEnvVar: seed.authEnvVar ?? null,
		});
	}
	if (typeof pi?.registerProvider !== "function") {
		throw seedError("host extension API does not expose registerProvider", {});
	}
	// Register the full current spec. This is the only path for both bundled
	// and custom models: the isolated session replaces the provider's model
	// list, so the host model keeps its exact input, compat, and api instead of
	// falling back to a different bundled catalog row.
	pi.registerProvider(seed.provider, {
		baseUrl: seed.baseUrl,
		apiKey,
		api: seed.api,
		models,
	});
	return {
		registered: true,
		provider: seed.provider,
		modelId: seed.modelId,
		baseUrl: seed.baseUrl,
		modelCount: 1,
	};
}
