import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EdnKeyword, printUfss, readUfss } from "../src/clj-sandbox/ufss.mjs";
import { buildCaseAuditorPrompt, formatCaseRecord } from "../src/prompts/roles.mjs";
import { aggregate } from "../src/stages/scores.mjs";
import {
	createFileSubmissionReader,
	deriveRepairSlices,
	snapshotWorkspace,
	startAuditBatch,
	validateSubmissions,
	writeSubmissionOnce,
} from "../src/swarm/auditors.mjs";
import { printEdn } from "../src/util/errors.mjs";

const fixtures = [];

afterEach(() => {
	for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CASES = [
	{
		case_id: "CASE-01",
		threshold: 90,
		path: "正常",
		steps: ["Observe case one marker."],
		expected: "Case one expected marker.",
		rubric: "rubric one marker",
	},
	{
		case_id: "CASE-02",
		threshold: 90,
		path: "错误",
		steps: ["Observe case two marker."],
		expected: "Case two expected marker.",
		rubric: "rubric two marker",
	},
];

const LIVE_SETTINGS = {
	get: () => 0,
	getStorage: () => undefined,
	getModelRoles: () => ({}),
};
const FakeSettings = function FakeSettings() {};
FakeSettings.instance = LIVE_SETTINGS;
const MODEL_REGISTRY = {
	authStorage: {},
	hasConfiguredAuth: () => true,
	getApiKey: () => "test-key",
};
const EVENT_BUS = { emit: () => {}, on: () => {} };
const CAPABILITIES = {
	hostPackageVersion: "test",
	cliVersion: "test",
	runtimePackageVersion: "test",
	typesPackageVersion: "test",
	hasToolCallInput: true,
	hasCtxAgent: true,
	hasBeforeSubagentSpawn: true,
	hasTurnEnd: true,
	hasSetWidget: true,
	hasHookWidget: true,
	hasOnTerminalInput: true,
	hasRegisterShortcut: true,
	hasSetActiveTools: true,
	hasEventBus: true,
	hasArtifactsDir: true,
	hasModelRegistry: true,
	hasSessionFile: true,
	hasSettingsInstance: true,
	hasRestrictToolNames: true,
	cherryLoaded: true,
	cherryHasEdnReader: true,
	unverified: [],
};

function write(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function casesEdnText(cases) {
	const records = cases.map(
		(entry) =>
			`{:case_id "${entry.case_id}" :path "${entry.path}" :threshold ${entry.threshold} :steps [${entry.steps
				.map((step) => `"${step}"`)
				.join(" ")}] :expected "${entry.expected}" :rubric "${entry.rubric}"}`,
	);
	return `{:cases [${records.join(" ")}]}\n`;
}

function field(map, name) {
	for (const [key, value] of map) if (key instanceof EdnKeyword && key.name === name) return value;
	return undefined;
}

function readCases(path) {
	const top = readUfss(readFileSync(path, "utf8"));
	return field(top, "cases").map((entry) => ({
		case_id: field(entry, "case_id"),
		path: field(entry, "path"),
		threshold: field(entry, "threshold"),
		steps: field(entry, "steps"),
		expected: field(entry, "expected"),
		rubric: field(entry, "rubric"),
	}));
}

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "herd-auditors-"));
	fixtures.push(root);
	const slug = "demo";
	const missionId = "mission-1";
	const revision = 3;
	write(join(root, "plans", slug, "s1-brainstorm.md"), "# S1\n\nS1 background marker\n");
	write(
		join(root, "plans", slug, "s2-manual-tests.md"),
		"# S2 manual test methodology\n\nMethodology only; CASEs live in s2-cases.edn.\n",
	);
	write(join(root, "plans", slug, "s3-dev-guide.md"), "# S3\n\nDevelopment guide marker\n");
	write(join(root, "plans", slug, "s4-coordination.md"), "# S4\n\nCoordination marker\n");
	write(join(root, "plans", slug, "s4-coordination.pml"), "active proctype Coordinator() { skip }\n");
	write(join(root, "src", "product.mjs"), "export const value = 1;\n");
	write(join(root, "tests", "product.test.mjs"), "console.log('test');\n");
	write(join(root, "package.json"), '{"name":"fixture"}\n');
	write(join(root, "docs", "guide.md"), "# guide\n");
	write(join(root, "README.md"), "# fixture\n");
	write(join(root, "tools", "dev-tool.mjs"), "export const tool = true;\n");
	write(join(root, "src", "nested", "build", "keep.mjs"), "export const nested = true;\n");
	write(join(root, "plugin-extension.mjs"), "export default {};\n");
	const casesPath = join(root, ".herd", "missions", slug, "s2-cases.edn");
	write(casesPath, casesEdnText(CASES));
	write(join(root, ".herd", "missions", slug, "board.edn"), "{:tasks {}}\n");
	return {
		root,
		slug,
		missionId,
		revision,
		casesPath,
		cases: readCases(casesPath),
		contract: { missionId, revision },
	};
}

function makeBareFixture({ slug, caseId }) {
	const root = mkdtempSync(join(tmpdir(), "herd-auditors-bare-"));
	fixtures.push(root);
	write(join(root, "plugin-extension.mjs"), "export default {};\n");
	const cases = [
		{
			case_id: caseId,
			threshold: 90,
			path: "正常",
			steps: ["Inspect the isolated copy."],
			expected: "The observable behavior matches the assigned CASE.",
			rubric: "long identifier rubric",
		},
	];
	const casesPath = join(root, ".herd", "missions", slug, "s2-cases.edn");
	write(casesPath, casesEdnText(cases));
	return {
		root,
		slug,
		missionId: "mission-long",
		revision: 1,
		casesPath,
		cases: readCases(casesPath),
		contract: { missionId: "mission-long", revision: 1 },
	};
}

function submissionFor(fixture, caseId, overrides = {}) {
	const relativePath = `plans/${fixture.slug}/evidence/${caseId}/observation.txt`;
	write(join(fixture.root, relativePath), `observed ${caseId}\n`);
	return {
		case_id: caseId,
		user_score: 96,
		developer_score: 95,
		report_markdown: `# ${caseId}\n\nObserved with evidence at ${relativePath}.\n`,
		evidence_paths: [relativePath],
		...overrides,
	};
}

function toolOutcome(fixture, caseId, overrides = {}) {
	return {
		ok: true,
		result: {
			extractedToolData: {
				submit_case_audit: [
					{
						status: "success",
						input: submissionFor(fixture, caseId, overrides),
					},
				],
			},
		},
	};
}

let idSequence = 0;

function newId() {
	idSequence += 1;
	return `00000000-0000-4000-8000-${String(idSequence).padStart(12, "0")}`;
}

