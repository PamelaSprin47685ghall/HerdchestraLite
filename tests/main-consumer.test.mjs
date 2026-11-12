import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxTools } from "../src/clj-sandbox/tools.mjs";
import { EdnKeyword, readUfss } from "../src/clj-sandbox/ufss.mjs";
import { missionBoardPort, sandboxRoots, writeAuditSubmission } from "../src/main.mjs";
import { apply, createWriteGateControl, TAKE_OR_DIE_CONFIRMATION } from "../src/swarm/board.mjs";
import { withLock } from "../src/util/file-lock.mjs";

const roots = [];

function field(value, key) {
	if (!(value instanceof Map)) return undefined;
	for (const [name, item] of value) {
		if (name instanceof EdnKeyword && name.name === key) return item;
	}
	return undefined;
}

function keywordName(value) {
	return value instanceof EdnKeyword ? value.name : String(value ?? "").replace(/^:/, "");
}

function parseReceipt(result) {
	return readUfss(result.content[0].text);
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("main consumer path", () => {
	it("claims real board work, commits a protected write, runs a Holder call, and settles the action", async () => {
		const root = mkdtempSync(join(tmpdir(), "herd-consumer-"));
		roots.push(root);
		const slug = "mission-a";
		const sliceId = "slice-a";
		const logs = join(root, ".herd", "artifacts", slug, sliceId);
		mkdirSync(logs, { recursive: true });
		mkdirSync(join(root, ".herd", "locks"), { recursive: true });

		const board = await missionBoardPort(root, slug).ensureSlice({ sliceId });
		const registered = await apply({
			board,
			command: { type: "registerActor", agentId: "holder-1", slotId: "slot-1" },
			turnId: "turn-1",
			requestId: "register",
		});
		expect(registered.ok).toBe(true);
		const added = await apply({
			board,
			command: {
				type: "addTasks",
				tasks: [
					{
						goal: "write and call",
						remainingWork: "write and call",
						doneWhen: "file exists",
						needsToken: true,
					},
				],
			},
			actor: "holder-1",
			turnId: "turn-1",
			requestId: "add",
		});
		expect(added.ok).toBe(true);
		const taskId = added.receipt.taskIds[0];
		const taken = await apply({
			board,
			command: { type: "takeOrDie", confirm: TAKE_OR_DIE_CONFIRMATION, handoffMarkdown: "holder takes the work" },
			actor: "holder-1",
			turnId: "turn-2",
			requestId: "take",
		});
		expect(taken.ok).toBe(true);
		const claimed = await apply({
			board,
			command: { type: "claim", taskId, atomicityReason: "one result" },
			actor: "holder-1",
			turnId: "turn-2",
			requestId: "claim",
		});
		expect(claimed.ok).toBe(true);
		const claimId = claimed.receipt.claimId;

		const lockPath = join(root, ".herd", "locks", `${sliceId}.write-w.lock`);
		const bundle = buildSandboxTools({
			role: "holder",
			roots: { writeRoot: root, callLogDir: logs },
			ports: {
				writeGate: {
					runExclusive: (run) =>
						withLock(
							lockPath,
							{
								lock_id: `${sliceId}-writeW`,
								purpose: "writeW",
								slice_id: sliceId,
								owner_agent_id: "holder-1",
								pid: process.pid,
							},
							run,
						),
				},
				control: createWriteGateControl(board),
				identity: { agent_id: "holder-1", status: "alive" },
				claim: { claim_id: claimId, task_id: taskId, status: "active" },
				callMeta: {
					read: () => ({ intentBytes: 1, deadlineAt: Date.now() + 60_000 }),
				},
			},
		});

		const result = await bundle.tool.execute(
			"consumer-call",
			{
				program_name: "p",
				code: `(defprogram p []
				        (do (write {:path "note.txt" :content "from-holder"})
				            (call {:command "cat note.txt"})))`,
			},
			undefined,
			undefined,
			{},
		);
		const receipt = parseReceipt(result);
		expect(keywordName(field(receipt, "state"))).toBe("completed");
		const call = field(receipt, "value");
		expect(field(call, "stdout")).toBe("from-holder");
		expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("from-holder");
		expect(field(call, "log-path")).toContain(join(".herd", "artifacts", slug, sliceId));

		const settled = await board.store.read();
		for (const action of Object.values(settled.actions ?? {})) {
			expect(action.phase).toBe("finished");
		}
		expect(settled.actors["holder-1"]["active-action-id"]).toBeNull();
	});
	it("reads package.json from a fresh workspace through the DevOps roots", async () => {
		const root = mkdtempSync(join(tmpdir(), "herd-devops-read-"));
		roots.push(root);
		writeFileSync(join(root, "package.json"), '{"name":"fresh-workspace"}', "utf8");
		const artifacts = join(root, ".herd", "artifacts", "real-mission", "devops");
		mkdirSync(artifacts, { recursive: true });
		const ctx = {
			cwd: root,
			sessionManager: { getSessionFile: () => join(artifacts, "agent.jsonl") },
		};
		const state = { id: "devops-child", root, slug: undefined, lastContext: {} };
		const devopsRoots = sandboxRoots("devops", ctx, state);
		expect(devopsRoots.readRoots).toEqual([]);
		expect(devopsRoots.callLogDir).toContain(join(".herd", "artifacts", "real-mission"));
		const bundle = buildSandboxTools({
			role: "devops",
			roots: devopsRoots,
			ports: {
				callMeta: { read: () => ({ intentBytes: 1, deadlineAt: Date.now() + 60_000 }) },
			},
		});
		const result = await bundle.tool.execute(
			"devops-read",
			{ program_name: "p", code: '(defprogram p [] (cat {:path "package.json"}))' },
			undefined,
			undefined,
			{},
		);
		const receipt = readUfss(result.content[0].text);
		expect(field(receipt, "value")).toContain("fresh-workspace");
	});
	it("writes one full EDN audit submission per batch and rejects a second write", () => {
		const root = mkdtempSync(join(tmpdir(), "herd-submit-"));
		roots.push(root);
		const binding = { slug: "mission-a", batchId: "batch-1", caseId: "CASE-01_" };
		const params = {
			case_id: "CASE-01_",
			user_score: 90,
			developer_score: 91,
			report_markdown: "evidence and report",
			evidence_paths: ["plans/mission-a/evidence/CASE-01_/report.md"],
		};
		writeAuditSubmission({ root }, binding, params);
		const path = join(root, ".herd", "missions", "mission-a", "audit", "batch-1", "CASE-01_.submit.edn");
		const record = readUfss(readFileSync(path, "utf8"));
		expect(field(record, "batch-id")).toBe("batch-1");
		expect(field(record, "case-id")).toBe("CASE-01_");
		expect(field(record, "user-score")).toBe(90);
		expect(field(record, "report-markdown")).toBe("evidence and report");
		let duplicate;
		try {
			writeAuditSubmission({ root }, binding, params);
		} catch (error) {
			duplicate = error;
		}
		expect(duplicate?.code).toBe(":AUDIT_DUPLICATE_CASE");
	});
});
