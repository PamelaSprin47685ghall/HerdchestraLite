/**
 * Cherry runtime loader for the ClojureScript sandbox.
 *
 * This module deliberately does not import the omp host package. The sandbox
 * evaluator is the one part of the product that can be exercised outside a
 * live host, and that property is worth keeping: `clj_*` tools must load with
 * only `cherry-cljs` present.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {{ loaded: boolean, hasEdnReader: boolean, version: string | undefined }} */
let cherryState = Object.freeze({ loaded: false, hasEdnReader: false, version: undefined });
/** @type {Promise<unknown> | undefined} */
let cherryLoadPromise;

/**
 * Resolve a package specifier to a filesystem path when the runtime supports
 * it. A compiled host may embed modules; `undefined` is a report, not a
 * failure.
 *
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolvePath(specifier) {
	try {
		const resolved = import.meta.resolve(specifier);
		if (typeof resolved !== "string") return undefined;
		if (resolved.startsWith("file:")) return fileURLToPath(resolved);
		return resolved;
	} catch {
		return undefined;
	}
}

/**
 * Read the package.json that owns a resolved module path.
 *
 * @param {string | undefined} modulePath
 * @returns {{ path: string, version: string } | undefined}
 */
async function packageMetadata(modulePath) {
	if (typeof modulePath !== "string" || modulePath.length === 0) return undefined;
	let directory = dirname(modulePath);
	for (let depth = 0; depth < 12; depth += 1) {
		const candidate = join(directory, "package.json");
		try {
			const parsed = JSON.parse(await readFile(candidate, "utf8"));
			if (typeof parsed.version === "string" && parsed.version.length > 0) {
				return { path: candidate, version: parsed.version };
			}
		} catch {
			// Keep walking; a missing package.json is normal for nested paths.
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}

/**
 * The exact `cherry-cljs@0.6.38` modules the sandbox may use.
 *
 * The package root is the compiler (`compileString` / `compileStringEx`) and
 * does not re-export `cljs.core`. The persistent collections and pure library
 * functions live in these deep modules. The package has no `exports` map, so
 * the deep specifiers resolve directly.
 */
export const CHERRY_RUNTIME_SPECIFIERS = Object.freeze({
	core: "cherry-cljs/cljs.core.js",
	string: "cherry-cljs/lib/clojure.string.js",
	set: "cherry-cljs/lib/clojure.set.js",
	walk: "cherry-cljs/lib/clojure.walk.js",
});

/**
 * Report what a loaded Cherry runtime exposes.
 *
 * @param {unknown} moduleNamespace
 * @param {{ version?: string }} [metadata]
 * @returns {{ hasEdnReader: boolean, version: string | undefined }}
 */
export function inspectCherryModule(moduleNamespace, metadata = {}) {
	const candidate =
		moduleNamespace !== null && (typeof moduleNamespace === "object" || typeof moduleNamespace === "function")
			? moduleNamespace
			: {};
	const core = candidate.core ?? candidate;
	const hasEdnReader =
		typeof core.readString === "function" ||
		typeof core.read === "function" ||
		typeof core.readStringEx === "function" ||
		typeof core.read_string === "function";
	const declared =
		typeof candidate.version === "string"
			? candidate.version
			: typeof candidate.VERSION === "string"
				? candidate.VERSION
				: typeof core.version === "string"
					? core.version
					: undefined;
	const version = typeof metadata.version === "string" ? metadata.version : declared;
	return Object.freeze({ hasEdnReader, version });
}

/**
 * Import the four pure Cherry modules. The compiler root is deliberately not
 * imported.
 *
 * @returns {Promise<{ core: unknown, string: unknown, set: unknown, walk: unknown }>}
 */
async function importCherryRuntime() {
	const [core, string, set, walk] = await Promise.all([
		import(CHERRY_RUNTIME_SPECIFIERS.core),
		import(CHERRY_RUNTIME_SPECIFIERS.string),
		import(CHERRY_RUNTIME_SPECIFIERS.set),
		import(CHERRY_RUNTIME_SPECIFIERS.walk),
	]);
	return Object.freeze({ core, string, set, walk });
}

/**
 * Load `cherry-cljs` once, lazily.
 *
 * Failure is a resolved value, never a throw and never a fallback to a JS
 * evaluator.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   cherry: { core: unknown, string: unknown, set: unknown, walk: unknown } | undefined,
 *   hasEdnReader: boolean,
 *   version: string | undefined,
 *   error: { code: string, message: string, data: Record<string, unknown> } | undefined,
 * }>}
 */
export function loadCherry() {
	cherryLoadPromise ??= importCherryRuntime()
		.then(async (moduleNamespace) => {
			const cherryPath = resolvePath(CHERRY_RUNTIME_SPECIFIERS.core);
			const metadata = await packageMetadata(cherryPath);
			const probed = inspectCherryModule(moduleNamespace, metadata);
			cherryState = Object.freeze({
				loaded: true,
				hasEdnReader: probed.hasEdnReader,
				version: probed.version,
			});
			return Object.freeze({
				ok: true,
				cherry: moduleNamespace,
				hasEdnReader: probed.hasEdnReader,
				version: probed.version,
				error: undefined,
			});
		})
		.catch((cause) => {
			cherryState = Object.freeze({ loaded: false, hasEdnReader: false, version: undefined });
			const message = cause instanceof Error ? cause.message : String(cause);
			return Object.freeze({
				ok: false,
				cherry: undefined,
				hasEdnReader: false,
				version: undefined,
				error: {
					code: ":HOST_API_MISMATCH",
					message: `cherry-cljs is unavailable: ${message}`,
					data: {
						module: "cherry-cljs",
						specifiers: CHERRY_RUNTIME_SPECIFIERS,
						next: "install the exact cherry-cljs version recorded in HACK.md",
					},
				},
			});
		});
	return cherryLoadPromise;
}

export function cherryStatus() {
	return cherryState;
}
