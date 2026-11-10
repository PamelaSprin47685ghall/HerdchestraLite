/**
 * Parse, freeze, and validate the MANUAL ACCEPTANCE verification contract.
 *
 * Inputs: a goal objective (prose containing the contract line), a working
 * directory, and, at completion time, the documents on disk.
 * Output: a parsed contract with its hashes, a frozen objective line, or the
 * exact rejection text the caller shows to the model.
 *
 * The contract line is the last `Verification contract:` line, matching
 * pi-goal-x's extraction rule. Hashes are optional when a proposal is first
 * parsed and required before completion.
 */

import { createHash } from "node:crypto";
import {
	MANUAL_ACCEPTANCE_CONTRACT_MISSING,
	MANUAL_ACCEPTANCE_CONTRACT_RE,
	MANUAL_ACCEPTANCE_CONTRACT_TEMPLATE,
	MANUAL_ACCEPTANCE_COORDINATION_FILE,
	MANUAL_ACCEPTANCE_DOCUMENT_PATH_RE,
	MANUAL_ACCEPTANCE_DOCUMENTS,
	MANUAL_ACCEPTANCE_GUIDE_FILE,
	MANUAL_ACCEPTANCE_HASH_REQUIREMENT,
	MANUAL_ACCEPTANCE_HASH_TOKEN_RE,
	MANUAL_ACCEPTANCE_MARKER_RE,
	MANUAL_ACCEPTANCE_PATH_TRAILER_RE,
	MANUAL_ACCEPTANCE_REQUIREMENTS_FILE,
	MANUAL_ACCEPTANCE_ROOT_DIR,
	MANUAL_ACCEPTANCE_SHA_RE,
} from "./constants.mjs";
import { manualAcceptanceDir, manualAcceptanceDocumentSlots, readManualAcceptanceDocuments } from "./documents.mjs";
import { parseRequirementCases } from "./requirements.mjs";

export { manualAcceptanceDocumentSlots };

/** The last contract line wins, matching pi-goal-x's extractVerificationContract. */
export function manualAcceptanceContractLine(objective) {
	let contract;
	for (const line of objective.split(/\r?\n/)) {
		const match = MANUAL_ACCEPTANCE_CONTRACT_RE.exec(line.trim());
		if (match) contract = match[1].trim();
	}
	return contract;
}

/**
 * Parse the contract shape and any attached hashes. Hashes are optional here so
 * the create gate can freeze a hashless proposal; every token that is present
 * must be well formed.
 */
export function parseManualContractParts(objective) {
	const rawLine = manualAcceptanceContractLine(objective);
	if (!rawLine || !MANUAL_ACCEPTANCE_MARKER_RE.test(rawLine)) return { ok: false, reason: "contract" };
	// Normalize the hash key so "SHA256", spacing, and case never erase a token.
	const line = rawLine.replace(MANUAL_ACCEPTANCE_HASH_TOKEN_RE, "sha256=");
	const hashTokens = [...rawLine.matchAll(MANUAL_ACCEPTANCE_HASH_TOKEN_RE)].length;
	// Collect every document path the contract names. Any unknown file, any
	// repeated file, or more than one slug makes the contract invalid.
	const documents = new Map();
	const hashes = new Map();
	for (const match of line.matchAll(MANUAL_ACCEPTANCE_DOCUMENT_PATH_RE)) {
		const slug = match[1];
		const file = match[2].replace(MANUAL_ACCEPTANCE_PATH_TRAILER_RE, "");
		// Reject the only relative-parent segment the regex can still capture.
		if (slug === "." || slug === "..") return { ok: false, reason: "contract" };
		if (!MANUAL_ACCEPTANCE_DOCUMENTS.has(file)) return { ok: false, reason: "contract" };
		const files = documents.get(slug) ?? new Set();
		if (files.has(file)) return { ok: false, reason: "contract" };
		files.add(file);
		documents.set(slug, files);
		const hash = match[3];
		if (hash !== undefined) {
			if (!MANUAL_ACCEPTANCE_SHA_RE.test(hash)) return { ok: false, reason: "hash" };
			hashes.set(file, hash.toLowerCase());
		}
	}
	// Every sha256 token must belong to exactly one document path. Extra or
	// detached tokens are malformed, not prose.
	if (hashTokens !== hashes.size) return { ok: false, reason: "hash" };
	if (documents.size !== 1) return { ok: false, reason: "contract" };
	const [slug, files] = [...documents][0];
	if (files.size !== MANUAL_ACCEPTANCE_DOCUMENTS.size) return { ok: false, reason: "contract" };
	const directory = `${MANUAL_ACCEPTANCE_ROOT_DIR}/${slug}`;
	return {
		ok: true,
		contract: {
			slug,
			requirementsPath: `${directory}/${MANUAL_ACCEPTANCE_REQUIREMENTS_FILE}`,
			guidePath: `${directory}/${MANUAL_ACCEPTANCE_GUIDE_FILE}`,
			coordinationPath: `${directory}/${MANUAL_ACCEPTANCE_COORDINATION_FILE}`,
		},
		hashes,
	};
}