function createRuntime(behavior = () => {}) {
	const starts = [];
	return {
		starts,
		start(options) {
			const record = {
				options,
				aborted: false,
				abortReasons: [],
				handle: null,
				resolve: null,
			};
			const done = new Promise((resolve) => {
				record.resolve = resolve;
			});
			const handle = {
				agentId: `agent-${starts.length + 1}`,
				abort(reason) {
					record.aborted = true;
					record.abortReasons.push(reason);
				},
			};
			record.handle = handle;
			starts.push(record);
			behavior(record, options);
			return { handle, done };
		},
	};
}

function depsFor(fixture, runtime, overrides = {}) {
	return {
		runtime,
		baseTmpDir: join(fixture.root, ".audit-tmp"),
		timeoutMs: 2000,
		maxRuntimeMs: 2000,
		randomUUID: newId,
		settings: LIVE_SETTINGS,
		modelRegistry: MODEL_REGISTRY,
		eventBus: EVENT_BUS,
		model: "test/model",
		parentActiveModelPattern: "test/model",
		capabilities: CAPABILITIES,
		preloadedExtensionPaths: [join(fixture.root, "plugin-extension.mjs")],
		buildPrompt: ({ caseSpec }) =>
			buildCaseAuditorPrompt({
				mission: { missionId: fixture.missionId, slug: fixture.slug },
				caseSpec,
			}),
		...overrides,
	};
}

async function runBatch(fixture, runtime, overrides = {}) {
	return startAuditBatch({
		root: fixture.root,
		slug: fixture.slug,
		caseSpecs: fixture.cases,
		deps: depsFor(fixture, runtime, overrides),
	});
}

function aggregateBatch(fixture, batch, extra = {}) {
	return aggregate({
		caseSpecs: batch.aggregateInput.caseSpecs,
		submissions: batch.aggregateInput.submissions,
		contract: fixture.contract,
		snapshotBefore: batch.aggregateInput.snapshotBefore,
		snapshotAfter: batch.aggregateInput.snapshotAfter,
		audit: { environment: "unit-test fixture" },
		...extra,
	});
}

describe("snapshotWorkspace", () => {
	it("is deterministic, records stamps, and ignores expected audit writes", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		expect(before.ok).toBe(true);
		expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(before.files.map((file) => file.path)).toEqual([...before.files.map((file) => file.path)].sort());
		expect(before.files.every((file) => typeof file.stamp.mtimeSec === "bigint")).toBe(true);
		expect(before.files.some((file) => file.path === "src/product.mjs")).toBe(true);
		expect(before.files.some((file) => file.path === ".herd/missions/demo/s2-cases.edn")).toBe(true);
		expect(before.files.some((file) => file.path === ".herd/missions/demo/board.edn")).toBe(true);

		const again = snapshotWorkspace(fixture.root);
		expect(again.digest).toBe(before.digest);

		write(join(fixture.root, "plans", fixture.slug, "evidence", "CASE-01", "shot.txt"), "screen\n");
		write(join(fixture.root, ".herd", "artifacts", fixture.slug, "audit", "CASE-01", "transcript.txt"), "log\n");
		write(join(fixture.root, ".herd", "missions", fixture.slug, "audit", "CASE-01.submit.edn"), "{}\n");
		expect(snapshotWorkspace(fixture.root).digest).toBe(before.digest);
	});

	it("detects a protected content change, a deletion, and a stamp-only change", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		write(join(fixture.root, "src", "product.mjs"), "export const value = 2;\n");
		const changed = snapshotWorkspace(fixture.root);
		expect(changed.digest).not.toBe(before.digest);

		rmSync(join(fixture.root, "tests", "product.test.mjs"));
		const deleted = snapshotWorkspace(fixture.root);
		expect(deleted.digest).not.toBe(changed.digest);
		expect(deleted.files.some((file) => file.path === "tests/product.test.mjs")).toBe(false);

		const readme = join(fixture.root, "README.md");
		utimesSync(readme, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
		expect(snapshotWorkspace(fixture.root).digest).not.toBe(deleted.digest);
	});
});

describe("validateSubmissions", () => {
	it("accepts one clean submission and attaches a positive validation receipt", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		const submission = submissionFor(fixture, "CASE-01");
		const after = snapshotWorkspace(fixture.root);
		const result = validateSubmissions({
			caseSpecs: fixture.cases,
			submissions: [submission],
			snapshotBefore: before,
			snapshotAfter: after,
			root: fixture.root,
			slug: fixture.slug,
		});
		expect(result.ok, JSON.stringify(result.errors)).toBe(true);
		expect(result.snapshotChecked).toBe(true);
		expect(result.workspaceMutated).toBe(false);
		expect(result.submissions[0].validation.ok).toBe(true);
		expect(result.validCount).toBe(1);
	});

	it("rejects unknown CASE ids, invalid scores, and empty reports", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		const submissions = [
			submissionFor(fixture, "CASE-99"),
			submissionFor(fixture, "CASE-01", { user_score: Number.NaN }),
			submissionFor(fixture, "CASE-02", { developer_score: 101, report_markdown: "   " }),
		];
		const after = snapshotWorkspace(fixture.root);
		const result = validateSubmissions({
			caseSpecs: fixture.cases,
			submissions,
			snapshotBefore: before,
			snapshotAfter: after,
			root: fixture.root,
			slug: fixture.slug,
		});
		expect(result.ok).toBe(false);
		expect(result.invalidCount).toBe(3);
		const codes = result.submissions.flatMap((entry) => entry.validation.errors.map((error) => error.code));
		expect(codes).toContain(":AUDIT_UNKNOWN_CASE");
		expect(codes).toContain(":AUDIT_INVALID_SCORE");
		expect(codes).toContain(":AUDIT_EVIDENCE_MISSING");
	});

	it("rejects missing evidence, lexical escapes, and absolute paths outside the repository", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		const submissions = [
			submissionFor(fixture, "CASE-01", {
				evidence_paths: [`plans/${fixture.slug}/evidence/CASE-01/missing.txt`],
			}),
			submissionFor(fixture, "CASE-02", {
				evidence_paths: [`plans/${fixture.slug}/evidence/CASE-02/../../../src/product.mjs`],
			}),
			submissionFor(fixture, "CASE-01", { evidence_paths: ["/etc/hostname"] }),
		];
		const after = snapshotWorkspace(fixture.root);
		const result = validateSubmissions({
			caseSpecs: fixture.cases,
			submissions,
			snapshotBefore: before,
			snapshotAfter: after,
			root: fixture.root,
			slug: fixture.slug,
		});
		const codes = result.submissions.flatMap((entry) => entry.validation.errors.map((error) => error.code));
		expect(codes).toContain(":AUDIT_EVIDENCE_MISSING");
		expect(codes).toContain(":PATH_ESCAPE");
	});

	it("turns a protected workspace mutation into a failed validation for every submission", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		write(join(fixture.root, "src", "product.mjs"), "tampered\n");
		const after = snapshotWorkspace(fixture.root);
		const result = validateSubmissions({
			caseSpecs: fixture.cases,
			submissions: [submissionFor(fixture, "CASE-01"), submissionFor(fixture, "CASE-02")],
			snapshotBefore: before,
			snapshotAfter: after,
			root: fixture.root,
			slug: fixture.slug,
		});
		expect(result.ok).toBe(false);
		expect(result.workspaceMutated).toBe(true);
		expect(result.submissions.every((entry) => entry.validation.ok === false)).toBe(true);
		expect(
			result.submissions.some((entry) =>
				entry.validation.errors.some((error) => error.code === ":AUDIT_WORKSPACE_MUTATED"),
			),
		).toBe(true);
	});

	it("treats an edited CASE dataset as a protected workspace mutation", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		write(fixture.casesPath, casesEdnText([CASES[0]]));
		const after = snapshotWorkspace(fixture.root);
		const result = validateSubmissions({
			caseSpecs: fixture.cases,
			submissions: [submissionFor(fixture, "CASE-01")],
			snapshotBefore: before,
			snapshotAfter: after,
			root: fixture.root,
			slug: fixture.slug,
		});
		expect(result.ok).toBe(false);
		expect(result.workspaceMutated).toBe(true);
		expect(result.submissions[0].validation.ok).toBe(false);
	});

	it("fails closed when evidence existence cannot be checked", () => {
		const fixture = makeFixture();
		const before = snapshotWorkspace(fixture.root);
		const after = snapshotWorkspace(fixture.root);
		const result = validateSubmissions({
			caseSpecs: fixture.cases,
			submissions: [submissionFor(fixture, "CASE-01")],
			snapshotBefore: before,
			snapshotAfter: after,
		});
		expect(result.ok).toBe(false);
		expect(result.submissions[0].validation.ok).toBe(false);
	});
});

