/**
 * Validate the manual-acceptance contract and write the S4 report.
 *
 * Inputs: the working directory, a goal slug, and the auditor's report
 * markdown. Output: a structured `{ ok, ... }` result.
 *
 * The three stage documents are written by the submit tools. This module only
 * reads them, recomputes their sha256, and compares the result with the
 * `Verification contract: MANUAL ACCEPTANCE` line supplied by the caller.
 * It never writes any stage document and never invokes an auditor.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	MANUAL_ACCEPTANCE_COORDINATION_FILE,
	MANUAL_ACCEPTANCE_GUIDE_FILE,
	MANUAL_ACCEPTANCE_REPORT_FILE,
	MANUAL_ACCEPTANCE_REQUIREMENTS_FILE,
} from "./constants.mjs";
import {
	manualAcceptanceDir,
	manualAcceptanceRelativePath,
	manualAcceptanceWriteDocument,
	manualAcceptanceWriteErrorText,
} from "./documents.mjs";
import { messageOf } from "./util/errors.mjs";

const REQUIRED_DOCUMENTS = [
	MANUAL_ACCEPTANCE_REQUIREMENTS_FILE,
	MANUAL_ACCEPTANCE_GUIDE_FILE,
	MANUAL_ACCEPTANCE_COORDINATION_FILE,
];

const DOCUMENT_HASH_RE =
	/docs\/manual-acceptance\/([^/\s"'`]+)\/([^/\s"'`;,()；，、：]+)\s+sha256\s*=\s*([0-9a-fA-F]{64})/g;

/**
 * Hash the exact bytes of a stage document. This matches the product contract
 * tool: `createHash("sha256").update(text, "utf8")`.
 */
export function sha256Document(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex").toLowerCase();
}

/**
 * Read the stage documents and parse their single contract line.
 *
 * The three stage documents must exist and be non-empty. The contract line is
 * supplied by the caller, not guessed from the documents: embedding it in a
 * hashed document would make its own sha256 self-referential.
 */
export function readVerificationContract(cwd, slug, providedLine) {
	let dir;
	try {
		dir = manualAcceptanceDir(cwd, slug);
	} catch (error) {
		return { ok: false, error: messageOf(error) };
	}

	for (const file of REQUIRED_DOCUMENTS) {
		let text;
		try {
			text = readFileSync(resolve(dir, file), "utf8");
		} catch {
			return { ok: false, error: `${file} is missing; submit it before the report` };
		}
		if (text.trim().length === 0) {
			return { ok: false, error: `${file} is empty; submit it before the report` };
		}
	}

	if (typeof providedLine !== "string" || providedLine.trim().length === 0) {
		return {
			ok: false,
			error: "contract_line is required: pass the full `Verification contract: MANUAL ACCEPTANCE ...` line",
		};
	}
	const line = providedLine.trim();
	if (!/^Verification contract:/i.test(line)) {
		return { ok: false, error: "contract_line must start with `Verification contract:`" };
	}
	if (!/MANUAL ACCEPTANCE/i.test(line)) {
		return { ok: false, error: "the verification contract line is not marked MANUAL ACCEPTANCE" };
	}

	const entries = new Map();
	DOCUMENT_HASH_RE.lastIndex = 0;
	let match = DOCUMENT_HASH_RE.exec(line);
	while (match !== null) {
		const entrySlug = match[1];
		const file = match[2];
		const hash = match[3].toLowerCase();
		if (entrySlug !== slug) {
			return { ok: false, error: `the contract names slug "${entrySlug}", expected "${slug}"` };
		}
		if (!REQUIRED_DOCUMENTS.includes(file)) continue;
		if (entries.has(file)) {
			return { ok: false, error: `the contract repeats ${file}` };
		}
		entries.set(file, hash);
		match = DOCUMENT_HASH_RE.exec(line);
	}
	for (const file of REQUIRED_DOCUMENTS) {
		if (!entries.has(file)) {
			return { ok: false, error: `the contract is missing ${file} sha256=<64hex>` };
		}
	}
	return { ok: true, dir, line, entries };
}

/**
 * Recompute the three document hashes and compare them with the contract.
 */
export function verifyManualReportContract(cwd, slug, providedLine) {
	const contract = readVerificationContract(cwd, slug, providedLine);
	if (!contract.ok) return contract;
	for (const file of REQUIRED_DOCUMENTS) {
		let actual;
		try {
			actual = sha256Document(resolve(contract.dir, file));
		} catch (error) {
			return {
				ok: false,
				code: ":CONTRACT_HASH_MISMATCH",
				error: `${file} cannot be read: ${messageOf(error)}`,
			};
		}
		if (actual !== contract.entries.get(file)) {
			return {
				ok: false,
				code: ":CONTRACT_HASH_MISMATCH",
				error: `${file} sha256 ${actual} does not match the contract ${contract.entries.get(file)}`,
			};
		}
	}
	return { ok: true, dir: contract.dir, contract };
}

/**
 * Verify the contract and atomically write report.md.
 */
export function writeManualReport(cwd, slug, markdown, providedLine) {
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return { ok: false, error: "report_markdown must be a non-empty string." };
	}
	if (!markdown.split(/\r?\n/).some((line) => /^##[ \t]+\S/.test(line))) {
		return { ok: false, error: 'report_markdown must contain at least one "## " section.' };
	}

	const verified = verifyManualReportContract(cwd, slug, providedLine);
	if (!verified.ok) return verified;

	const relativePath = manualAcceptanceRelativePath(slug, MANUAL_ACCEPTANCE_REPORT_FILE);
	let existed;
	try {
		existed = manualAcceptanceWriteDocument(verified.dir, MANUAL_ACCEPTANCE_REPORT_FILE, markdown);
	} catch (error) {
		return { ok: false, error: manualAcceptanceWriteErrorText(relativePath, error) };
	}
	return { ok: true, relativePath, existed };
}
