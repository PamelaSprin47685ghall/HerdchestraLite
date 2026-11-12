import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	manualAcceptanceDir,
	manualAcceptanceDocumentError,
	manualAcceptanceRelativePath,
	manualAcceptanceWriteDocument,
} from "../documents.mjs";

const roots = [];

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-dev-acceptance-docs-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("manual acceptance document helpers", () => {
	it("resolves a safe slug and rejects a traversal slug", () => {
		const cwd = sandbox();

		expect(manualAcceptanceDir(cwd, "demo")).toBe(join(cwd, "docs", "manual-acceptance", "demo"));
		expect(manualAcceptanceRelativePath("demo", "requirements.md")).toBe("docs/manual-acceptance/demo/requirements.md");
		expect(() => manualAcceptanceDir(cwd, "../demo")).toThrow(
			"invalid goal_slug: use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit",
		);
	});

	it("reports whether the target already existed", () => {
		const root = sandbox();

		expect(manualAcceptanceWriteDocument(root, "requirements.md", "# one\n")).toBe(false);
		expect(manualAcceptanceWriteDocument(root, "requirements.md", "# two\n")).toBe(true);
	});

	it("requires a non-empty markdown body and at least one level-2 section", () => {
		expect(manualAcceptanceDocumentError("", "guide_markdown")).toBe("guide_markdown must be a non-empty string.");
		expect(manualAcceptanceDocumentError("没有小节", "guide_markdown")).toBe(
			'guide_markdown must contain at least one "## " section.',
		);
	});

	it("requires the development-guide shape", () => {
		expect(manualAcceptanceDocumentError("## 概要\n", "guide_markdown")).toBe(
			'guide_markdown must contain "S2" or a "## ...实现/步骤..." heading.',
		);
		expect(manualAcceptanceDocumentError("## 实现\n", "guide_markdown")).toBeUndefined();
		expect(manualAcceptanceDocumentError("## S2\n\n正文。\n", "guide_markdown")).toBeUndefined();
	});

	it("requires the coordination shape, including a level-3 merge-order heading", () => {
		expect(manualAcceptanceDocumentError("## 设计\n", "coordination_markdown")).toBe(
			'coordination_markdown must contain a 切片/任务分解 section and a "## ...合并顺序" heading.',
		);
		expect(manualAcceptanceDocumentError("## 切片\n\n## 合并顺序\n", "coordination_markdown")).toBeUndefined();
		expect(manualAcceptanceDocumentError("## 切片\n\n### 6.6 拓扑合并顺序\n", "coordination_markdown")).toBeUndefined();
	});
});