describe("createFileSubmissionReader", () => {
	const BATCH_ID = "audit-demo-batch-1";

	function auditFile(fixture, batchId, caseId) {
		return join(fixture.root, ".herd", "missions", fixture.slug, "audit", batchId, `${caseId}.submit.edn`);
	}

	function writeSubmission(fixture, batchId, caseId, overrides = {}) {
		const submission = submissionFor(fixture, caseId, overrides);
		const path = auditFile(fixture, batchId, caseId);
		write(
			path,
			printEdn({
				"batch-id": batchId,
				"case-id": caseId,
				"user-score": submission.user_score,
				"developer-score": submission.developer_score,
				"report-markdown": submission.report_markdown,
				"evidence-paths": submission.evidence_paths,
			}),
		);
		return { path, submission };
	}

	it("reads a complete real EDN submission with batch identity", () => {
		const fixture = makeFixture();
		const { path } = writeSubmission(fixture, BATCH_ID, "CASE-01");
		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: BATCH_ID });
		const result = reader({ caseId: "CASE-01" });
		expect(result.ok).toBe(true);
		expect(result.submission.case_id).toBe("CASE-01");
		expect(result.submission.user_score).toBe(96);
		expect(result.path).toBe(path);
	});

	it("reads the printUfss/EdnKeyword map shape written by main", () => {
		const fixture = makeFixture();
		const submission = submissionFor(fixture, "CASE-01");
		const record = new Map([
			[new EdnKeyword("batch-id"), BATCH_ID],
			[new EdnKeyword("case-id"), "CASE-01"],
			[new EdnKeyword("slug"), fixture.slug],
			[new EdnKeyword("user-score"), submission.user_score],
			[new EdnKeyword("developer-score"), submission.developer_score],
			[new EdnKeyword("report-markdown"), submission.report_markdown],
			[new EdnKeyword("evidence-paths"), submission.evidence_paths],
			[new EdnKeyword("defects"), []],
		]);
		write(auditFile(fixture, BATCH_ID, "CASE-01"), printUfss(record));
		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: BATCH_ID });
		const result = reader({ caseId: "CASE-01" });
		expect(result.ok).toBe(true);
		expect(result.submission.user_score).toBe(96);
	});

	it("rejects missing, malformed, wrong-batch, wrong-CASE, and incomplete files", () => {
		const fixture = makeFixture();
		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: BATCH_ID });
		expect(reader({ caseId: "CASE-02" }).ok).toBe(false);

		write(auditFile(fixture, BATCH_ID, "CASE-01"), "{not-edn");
		expect(reader({ caseId: "CASE-01" }).ok).toBe(false);

		const wrongBatch = submissionFor(fixture, "CASE-01");
		write(
			auditFile(fixture, BATCH_ID, "CASE-01"),
			printEdn({
				"batch-id": "audit-other",
				"case-id": "CASE-01",
				"user-score": wrongBatch.user_score,
				"developer-score": wrongBatch.developer_score,
				"report-markdown": wrongBatch.report_markdown,
				"evidence-paths": wrongBatch.evidence_paths,
			}),
		);
		expect(reader({ caseId: "CASE-01" }).ok).toBe(false);

		const wrongCase = submissionFor(fixture, "CASE-01");
		write(
			auditFile(fixture, BATCH_ID, "CASE-01"),
			printEdn({
				"batch-id": BATCH_ID,
				"case-id": "CASE-02",
				"user-score": wrongCase.user_score,
				"developer-score": wrongCase.developer_score,
				"report-markdown": wrongCase.report_markdown,
				"evidence-paths": wrongCase.evidence_paths,
			}),
		);
		const wrong = reader({ caseId: "CASE-01" });
		expect(wrong.ok).toBe(false);
		expect(wrong.error.code).toBe(":AUDIT_UNKNOWN_CASE");

		write(auditFile(fixture, BATCH_ID, "CASE-01"), printEdn({ "batch-id": BATCH_ID, "case-id": "CASE-01" }));
		expect(reader({ caseId: "CASE-01" }).ok).toBe(false);
	});

	it("never reads another batch and leaves the old batch file untouched", () => {
		const fixture = makeFixture();
		const old = writeSubmission(fixture, "audit-old-batch", "CASE-01");
		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: BATCH_ID });
		expect(reader({ caseId: "CASE-01" }).ok).toBe(false);
		expect(readFileSync(old.path, "utf8")).toBe(
			printEdn({
				"batch-id": "audit-old-batch",
				"case-id": "CASE-01",
				"user-score": old.submission.user_score,
				"developer-score": old.submission.developer_score,
				"report-markdown": old.submission.report_markdown,
				"evidence-paths": old.submission.evidence_paths,
			}),
		);
	});

	it("rejects invalid paths, batch ids, and CASE ids", () => {
		const fixture = makeFixture();
		const badSlug = createFileSubmissionReader({ root: fixture.root, slug: "Bad Slug", batchId: BATCH_ID });
		expect(badSlug({ caseId: "CASE-01" }).ok).toBe(false);
		const badBatch = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: "../x" });
		expect(badBatch({ caseId: "CASE-01" }).ok).toBe(false);
		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: BATCH_ID });
		expect(reader({ caseId: "CASE-01/../../x" }).ok).toBe(false);
		expect(reader({ caseId: "" }).ok).toBe(false);
	});
});