export function parseManualContract(objective) {
	const parsed = parseManualContractParts(objective);
	if (!parsed.ok) return undefined;
	// Completion requires a fully frozen contract.
	if (parsed.hashes.size !== MANUAL_ACCEPTANCE_DOCUMENTS.size) return undefined;
	return parsed.contract;
}

/** Resolve the slug through the path function and turn its refusal into a gate error. */
export function manualAcceptanceDirectory(cwd, slug) {
	try {
		return { ok: true, directory: manualAcceptanceDir(cwd, slug) };
	} catch (error) {
		const reason = error instanceof Error ? error.message.trim() : "";
		// Keep the reason only when it is a short, path-free diagnostic.
		const detail = reason && reason.length <= 120 && !/[/\\]/.test(reason) ? ` (${reason})` : "";
		return {
			ok: false,
			error: `a valid goal_slug in the verification contract${detail}; use lowercase letters, digits, and hyphens with no path segments`,
		};
	}
}

export function manualAcceptanceFrozenLine(contract, hashes) {
	return [
		"Verification contract: MANUAL ACCEPTANCE —",
		`requirements: ${contract.requirementsPath} sha256=${hashes.get(MANUAL_ACCEPTANCE_REQUIREMENTS_FILE)};`,
		`development-guide: ${contract.guidePath} sha256=${hashes.get(MANUAL_ACCEPTANCE_GUIDE_FILE)};`,
		`coordination: ${contract.coordinationPath} sha256=${hashes.get(MANUAL_ACCEPTANCE_COORDINATION_FILE)};`,
		"execute every CASE and score it out of 100;",
		"automated tests are NOT acceptance evidence.",
	].join(" ");
}

/** Replace the last contract line, the one goal-x will extract. */
export function freezeManualAcceptanceObjective(objective, frozenLine) {
	const lines = objective.split(/\r?\n/);
	let index = -1;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		if (MANUAL_ACCEPTANCE_CONTRACT_RE.test(lines[lineIndex].trim())) index = lineIndex;
	}
	if (index === -1) return undefined;
	lines[index] = frozenLine;
	return lines.join("\n");
}

/** The rejection text every create-gate failure shares. */
export function manualProposeGateRejection(missing) {
	return [
		"propose_goal_draft REJECTED (manual acceptance gate).",
		`Missing: ${missing}.`,
		"The objective must contain one line:",
		MANUAL_ACCEPTANCE_CONTRACT_TEMPLATE,
	].join("\n");
}

export function validateManualDocuments(cwd, objective) {
	const parsed = parseManualContractParts(objective);
	if (!parsed.ok) {
		return {
			ok: false,
			error: parsed.reason === "hash" ? MANUAL_ACCEPTANCE_HASH_REQUIREMENT : MANUAL_ACCEPTANCE_CONTRACT_MISSING,
		};
	}
	if (parsed.hashes.size !== MANUAL_ACCEPTANCE_DOCUMENTS.size) {
		return { ok: false, error: MANUAL_ACCEPTANCE_HASH_REQUIREMENT };
	}
	const contract = parsed.contract;
	const located = manualAcceptanceDirectory(cwd, contract.slug);
	if (!located.ok) return located;
	const read = readManualAcceptanceDocuments(located.directory, contract);
	if (!read.ok) return read;
	for (const slot of manualAcceptanceDocumentSlots(contract)) {
		const expected = parsed.hashes.get(slot.name);
		const actual = createHash("sha256").update(read.markdown.get(slot.name), "utf8").digest("hex");
		if (actual !== expected) {
			return {
				ok: false,
				error: `${slot.path} hash mismatch (the file changed after the contract was frozen)`,
			};
		}
	}
	const requirementsMarkdown = read.markdown.get(MANUAL_ACCEPTANCE_REQUIREMENTS_FILE);
	let cases;
	try {
		cases = parseRequirementCases(requirementsMarkdown);
	} catch {
		return { ok: false, error: `${contract.requirementsPath} (unreadable CASE list)` };
	}
	if (cases.length === 0) {
		return {
			ok: false,
			error: `${contract.requirementsPath} (no CASE with a "- PASS threshold: N/100" line)`,
		};
	}
	return {
		ok: true,
		docs: {
			contract,
			requirementsMarkdown,
			guideMarkdown: read.markdown.get(MANUAL_ACCEPTANCE_GUIDE_FILE),
			coordinationMarkdown: read.markdown.get(MANUAL_ACCEPTANCE_COORDINATION_FILE),
		},
	};
}

/**
 * The effective contract text shown to the auditor and the report writer.
 *
 * An embedded contract line wins; otherwise the goal's own verification
 * contract is prefixed with the same label. Missing both yields `undefined`.
 */
export function manualAcceptanceEffectiveContract(goal) {
	const embedded = manualAcceptanceContractLine(goal.objective ?? "");
	if (embedded) return `Verification contract: ${embedded}`;
	const contract = goal.verificationContract?.trim();
	return contract ? `Verification contract: ${contract}` : undefined;
}
