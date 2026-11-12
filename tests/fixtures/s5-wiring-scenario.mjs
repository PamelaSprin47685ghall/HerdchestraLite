import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	commitS2,
	createMission,
	freezeStage,
	readMission,
	saveS1Summary,
	saveStageDocument,
	takeApprovalAuthority,
	verifyApproval,
	verifyContract,
} from "../../src/stages/contract.mjs";
import { aggregate, writeS5Report } from "../../src/stages/scores.mjs";
import { deriveRepairSlices, snapshotWorkspace, validateSubmissions } from "../../src/swarm/auditors.mjs";
import { openBoard } from "../../src/swarm/board.mjs";
import { runTenure, startSlice } from "../../src/swarm/runner.mjs";
import { enqueueSlice, forkSlices, joinSlice } from "../../src/swarm/worktree.mjs";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function protectedView(snapshot, excludedPath) {
	return JSON.stringify(
		snapshot.files.filter((file) => file.path !== excludedPath),
		(_key, value) => (typeof value === "bigint" ? value.toString() : value),
	);
}

function git(cwd, args) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "S5 Wiring",
			GIT_AUTHOR_EMAIL: "s5-wiring@example.test",
			GIT_COMMITTER_NAME: "S5 Wiring",
			GIT_COMMITTER_EMAIL: "s5-wiring@example.test",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function write(root, relativePath, text) {
	const path = join(root, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
	return path;
}

const CASES = [
	{
		case_id: "CASE-01",
		threshold: 90,
		path: "正常",
		steps: ["Exercise the normal path."],
		expected: "The normal path is observable.",
		rubric: "case one rubric",
	},
	{
		case_id: "CASE-02",
		threshold: 90,
		path: "错误",
		steps: ["Exercise the error path."],
		expected: "The error path is observable.",
		rubric: "case two rubric",
	},
	{
		case_id: "CASE-03",
		threshold: 90,
		path: "边界",
		steps: ["Exercise the boundary path."],
		expected: "The boundary path is observable.",
		rubric: "case three rubric",
	},
	{
		case_id: "CASE-04",
		threshold: 90,
		path: "并发",
		steps: ["Exercise the concurrent path."],
		expected: "The concurrent path is observable.",
		rubric: "case four rubric",
	},
	{
		case_id: "CASE-05",
		threshold: 90,
		path: "恢复",
		steps: ["Exercise the recovery path."],
		expected: "The recovery path is observable.",
		rubric: "case five rubric",
	},
];
const CASE_IDS = CASES.map((entry) => entry.case_id);
const MODULES = [{ path: "src/product.mjs", secret_owned: "product", depends_on: [], mapped_cases: CASE_IDS }];
const SLICES = [
	{
		slice_id: "slice-a",
		goal: "wire S5",
		inputs: CASE_IDS,
		depends_on: [],
		done_when: "joined",
		mapped_cases: CASE_IDS,
	},
];
const SLUG = "s5-wiring";
const S1 = "# S1\n\n## 一句话目标与用户可见结果\n\nS5 wiring scenario.\n";
const S2 = [
	"# S2 manual tests",
	"",
	"### CASE-01",
	"- PASS threshold: 90/100",
	"- 路径：正常",
	"- 评分细则：case one rubric",
	"",
	"### CASE-02",
	"- PASS threshold: 90/100",
	"- 路径：错误",
	"- 评分细则：case two rubric",
	"",
].join("\n");
const S3 = "# S3\n\nS5 wiring development guide.\n";
const S4 = "# S4\n\nS5 wiring coordination book.\n";

function fakeAgents() {
	return {
		start(request) {
			const controller = new AbortController();
			return {
				handle: {
					agentId: request.id,
					controller,
					abort(reason) {
						controller.abort(reason);
					},
				},
				done: new Promise(() => {}),
			};
		},
	};
}

function submissions(root, lowSecond) {
	const specs = CASES.map((entry, index) => ({
		case_id: entry.case_id,
		user_score: index === 1 && lowSecond ? 96 : 96,
		developer_score: index === 1 && lowSecond ? 80 : 95,
		report_markdown: `# ${entry.case_id}\n\nObserved through the real temporary workspace.\n`,
		evidence_paths: [`plans/${SLUG}/evidence/${entry.case_id}/observation.txt`],
	}));
	for (const spec of specs) {
		write(root, spec.evidence_paths[0], `observed ${spec.case_id}\n`);
	}
	return specs;
}

function emptyRunnerDeps(board) {
	return {
		agents: fakeAgents(),
		ff: { ready: () => true },
		writeLock: { held: () => false },
		worktree: {
			enqueue: (info) => enqueueSlice({ ...info, deps: { board } }),
		},
		randomUUID: (() => {
			let n = 0;
			return () => {
				n += 1;
				return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
			};
		})(),
		now: () => Date.parse("2026-11-11T00:00:00.000Z"),
		seed: "s5 wiring seed",
		contracts: [
			{ path: `plans/${SLUG}/s1-brainstorm.md`, sha256: "a".repeat(64) },
			{ path: `plans/${SLUG}/s2-manual-tests.md`, sha256: "b".repeat(64) },
		],
	};
}

async function main() {
	const root = mkdtempSync(join(tmpdir(), "herd-s5-wiring-"));
	try {
		git(root, ["init", "-q", "-b", "main"]);
		write(root, "base.txt", "base\n");
		git(root, ["add", "base.txt"]);
		git(root, ["commit", "-q", "-m", "base"]);

		const created = await createMission(root, { slug: SLUG, missionId: "mission-s5-wiring" });
		assert(created.ok, `createMission: ${JSON.stringify(created)}`);
		assert((await saveStageDocument(root, SLUG, "s1", S1, { callId: "s1-save" })).ok, "save s1");
		assert((await saveS1Summary(root, SLUG, "S5 wiring summary", { callId: "s1-summary" })).ok, "save summary");
		assert((await freezeStage(root, SLUG, "s1", undefined, { callId: "s1-freeze" })).ok, "freeze s1");
		assert(
			(await commitS2(root, SLUG, { manual_tests_markdown: S2, cases: CASES }, { callId: "s2-commit" })).ok,
			"commit s2",
		);
		assert(
			(
				await freezeStage(root, SLUG, "s3", S3, {
					callId: "s3-freeze",
					modules: MODULES,
					structure: { modules: [{ path: "src/product.mjs" }] },
				})
			).ok,
			"freeze s3",
		);
		assert(
			(
				await freezeStage(root, SLUG, "s4", S4, {
					callId: "s4-freeze",
					slices: SLICES,
					structure: { slices: [{ slice_id: "slice-a", mapped_cases: CASE_IDS }] },
				})
			).ok,
			"freeze s4",
		);
		const read = await readMission(root, SLUG);
		assert(
			read.ok && String(read.mission.stage).replace(/^:/, "") === "s5",
			`mission is at s5 after freeze: ${JSON.stringify(read)}`,
		);
		const mission = read.mission;

		const slug = SLUG;
		const sliceId = "slice-a";
		const board = openBoard(root, slug, sliceId);
		const handles = await forkSlices({
			root,
			slug,
			base: "main",
			slices: [
				{
					slice_id: sliceId,
					depends_on: [],
					goal: "wire the S5 scenario",
					done_when: "slice queued and joined",
					mapped_cases: CASES.map((entry) => entry.case_id),
				},
			],
			deps: { board },
		});
		assert(handles.length === 1, "one worktree");
		const handle = handles[0];
		const deps = emptyRunnerDeps(board);
		const slice = {
			slice_id: sliceId,
			slug,
			root,
			workspace: handle.workspace,
			board,
			goal: "wire the S5 scenario",
			done_when: "slice queued and joined",
			mapped_cases: CASES.map((entry) => entry.case_id),
		};
		assert((await startSlice({ slice, deps })).ok, "startSlice");
		assert(
			(
				await runTenure({
					slice,
					deps,
					findings: [{ key: "F1", value: "finish the S5 scenario slice" }],
				})
			).ok,
			"findings open",
		);
		await board.store.transaction(async (current) => {
			const draft = structuredClone(current);
			for (const task of Object.values(draft.tasks)) task.state = "done";
			return { board: draft, events: [], response: { ok: true }, commit: true };
		});
		assert((await runTenure({ slice, deps, findings: [] })).ok, "empty review queues");
		const joined = await joinSlice({ root, slug, deps: { board } });
		assert(joined.slice_id === sliceId, "joinSlice returns the slice");
		assert(typeof joined.ff_commit === "string" && joined.ff_commit.length === 40, "ff commit");

		const contract = {
			missionId: mission["mission-id"],
			revision: mission.revision,
			contractLine: mission["contract-line"],
			frozen: mission.frozen,
			verified: true,
		};
		const verifiedContract = await verifyContract(root, SLUG);
		assert(verifiedContract.ok, `verifyContract: ${JSON.stringify(verifiedContract)}`);
		const before = snapshotWorkspace(root);
		assert(before.ok, "snapshot before");
		const failingSubmissions = submissions(root, true);
		const after = snapshotWorkspace(root);
		assert(after.ok, "snapshot after");
		const failureValidation = validateSubmissions({
			caseSpecs: CASES,
			submissions: failingSubmissions,
			snapshotBefore: before,
			snapshotAfter: after,
			root,
			slug: SLUG,
		});
		assert(failureValidation.ok, `failure validation: ${JSON.stringify(failureValidation)}`);
		const failureResult = aggregate({
			caseSpecs: CASES,
			submissions: failureValidation.submissions,
			contract,
			snapshotBefore: before,
			snapshotAfter: after,
			audit: { environment: "temporary git + durable board", limitations: "none", lessons: "none" },
			ports: { verifyContract: () => verifiedContract },
		});
		assert(failureResult.verdict === "FAIL", `expected FAIL, got ${failureResult.verdict}`);
		assert(failureResult.repairSpec !== null, "FAIL yields a repair spec");
		const repair = deriveRepairSlices({ aggregateResult: failureResult });
		assert(repair.ok && repair.retryRequired === false, "derive repair slices");
		assert(repair.mappedCases.includes("CASE-02"), "repair mapped only the failing CASE");
		assert(repair.frozenS4Modified === false, "repair does not modify the frozen S4");
		assert(repair.nextRevision === contract.revision + 1, "repair advances revision");
		const repairSlice = repair.repairSlices[0];
		assert(repairSlice.mapped_cases.length === 1, "repair slice maps exactly one CASE");
		assert(repairSlice.mapped_cases[0] === "CASE-02", "repair slice maps the failed CASE");
		assert(typeof repairSlice.goal === "string" && repairSlice.goal.length > 0, "repair slice goal");
		assert(typeof repairSlice.done_when === "string" && repairSlice.done_when.includes("CASE-02"), "repair done_when");
		const failedReport = await writeS5Report(root, SLUG, failureResult, {
			approvalPort: {
				issue() {
					throw new Error("FAIL must never reach the approval port");
				},
			},
			recheckPort: () => ({ ok: true }),
		});
		assert(failedReport.ok === false, "FAIL must not write a report");
		assert(existsSync(join(root, "plans", SLUG, "s5-report.md")) === false, "no s5-report after FAIL");
		const afterFailureMission = await readMission(root, SLUG);
		assert(afterFailureMission.ok, "mission readable after FAIL");
		assert(afterFailureMission.mission.revision === contract.revision, "FAIL does not advance the mission revision");
		assert(afterFailureMission.mission.approval === null, "FAIL does not issue an approval");

		const passingSubmissions = submissions(root, false);
		const afterPass = snapshotWorkspace(root);
		assert(afterPass.ok, "snapshot after pass");
		const passValidation = validateSubmissions({
			caseSpecs: CASES,
			submissions: passingSubmissions,
			snapshotBefore: before,
			snapshotAfter: afterPass,
			root,
			slug: SLUG,
		});
		assert(passValidation.ok, `pass validation: ${JSON.stringify(passValidation)}`);
		const passResult = aggregate({
			caseSpecs: CASES,
			submissions: passValidation.submissions,
			contract,
			snapshotBefore: before,
			snapshotAfter: afterPass,
			audit: { environment: "temporary git + durable board", limitations: "none", lessons: "none" },
			ports: { verifyContract: () => verifiedContract },
		});
		assert(passResult.verdict === "PASS", `expected PASS, got ${passResult.verdict}`);
		assert(passResult.repairSpec === null, "PASS has no repair spec");

		const authority = takeApprovalAuthority();
		assert(authority !== null, "approval authority is available in this process");
		const recheckPort = async () => {
			const contractNow = await verifyContract(root, SLUG);
			if (!contractNow.ok) return { ok: false, code: ":CONTRACT_HASH_MISMATCH", message: "contract changed" };
			const snapshotNow = snapshotWorkspace(root);
			if (
				!snapshotNow.ok ||
				protectedView(snapshotNow, `plans/${SLUG}/s5-report.md`) !== protectedView(before, `plans/${SLUG}/s5-report.md`)
			) {
				return { ok: false, code: ":AUDIT_WORKSPACE_MUTATED", message: "workspace changed" };
			}
			return { ok: true };
		};
		const report = await writeS5Report(root, SLUG, passResult, {
			approvalPort: authority.createPort(root, SLUG),
			recheckPort,
		});
		assert(report.ok, `writeS5Report: ${JSON.stringify(report)}`);
		assert(typeof report.approval.token === "string" && report.approval.token.length > 0, "approval token");
		assert(existsSync(join(root, "plans", SLUG, "s5-report.md")), "s5-report exists");
		const reportText = readFileSync(join(root, "plans", SLUG, "s5-report.md"), "utf8");
		assert(reportText.includes("CASE-02") && reportText.includes("PASS"), "report rows");
		const completed = await readMission(root, SLUG);
		assert(completed.ok && String(completed.mission.stage).replace(/^:/, "") === "completed", "mission completed");
		const approval = await verifyApproval(root, SLUG);
		assert(approval.ok, `verifyApproval: ${JSON.stringify(approval)}`);

		process.stdout.write(
			`${JSON.stringify({
				ok: true,
				join: { sliceId: joined.slice_id, ffCommit: joined.ff_commit, report: joined.report.split("\n")[0] },
				failure: {
					verdict: failureResult.verdict,
					repairSpec: failureResult.repairSpec !== null,
					mappedCases: repair.mappedCases,
					reportWritten: false,
				},
				success: {
					verdict: passResult.verdict,
					reportPath: "plans/s5-wiring/s5-report.md",
					approvalToken: report.approval.token.slice(0, 8),
					missionStage: String(completed.mission.stage).replace(/^:/, ""),
				},
			})}\n`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exitCode = 1;
});