describe("writeSubmissionOnce", () => {
	it("writes one EDN receipt and rejects a second write without changing the first", () => {
		const fixture = makeFixture();
		const batchId = "audit-write-1";
		const submission = submissionFor(fixture, "CASE-01");
		const first = writeSubmissionOnce({
			root: fixture.root,
			slug: fixture.slug,
			batchId,
			caseId: "CASE-01",
			submission,
		});
		expect(first.ok).toBe(true);
		const original = readFileSync(first.path, "utf8");
		const second = writeSubmissionOnce({
			root: fixture.root,
			slug: fixture.slug,
			batchId,
			caseId: "CASE-01",
			submission: { ...submission, user_score: 1, developer_score: 1 },
		});
		expect(second.ok).toBe(false);
		expect(second.code).toBe(":AUDIT_DUPLICATE_CASE");
		expect(readFileSync(first.path, "utf8")).toBe(original);

		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId });
		const read = reader({ caseId: "CASE-01" });
		expect(read.ok).toBe(true);
		expect(read.submission.user_score).toBe(96);
	});

	it("keeps batches isolated and refuses incomplete payloads", () => {
		const fixture = makeFixture();
		const submission = submissionFor(fixture, "CASE-01");
		const old = writeSubmissionOnce({
			root: fixture.root,
			slug: fixture.slug,
			batchId: "audit-old",
			caseId: "CASE-01",
			submission,
		});
		const current = writeSubmissionOnce({
			root: fixture.root,
			slug: fixture.slug,
			batchId: "audit-new",
			caseId: "CASE-01",
			submission: { ...submission, user_score: 91, developer_score: 91 },
		});
		expect(old.ok).toBe(true);
		expect(current.ok).toBe(true);
		expect(existsSync(old.path)).toBe(true);
		const reader = createFileSubmissionReader({ root: fixture.root, slug: fixture.slug, batchId: "audit-new" });
		expect(reader({ caseId: "CASE-01" }).submission.user_score).toBe(91);

		const incomplete = writeSubmissionOnce({
			root: fixture.root,
			slug: fixture.slug,
			batchId: "audit-incomplete",
			caseId: "CASE-02",
			submission: { case_id: "CASE-02" },
		});
		expect(incomplete.ok).toBe(false);
		expect(incomplete.code).toBe(":INVALID_ARGUMENT");

		const wrongCase = writeSubmissionOnce({
			root: fixture.root,
			slug: fixture.slug,
			batchId: "audit-wrong-case",
			caseId: "CASE-01",
			submission: { ...submission, case_id: "CASE-02" },
		});
		expect(wrongCase.ok).toBe(false);
		expect(wrongCase.code).toBe(":AUDIT_UNKNOWN_CASE");
	});
});

