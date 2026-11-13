/**
 * T3: the S1-S4 review and attach tools.
 *
 * The module owns the lifecycle around `review`, `attach_brainstorm`,
 * `attach_manual_tests`, `attach_dev_guide`, `attach_coordination`,
 * `ask_user`, `devops`, and `submit_devops_report`.
 *
 * `review` is the only writer of the review ledger during a tenure. It
 * upserts findings (`value` string), deletes them (`value` nil), leaves the
 * ledger untouched for an empty finding list, and sets `attach-ready` only
 * when the ledger is empty. Review never writes a deliverable and never
 * advances the stage.
 *
 * `attach_*` is the only writer of deliverables. It requires one active
 * tenure, the matching stage, an empty ledger, `attach-ready`, and no pending
 * attach. It writes the deliverables atomically, archives the ledger, writes
 * the barrier, retires the tenure, opens an empty successor, and returns the
 * next briefing. S1 additionally waits for explicit human approval.
 *
 * Outside world through injected ports:
 *   contract.readMission(root, slug, options)
 *   contract.saveStageDocument(root, slug, stage, markdown, options)
 *   contract.readPendingGate(root, slug, options)
 *   contract.writePendingGate(root, slug, pending, options)
 *   contract.readBoard(root, slug, options)
 *   contract.writeBoard(root, slug, board, options)
 *   contract.archiveBoard(root, slug, board, options)
 *   contract.advanceTenure(root, slug, attach, options)
 *
 *   host.confirm / host.resumeApproval / host.askUser / host.onStageChange
 *   host.runDevops / host.acceptDevopsReport
 *   runner.assertInitialEmptyLedger / runner.submitReview
 *
 * Expected failures never throw. Disclosure is attached only to the receipt
 * that carries the next briefing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { herdError, isHerdError, printEdn, renderError } from "../util/errors.mjs";
import * as tenure from "./tenure.mjs";
import { currentBriefing } from "./disclosures.mjs";

function gatedObject(Type, properties, options = { additionalProperties: false }) {
	return Type.Object(properties, options);
}

export { currentBriefing };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CALL_ID = 200;
const STAGE_ORDER = Object.freeze({ s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, completed: 6 });
const REVIEW_ROLES = Object.freeze(["Reviewer", "Plan", "Coordinator"]);
const ATTACH_ROLES = Object.freeze(["Plan", "Coordinator"]);
const ASK_ROLES = Object.freeze(["Plan", "Coordinator", "Reviewer"]);
const STAGE_ATTACH_TOOLS = Object.freeze({
	s1: "attach_brainstorm",
	s2: "attach_manual_tests",
	s3: "attach_dev_guide",
	s4: "attach_coordination",
});

export const GATE_TOOL_NAMES = Object.freeze([
	"review",
	"attach_brainstorm",
	"attach_manual_tests",
	"attach_dev_guide",
	"attach_coordination",
	"ask_user",
	"devops",
	"submit_devops_report",
]);

const TOOL_LABELS = Object.freeze({
	review: "Submit Review",
	attach_brainstorm: "Attach Brainstorm",
	attach_manual_tests: "Attach Manual Tests",
	attach_dev_guide: "Attach Dev Guide",
	attach_coordination: "Attach Coordination",
	ask_user: "Ask User",
	devops: "DevOps Investigation",
	submit_devops_report: "Submit DevOps Report",
});

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isText(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function isSpecificText(value) {
	return isText(value) && /[\p{L}\p{N}]/u.test(value);
}

function settingsOf(deps) {
	return deps !== null && typeof deps === "object" ? deps : {};
}

function now(deps) {
	return typeof deps.now === "function" ? deps.now() : new Date().toISOString();
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value) {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizeCasesForDigest(cases) {
	if (!Array.isArray(cases)) return cases;
	return cases.map((entry) => {
		if (!isPlainObject(entry)) return entry;
		return {
			case_id: entry.case_id,
			path: entry.path,
			threshold: entry.threshold,
			steps: Array.isArray(entry.steps) ? [...entry.steps] : entry.steps,
			expected: entry.expected,
			rubric: entry.rubric,
		};
	});
}

function normalizedDependsOn(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? [...value] : value;
}

function normalizeModulesForDigest(modules) {
	if (!Array.isArray(modules)) return modules;
	return modules.map((entry) => {
		if (!isPlainObject(entry)) return entry;
		return {
			path: entry.path,
			secret_owned: entry.secret_owned,
			depends_on: normalizedDependsOn(entry.depends_on),
			mapped_cases: Array.isArray(entry.mapped_cases) ? [...entry.mapped_cases] : entry.mapped_cases,
		};
	});
}

function normalizeSlicesForDigest(slices) {
	if (!Array.isArray(slices)) return slices;
	return slices.map((entry) => {
		if (!isPlainObject(entry)) return entry;
		return {
			slice_id: entry.slice_id,
			goal: entry.goal,
			inputs: Array.isArray(entry.inputs) ? [...entry.inputs] : entry.inputs,
			depends_on: normalizedDependsOn(entry.depends_on),
			done_when: entry.done_when,
			mapped_cases: Array.isArray(entry.mapped_cases) ? [...entry.mapped_cases] : entry.mapped_cases,
		};
	});
}

function digestPayload(op, params) {
	switch (op) {
		case "advance_s1":
			return {
				slug: params.slug,
				brainstorm_markdown: params.brainstorm_markdown,
				summary: params.summary,
				non_goals: params.non_goals,
			};
		case "advance_s2":
			return {
				slug: params.slug,
				manual_tests_markdown: params.manual_tests_markdown,
				cases: normalizeCasesForDigest(params.cases),
			};
		case "advance_s3":
			return {
				slug: params.slug,
				dev_guide_markdown: params.dev_guide_markdown,
				modules: normalizeModulesForDigest(params.modules),
			};
		case "advance_s4":
			return {
				slug: params.slug,
				coordination_markdown: params.coordination_markdown,
				slices: normalizeSlicesForDigest(params.slices),
			};
		default:
			return params;
	}
}

function callPayloadDigest(op, params) {
	return sha256(canonicalJson({ op, payload: digestPayload(op, params) }));
}

function gateReceiptPrefix(userCallId) {
	return `gate:${sha256(`herdchestra-gate-call:${userCallId}`)}:`;
}

function effectiveGateCallId(userCallId, digest) {
	return `${gateReceiptPrefix(userCallId)}${digest}`;
}

function recordedGateDigests(mission, userCallId) {
	if (userCallId === undefined) return [];
	const marker = gateReceiptPrefix(userCallId);
	const receipts = isPlainObject(mission?.receipts) ? mission.receipts : {};
	const digests = new Set();
	for (const key of Object.keys(receipts)) {
		const index = key.indexOf(marker);
		if (index === -1) continue;
		const rest = key.slice(index + marker.length);
		const digest = rest.split(":")[0];
		digests.add(/^[0-9a-f]{64}$/.test(digest) ? digest : "<corrupt>");
	}
	return [...digests];
}

function gateReplayMismatch(mission, userCallId, digest) {
	if (userCallId === undefined) return undefined;
	if (!isPlainObject(mission?.receipts)) {
		return failure(":CALL_REPLAY_MISMATCH", "mission receipt map is missing; cannot verify call-id identity", {
			"call-id": userCallId,
			reason: "receipt-map-missing",
		});
	}
	const recorded = recordedGateDigests(mission, userCallId);
	if (recorded.length === 0) return undefined;
	if (recorded.length === 1 && recorded[0] === digest) return undefined;
	const error = replayMismatch(userCallId, recorded[0] ?? null, digest);
	if (recorded.length > 1) error.error.data.recorded = recorded;
	return error;
}

function normalizeCallId(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const text = value.trim();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: call ids reject control characters.
	if (text.length === 0 || text.length > MAX_CALL_ID || /[\u0000-\u001f]/.test(text)) return null;
	return text;
}

function derivedCallId(callId, suffix) {
	if (callId === undefined) return undefined;
	const text = `${callId}:${suffix}`;
	return text.length <= 256 ? text : sha256(text);
}

function ensureColon(code) {
	if (typeof code !== "string" || code.length === 0) return ":INVALID_ARGUMENT";
	return code.startsWith(":") ? code : `:${code}`;
}

function normalizeStage(value) {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/^:/, "").toLowerCase();
	return ["s1", "s2", "s3", "s4", "s5", "completed"].includes(text) ? text : undefined;
}

function isLaterStage(current, boundary) {
	return (STAGE_ORDER[current] ?? 0) > (STAGE_ORDER[boundary] ?? 0);
}

function validSlug(value) {
	return typeof value === "string" && SLUG_RE.test(value);
}

function slugFailure(slug) {
	if (validSlug(slug)) return undefined;
	return failure(":INVALID_ARGUMENT", "slug must be 1-64 lowercase letters, digits, or hyphens", {
		field: "slug",
	});
}

function missingSessionSlug(tool) {
	return failure(
		":STAGE_MISMATCH",
		"the session mission focus is not bound; the framework must supply the mission slug",
		{
			field: "slug",
			reason: "session-slug-missing",
			tool,
			next: "bind this subagent to its parent mission; do not retry with a guessed slug and do not use yield",
		},
	);
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function failure(code, message, data = {}) {
	return {
		ok: false,
		error: {
			code: ensureColon(code),
			message: message === undefined || message === null ? "" : String(message),
			data: isPlainObject(data) ? data : {},
		},
	};
}

function normalizeError(error, fallbackCode = ":INVALID_ARGUMENT") {
	if (typeof error === "string") {
		return { code: fallbackCode, message: error, data: {} };
	}
	const code = typeof error?.code === "string" ? ensureColon(error.code) : fallbackCode;
	const message =
		typeof error?.message === "string" ? error.message : error instanceof Error ? error.message : String(error ?? "");
	const data = isPlainObject(error?.data) ? error.data : {};
	return { code, message, data };
}

function herdLikeError(error, fallbackCode = ":INVALID_ARGUMENT") {
	if (isHerdError(error)) return { code: error.code, message: error.message, data: error.data ?? {} };
	const normalized = normalizeError(error, fallbackCode);
	if (!error?.code && error instanceof Error) normalized.data = {};
	return normalized;
}

function normalizePortResult(value, fallbackCode, fallbackMessage) {
	if (value && value.ok === true) return value;
	if (value && value.ok === false && value.error) {
		return failure(value.error.code, value.error.message, value.error.data);
	}
	return failure(fallbackCode, fallbackMessage, { reason: "port-protocol" });
}

async function invokePort(fn, args, fallbackCode, fallbackMessage) {
	if (typeof fn !== "function") {
		return failure(":HOST_API_MISMATCH", fallbackMessage, { reason: "port-missing" });
	}
	try {
		return normalizePortResult(await fn(args), fallbackCode, fallbackMessage);
	} catch (error) {
		return { ok: false, error: herdLikeError(error, fallbackCode) };
	}
}

function validationFailure(stage, errors) {
	return failure(":INVALID_ARGUMENT", `${stage} validation failed`, { stage, errors });
}

function replayMismatch(callId, expected, actual) {
	return failure(":CALL_REPLAY_MISMATCH", "call-id was already used with a different payload", {
		"call-id": callId ?? null,
		expected,
		actual,
	});
}

function roleFailure(role, allowed) {
	return failure(":CAPABILITY_DENIED", "the current role may not call this tool", {
		role: role ?? null,
		allowed,
	});
}

function roleAllowed(options, allowed) {
	const role = options.role;
	if (role === undefined || role === null) return undefined;
	return allowed.includes(role) ? undefined : roleFailure(role, allowed);
}

// ---------------------------------------------------------------------------
// Port access
// ---------------------------------------------------------------------------

function contractOptions(deps) {
	return isPlainObject(deps.contractOptions) ? deps.contractOptions : {};
}

const DISK_DOCUMENTS = Object.freeze({
	async readText(path) {
		try {
			return { ok: true, text: readFileSync(path, "utf8") };
		} catch (error) {
			return { ok: false, code: error?.code ?? "EIO", message: error?.message ?? String(error) };
		}
	},
});

function documentsPort(deps) {
	if (deps.documents !== undefined) {
		return typeof deps.documents?.readText === "function" ? deps.documents : null;
	}
	const options = contractOptions(deps);
	if (options.documents !== undefined) {
		return typeof options.documents?.readText === "function" ? options.documents : null;
	}
	return DISK_DOCUMENTS;
}

function requireContract(deps) {
	const contract = deps.contract;
	if (contract === null || (typeof contract !== "object" && typeof contract !== "function")) {
		throw new TypeError("gate-tools: contract port is required");
	}
	for (const method of ["readMission", "saveStageDocument", "freezeStage", "readPendingGate", "writePendingGate"]) {
		if (typeof contract[method] !== "function") {
			throw new TypeError(`gate-tools: contract.${method}() is required`);
		}
	}
	return contract;
}

async function readMissionOrError(deps, root, slug) {
	let read;
	try {
		read = await deps.contract.readMission(root, slug, contractOptions(deps));
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":STAGE_MISMATCH") };
	}
	if (read?.ok !== true) {
		return normalizePortResult(read, ":STAGE_MISMATCH", "readMission returned no result");
	}
	if (read.mission === null || read.mission === undefined) {
		return failure(":STAGE_MISMATCH", `mission not found: ${slug}`, { slug, reason: "mission-missing" });
	}
	if (read.valid === false) {
		return { ok: false, error: normalizeError(read.error, ":STAGE_MISMATCH") };
	}
	return read;
}

async function readPending(deps, root, slug) {
	let read;
	try {
		read = await deps.contract.readPendingGate(root, slug, contractOptions(deps));
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	if (read?.ok !== true) {
		return normalizePortResult(read, ":INVALID_ARGUMENT", "readPendingGate returned no result");
	}
	return { ok: true, pending: read.pending ?? null };
}

async function writePending(deps, root, slug, pending) {
	let written;
	try {
		written = await deps.contract.writePendingGate(root, slug, pending, contractOptions(deps));
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	if (written?.ok !== true) {
		return normalizePortResult(written, ":INVALID_ARGUMENT", "writePendingGate returned no result");
	}
	return { ok: true, pending: written.pending ?? pending };
}

async function saveDocument(deps, root, slug, stage, markdown, options) {
	let saved;
	try {
		saved = await deps.contract.saveStageDocument(root, slug, stage, markdown, {
			...contractOptions(deps),
			...options,
		});
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	return normalizePortResult(saved, ":INVALID_ARGUMENT", "saveStageDocument returned no result");
}


// ---------------------------------------------------------------------------
// Tenure review and attach
// ---------------------------------------------------------------------------

function attachStageOf(tool) {
	return Object.hasOwn(STAGE_ATTACH_TOOLS, tool) ? STAGE_ATTACH_TOOLS[tool] : null;
}

function tenureStore(deps) {
	return isPlainObject(deps.tenure) ? deps.tenure : tenure;
}

async function readAttachBoard(deps, root, slug) {
	const contract = deps.contract;
	if (typeof contract?.readBoard !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.readBoard is not available", {
			reason: "port-missing",
			port: "readBoard",
		});
	}
	let read;
	try {
		read = await contract.readBoard(root, slug, contractOptions(deps));
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":BOARD_CONFLICT") };
	}
	const normalized = normalizePortResult(read, ":BOARD_CONFLICT", "readBoard returned no result");
	if (!normalized.ok) return normalized;
	const board = normalized.board ?? read?.board;
	if (!isPlainObject(board) || !isPlainObject(board.tasks)) {
		return failure(":BOARD_CONFLICT", "board.edn has no tasks map", { slug });
	}
	return {
		ok: true,
		board,
		pendingAttach: normalized.pendingAttach ?? normalized["pending-attach"] ?? null,
	};
}

async function writeAttachBoard(deps, root, slug, board, options = {}) {
	const contract = deps.contract;
	if (typeof contract?.writeBoard !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.writeBoard is not available", {
			reason: "port-missing",
			port: "writeBoard",
		});
	}
	let written;
	try {
		written = await contract.writeBoard(root, slug, board, { ...contractOptions(deps), ...options });
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":BOARD_CONFLICT") };
	}
	const normalized = normalizePortResult(written, ":BOARD_CONFLICT", "writeBoard returned no result");
	if (!normalized.ok) return normalized;
	return { ok: true, board: normalized.board ?? board, path: normalized.path ?? null };
}

async function archiveAttachBoard(deps, root, slug, board, options = {}) {
	const contract = deps.contract;
	if (typeof contract?.archiveBoard !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.archiveBoard is not available", {
			reason: "port-missing",
			port: "archiveBoard",
		});
	}
	let archived;
	try {
		archived = await contract.archiveBoard(root, slug, board, { ...contractOptions(deps), ...options });
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":BOARD_CONFLICT") };
	}
	const normalized = normalizePortResult(archived, ":BOARD_CONFLICT", "archiveBoard returned no result");
	if (!normalized.ok) return normalized;
	return { ok: true, path: normalized.path ?? null };
}

async function advanceAttachTenure(deps, ctx) {
	const contract = deps.contract;
	if (typeof contract?.advanceTenure !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.advanceTenure is not available", {
			reason: "port-missing",
			port: "advanceTenure",
			stage: ctx.stage,
		});
	}
	let advanced;
	try {
		advanced = await contract.advanceTenure(
			ctx.root,
			ctx.slug,
			{
				stage: ctx.stage,
				tool: ctx.tool,
				board: ctx.board,
				barrier: ctx.barrier,
				successor: ctx.successor,
				markdown: ctx.markdown,
				cases: ctx.payload?.cases ?? null,
				promela: ctx.payload?.promela ?? null,
				call_id: ctx.callId,
				digest: ctx.digest,
			},
			contractOptions(deps),
		);
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":STAGE_MISMATCH") };
	}
	const normalized = normalizePortResult(advanced, ":STAGE_MISMATCH", "advanceTenure returned no result");
	if (!normalized.ok) return normalized;
	return {
		ok: true,
		stage: normalized.stage ?? ctx.successor?.stage ?? null,
		successor: normalized.successor ?? ctx.successor ?? null,
		attached: normalized.attached ?? null,
	};
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function normalizeReviewFindings(findings) {
	if (!Array.isArray(findings)) {
		return { ok: false, message: "findings must be an array" };
	}
	const normalized = [];
	for (let index = 0; index < findings.length; index += 1) {
		const finding = findings[index];
		if (!isPlainObject(finding)) {
			return { ok: false, message: "findings[" + index + "] must be an object" };
		}
		if (!isSpecificText(finding.key)) {
			return { ok: false, message: "findings[" + index + "].key must be a non-empty string" };
		}
		const value = finding.value;
		if (value !== null && value !== undefined && !isSpecificText(value)) {
			return { ok: false, message: "findings[" + index + "].value must be a non-empty string or nil" };
		}
		normalized.push({ key: finding.key.trim(), value: value ?? null });
	}
	return { ok: true, findings: normalized };
}

async function review(deps, params = {}, options = {}) {
	const denied = roleAllowed(options, REVIEW_ROLES);
	if (denied) return denied;
	const slug = options.slug;
	if (!validSlug(slug)) return missingSessionSlug("review");
	const summary = params.summary_markdown;
	if (summary !== undefined && summary !== null && !isSpecificText(summary)) {
		return failure(":INVALID_ARGUMENT", "summary_markdown must be a non-empty, specific string", {
			field: "summary_markdown",
		});
	}
	const findings = normalizeReviewFindings(params.findings ?? []);
	if (!findings.ok) {
		return failure(":INVALID_ARGUMENT", findings.message, { field: "findings" });
	}
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const mission = read.mission;
	const stage = normalizeStage(mission.stage);
	if (stage === "s5") {
		return reviewSwarm(deps, { slug, stage, summary, findings: findings.findings, options });
	}
	if (!Object.hasOwn(STAGE_ATTACH_TOOLS, stage)) {
		return failure(":STAGE_MISMATCH", "review is available only during an active tenure", { stage });
	}
	const boardRead = await readAttachBoard(deps, options.root, slug);
	if (!boardRead.ok) return boardRead;
	const applied = tenureStore(deps).applyReview(boardRead.board, {
		summary_markdown: summary,
		findings: findings.findings,
		stage,
	});
	if (!applied.ok) return { ok: false, error: applied.error };
	const written = await writeAttachBoard(deps, options.root, slug, applied.board, {
		callId: options.callId,
	});
	if (!written.ok) return written;
	return {
		ok: true,
		status: applied.status,
		stage,
		slug,
		board: written.board,
		openTasks: applied.openTasks,
		attachReady: applied.attachReady,
		expectedAttach: applied.expectedAttach,
		findings: findings.findings.length,
		suppressNudge: true,
	};
}

async function reviewSwarm(deps, { slug, stage, summary, findings, options }) {
	if (!isSpecificText(summary)) {
		return failure(":INVALID_ARGUMENT", "summary_markdown is required in S5", {
			field: "summary_markdown",
		});
	}
	if (typeof deps.runner?.submitReview !== "function") {
		return failure(":HOST_API_MISMATCH", "runner.submitReview is not available", {
			reason: "port-missing",
		});
	}
	try {
		const result = await deps.runner.submitReview({
			root: options.root,
			slug,
			summary_markdown: summary,
			findings,
			slice_id: null,
			tenure_id: null,
			request_id: options.callId ?? null,
		});
		const normalized = normalizePortResult(
			result,
			":RESOURCES_NOT_QUIESCENT",
			"submitReview returned no result",
		);
		if (!normalized.ok) return normalized;
		return {
			...normalized,
			ok: true,
			status: findings.length === 0 ? "review-quiescent" : "review-open",
			slug,
			stage,
			findings: findings.length,
			attachReady: null,
			expectedAttach: null,
		};
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":RESOURCES_NOT_QUIESCENT") };
	}
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

function normalizeAttachCases(cases) {
	if (!Array.isArray(cases) || cases.length === 0) {
		return { ok: false, message: "cases must be a non-empty array" };
	}
	const normalized = [];
	for (let index = 0; index < cases.length; index += 1) {
		const entry = cases[index];
		if (!isPlainObject(entry)) {
			return { ok: false, message: "cases[" + index + "] must be an object" };
		}
		for (const field of ["case_id", "path", "expected", "rubric"]) {
			if (!isSpecificText(entry[field])) {
				return { ok: false, message: "cases[" + index + "]." + field + " must be a non-empty string" };
			}
		}
		if (
			!Array.isArray(entry.steps) ||
			entry.steps.length === 0 ||
			!entry.steps.every((step) => isSpecificText(step))
		) {
			return { ok: false, message: "cases[" + index + "].steps must be a non-empty array of strings" };
		}
		if (typeof entry.threshold !== "number" || !Number.isFinite(entry.threshold)) {
			return { ok: false, message: "cases[" + index + "].threshold must be a number" };
		}
		normalized.push({
			case_id: entry.case_id.trim(),
			path: entry.path.trim(),
			threshold: entry.threshold,
			steps: entry.steps.map((step) => step.trim()),
			expected: entry.expected.trim(),
			rubric: entry.rubric.trim(),
		});
	}
	return { ok: true, cases: normalized };
}

function attachPayload(tool, params) {
	if (tool === "attach_manual_tests") {
		const cases = normalizeAttachCases(params.cases);
		if (!cases.ok) return failure(":INVALID_ARGUMENT", cases.message, { field: "cases" });
		return { ok: true, cases: cases.cases, digest: { cases: cases.cases } };
	}
	if (tool === "attach_coordination") {
		const promela = params.promela;
		if (!isSpecificText(promela)) {
			return failure(":INVALID_ARGUMENT", "promela must be a non-empty, specific string", {
				field: "promela",
			});
		}
		return { ok: true, promela, digest: { promela } };
	}
	return { ok: true, digest: {} };
}

function confirmDecision(value) {
	if (typeof value === "string") return { decision: value };
	if (!isPlainObject(value)) return { decision: "pending", reason: "host-confirm-protocol" };
	if (value.ok === false) return { decision: "error", error: normalizeError(value.error, ":HOST_API_MISMATCH") };
	const decision = typeof value.decision === "string" ? value.decision : undefined;
	if (decision === "approve" || decision === "revise" || decision === "pending") {
		return {
			decision,
			feedback: typeof value.feedback === "string" ? value.feedback : undefined,
			diskDiff: value.diskDiff ?? value.disk_diff ?? undefined,
		};
	}
	return { decision: "pending", reason: value.reason ?? "host-confirm-protocol" };
}

async function askApproval(deps, args) {
	const host = deps.host;
	if (!host || typeof host.confirm !== "function") {
		return { decision: "pending", reason: "host-confirm-unavailable" };
	}
	try {
		return confirmDecision(await host.confirm(args));
	} catch (error) {
		return { decision: "error", error: herdLikeError(error, ":HOST_API_MISMATCH") };
	}
}

async function resumeApproval(deps, args) {
	const host = deps.host;
	if (!host || typeof host.resumeApproval !== "function") {
		return {
			decision: "error",
			error: normalizeError("host.resumeApproval is not available", ":HOST_API_MISMATCH"),
		};
	}
	try {
		return confirmDecision(await host.resumeApproval(args));
	} catch (error) {
		return { decision: "error", error: herdLikeError(error, ":HOST_API_MISMATCH") };
	}
}

function awaitingAttach(pending, reason) {
	return {
		ok: true,
		status: "awaiting-user",
		stage: "s1",
		slug: pending.slug ?? null,
		sha256: pending.sha256 ?? null,
		reason: reason ?? "host-pending",
		suppressNudge: true,
		message: "S1 is saved. Wait for explicit human approval or a revision request.",
	};
}

async function attachStage(deps, tool, params = {}, options = {}) {
	const denied = roleAllowed(options, ATTACH_ROLES);
	if (denied) return denied;
	const stage = attachStageOf(tool);
	if (stage === null) return failure(":INVALID_ARGUMENT", "unknown attach tool", { tool });
	const root = options.root;
	const slug = params.slug ?? options.slug;
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	const markdown = params.markdown;
	if (!isSpecificText(markdown)) {
		return failure(":INVALID_ARGUMENT", "markdown must be a non-empty, specific string", {
			field: "markdown",
		});
	}
	const payload = attachPayload(tool, params);
	if (!payload.ok) return payload;
	const read = await readMissionOrError(deps, root, slug);
	if (!read.ok) return read;
	const mission = read.mission;
	const pendingRead = await readPending(deps, root, slug);
	if (!pendingRead.ok) return pendingRead;
	if (isPlainObject(pendingRead.pending)) {
		return failure(":ATTACH_IN_PROGRESS", "an S1 attach is already waiting for human approval", {
			stage: normalizeStage(pendingRead.pending.stage) ?? null,
		});
	}
	const boardRead = await readAttachBoard(deps, root, slug);
	if (!boardRead.ok) return boardRead;
	if (isPlainObject(boardRead.pendingAttach)) {
		return failure(":ATTACH_IN_PROGRESS", "this tenure already has a pending attach", {
			tool: boardRead.pendingAttach.tool ?? null,
		});
	}
	const gate = tenureStore(deps).evaluateAttach({ mission, board: boardRead.board, tool, stage });
	if (!gate.ok) return { ok: false, error: gate.error };
	const digest = callPayloadDigest(tool, { slug, stage, markdown, ...payload.digest });
	const callId = effectiveGateCallId(options.callId, digest);
	const barrier = tenureStore(deps).buildBarrier({
		mission,
		board: boardRead.board,
		tool,
		stage,
		now: now(deps),
	});
	const successor = tenureStore(deps).buildSuccessorMission({
		mission,
		tool,
		stage,
		now: now(deps),
	});
	const ctx = {
		root,
		slug,
		stage,
		tool,
		board: boardRead.board,
		barrier,
		successor,
		markdown,
		callId,
		digest,
		payload,
		mission,
		signal: options.signal,
	};
	if (stage === "s1") {
		const saved = await saveDocument(deps, root, slug, "s1", markdown, {
			callId: derivedCallId(callId, "attach"),
		});
		if (!saved.ok) return saved;
		return requestS1Approval(deps, { ...ctx, saved });
	}
	return completeAttach(deps, ctx);
}

async function requestS1Approval(deps, ctx) {
	const pending = {
		slug: ctx.slug,
		stage: "s1",
		tool: "attach_brainstorm",
		callId: ctx.callId,
		digest: ctx.digest,
		markdown: ctx.markdown,
		path: ctx.saved.path ?? null,
		sha256: ctx.saved.sha256 ?? null,
		revision: ctx.saved.revision ?? null,
	};
	const written = await writePending(deps, ctx.root, ctx.slug, pending);
	if (!written.ok) return written;
	const decision = await askApproval(deps, {
		root: ctx.root,
		slug: ctx.slug,
		pending,
		markdown: ctx.markdown,
		signal: ctx.signal,
	});
	return applyAttachDecision(deps, { ...ctx, pending, decision });
}

async function applyAttachDecision(deps, ctx) {
	const decision = ctx.decision;
	if (decision.decision === "pending") return awaitingAttach(ctx.pending, decision.reason);
	if (decision.decision === "revise") {
		const revised = { ...ctx.board, "attach-ready": false };
		const written = await writeAttachBoard(deps, ctx.root, ctx.slug, revised, {
			callId: derivedCallId(ctx.callId, "revise"),
		});
		if (!written.ok) return written;
		const cleared = await writePending(deps, ctx.root, ctx.slug, null);
		if (!cleared.ok) return cleared;
		return {
			ok: true,
			status: "revision-requested",
			stage: "s1",
			slug: ctx.slug,
			sha256: ctx.saved?.sha256 ?? null,
			feedback: decision.feedback ?? "",
			diskDiff: decision.diskDiff ?? null,
			suppressNudge: false,
		};
	}
	if (decision.decision === "error") {
		return {
			ok: false,
			error: decision.error ?? normalizeError("confirmation host failed", ":HOST_API_MISMATCH"),
		};
	}
	if (decision.decision !== "approve") {
		return failure(":HOST_API_MISMATCH", "the confirmation host returned no usable decision", {
			reason: decision.reason ?? "host-confirm-protocol",
			callId: ctx.callId ?? null,
		});
	}
	const cleared = await writePending(deps, ctx.root, ctx.slug, null);
	if (!cleared.ok) return cleared;
	return completeAttach(deps, ctx);
}

async function announceSuccessor(deps, args) {
	if (!deps.host || typeof deps.host.onStageChange !== "function") return undefined;
	try {
		const result = await deps.host.onStageChange(args);
		if (result && result.ok === false) {
			return { ok: false, error: normalizeError(result.error, ":HOST_API_MISMATCH") };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":HOST_API_MISMATCH") };
	}
}

async function completeAttach(deps, ctx) {
	const archived = await archiveAttachBoard(deps, ctx.root, ctx.slug, ctx.board, {
		callId: derivedCallId(ctx.callId, "archive"),
	});
	if (!archived.ok) return archived;
	const advanced = await advanceAttachTenure(deps, ctx);
	if (!advanced.ok) return advanced;
	const nextStage = advanced.stage ?? ctx.successor?.stage ?? null;
	const briefing = nextStage === null ? null : currentBriefing(nextStage);
	const wiring = await announceSuccessor(deps, {
		root: ctx.root,
		slug: ctx.slug,
		previousStage: ctx.stage,
		stage: nextStage,
		nextStage,
		briefing: typeof briefing === "string" ? briefing : null,
		successor: advanced.successor,
	});
	return {
		ok: true,
		status: "attached",
		stage: ctx.stage,
		slug: ctx.slug,
		tool: ctx.tool,
		attached: advanced.attached ?? null,
		barrier: ctx.barrier,
		archive: archived.path ?? tenure.archiveBoardPath(ctx.board["tenure-id"]),
		successor: advanced.successor,
		nextStage,
		disclosedStage: nextStage,
		briefing: typeof briefing === "string" ? briefing : null,
		wiring,
		suppressNudge: false,
	};
}

async function resumeS1(deps, root, slug, message) {
	const pendingRead = await readPending(deps, root, slug);
	if (!pendingRead.ok) return pendingRead;
	const pending = pendingRead.pending;
	if (!isPlainObject(pending) || pending.tool !== "attach_brainstorm") {
		return failure(":STAGE_MISMATCH", "no S1 attach is waiting for approval", {
			slug,
			reason: "no-pending-attach",
		});
	}
	if (normalizeStage(pending.stage) !== "s1") {
		return failure(":STAGE_MISMATCH", "the pending attach is not an S1 attach", {
			stage: pending.stage ?? null,
		});
	}
	const decision = await resumeApproval(deps, {
		root,
		slug,
		pending,
		markdown: pending.markdown,
		message,
	});
	const read = await readMissionOrError(deps, root, slug);
	if (!read.ok) return read;
	const boardRead = await readAttachBoard(deps, root, slug);
	if (!boardRead.ok) return boardRead;
	const barrier = tenureStore(deps).buildBarrier({
		mission: read.mission,
		board: boardRead.board,
		tool: "attach_brainstorm",
		stage: "s1",
		now: now(deps),
	});
	const successor = tenureStore(deps).buildSuccessorMission({
		mission: read.mission,
		tool: "attach_brainstorm",
		stage: "s1",
		now: now(deps),
	});
	return applyAttachDecision(deps, {
		root,
		slug,
		stage: "s1",
		tool: "attach_brainstorm",
		board: boardRead.board,
		barrier,
		successor,
		markdown: pending.markdown,
		callId: pending.callId,
		digest: pending.digest,
		payload: { ok: true, digest: {} },
		saved: pending,
		mission: read.mission,
		pending,
		decision,
	});
}

async function askUser(deps, params = {}, options = {}) {
	const slug = params.slug ?? options.slug;
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	const question = params.question;
	if (!isSpecificText(question)) {
		return failure(":INVALID_ARGUMENT", "question must be a non-empty, specific string", { field: "question" });
	}
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const stage = normalizeStage(read.mission.stage);
	let context = params.context;
	let recommendedDefault = params.recommended_default;
	if (stage === "s5") {
		const check = await invokePort(
			deps.runner?.assertInitialEmptyLedger,
			{ root: options.root, slug },
			":ASK_FORBIDDEN_OUTSIDE_S1",
			"the S5 initial-empty-ledger exception needs runner.assertInitialEmptyLedger()",
		);
		if (!check.ok) {
			return failure(
				":ASK_FORBIDDEN_OUTSIDE_S1",
				"ask_user is allowed only in S1 or the one-time S5 empty-ledger exception",
				{ stage, reason: check.error?.code ?? "ledger-check-failed" },
			);
		}
		context = isText(context) ? context : "";
		recommendedDefault = isText(recommendedDefault) ? recommendedDefault : "";
	} else if (stage !== "s1") {
		return failure(
			":ASK_FORBIDDEN_OUTSIDE_S1",
			"ask_user is allowed only in S1 or the one-time S5 empty-ledger exception",
			{ stage },
		);
	} else {
		if (!isSpecificText(context)) {
			return failure(":INVALID_ARGUMENT", "context must be a non-empty, specific string", { field: "context" });
		}
		if (!isSpecificText(recommendedDefault)) {
			return failure(":INVALID_ARGUMENT", "recommended_default must be a non-empty, specific string", {
				field: "recommended_default",
			});
		}
	}
	const receipt = {
		ok: true,
		status: "awaiting-user",
		stage,
		question,
		context,
		recommendedDefault,
		suppressNudge: true,
	};
	if (!deps.host || typeof deps.host.askUser !== "function") return receipt;
	try {
		const answer = await deps.host.askUser({
			root: options.root,
			slug,
			question,
			context,
			recommended_default: recommendedDefault,
		});
		if (answer && answer.ok === true && isText(answer.answer)) {
			return { ok: true, status: "answered", stage, question, answer: answer.answer };
		}
		if (answer && answer.ok === false) {
			return { ok: false, error: normalizeError(answer.error, ":HOST_API_MISMATCH") };
		}
		return receipt;
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":HOST_API_MISMATCH") };
	}
}

async function devops(deps, params = {}, options = {}) {
	const invalidSlug = slugFailure(params.slug);
	if (invalidSlug) return invalidSlug;
	const intent = params.verbose_intent;
	if (!isSpecificText(intent)) {
		return failure(":INVALID_ARGUMENT", "verbose_intent must be a non-empty, specific string", {
			field: "verbose_intent",
		});
	}
	const read = await readMissionOrError(deps, options.root, params.slug);
	if (!read.ok) return read;
	const stage = normalizeStage(read.mission.stage);
	if (stage !== "s1" && stage !== "s2" && stage !== "s3" && stage !== "s4") {
		return failure(":STAGE_MISMATCH", "devops is available only in S1-S4", { stage });
	}
	if (!deps.host || typeof deps.host.runDevops !== "function") {
		return failure(":HOST_API_MISMATCH", "host.runDevops is not available", { reason: "port-missing" });
	}
	try {
		const result = await deps.host.runDevops({
			root: options.root,
			slug: params.slug,
			intent,
			verbose_intent: intent,
			stage,
			signal: options.signal,
		});
		const normalized = normalizePortResult(result, ":HOST_API_MISMATCH", "runDevops returned no result");
		if (!normalized.ok) return normalized;
		return {
			ok: true,
			status: normalized.status ?? "devops-report",
			stage,
			agentId: normalized.agentId ?? null,
			report: normalized.report ?? null,
		};
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":HOST_API_MISMATCH") };
	}
}

async function submitDevopsReport(deps, params = {}, options = {}) {
	const denied = roleAllowed(options, ["Plan DevOps"]);
	if (denied) return denied;
	const slug = options.slug;
	if (!validSlug(slug)) return missingSessionSlug("submit_devops_report");
	const status = params.status;
	const reportMarkdown = params.report_markdown;
	const inspectedPaths = params.inspected_paths;
	if (!isSpecificText(status)) {
		return failure(":INVALID_ARGUMENT", "status must be a non-empty string", { field: "status" });
	}
	if (!isSpecificText(reportMarkdown)) {
		return failure(":INVALID_ARGUMENT", "report_markdown must be a non-empty, specific string", {
			field: "report_markdown",
		});
	}
	if (!Array.isArray(inspectedPaths) || inspectedPaths.length === 0 || !inspectedPaths.every(isText)) {
		return failure(":INVALID_ARGUMENT", "inspected_paths must be a non-empty array of paths", {
			field: "inspected_paths",
		});
	}
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const stage = normalizeStage(read.mission.stage);
	if (stage !== "s1" && stage !== "s2" && stage !== "s3" && stage !== "s4") {
		return failure(":STAGE_MISMATCH", "devops reports are accepted only in S1-S4", { stage });
	}
	const report = {
		status: status.trim(),
		report_markdown: reportMarkdown,
		inspected_paths: inspectedPaths.map((path) => path.trim()),
	};
	if (deps.host && typeof deps.host.acceptDevopsReport === "function") {
		try {
			const accepted = await deps.host.acceptDevopsReport({ root: options.root, slug, report });
			if (accepted && accepted.ok === false) {
				return { ok: false, error: normalizeError(accepted.error, ":INVALID_ARGUMENT") };
			}
		} catch (error) {
			return { ok: false, error: herdLikeError(error, ":HOST_API_MISMATCH") };
		}
	}
	return { ok: true, status: "devops-report-submitted", slug, stage, report };
}


// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function requireAttachContract(deps) {
	const contract = deps.contract;
	if (contract === null || (typeof contract !== "object" && typeof contract !== "function")) {
		throw new TypeError("gate-tools: contract port is required");
	}
	for (const method of ["readMission", "saveStageDocument", "readPendingGate", "writePendingGate"]) {
		if (typeof contract[method] !== "function") {
			throw new TypeError("gate-tools: contract." + method + "() is required");
		}
	}
	return contract;
}

/**
 * Build the gate service from injected ports.
 *
 * `deps.contract` is required. `deps.host`, `deps.runner`, `deps.root`,
 * `deps.now`, and `deps.contractOptions` are optional. A missing optional
 * port fails only the tool that needs it.
 */
