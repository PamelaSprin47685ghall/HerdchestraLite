import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_SUBMISSION_SCHEMA,
	createFileSubmissionReader,
	writeSubmissionOnce,
} from "../src/swarm/auditors.mjs";

describe("attach_case_audit persistence", () => {
	let root;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "attach-audit-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("requires only the verdict fields", () => {
		expect(AUDIT_SUBMISSION_SCHEMA.required).toEqual([
			"case_id",
			"user_score",
			"developer_score",
			"report_markdown",
		]);
		expect(AUDIT_SUBMISSION_SCHEMA.properties.evidence_paths).toBeUndefined();
	});

	it("writes one <case_id>.submit.edn and reads it back", () => {
		const submission = {
			case_id: "CASE-1",
			user_score: 80,
			developer_score: 90,
			report_markdown: "real interface observed",
		};
		const written = writeSubmissionOnce({ root, slug: "demo", caseId: "CASE-1", submission });
		expect(written.ok).toBe(true);

		const path = join(root, ".herd", "missions", "demo", "audit", "CASE-1.submit.edn");
		expect(written.path).toBe(path);
		const text = readFileSync(path, "utf8");
		expect(text).toContain(":case-id");
		expect(text).not.toContain("evidence");
		expect(text).not.toContain("batch-id");

		const read = createFileSubmissionReader({ root, slug: "demo" })({ caseId: "CASE-1" });
		expect(read.ok).toBe(true);
		expect(read.submission).toEqual(submission);
	});

	it("rejects a second submission for the same CASE", () => {
		const submission = {
			case_id: "CASE-1",
			user_score: 80,
			developer_score: 90,
			report_markdown: "real interface observed",
		};
		expect(writeSubmissionOnce({ root, slug: "demo", caseId: "CASE-1", submission }).ok).toBe(true);
		const again = writeSubmissionOnce({ root, slug: "demo", caseId: "CASE-1", submission });
		expect(again.ok).toBe(false);
		expect(String(again.code)).toContain("AUDIT_DUPLICATE_CASE");
	});
});