describe("startAuditBatch", () => {
	it("starts every CASE before any agent settles, isolates prompts and directories, and collects every submission", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime();
		const promise = runBatch(fixture, runtime);
		for (let index = 0; index < 8 && runtime.starts.length < 2; index += 1) await Promise.resolve();

		expect(runtime.starts.length).toBe(2);
		expect(runtime.starts.map((record) => record.options.name)).toEqual([
			"Auditor-demo-CASE-01",
			"Auditor-demo-CASE-02",
		]);
		const first = runtime.starts[0].options;
		expect(first.task).toContain("CASE-01");
		expect(first.task).toContain("case one marker");
		expect(first.task).not.toContain("CASE-02");
		expect(first.task).not.toContain("case two marker");
		expect(first.tools).toEqual(["clj_auditor", "submit_case_audit", "yield"]);
		expect(first.restrictToolNames).toBe(false);
		expect(first.enableMCP).toBe(false);
		expect(first.enableLsp).toBe(false);
		expect(first.enableIrc).toBe(false);
		expect(first.capabilities).toBe(CAPABILITIES);
		expect(first.preloadedExtensionPaths).toEqual([join(fixture.root, "plugin-extension.mjs")]);
		expect(first.model).toBe("test/model");
		expect(first.modelRegistry).toBe(MODEL_REGISTRY);
		expect(first.eventBus).toBe(EVENT_BUS);
		expect(first.settings).toBe(LIVE_SETTINGS);
		expect(first.visible).toBe(true);
		expect(first.requireArtifacts).toBe(true);
		expect(first.outputSchemaMode).toBe("strict");
		expect(first.outputSchema.properties.case_id.enum).toEqual(["CASE-01"]);
		expect(first.artifactsDir).not.toContain("plans/demo/evidence");
		expect(first.artifactsDir).toContain(".herd/artifacts/demo/audit/");
		expect(first.artifactsDir.endsWith("/CASE-01")).toBe(true);
		expect(existsSync(join(first.artifactsDir, "audit-context.edn"))).toBe(true);
		expect(first.timeoutMs).toBe(2000);
		expect(first.maxRuntimeMs).toBe(2000);
		expect(first.signal.aborted).toBe(false);
		expect(new Set(runtime.starts.map((record) => record.options.name)).size).toBe(2);
		expect(existsSync(join(fixture.root, "plans", fixture.slug, "evidence", "CASE-01"))).toBe(true);
		expect(existsSync(join(fixture.root, "plans", fixture.slug, "evidence", "CASE-02"))).toBe(true);

		runtime.starts[0].resolve(toolOutcome(fixture, "CASE-01"));
		runtime.starts[1].resolve(toolOutcome(fixture, "CASE-02"));
		const result = await promise;

		expect(result.ok, JSON.stringify(result.errors)).toBe(true);
		expect(result.state).toBe("completed");
		expect(result.auditors.map((record) => record.status)).toEqual(["submitted", "submitted"]);
		expect(result.auditors.every((record) => record.validation.ok === true)).toBe(true);
		expect(result.submissions.length).toBe(2);
		expect(result.missingCases).toEqual([]);
		expect(result.workspaceMutated).toBe(false);
		expect(result.closureBlocked).toBe(false);
		expect(result.validation.ok).toBe(true);
		expect(result.aggregateInput.caseSpecs.map((spec) => spec.case_id)).toEqual(["CASE-01", "CASE-02"]);
	});

	it("emits options that the actual host planSpawn accepts", async () => {
		const { planSpawn } = await import("../src/host/subprocess.mjs");
		const fixture = makeFixture();
		const plans = [];
		const runtime = createRuntime((record) => {
			const plan = planSpawn(record.options, { Settings: FakeSettings });
			plans.push(plan);
			if (!plan.ok) {
				record.resolve({ ok: false, error: plan.error });
				return;
			}
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve(toolOutcome(fixture, caseId));
		});
		const result = await runBatch(fixture, runtime);
		expect(plans.length).toBe(2);
		expect(plans.every((plan) => plan.ok === true)).toBe(true);
		const request = plans[0].request;
		expect(request.agent.tools).toEqual(["clj_auditor", "submit_case_audit", "yield"]);
		expect(request.restrictToolNames).toBe(false);
		expect(request.preloadedExtensionPaths).toEqual([join(fixture.root, "plugin-extension.mjs")]);
		expect(request.modelOverride).toEqual(["test/model"]);
		expect(plans[0].meta.role).toBe("Manual Auditor");
		expect(plans[0].meta.visibility).toBe("hub");
		expect(plans[0].meta.extensionSource).toBe("preloaded");
		expect(plans[0].meta.toolNarrowingRequired).toBe(true);
		expect(plans[0].meta.limits.timeoutMs).toBe(2000);
		expect(result.ok).toBe(true);
	});

	it("fails the whole batch when the runtime cannot open an auditor sandbox", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			record.resolve({ ok: false, error: { code: ":CAPABILITY_DENIED", message: "bwrap is not executable on PATH" } });
		});
		const result = await runBatch(fixture, runtime);
		expect(runtime.starts.length).toBe(2);
		expect(result.ok).toBe(false);
		expect(result.auditors.map((record) => record.status)).toEqual(["crashed", "crashed"]);
		expect(result.auditors.every((record) => record.submission === null)).toBe(true);
		expect(result.retryRequired).toBe(true);
	});

	it("keeps the auditor name within the host's 80-character limit", async () => {
		const fixture = makeBareFixture({ slug: "s".repeat(64), caseId: `CASE-${"X".repeat(60)}` });
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve(toolOutcome(fixture, caseId));
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(true);
		const name = result.auditors[0].name;
		expect(name.length).toBeLessThanOrEqual(80);
		expect(name).toMatch(/^[A-Za-z][A-Za-z0-9._-]*$/);
		expect(name.startsWith("Auditor-")).toBe(true);
	});

	it("passes only the structured CASE record to buildPrompt and appends the yield confirmation", async () => {
		const fixture = makeFixture();
		const prompts = [];
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			prompts.push(record.options.task);
			record.resolve(toolOutcome(fixture, caseId));
		});
		const result = await runBatch(fixture, runtime, {
			buildPrompt: ({ caseSpec }) => {
				const marker = caseSpec.case_id === "CASE-01" ? "Observe case one marker." : "Observe case two marker.";
				if (!caseSpec.steps.includes(marker)) throw new Error("steps missing");
				return `Audit ${caseSpec.case_id} only. Submit with submit_case_audit; include user_score and evidence_paths.`;
			},
		});
		expect(result.ok).toBe(true);
		expect(prompts[0]).toContain("## Completion");
		expect(prompts[0]).toContain("yield a minimal confirmation");
		expect(prompts[0]).not.toContain("## Submission handoff");
		expect(prompts[0]).toContain(result.auditors[0].artifactsDir);
	});

	it("works with the real buildCaseAuditorPrompt from the main assembly", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve(toolOutcome(fixture, caseId));
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(true);
		const task = runtime.starts[0].options.task;
		expect(task).toContain(`Mission: ${fixture.missionId} (slug: ${fixture.slug})`);
		expect(task).toContain(".herd/missions/demo/s2-cases.edn");
		expect(task).not.toContain("- plans/demo/s1-summary.md");
		expect(task).toContain("There is no `s1-summary.md`");
		expect(task).toContain(":case_id");
		expect(task).toContain("Observe case one marker.");
		expect(task).toContain("Case one expected marker.");
		expect(task).toContain(":expected");
		expect(task).toContain(":rubric");
		expect(task).toContain("## Completion");
	});

	it("renders one assigned CASE record as deterministic EDN with the declared fields and step order", () => {
		const caseSpec = {
			case_id: "CASE-01",
			path: "正常",
			threshold: 90,
			steps: ["First step.", "Second step."],
			expected: "Expected behavior.",
			rubric: "Rubric text.",
		};
		const text = formatCaseRecord(caseSpec);
		expect(formatCaseRecord(caseSpec)).toBe(text);
		const record = readUfss(text);
		expect(record).toBeInstanceOf(Map);
		const keys = [...record.keys()].map((key) => (key instanceof EdnKeyword ? key.name : key));
		expect(keys).toEqual(["case_id", "path", "threshold", "steps", "expected", "rubric"]);
		const byName = (name) => [...record.entries()].find(([key]) => key instanceof EdnKeyword && key.name === name)?.[1];
		expect(byName("case_id")).toBe("CASE-01");
		expect(byName("steps")).toEqual(["First step.", "Second step."]);
		expect(byName("expected")).toBe("Expected behavior.");
		expect(() => formatCaseRecord({ ...caseSpec, steps: [] })).toThrow();
	});

	it("supports the main assembly's promise-only spawnAgent port", async () => {
		const fixture = makeFixture();
		const spawnAgent = async (options) => {
			const caseId = options.outputSchema.properties.case_id.enum[0];
			const contextText = readFileSync(join(options.artifactsDir, "audit-context.edn"), "utf8");
			const context = readUfss(contextText);
			expect(context).toBeInstanceOf(Map);
			expect(field(context, "batch-id")).toMatch(/^audit-/);
			expect(field(context, "case-id")).toBe(caseId);
			const submission = submissionFor(fixture, caseId);
			write(
				join(fixture.root, field(context, "submission-path")),
				printEdn({
					"batch-id": field(context, "batch-id"),
					"case-id": caseId,
					"user-score": submission.user_score,
					"developer-score": submission.developer_score,
					"report-markdown": submission.report_markdown,
					"evidence-paths": submission.evidence_paths,
				}),
			);
			return {
				ok: true,
				agentId: `host-${caseId}`,
				resolvedModel: "test/model",
				result: {
					extractedToolData: {
						submit_case_audit: [{ status: "success", data: { ok: true, case_id: caseId } }],
					},
				},
			};
		};
		const result = await startAuditBatch({
			root: fixture.root,
			slug: fixture.slug,
			caseSpecs: fixture.cases,
			deps: { ...depsFor(fixture, undefined), runtime: undefined, spawnAgent },
		});
		expect(result.ok).toBe(true);
		expect(result.auditors.map((record) => record.agentId)).toEqual(["host-CASE-01", "host-CASE-02"]);
		expect(result.auditors.every((record) => record.submissionSource === "port")).toBe(true);
	});

	it("does not accept a yield as a substitute for the durable tool submission", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve({
				ok: true,
				result: {
					extractedToolData: {
						submit_case_audit: [{ status: "success", data: { ok: true, case_id: caseId } }],
						yield: [{ status: "success", data: submissionFor(fixture, caseId) }],
					},
				},
			});
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(false);
		expect(result.auditors.every((record) => record.status === "missing_submission")).toBe(true);
		expect(result.auditors.every((record) => record.submission === null)).toBe(true);
		expect(result.auditors.every((record) => record.submissionSource === null)).toBe(true);
		expect(result.auditors.every((record) => record.receipts.length === 1)).toBe(true);
		expect(result.auditors.every((record) => record.receipts[0].data?.ok === true)).toBe(true);
	});

	it("propagates a parent abort to every live auditor", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime();
		const controller = new AbortController();
		const promise = runBatch(fixture, runtime, { signal: controller.signal, timeoutMs: 5000 });
		for (let index = 0; index < 8 && runtime.starts.length < 2; index += 1) await Promise.resolve();
		expect(runtime.starts.length).toBe(2);

		controller.abort("operator cancelled");
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.auditors.map((record) => record.status)).toEqual(["aborted", "aborted"]);
		expect(runtime.starts.every((record) => record.aborted === true)).toBe(true);
		expect(result.auditors.every((record) => record.error.code === ":AUDIT_ABORTED")).toBe(true);
		expect(result.uncertain).toBe(true);
		expect(result.state).toBe("uncertain");
		expect(result.closureBlocked).toBe(true);
		expect(result.snapshotAfter).toBeNull();
		expect(result.aggregateInput).toBeNull();
		expect(result.auditors.every((record) => record.exitConfirmed === false)).toBe(true);
	});

	it("takes the after snapshot after cancel only when the runtime confirms exit", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			record.handle.abort = (reason) => {
				record.aborted = true;
				record.abortReasons.push(reason);
				record.resolve({ ok: false, error: { code: ":UPSTREAM_ABORTED", message: "aborted" } });
			};
		});
		const controller = new AbortController();
		const promise = runBatch(fixture, runtime, { signal: controller.signal, timeoutMs: 5000 });
		controller.abort("stop");
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.auditors.map((record) => record.status)).toEqual(["aborted", "aborted"]);
		expect(result.uncertain).toBe(false);
		expect(result.closureBlocked).toBe(true);
		expect(result.exitConfirmed).toBe(true);
		expect(result.state).toBe("aborted");
		expect(result.snapshotAfter).not.toBeNull();
		expect(result.aggregateInput).not.toBeNull();
	});

	it("enforces the hard timeout and never turns it into a pass", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime();
		const began = Date.now();
		const result = await runBatch(fixture, runtime, { timeoutMs: 25, maxRuntimeMs: 25 });
		const elapsed = Date.now() - began;

		expect(elapsed).toBeLessThan(2000);
		expect(result.ok).toBe(false);
		expect(result.auditors.map((record) => record.status)).toEqual(["timeout", "timeout"]);
		expect(result.auditors.every((record) => record.error.code === ":AUDIT_TIMEOUT")).toBe(true);
		expect(runtime.starts.every((record) => record.aborted === true)).toBe(true);
		expect(result.missingCases).toEqual(["CASE-01", "CASE-02"]);
		expect(result.uncertain).toBe(true);
		expect(result.state).toBe("uncertain");
		expect(result.closureBlocked).toBe(true);
		expect(result.snapshotAfter).toBeNull();
		expect(result.aggregateInput).toBeNull();
		expect(result.auditors.every((record) => record.exitConfirmed === false)).toBe(true);
	});

	it("applies the hard timeout to a hanging submission collector", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			record.resolve({ ok: true, result: {} });
		});
		const result = await runBatch(fixture, runtime, {
			timeoutMs: 25,
			maxRuntimeMs: 25,
			collectSubmission: () => new Promise(() => {}),
		});
		expect(result.ok).toBe(false);
		expect(result.auditors.map((record) => record.status)).toEqual(["timeout", "timeout"]);
		expect(result.auditors.every((record) => record.error.code === ":AUDIT_TIMEOUT")).toBe(true);
		expect(result.uncertain).toBe(false);
		expect(result.closureBlocked).toBe(true);
		expect(result.auditors.every((record) => record.exitConfirmed === true)).toBe(true);
		expect(result.snapshotAfter).not.toBeNull();
		expect(result.aggregateInput).not.toBeNull();
	});

	it("classifies crashes, model fallback, and missing submissions as failures", async () => {
		const fixture = makeFixture();
		const crashRuntime = createRuntime((record) => {
			record.resolve({ ok: false, error: { code: ":AGENT_SPAWN_FAILED", message: "boom" } });
		});
		const crashed = await runBatch(fixture, crashRuntime);
		expect(crashed.ok).toBe(false);
		expect(crashed.auditors.map((record) => record.status)).toEqual(["crashed", "crashed"]);
		expect(crashed.retryRequired).toBe(true);

		const fallbackRuntime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve({ ...toolOutcome(fixture, caseId), resolvedModelIsFallback: true });
		});
		const fallback = await runBatch(fixture, fallbackRuntime);
		expect(fallback.ok).toBe(false);
		expect(fallback.auditors.map((record) => record.status)).toEqual(["crashed", "crashed"]);
		expect(fallback.auditors.every((record) => record.error.code === ":MODEL_FALLBACK")).toBe(true);

		const emptyRuntime = createRuntime((record) => {
			record.resolve({ ok: true, result: {} });
		});
		const missing = await runBatch(fixture, emptyRuntime);
		expect(missing.ok).toBe(false);
		expect(missing.auditors.map((record) => record.status)).toEqual(["missing_submission", "missing_submission"]);
		expect(missing.missingCases).toEqual(["CASE-01", "CASE-02"]);

		const exitRuntime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve({ ...toolOutcome(fixture, caseId), exitCode: 1 });
		});
		const exited = await runBatch(fixture, exitRuntime);
		expect(exited.ok).toBe(false);
		expect(exited.auditors.map((record) => record.status)).toEqual(["crashed", "crashed"]);
		expect(exited.auditors.every((record) => record.submission === null)).toBe(true);

		const abortedRuntime = createRuntime((record) => {
			record.resolve({ ok: true, aborted: true, abortReason: "timeout after 25ms" });
		});
		const abortedResult = await runBatch(fixture, abortedRuntime);
		expect(abortedResult.ok).toBe(false);
		expect(abortedResult.auditors.map((record) => record.status)).toEqual(["timeout", "timeout"]);
		expect(abortedResult.uncertain).toBe(false);
		expect(abortedResult.snapshotAfter).not.toBeNull();
	});

	it("prefers the submit_case_audit receipt over a minimal yield confirmation", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			if (caseId === "CASE-02") {
				record.resolve(toolOutcome(fixture, caseId));
				return;
			}
			record.resolve({
				ok: true,
				result: {
					extractedToolData: {
						yield: [{ status: "success", data: { case_id: caseId } }],
						submit_case_audit: [
							{
								status: "success",
								data: { ok: true, case_id: caseId },
								input: submissionFor(fixture, caseId),
							},
						],
					},
				},
			});
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(true);
		expect(result.auditors[0].submissionSource).toBe("tool");
		expect(result.auditors[0].validation.ok).toBe(true);
	});

	it("rejects multiple submit_case_audit receipts instead of taking the last write", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			if (caseId === "CASE-02") {
				record.resolve(toolOutcome(fixture, caseId));
				return;
			}
			record.resolve({
				ok: true,
				result: {
					extractedToolData: {
						submit_case_audit: [
							{ status: "success", data: submissionFor(fixture, caseId, { user_score: 96, developer_score: 96 }) },
							{ status: "success", data: submissionFor(fixture, caseId, { user_score: 70, developer_score: 70 }) },
						],
					},
				},
			});
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(false);
		const duplicate = result.auditors.find((record) => record.caseId === "CASE-01");
		expect(duplicate.status).toBe("duplicate_submission");
		expect(duplicate.submission).toBeNull();
		expect(duplicate.submissions.length).toBe(2);
		expect(duplicate.submissions[1].user_score).toBe(70);
		expect(duplicate.error.code).toBe(":AUDIT_DUPLICATE_CASE");
		expect(result.duplicateSubmissionCases).toEqual(["CASE-01"]);
		expect(result.missingCases).toContain("CASE-01");
		expect(result.submissions.some((entry) => entry.case_id === "CASE-01")).toBe(false);

		const aggregateResult = aggregateBatch(fixture, result);
		expect(aggregateResult.verdict).toBe("INCOMPLETE");
		const repair = deriveRepairSlices({ aggregateResult });
		expect(repair.retryRequired).toBe(true);
		expect(repair.repairSlices).toEqual([]);
	});

	it("rejects duplicate submit_case_audit receipts even when both expose only {ok, case_id}", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve({
				ok: true,
				result: {
					extractedToolData: {
						submit_case_audit: [
							{ status: "success", data: { ok: true, case_id: caseId } },
							{ status: "success", data: { ok: true, case_id: caseId } },
						],
						yield: [{ status: "success", data: submissionFor(fixture, caseId) }],
					},
				},
			});
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(false);
		const duplicate = result.auditors.find((record) => record.caseId === "CASE-01");
		expect(duplicate.status).toBe("duplicate_submission");
		expect(duplicate.submission).toBeNull();
		expect(duplicate.receipts.length).toBe(2);
		expect(duplicate.submissions.length).toBe(0);
		expect(duplicate.error.code).toBe(":AUDIT_DUPLICATE_CASE");
		expect(duplicate.error.count).toBe(2);
		expect(result.duplicateSubmissionCases).toContain("CASE-01");
	});

	it("rejects a submission filed under another auditor's CASE and reports the duplicate", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			record.resolve(toolOutcome(fixture, "CASE-02"));
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(false);
		expect(result.missingCases).toContain("CASE-01");
		expect(result.duplicateCases).toEqual(["CASE-02"]);
		expect(result.auditors[0].validation.ok).toBe(false);
	});

	it("voids the batch when an auditor changes the protected workspace", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			if (caseId === "CASE-01") write(join(fixture.root, "src", "product.mjs"), "tampered\n");
			record.resolve(toolOutcome(fixture, caseId));
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(false);
		expect(result.workspaceMutated).toBe(true);
		expect(result.auditors.every((record) => record.validation.ok === false)).toBe(true);
		expect(
			result.auditors.some((record) =>
				record.validation.errors.some((error) => error.code === ":AUDIT_WORKSPACE_MUTATED"),
			),
		).toBe(true);
	});

	it("voids the batch when an auditor edits the persisted CASE dataset", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			if (caseId === "CASE-01") write(fixture.casesPath, casesEdnText([CASES[0]]));
			record.resolve(toolOutcome(fixture, caseId));
		});
		const result = await runBatch(fixture, runtime);
		expect(result.ok).toBe(false);
		expect(result.workspaceMutated).toBe(true);
		expect(result.retryRequired).toBe(true);
		expect(result.aggregateInput).not.toBeNull();
	});

	it("refuses zero CASEs and a missing runtime port", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime();
		const empty = await startAuditBatch({
			root: fixture.root,
			slug: fixture.slug,
			caseSpecs: [],
			deps: depsFor(fixture, runtime),
		});
		expect(empty.state).toBe("refused");
		expect(runtime.starts.length).toBe(0);

		const noRuntime = await startAuditBatch({
			root: fixture.root,
			slug: fixture.slug,
			caseSpecs: fixture.cases,
			deps: { ...depsFor(fixture, undefined), runtime: undefined },
		});
		expect(noRuntime.state).toBe("refused");
		expect(noRuntime.errors.some((error) => error.code === ":HOST_API_MISMATCH")).toBe(true);
	});

	it("refuses a legacy Markdown-era CASE shape before spawning auditors", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime();
		const legacy = await startAuditBatch({
			root: fixture.root,
			slug: fixture.slug,
			caseSpecs: [{ ...fixture.cases[0], id: "CASE-01", rawBlock: "legacy markdown" }],
			deps: depsFor(fixture, runtime),
		});
		expect(legacy.state).toBe("refused");
		const legacyError = legacy.errors.find((error) => error.field === "caseSpecs" && Array.isArray(error.unknown));
		expect(legacyError?.unknown).toEqual(expect.arrayContaining(["id", "rawBlock"]));
		expect(runtime.starts.length).toBe(0);
	});

	it("refuses a missing prompt port and an empty CASE dataset", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime();
		const noPrompt = await startAuditBatch({
			root: fixture.root,
			slug: fixture.slug,
			caseSpecs: fixture.cases,
			deps: { ...depsFor(fixture, runtime), buildPrompt: undefined },
		});
		expect(noPrompt.state).toBe("refused");
		expect(noPrompt.errors.some((error) => error.field === "deps.buildPrompt")).toBe(true);
		expect(runtime.starts.length).toBe(0);

		const empty = await startAuditBatch({
			root: fixture.root,
			slug: fixture.slug,
			caseSpecs: [],
			deps: depsFor(fixture, runtime),
		});
		expect(empty.state).toBe("refused");
		expect(empty.errors.some((error) => error.field === "caseSpecs")).toBe(true);
		expect(runtime.starts.length).toBe(0);
	});

	it("turns missing submissions into an audit retry, not a code repair", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			record.resolve({ ok: true, result: {} });
		});
		const batch = await runBatch(fixture, runtime);
		expect(batch.ok).toBe(false);
		const aggregateResult = aggregateBatch(fixture, batch);
		expect(aggregateResult.verdict).toBe("INCOMPLETE");
		const repair = deriveRepairSlices({ aggregateResult });
		expect(repair.ok).toBe(false);
		expect(repair.retryRequired).toBe(true);
		expect(repair.repairSlices).toEqual([]);
	});

	it("feeds T4 a score miss and derives a rework Slice from the resulting RepairSpec", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			const overrides = caseId === "CASE-02" ? { user_score: 80, developer_score: 96 } : {};
			record.resolve(toolOutcome(fixture, caseId, overrides));
		});
		const batch = await runBatch(fixture, runtime);
		expect(batch.ok).toBe(true);
		const aggregateResult = aggregateBatch(fixture, batch);
		expect(aggregateResult.verdict).toBe("FAIL");
		expect(aggregateResult.rows.find((row) => row.caseId === "CASE-02").score).toBe(80);
		const repair = deriveRepairSlices({ aggregateResult });
		expect(repair.ok).toBe(true);
		expect(repair.retryRequired).toBe(false);
		expect(repair.mappedCases).toEqual(["CASE-02"]);
		expect(repair.repairSlices[0].mapped_cases).toEqual(["CASE-02"]);
		expect(repair.repairSlices[0].defects.join(" ")).toContain("user_score 80");
	});

	it("produces an aggregate input that T4 accepts for a clean PASS", async () => {
		const fixture = makeFixture();
		const runtime = createRuntime((record) => {
			const caseId = record.options.outputSchema.properties.case_id.enum[0];
			record.resolve(toolOutcome(fixture, caseId));
		});
		const batch = await runBatch(fixture, runtime);
		expect(batch.ok).toBe(true);

		const aggregateResult = aggregateBatch(fixture, batch);
		expect(aggregateResult.verdict).toBe("PASS");
		expect(aggregateResult.ok).toBe(true);
		expect(aggregateResult.workspaceMutated).toBe(false);
		expect(aggregateResult.rows.every((row) => row.valid === true)).toBe(true);
	});
});