export function createGateService(deps) {
	const settings = settingsOf(deps);
	requireAttachContract(settings);
	const service = {
		review: (params, options = {}) =>
			review(settings, params, { ...options, root: options.root ?? settings.root }),
		attachBrainstorm: (params, options = {}) =>
			attachStage(settings, "attach_brainstorm", params, {
				...options,
				root: options.root ?? settings.root,
			}),
		attachManualTests: (params, options = {}) =>
			attachStage(settings, "attach_manual_tests", params, {
				...options,
				root: options.root ?? settings.root,
			}),
		attachDevGuide: (params, options = {}) =>
			attachStage(settings, "attach_dev_guide", params, {
				...options,
				root: options.root ?? settings.root,
			}),
		attachCoordination: (params, options = {}) =>
			attachStage(settings, "attach_coordination", params, {
				...options,
				root: options.root ?? settings.root,
			}),
		askUser: (params, options = {}) =>
			askUser(settings, params, { ...options, root: options.root ?? settings.root }),
		devops: (params, options = {}) =>
			devops(settings, params, { ...options, root: options.root ?? settings.root }),
		submitDevopsReport: (params, options = {}) =>
			submitDevopsReport(settings, params, { ...options, root: options.root ?? settings.root }),
		resumePendingApproval: (root, slug, message) =>
			resumeS1(settings, root ?? settings.root, slug, message),
		currentBriefing,
	};
	return Object.freeze(service);
}

