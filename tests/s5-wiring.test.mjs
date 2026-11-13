import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdnKeyword, readUfss } from "../src/clj-sandbox/ufss.mjs";
import { startAuditBatch } from "../src/swarm/auditors.mjs";
import { applyReview, initialBoard, openBoard, wakeAll } from "../src/swarm/board.mjs";
import { attachToolForStage, boardIsEmpty } from "../src/stages/tenure.mjs";
const roots = [];
let uuidCounter = 0;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function newRoot() {
	const root = mkdtempSync(join(tmpdir(), "herd-s5-wiring-"));
	roots.push(root);
	return root;
}
function uuidFactory() {
	return () => {
		uuidCounter += 1;
		return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
	};
}
const S2_CASES = [
	{
		case_id: "CASE-01",
		path: "happy path",
		threshold: 90,
		steps: ["Run the happy path", "Inspect the review ledger"],
		expected: "The dashboard shows the live review ledger",
		rubric: "Every requested field is visible",
	},
	{
		case_id: "CASE-02",
		path: "failure path",
		threshold: 90,
		steps: ["Run the failure path", "Inspect the tenure barrier"],
		expected: "The barrier retires the tenure without losing tasks",
		rubric: "The failure is reported and the successor stays clean",
	},
];
function s2CasesEdnText() {
	return [
		"[{:case-id \"CASE-01\"",
		"  :path \"happy path\"",
		"  :threshold 90",
		"  :steps [\"Run the happy path\" \"Inspect the review ledger\"]",
		"  :expected \"The dashboard shows the live review ledger\"",
		"  :rubric \"Every requested field is visible\"}",
		" {:case-id \"CASE-02\"",
		"  :path \"failure path\"",
		"  :threshold 90",
		"  :steps [\"Run the failure path\" \"Inspect the tenure barrier\"]",
		"  :expected \"The barrier retires the tenure without losing tasks\"",
		"  :rubric \"The failure is reported and the successor stays clean\"}]",
		"",
	].join("\n");
}
function setupMission(root, slug) {
	const directory = join(root, ".herd", "missions", slug);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "mission.edn"),
		`{:mission-id "mission-s5-wiring"\n :slug "${slug}"\n :stage :s5\n :revision 1}\n`,
	);
	writeFileSync(join(directory, "s2-cases.edn"), s2CasesEdnText());
	return { directory };
}
function keywordValue(map, name) {
	for (const [key, value] of map) {
		if (key instanceof EdnKeyword && key.name === name) return value;
	}
	return undefined;
}
function keywordName(value) {
	return value instanceof EdnKeyword ? value.name : value;
}
function casesFromEdn(value) {
	if (!Array.isArray(value)) throw new Error("s2-cases.edn must hold a CASE vector");
	return value.map((record) => ({
		case_id: keywordValue(record, "case-id"),
		path: keywordValue(record, "path"),
		threshold: keywordValue(record, "threshold"),
		steps: keywordValue(record, "steps"),
		expected: keywordValue(record, "expected"),
		rubric: keywordValue(record, "rubric"),
	}));
}
function readEvents(board) {
	if (!existsSync(board.eventsPath)) return [];
	return readFileSync(board.eventsPath, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}
describe("S5 wiring: one main board, review findings, K-path audit", () => {
	it("persists s2-cases.edn in the mission root and reads the CASE records back", () => {
		const root = newRoot();
		const { directory } = setupMission(root, "wiring-cases");
		const casesPath = join(directory, "s2-cases.edn");
		expect(existsSync(casesPath)).toBe(true);
		const value = readUfss(readFileSync(casesPath, "utf8"));
		expect(Array.isArray(value)).toBe(true);
		expect(value.length).toBe(2);
		expect(value.map((record) => keywordValue(record, "case-id"))).toEqual(["CASE-01", "CASE-02"]);
		const mission = readUfss(readFileSync(join(directory, "mission.edn"), "utf8"));
		expect(keywordName(keywordValue(mission, "stage"))).toBe("s5");
		expect(existsSync(join(root, "plans", "wiring-cases", "s2-cases.edn"))).toBe(false);
	});
	it("turns review findings into root tasks and one wake-all on the single main board", async () => {
		const root = newRoot();
		const slug = "wiring-review";
		setupMission(root, slug);
		const board = openBoard(root, slug);
		expect(board.mode).toBe("plan");
		expect(board.sliceId).toBeNull();
		await board.store.initialize(initialBoard({ mode: "plan" }));
		await board.store.transaction(async (current) => {
			const reviewed = applyReview(current, {
				summaryMarkdown: "single reviewer round",
				findings: S2_CASES.map((spec) => ({ key: spec.case_id, value: `${spec.case_id}: ${spec.expected}` })),
			});
			const woke = wakeAll(reviewed.board, "review-findings-opened");
			return {
				board: woke.board,
				events: [...reviewed.events, woke.event],
				response: { ...reviewed.receipt, epoch: woke.epoch },
				commit: true,
			};
		});
		const saved = await board.store.read();
		expect(Object.keys(saved.tasks)).toEqual(["CASE-01", "CASE-02"]);
		expect(saved.tasks["CASE-01"].value).toContain("CASE-01");
		expect(saved["attach-ready"]).toBe(false);
		expect(saved.wake.epoch).toBe(1);
		expect(saved["review-summary"]).toBe("single reviewer round");
		const events = readEvents(board);
		expect(events.some((event) => event["event-type"] === "review")).toBe(true);
		expect(events.some((event) => event["event-type"] === "wake-all")).toBe(true);
		expect(existsSync(join(root, ".herd", "missions", slug, "slices"))).toBe(false);
	});
	it("keeps an empty S5 ledger for the K-path audit instead of attaching", () => {
		const empty = initialBoard({ mode: "plan" });
		expect(boardIsEmpty(empty)).toBe(true);
		expect(attachToolForStage("s5")).toBeNull();
		expect(attachToolForStage("s4")).toBe("attach_coordination");
	});
	it("starts one auditor per CASE from s2-cases.edn with the new startAuditBatch signature", async () => {
		const root = newRoot();
		const slug = "wiring-audit";
		const { directory } = setupMission(root, slug);
		const caseSpecs = casesFromEdn(readUfss(readFileSync(join(directory, "s2-cases.edn"), "utf8")));
		const starts = [];
		const result = await startAuditBatch({
			root,
			slug,
			caseSpecs,
			deps: {
				runtime: {
					start(options) {
						starts.push(options);
						return {
							handle: { agentId: `auditor-${starts.length}`, abort() {} },
							done: Promise.resolve({ ok: true }),
						};
					},
				},
				buildPrompt: ({ caseSpec }) => `Audit ${caseSpec.case_id} against the single read-only workspace.`,
				randomUUID: uuidFactory(),
				now: () => Date.parse("2026-11-13T00:00:00.000Z"),
				timeoutMs: 5000,
				maxRuntimeMs: 5000,
			},
		});
		expect(starts.length).toBe(2);
		expect(result.auditors.length).toBe(2);
		expect(result.auditors.map((auditor) => auditor.caseId).sort()).toEqual(["CASE-01", "CASE-02"]);
		expect(result.caseSpecs.length).toBe(2);
		expect(result.validation.workspaceMutated).toBe(false);
		expect(result.validation.snapshotChecked).toBe(true);
		expect(Object.hasOwn(result, "contractVerification")).toBe(false);
		expect(Object.hasOwn(result, "frozen")).toBe(false);
	});
});
