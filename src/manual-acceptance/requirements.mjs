/**
 * Parse the CASE list out of a requirements sheet.
 *
 * Inputs: the complete `requirements.md` markdown.
 * Output: `{ id, threshold, path }` per CASE, in document order. The parsed
 * rubric is validated for presence but never returned.
 *
 * Fenced code blocks are ignored; any heading of level 1–3 other than a CASE
 * heading closes the current CASE. A malformed sheet throws with the source
 * line and the reason, and the text names the exact line the author must fix.
 */

import {
	MANUAL_CASE_HEADING_RE,
	MANUAL_CASE_PATH_RE,
	MANUAL_CASE_RUBRIC_RE,
	MANUAL_CASE_THRESHOLD_RE,
} from "./constants.mjs";

export function parseRequirementCases(markdown) {
	const cases = [];
	const seen = new Set();
	let current;

	const finish = () => {
		if (!current) return;
		const { id, threshold, path, rubric, line } = current;
		if (threshold === undefined) {
			throw new Error(`requirements markdown line ${line}: ${id} has no "- PASS threshold: N/100" line`);
		}
		if (path === undefined || path.length === 0) {
			throw new Error(`requirements markdown line ${line}: ${id} has no "- 路径：..." line`);
		}
		if (rubric === undefined || rubric.length === 0) {
			throw new Error(`requirements markdown line ${line}: ${id} has no non-empty "- 评分细则：..." line`);
		}
		if (seen.has(id)) {
			throw new Error(`requirements markdown: duplicate CASE id ${id}`);
		}
		seen.add(id);
		cases.push({ id, threshold, path });
		current = undefined;
	};

	let fence;
	const lines = markdown.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		if (fence) {
			const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(rawLine);
			if (closing && closing[1].startsWith(fence.marker) && closing[1].length >= fence.length) {
				fence = undefined;
			}
			continue;
		}
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine);
		if (opening) {
			const marker = opening[1];
			fence = { marker: marker.startsWith("`") ? "`" : "~", length: marker.length };
			continue;
		}
		const line = rawLine.trim();
		const heading = MANUAL_CASE_HEADING_RE.exec(line);
		if (heading) {
			finish();
			current = { id: heading[1], line: index + 1 };
			continue;
		}
		if (/^#{1,3}[ \t]+\S/.test(line)) {
			finish();
			continue;
		}
		if (!current) continue;
		const threshold = MANUAL_CASE_THRESHOLD_RE.exec(line);
		if (threshold) {
			if (current.threshold !== undefined) {
				throw new Error(`requirements markdown line ${index + 1}: ${current.id} has more than one PASS threshold line`);
			}
			const value = Number(threshold[1]);
			if (!Number.isFinite(value) || value < 0 || value > 100) {
				throw new Error(
					`requirements markdown line ${index + 1}: ${current.id} threshold ${threshold[1]} is outside 0..100`,
				);
			}
			current.threshold = value;
			continue;
		}
		const path = MANUAL_CASE_PATH_RE.exec(line);
		if (path) {
			if (current.path !== undefined) {
				throw new Error(`requirements markdown line ${index + 1}: ${current.id} has more than one "- 路径：" line`);
			}
			current.path = path[1].trim();
			continue;
		}
		const rubric = MANUAL_CASE_RUBRIC_RE.exec(line);
		if (rubric) {
			if (current.rubric !== undefined) {
				throw new Error(`requirements markdown line ${index + 1}: ${current.id} has more than one "- 评分细则：" line`);
			}
			current.rubric = rubric[1].trim();
		}
	}
	finish();
	if (cases.length === 0) {
		throw new Error('requirements markdown has no "### CASE-*" headings');
	}
	return cases;
}
