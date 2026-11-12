/**
 * Resolve, read, validate, and write the manual-acceptance documents.
 *
 * Inputs: a working directory, a goal slug, a parsed contract, and markdown.
 * Output: absolute paths, document contents, booleans, or error text.
 *
 * Writes go through `writeFileAtomic` so a failed write never leaves a
 * half-written target behind. Every error string is user-visible and copied
 * verbatim from the old implementation.
 */

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
	MANUAL_ACCEPTANCE_COORDINATION_FILE,
	MANUAL_ACCEPTANCE_GUIDE_FILE,
	MANUAL_ACCEPTANCE_REQUIREMENTS_FILE,
	MANUAL_ACCEPTANCE_ROOT_DIR,
	MANUAL_ACCEPTANCE_SLUG_RE,
} from "./constants.mjs";
import { writeFileAtomic } from "./util/atomic-write.mjs";
import { errorCode } from "./util/errors.mjs";

/**
 * Map a contract to its three file names and contract-declared paths.
 *
 * The slot order is the order the gate reports and hashes documents in:
 * requirements, guide, coordination.
 */
export function manualAcceptanceDocumentSlots(contract) {
	return [
		{ name: MANUAL_ACCEPTANCE_REQUIREMENTS_FILE, path: contract.requirementsPath },
		{ name: MANUAL_ACCEPTANCE_GUIDE_FILE, path: contract.guidePath },
		{ name: MANUAL_ACCEPTANCE_COORDINATION_FILE, path: contract.coordinationPath },
	];
}

export function manualAcceptanceDir(cwd, slug) {
	if (typeof slug !== "string" || !MANUAL_ACCEPTANCE_SLUG_RE.test(slug)) {
		throw new Error(
			"invalid goal_slug: use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit",
		);
	}
	const root = resolve(cwd, MANUAL_ACCEPTANCE_ROOT_DIR);
	const dir = resolve(root, slug);
	if (!dir.startsWith(root + sep)) {
		throw new Error("path escapes the manual-acceptance root");
	}
	return dir;
}

export function manualAcceptanceRelativePath(slug, fileName) {
	return `${MANUAL_ACCEPTANCE_ROOT_DIR}/${slug}/${fileName}`;
}

export function readManualAcceptanceDocuments(directory, contract) {
	const markdown = new Map();
	for (const slot of manualAcceptanceDocumentSlots(contract)) {
		let content;
		try {
			content = readFileSync(resolve(directory, slot.name), "utf8");
		} catch {
			return { ok: false, error: `${slot.path} (not found; submit it before proposing the goal)` };
		}
		if (content.trim().length === 0) return { ok: false, error: `${slot.path} (empty)` };
		markdown.set(slot.name, content);
	}
	return { ok: true, markdown };
}

export function manualAcceptanceWriteDocument(dir, fileName, markdown) {
	return writeFileAtomic(dir, fileName, markdown).existed;
}

function manualAcceptanceErrorCode(error) {
	const code = errorCode(error);
	return code === undefined ? "" : ` (${code})`;
}

export function manualAcceptanceWriteErrorText(relativePath, error) {
	return `failed to write ${relativePath}${manualAcceptanceErrorCode(error)}; the previous file, if any, was left unchanged`;
}

export function manualAcceptanceDocumentError(markdown, field) {
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return `${field} must be a non-empty string.`;
	}
	if (!markdown.split(/\r?\n/).some((line) => /^##[ \t]+\S/.test(line))) {
		return `${field} must contain at least one "## " section.`;
	}
	if (field === "guide_markdown") {
		if (!markdown.includes("S2") && !/^##.*(实现|步骤)/m.test(markdown)) {
			return `${field} must contain "S2" or a "## ...实现/步骤..." heading.`;
		}
		return undefined;
	}
	if (!/(切片|任务分解)/.test(markdown) || !/^#{2,3}.*合并顺序/m.test(markdown)) {
		return `${field} must contain a 切片/任务分解 section and a "## ...合并顺序" heading.`;
	}
	return undefined;
}