/**
 * Resume an asynchronous S1 approval after the human's next message.
 *
 * The fourth argument carries the injected ports; without it the call fails
 * because this module imports no default contract or host.
 */
export function resumePendingApproval(root, slug, message, deps) {
	return createGateService(deps).resumePendingApproval(root, slug, message);
}

// ---------------------------------------------------------------------------
// Host registration
// ---------------------------------------------------------------------------

function schemaFor(pi) {
	const { Type } = pi.typebox;
	if (!Type) throw new TypeError("gate-tools: pi.typebox.Type is required");
	const gated = (properties, options = { additionalProperties: false }) =>
		gatedObject(Type, properties, options);
	const slug = Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
		description: "Mission slug.",
	});
	const caseShape = Type.Object(
		{
			case_id: Type.String({ minLength: 1 }),
			path: Type.String({ minLength: 1 }),
			threshold: Type.Number({ minimum: 0, maximum: 100 }),
			steps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			expected: Type.String({ minLength: 1 }),
			rubric: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	);
	const finding = Type.Object(
		{
			key: Type.String({ minLength: 1 }),
			value: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		},
		{ additionalProperties: false },
	);
	return {
		slug,
		review: gated(
			{
				summary_markdown: Type.Optional(
					Type.String({ minLength: 1, description: "Review summary for the ledger." }),
				),
				findings: Type.Optional(
					Type.Array(finding, {
						default: [],
						description: "String upserts, nil deletes, [] leaves the task unchanged.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		attachBrainstorm: gated({
			slug: Type.Optional(slug),
			markdown: Type.String({ minLength: 1, description: "Complete s1-brainstorm.md." }),
		}),
		attachManualTests: gated({
			slug: Type.Optional(slug),
			markdown: Type.String({ minLength: 1, description: "Complete s2-manual-tests.md." }),
			cases: Type.Array(caseShape, { minItems: 1 }),
		}),
		attachDevGuide: gated({
			slug: Type.Optional(slug),
			markdown: Type.String({ minLength: 1, description: "Complete s3-dev-guide.md." }),
		}),
		attachCoordination: gated({
			slug: Type.Optional(slug),
			markdown: Type.String({ minLength: 1, description: "Complete s4-coordination.md." }),
			promela: Type.String({
				minLength: 1,
				description: "Promela model. Stored verbatim; never parsed or checked.",
			}),
		}),
		askUser: gated(
			{
				slug,
				question: Type.String({ minLength: 1 }),
				context: Type.Optional(Type.String({ minLength: 1 })),
				recommended_default: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		devops: gated(
			{
				slug,
				verbose_intent: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		submitDevopsReport: gated(
			{
				status: Type.String({ minLength: 1 }),
				report_markdown: Type.String({ minLength: 1 }),
				inspected_paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			},
			{ additionalProperties: false },
		),
	};
}

function toolResult(result) {
	if (result && result.ok === true) {
		let text;
		try {
			text = printEdn(result);
		} catch (error) {
			return toolFailure({
				ok: false,
				error: normalizeError(error, ":INVALID_ARGUMENT"),
			});
		}
		return {
			content: [{ type: "text", text }],
			details: {
				ok: true,
				status: result.status ?? null,
				stage: result.stage ?? null,
				suppressNudge: result.suppressNudge === true,
				forkFailed: result.fork?.ok === false,
				warning: result.warning ?? null,
			},
		};
	}
	return toolFailure(result);
}

function toolFailure(result) {
	const error = normalizeError(result?.error, ":INVALID_ARGUMENT");
	let rendered;
	try {
		rendered = renderError(herdError(error.code, error.message, error.data));
	} catch {
		rendered = renderError(herdError("INVALID_ARGUMENT", error.message, { code: error.code }));
	}
	return {
		isError: true,
		content: [{ type: "text", text: rendered }],
		details: { ok: false, code: error.code },
	};
}

function roleOfContext(deps, ctx) {
	if (typeof deps.roleOf !== "function") return undefined;
	try {
		return deps.roleOf(ctx);
	} catch {
		return "<unresolved>";
	}
}

function slugOfContext(deps, ctx) {
	if (typeof deps.slugOf === "function") {
		try {
			const slug = deps.slugOf(ctx);
			return isText(slug) ? slug.trim() : undefined;
		} catch {
			return undefined;
		}
	}
	return isText(deps.slug) ? deps.slug.trim() : undefined;
}

function rootOf(deps, ctx) {
	if (isText(deps.root)) return deps.root;
	if (isText(ctx?.cwd)) return ctx.cwd;
	return undefined;
}

/**
 * Register the review and attach tools on the host extension API.
 *
 * `pi.typebox`, `pi.registerTool`, and `deps.contract` are required. The
 * returned gate service is frozen. Every tool's `execute` returns the host's
 * content-block shape; a rejected call is `isError: true` and its text is EDN.
 */
export function registerGateTools(pi, deps) {
	if (!pi || typeof pi.registerTool !== "function") {
		throw new TypeError("gate-tools: pi.registerTool is required");
	}
	const service = createGateService(deps);
	const schemas = schemaFor(pi);

	const execute = (name, parameters, description, call) => {
		pi.registerTool({
			name,
			label: TOOL_LABELS[name] ?? name,
			description,
			loadMode: "essential",
			parameters,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const root = rootOf(deps, ctx);
				if (!root) {
					return toolResult(
						failure(":INVALID_ARGUMENT", "workspace root is unavailable", { tool: name }),
					);
				}
				const role = roleOfContext(deps, ctx);
				const slug = slugOfContext(deps, ctx);
				try {
					return toolResult(
						await call(params ?? {}, { root, callId: toolCallId, signal, role, slug }),
					);
				} catch (error) {
					return toolFailure({ ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") });
				}
			},
		});
	};

	execute(
		"review",
		schemas.review,
		"Apply Reviewer findings to this tenure's review ledger. Non-empty findings open the review; an empty ledger becomes attach-ready. Review never writes a deliverable and never advances the stage.",
		(params, options) => service.review(params, options),
	);
	execute(
		"attach_brainstorm",
		schemas.attachBrainstorm,
		"Write s1-brainstorm.md, ask the human to approve or revise it, then archive the ledger, retire the S1 tenure, open S2, and disclose the S2 briefing.",
		(params, options) => service.attachBrainstorm(params, options),
	);
	execute(
		"attach_manual_tests",
		schemas.attachManualTests,
		"Write s2-manual-tests.md and s2-cases.edn, archive the ledger, retire the S2 tenure, open S3, and disclose the S3 briefing.",
		(params, options) => service.attachManualTests(params, options),
	);
	execute(
		"attach_dev_guide",
		schemas.attachDevGuide,
		"Write s3-dev-guide.md, archive the ledger, retire the S3 tenure, open S4, and disclose the S4 briefing.",
		(params, options) => service.attachDevGuide(params, options),
	);
	execute(
		"attach_coordination",
		schemas.attachCoordination,
		"Write s4-coordination.md and the unchecked Promela model, archive the ledger, retire the S4 tenure, open S5, and disclose the S5 briefing.",
		(params, options) => service.attachCoordination(params, options),
	);
	execute(
		"ask_user",
		schemas.askUser,
		"Ask one high-value S1 question, or the one-time S5 initial-empty-ledger question. Never ask for permission to continue.",
		(params, options) => {
			const denied = roleAllowed(options, ASK_ROLES);
			return denied ?? service.askUser(params, options);
		},
	);
	execute(
		"devops",
		schemas.devops,
		"Start the read-only Plan DevOps investigator and return its structured report.",
		(params, options) => {
			const denied = roleAllowed(options, ["Plan", "Coordinator"]);
			return denied ?? service.devops(params, options);
		},
	);
	execute(
		"submit_devops_report",
		schemas.submitDevopsReport,
		"Finish a Plan DevOps investigation with a structured report and inspected paths. The mission slug comes from the bound session.",
		(params, options) => service.submitDevopsReport(params, options),
	);
	return service;
}