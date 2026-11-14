/**
 * M1: lazy entry for the main assembly.
 *
 * The host loads this entry before `main.mjs`. It must never let a main-assembly
 * failure take down the host or the independent tool-gate entry. The only
 * work here is: import `main.mjs`, call its default factory, and record the
 * outcome in the cross-entry health registry. No business tool or command is
 * registered here.
 */

import { recordHealth } from "./host/health.mjs";
import { registerAuditModelSeed } from "./host/model-seed.mjs";

const ENTRY = "main.bootstrap";
const VERSION = "1";

function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * Run the lazy main assembly with an injectable importer for tests.
 *
 * @param {import("./host/imports.mjs").ExtensionAPI} pi
 * @param {{ importMain?: () => Promise<{ default?: Function }> }} [deps]
 */
export async function bootstrapMain(pi, deps = {}) {
	try {
		const seed = await registerAuditModelSeed(pi, deps.env ?? process.env);
		if (seed.registered) {
			recordHealth({
				entry: "main.audit-model-seed",
				status: "ok",
				version: VERSION,
				capabilities: { provider: seed.provider, models: seed.modelCount },
				degraded: false,
			});
			if (typeof pi?.on === "function" && typeof pi?.setModel === "function") {
				pi.on("session_start", async (_event, ctx) => {
					try {
						const spec = `${seed.provider}/${seed.modelId}`;
						// setModel must receive the host-built registry model: identity
						// comes from the host catalog/registry, never from this seed.
						const resolveBuilt = () => {
							let model;
							try {
								model = ctx?.models?.resolve?.(spec);
							} catch {
								model = undefined;
							}
							if (
								model === undefined ||
								model.provider !== seed.provider ||
								model.id !== seed.modelId ||
								model.identity === undefined ||
								typeof model.identity.class !== "string" ||
								model.identity.class.length === 0
							) {
								return undefined;
							}
							return model;
						};
						const registered = resolveBuilt();
						if (registered === undefined) {
							recordHealth({
								entry: "main.audit-model-seed",
								status: "failed",
								version: VERSION,
								capabilities: { provider: seed.provider, registeredModel: false },
								requiredCapabilities: ["registeredModel"],
								degraded: true,
								error: "registered audit model is unavailable or lacks canonical identity",
							});
							return;
						}
						// The registration carried the relay baseUrl, so the built model
						// must already route there. Never patch a model outside the registry.
						if (registered.baseUrl !== seed.baseUrl) {
							recordHealth({
								entry: "main.audit-model-seed",
								status: "failed",
								version: VERSION,
								capabilities: { provider: seed.provider, sessionModel: false },
								requiredCapabilities: ["sessionModel"],
								degraded: true,
								error: "registered audit model does not use the relay base URL",
							});
							return;
						}
						const applied = await pi.setModel(registered);
						recordHealth({
							entry: "main.audit-model-seed",
							status: applied ? "ok" : "failed",
							version: VERSION,
							capabilities: { provider: seed.provider, sessionModel: applied },
							requiredCapabilities: applied ? [] : ["sessionModel"],
							degraded: !applied,
							...(applied ? {} : { error: "pi.setModel returned false" }),
						});
					} catch (error) {
						recordHealth({
							entry: "main.audit-model-seed",
							status: "failed",
							version: VERSION,
							capabilities: { provider: seed.provider, sessionModel: false },
							requiredCapabilities: ["sessionModel"],
							degraded: true,
							error: errorMessage(error),
						});
					}
				});
			} else {
				recordHealth({
					entry: "main.audit-model-seed",
					status: "failed",
					version: VERSION,
					capabilities: { provider: seed.provider, sessionModel: false },
					requiredCapabilities: ["sessionModel"],
					degraded: true,
					error: "host extension API lacks pi.on/pi.setModel",
				});
			}
		}
	} catch (error) {
		recordHealth({
			entry: "main.audit-model-seed",
			status: "failed",
			version: VERSION,
			capabilities: { registered: false },
			requiredCapabilities: ["registered"],
			degraded: true,
			error: errorMessage(error),
		});
	}
	const importMain = typeof deps.importMain === "function" ? deps.importMain : () => import("./main.mjs");
	try {
		const module = await importMain();
		if (typeof module?.default !== "function") {
			throw new TypeError("main.mjs must export a default activation function");
		}
		const result = await module.default(pi);
		recordHealth({
			entry: ENTRY,
			status: "ok",
			version: VERSION,
			capabilities: { loaded: true },
			degraded: false,
		});
		return result;
	} catch (error) {
		recordHealth({
			entry: ENTRY,
			status: "failed",
			version: VERSION,
			capabilities: { loaded: false },
			requiredCapabilities: ["loaded"],
			degraded: true,
			error: errorMessage(error),
		});
		return undefined;
	}
}

/**
 * Host extension factory.
 *
 * @param {import("./host/imports.mjs").ExtensionAPI} pi
 */
export default async function activate(pi) {
	return bootstrapMain(pi);
}
