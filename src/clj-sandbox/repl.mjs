/**
 * Official Cherry REPL path with standard ClojureScript capability modules.
 *
 * Capabilities are grouped by role, and each role is a normal CLJS module:
 * `herd/roles/devops.mjs` re-exports the shared `herd/sandbox/files.mjs`,
 * `where.mjs`, and `shell.mjs` modules. Programs require only their role
 * module; the shared implementation exists once in the lower modules.
 *
 * Evaluation follows the official CLI: `compileString` produces a JS module,
 * which is imported back. UFSS is a pre-pass over the source and a post-pass
 * over printed values; the compiler owns every reader macro and value type.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileString } from "cherry-cljs/lib/compiler.js";
import { awaitSuspends } from "./await-suspends.mjs";
import { unwrapFences } from "./unwrap-fences.mjs";

export const ROLE_MODULES = Object.freeze({
	devops: "herd/roles/devops.mjs",
	worker: "herd/roles/worker.mjs",
	holder: "herd/roles/holder.mjs",
	reviewer: "herd/roles/reviewer.mjs",
});

const MODULE_TREE = Object.freeze({
	"herd/sandbox/base.mjs": `export const bind = (name) => (...args) => {
	const fn = globalThis.__herdCapabilities?.[name];
	if (typeof fn !== "function") {
		throw new Error("capability " + name + " is not available in this role");
	}
	return fn(...args);
};
`,
	"herd/sandbox/files.mjs": `import { bind } from "./base.mjs";
export const cat = bind("cat");
export const read = bind("read");
export const stat = bind("stat");
export const ls = bind("ls");
export const glob = bind("glob");
export const write = bind("write");
export const mkdir = bind("mkdir");
export const rm = bind("rm");
export const mv = bind("mv");
`,
	"herd/sandbox/where.mjs": `import { bind } from "./base.mjs";
export const where = bind("where");
export const whereAll = bind("whereAll");
`,
	"herd/sandbox/shell.mjs": `import { bind } from "./base.mjs";
export const call = bind("call");
`,
	"herd/sandbox/review.mjs": `import { bind } from "./base.mjs";
export const cat = bind("cat");
export const read = bind("read");
export const stat = bind("stat");
export const ls = bind("ls");
export const where = bind("where");
export const whereAll = bind("whereAll");
`,
	"herd/roles/devops.mjs": `export * from "../sandbox/files.mjs";
export * from "../sandbox/where.mjs";
export * from "../sandbox/shell.mjs";
`,
	"herd/roles/worker.mjs": `export * from "../sandbox/files.mjs";
export * from "../sandbox/where.mjs";
`,
	"herd/roles/holder.mjs": `export * from "../sandbox/files.mjs";
export * from "../sandbox/where.mjs";
export * from "../sandbox/shell.mjs";
`,
	"herd/roles/reviewer.mjs": `export * from "../sandbox/review.mjs";
`,
});

function ensureModuleTree(root) {
	const directory = join(root, ".herd", "eval");
	for (const [relative, source] of Object.entries(MODULE_TREE)) {
		const path = join(directory, relative);
		if (existsSync(path)) continue;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, source);
	}
	return directory;
}

/**
 * Evaluate one ClojureScript program with its role's capability module.
 *
 * @param {string} code ClojureScript source, possibly containing UFSS fences
 * @param {{capabilities?: Record<string, unknown>, root?: string, role?: string}} options
 * @returns {Promise<unknown>} the value of `__result`
 */
export async function evaluateCljs(code, { capabilities = {}, root = process.cwd(), role = "devops" } = {}) {
	const roleModule = ROLE_MODULES[role];
	if (roleModule === undefined) {
		throw new Error(`unknown sandbox role: ${role}`);
	}
	const directory = ensureModuleTree(root);
	const programPath = join(directory, `program-${randomUUID()}.mjs`);

	const wrapped = `(ns herd.program (:require ["./${roleModule}" :as sandbox]))
(defn ^:async __run []
${code}
)
(def __promise (__run))
`;
	const compiled = await compileString(awaitSuspends(unwrapFences(wrapped).source).source);

	writeFileSync(programPath, compiled);
	const previous = globalThis.__herdCapabilities;
	globalThis.__herdCapabilities = capabilities;
	try {
		const module = await import(`${pathToFileURL(programPath).href}?v=${randomUUID()}`);
		return await module.__promise;
	} finally {
		globalThis.__herdCapabilities = previous;
		rmSync(programPath, { force: true });
	}
}