describe("deriveRepairSlices", () => {
	const failingAggregate = {
		ok: false,
		verdict: "FAIL",
		retryRequired: false,
		contract: { missionId: "mission-1", revision: 3 },
		rows: [
			{
				caseId: "CASE-02",
				path: "错误",
				threshold: 95,
				userScore: 96,
				developerScore: 88,
				score: 88,
				passed: false,
				valid: true,
				evidencePaths: ["plans/demo/evidence/CASE-02/observation.txt"],
				reportMarkdown: "# report",
			},
		],
		invalid: [{ caseId: "CASE-02", message: "developer_score 88 is below threshold 95" }],
		repairSpec: {
			missionId: "mission-1",
			revision: 3,
			nextRevision: 4,
			cases: [
				{
					caseId: "CASE-02",
					path: "错误",
					threshold: 95,
					userScore: 96,
					developerScore: 88,
					score: 88,
					evidencePaths: ["plans/demo/evidence/CASE-02/observation.txt"],
					defects: ["developer_score 88 is below threshold 95"],
				},
			],
			mappedCases: ["CASE-02"],
		},
	};

	it("derives one runtime repair Slice per failed CASE and never writes an S4 document", () => {
		const fixture = makeFixture();
		const s4 = join(fixture.root, "plans", fixture.slug, "s4-coordination.md");
		const pml = join(fixture.root, "plans", fixture.slug, "s4-coordination.pml");
		const before = readFileSync(s4, "utf8");
		const beforePml = readFileSync(pml, "utf8");
		const result = deriveRepairSlices({ aggregateResult: failingAggregate });
		expect(result.ok).toBe(true);
		expect(result.retryRequired).toBe(false);
		expect(result.nextRevision).toBe(4);
		expect(result.mappedCases).toEqual(["CASE-02"]);
		expect(result.repairSlices.length).toBe(1);
		const slice = result.repairSlices[0];
		expect(slice.slice_id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
		expect(slice.mapped_cases).toEqual(["CASE-02"]);
		expect(slice.depends_on).toEqual([]);
		expect(slice.defects).toContain("developer_score 88 is below threshold 95");
		expect(slice.done_when).toContain("95/100");
		expect(readFileSync(s4, "utf8")).toBe(before);
		expect(readFileSync(pml, "utf8")).toBe(beforePml);
		expect(existsSync(join(fixture.root, "plans", fixture.slug, "s4-coordination.repair.md"))).toBe(false);
	});

	it("returns no slices for PASS and a retry for INCOMPLETE anomalies", () => {
		const passed = deriveRepairSlices({
			aggregateResult: { ok: true, verdict: "PASS", contract: { missionId: "mission-1", revision: 1 }, rows: [] },
		});
		expect(passed.ok).toBe(true);
		expect(passed.repairSlices).toEqual([]);
		expect(passed.retryRequired).toBe(false);

		const incomplete = deriveRepairSlices({
			aggregateResult: {
				ok: false,
				verdict: "INCOMPLETE",
				retryRequired: true,
				contract: { missionId: "mission-1", revision: 2 },
				invalid: [{ caseId: "CASE-01", message: "AUDIT_MISSING" }],
			},
		});
		expect(incomplete.ok).toBe(false);
		expect(incomplete.retryRequired).toBe(true);
		expect(incomplete.repairSlices).toEqual([]);
		expect(incomplete.errors.length).toBeGreaterThan(0);
	});

	it("keeps repair Slice ids unique when CASE ids normalize to the same text", () => {
		const shared = {
			...failingAggregate.repairSpec,
			cases: [
				{ caseId: "CASE-A_1", defects: ["one"], evidencePaths: [] },
				{ caseId: "CASE-A-1", defects: ["two"], evidencePaths: [] },
			],
		};
		const result = deriveRepairSlices({ aggregateResult: { ...failingAggregate, repairSpec: shared } });
		const ids = result.repairSlices.map((slice) => slice.slice_id);
		expect(new Set(ids).size).toBe(2);
	});
});