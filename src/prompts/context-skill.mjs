import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * P1: read pi-context's context-management SKILL.md body for the system prompt.
 *
 * Depends on node:fs and node:url only. omp does not discover skills bundled in
 * an extension's dependencies, so main.mjs calls this once at module or factory
 * time. Old location: vibe-workers.ts loadContextManagementSkill, VW 21-48.
 *
 * Resolution order:
 * 1. Resolve pi-context/package.json and look in its skills/context-management/.
 * 2. Fall back to ../../node_modules/pi-context/skills/context-management/.
 * 3. If neither SKILL.md is readable, log the original error text and return "".
 */
function skillDirectories() {
	/** @type {URL[]} */
	const directories = [];
	try {
		const packageJsonPath = fileURLToPath(import.meta.resolve("pi-context/package.json"));
		directories.push(new URL("skills/context-management/", pathToFileURL(packageJsonPath)));
	} catch {
		// Package exports may hide package.json; the path beside this module is the fallback.
	}
	directories.push(new URL("../../node_modules/pi-context/skills/context-management/", import.meta.url));
	return directories;
}

/**
 * Read the skill body and append the absolute references path sentence.
 * @returns {string} The system-prompt block, or "" when the skill is absent.
 */
export function loadContextManagementSkill() {
	for (const skillDir of skillDirectories()) {
		try {
			const body = readFileSync(new URL("SKILL.md", skillDir), "utf8");
			if (!body) continue;
			return [
				body.trim(),
				"",
				`Scenario references live in ${fileURLToPath(new URL("references/", skillDir))}. Read one with the read tool only when the main skill body says that scenario applies.`,
			].join("\n");
		} catch {
			// Try the next candidate; both missing means the dependency is unusable.
		}
	}
	console.error("vibe-workers: context-management skill not found beside the extension");
	return "";
}
