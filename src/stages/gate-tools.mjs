/**
 * T3: the S1-S4 stage gate tools.
 *
 * The module owns the structured lifecycle around `advance_s1..s4`, `ask_user`,
 * `devops`, `submit_devops_report`, and `submit_review`. It uses two pure
 * validators from `parsers.mjs` and talks to the outside world only through
 * injected ports:
 *
 *   contract.readMission(root, slug, options)
 *   contract.saveStageDocument(root, slug, stage, markdown, options)
 *   contract.freezeStage(root, slug, stage, markdown, options)
 *   contract.saveS1Summary(root, slug, summary, options)
 *   contract.commitS2(root, slug, {markdown, cases}, options)
 *   contract.readS2Cases(root, slug, options)
 *   contract.verifyFrozenPrefix(root, slug, {keys})
 *   contract.readPendingGate(root, slug, options)
 *   contract.writePendingGate(root, slug, pending, options)
 *   contract.realign(root, slug, stage, options)
 *       -> {ok:true, status:"realigned"|"unchanged", sha256, revision,
 *           changedSections, affected, unknown}
 *
 *   documents.readText(path) -> {ok:true, text} | {ok:false, code, message}
 *       Defaults to a disk UTF-8 reader. S4 always checks the frozen S1-S3
 *       hashes; an explicitly broken port fails the gate closed.
 *
 *   host.confirm({root, slug, pending, markdown, signal})
 *       -> {decision: "approve" | "revise" | "pending", feedback?, diskDiff?}
 *   host.resumeApproval({root, slug, pending, message})
 *       -> {decision: "approve" | "revise" | "pending", feedback?, diskDiff?}
 *   host.askUser({root, slug, question, context, recommended_default})
 *       -> {ok:true, answer} | {ok:true, pending:true}
 *   host.onStageChange({root, slug, previousStage, stage, nextStage, briefing})
 *       -> {ok:true} | {ok:false, error}
 *   host.runDevops({root, slug, intent, verbose_intent, stage, signal})
 *       -> {ok:true, report, agentId}
 *
 *   runner.forkSlices({root, slug, slices, base, signal})
 *       -> {ok:true, ...} | {ok:false, error}
 *   runner.assertInitialEmptyLedger({root, slug})
 *       -> {ok:true} | {ok:false, error}
 *   runner.submitReview({root, slug, summary_markdown, findings, slice_id, tenure_id, request_id})
 *       -> {ok:true, phase:"b"|"join", ...} | {ok:false, error}
 *
 *   deps.roleOf(ctx) / deps.slugOf(ctx)
 *       -> trusted role and mission slug for the bound session. `deps.slug`
 *          is an optional static fallback for tests or single-mission hosts.
 *
 * `contract` is required. The host and runner methods are optional per tool:
 * a missing port fails that tool closed, never silently degrades to approval,
 * disclosure, or "review accepted".
 *
 * `runner.forkSlices` must be idempotent for one mission revision. The gate
 * calls it on every successful S4 replay so a crash between the freeze and the
 * fork is recoverable. `host.onStageChange` is the tool-surface hand-off; a
 * failure there is reported as `wiring` and never rolls back a committed gate.
 * `contractOptions` is spread into every contract call, so a memory store or
 * document adapter can be injected without changing the production contract.
 *
 * Frozen-document realignment is read-only on the user's bytes: the
 * `realign` service method and `realignFrozenDocuments` only re-read, re-hash,
 * and call `contract.realign`. They never call `saveStageDocument` or
 * `freezeStage`, so a human edit is adopted, not overwritten.
 *
 * Full-payload replay identity: every gate call hashes the normalized complete
 * params (document, CASE/module/Slice lists, and every nested field) into a
 * digest. The effective call-id is `gate:<sha256(call-id)>:<digest>`. Contract
 * `freezeStage` stores its receipt under that key in the same mission
 * transaction, so the digest is durable and atomic with the freeze. Any later
 * call-id with a different digest is rejected as `:CALL_REPLAY_MISMATCH`
 * before validation or mutation. "Normalized" means object keys are sorted,
 * array order is preserved, a missing `depends_on` equals `[]`, and every
 * other value is kept exact.
 *
 * The functions return `{ok:true, ...}` or `{ok:false, error:{code,message,data}}`.
 * Expected failures never throw. Disclosure is attached only to the receipt
 * that also completed the freeze, so a rejected or merely saved gate never
 * leaks the next stage.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatedObject } from "../scope/schema.mjs";
import { herdError, isHerdError, printEdn, renderError } from "../util/errors.mjs";
import { currentBriefing } from "./disclosures.mjs";
import { validateModuleCoverage, validateS1, validateS2, validateS3, validateS4 } from "./parsers.mjs";

export { currentBriefing };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CALL_ID = 200;
const DEFAULT_BASE = "HEAD";
const ADVANCE_ROLES = Object.freeze(["Plan", "Coordinator"]);
const ASK_ROLES = Object.freeze(["Plan", "Coordinator", "Reviewer"]);
const STAGE_ORDER = Object.freeze({ s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, completed: 6 });

export const GATE_TOOL_NAMES = Object.freeze([
	"advance_s1",
	"advance_s2",
	"advance_s3",
	"advance_s4",
	"ask_user",
	"devops",
	"submit_devops_report",
	"submit_review",
]);

const TOOL_LABELS = Object.freeze({
	advance_s1: "Advance S1",
	advance_s2: "Advance S2",
	advance_s3: "Advance S3",
	advance_s4: "Advance S4",
	ask_user: "Ask User",
	devops: "DevOps Investigation",
	submit_devops_report: "Submit DevOps Report",
	submit_review: "Submit Review",
});

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

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

async function freezeDocument(deps, root, slug, stage, markdown, options) {
	let frozen;
	try {
		frozen = await deps.contract.freezeStage(root, slug, stage, markdown, {
			...contractOptions(deps),
			...options,
		});
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	return normalizePortResult(frozen, ":INVALID_ARGUMENT", "freezeStage returned no result");
}

async function saveS1Summary(deps, root, slug, summary, options) {
	let saved;
	try {
		saved = await deps.contract.saveS1Summary(root, slug, summary, {
			...contractOptions(deps),
			...options,
		});
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	return normalizePortResult(saved, ":INVALID_ARGUMENT", "saveS1Summary returned no result");
}

async function readS2Cases(deps, root, slug) {
	let read;
	try {
		read = await deps.contract.readS2Cases(root, slug, contractOptions(deps));
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	return normalizePortResult(read, ":INVALID_ARGUMENT", "readS2Cases returned no result");
}

async function verifyContractPrefix(deps, root, slug, keys) {
	if (typeof deps.contract?.verifyFrozenPrefix !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.verifyFrozenPrefix is not available", { reason: "port-missing" });
	}
	let result;
	try {
		result = await deps.contract.verifyFrozenPrefix(root, slug, {
			...contractOptions(deps),
			keys,
		});
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":CONTRACT_HASH_MISMATCH") };
	}
	return normalizePortResult(result, ":CONTRACT_HASH_MISMATCH", "verifyFrozenPrefix returned no result");
}

async function readStageText(deps, root, path) {
	const documents = documentsPort(deps);
	if (!documents) {
		return failure(":HOST_API_MISMATCH", "documents.readText is not available to read the saved stage document", {
			reason: "port-invalid",
			path,
		});
	}
	let read;
	try {
		read = await documents.readText(join(root, path));
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":FILE_CONFLICT") };
	}
	if (read?.ok !== true || typeof read.text !== "string" || read.text.length === 0) {
		return failure(":FILE_CONFLICT", "the saved stage document cannot be read back", {
			path,
			reason: read?.code === "ENOENT" ? "missing" : "unreadable",
		});
	}
	return { ok: true, text: read.text };
}

async function completeStage(deps, { root, slug, stage, nextStage, callId, markdown, extra = {} }) {
	const frozen = await freezeDocument(deps, root, slug, stage, markdown, {
		callId,
		write: true,
		...extra,
	});
	if (!frozen.ok) return frozen;
	return withBriefing(frozen, nextStage, { replayed: frozen.replayed === true });
}

async function replayStage(deps, { root, slug, stage, nextStage, callId, markdown, mission, extra = {} }) {
	const replayed = await freezeDocument(deps, root, slug, stage, markdown, {
		callId,
		write: false,
		...extra,
	});
	if (replayed.ok) return withBriefing(replayed, nextStage, { replayed: true });
	if (replayed.error?.code === ":CALL_REPLAY_MISMATCH") return replayed;
	return withBriefing(reconstructedFreeze(mission, stage, { recovered: true, replayed: true }), nextStage);
}

// ---------------------------------------------------------------------------
// Receipt helpers
// ---------------------------------------------------------------------------

function withBriefing(receipt, stage, extra = {}) {
	const briefing = currentBriefing(stage);
	return {
		...receipt,
		...extra,
		ok: true,
		disclosedStage: stage,
		briefing: typeof briefing === "string" ? briefing : null,
	};
}

function awaitingReceipt(pending) {
	const stored = isPlainObject(pending.receipt) ? pending.receipt : undefined;
	if (stored) return { ...stored, ok: true, status: "awaiting-user", suppressNudge: true };
	return {
		ok: true,
		status: "awaiting-user",
		stage: "s1",
		slug: pending.slug ?? null,
		path: pending.path ?? null,
		sha256: pending.sha256 ?? null,
		revision: pending.revision ?? null,
		suppressNudge: true,
		message: "S1 is saved. Wait for explicit human approval or a revision request.",
	};
}

function reconstructedFreeze(mission, stage, extra = {}) {
	const frozen = mission.frozen?.[stage];
	const missionStage = normalizeStage(mission.stage);
	return {
		ok: true,
		stage,
		path: frozen?.path ?? null,
		sha256: frozen?.sha256 ?? null,
		revision: mission.revision,
		missionStage,
		advanced: true,
		contractLine: mission["contract-line"] ?? null,
		...extra,
	};
}

async function announceStage(deps, args) {
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

async function finishStage(deps, result, { root, slug, previousStage, nextStage }) {
	if (!result?.ok || !result.briefing || result.missionStage !== nextStage) return result;
	if (result.replayAtLaterStage === true) return result;
	const wiring = await announceStage(deps, {
		root,
		slug,
		previousStage,
		stage: nextStage,
		nextStage,
		briefing: result.briefing,
	});
	if (!wiring) return result;
	if (wiring.ok) return { ...result, wiring };
	return {
		...result,
		wiring,
		warning: `The contract advanced to ${nextStage}, but the host could not update the tool surface. Fix the wiring and do not rerun the gate.`,
	};
}

// ---------------------------------------------------------------------------
// S1 human approval
// ---------------------------------------------------------------------------

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
		return { decision: "error", error: normalizeError("host.resumeApproval is not available", ":HOST_API_MISMATCH") };
	}
	try {
		return confirmDecision(await host.resumeApproval(args));
	} catch (error) {
		return { decision: "error", error: herdLikeError(error, ":HOST_API_MISMATCH") };
	}
}

async function approveS1(deps, { root, slug, callId }) {
	const frozen = await freezeDocument(deps, root, slug, "s1", undefined, {
		callId,
		write: false,
	});
	if (!frozen.ok) return frozen;
	return withBriefing(frozen, "s2", { replayed: frozen.replayed === true });
}

async function replayS1Approval(deps, { root, slug, callId, mission }) {
	const frozen = mission.frozen?.s1;
	if (!isPlainObject(frozen)) {
		return failure(":STAGE_MISMATCH", "s1 is not frozen", { slug, reason: "s1-not-frozen" });
	}
	const replayed = await freezeDocument(deps, root, slug, "s1", undefined, {
		callId,
		write: false,
	});
	if (replayed.ok) return withBriefing(replayed, "s2", { replayed: true });
	if (replayed.error?.code === ":CALL_REPLAY_MISMATCH") return replayed;
	const reconstructed = reconstructedFreeze(mission, "s1", {
		recovered: true,
		replayed: true,
		summarySha256: mission.frozen?.["s1-summary"]?.sha256 ?? null,
	});
	return withBriefing(reconstructed, "s2");
}

async function applyS1Decision(deps, { root, slug, callId, pending, decision }) {
	if (decision.decision === "pending") {
		const receipt = awaitingReceipt(pending);
		return { ...receipt, reason: decision.reason ?? "host-pending", replayed: false };
	}
	if (decision.decision === "revise") {
		const cleared = await writePending(deps, root, slug, null);
		if (!cleared.ok) return cleared;
		return {
			ok: true,
			status: "revision-requested",
			stage: "s1",
			slug,
			sha256: pending.sha256 ?? null,
			feedback: decision.feedback ?? "",
			diskDiff: decision.diskDiff ?? null,
			suppressNudge: false,
		};
	}
	if (decision.decision === "error") {
		return { ok: false, error: decision.error ?? normalizeError("confirmation host failed", ":HOST_API_MISMATCH") };
	}
	if (decision.decision !== "approve") {
		return failure(":HOST_API_MISMATCH", "the confirmation host returned no usable decision", {
			reason: decision.reason ?? "host-confirm-protocol",
			callId: callId ?? null,
		});
	}
	return approveS1(deps, { root, slug, callId });
}

async function advanceS1(deps, params = {}, options = {}) {
	const slug = params.slug;
	const markdown = params.brainstorm_markdown;
	const summary = params.summary;
	const nonGoals = params.non_goals;
	const callId = normalizeCallId(options.callId);
	if (callId === null) return failure(":INVALID_ARGUMENT", "call-id is malformed", { field: "call_id" });
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;

	const digest = callPayloadDigest("advance_s1", params);
	const gateCallId = callId === undefined ? undefined : effectiveGateCallId(callId, digest);
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const mission = read.mission;
	const replayMismatchError = gateReplayMismatch(mission, callId, digest);
	if (replayMismatchError) return replayMismatchError;

	if (!isText(summary)) {
		return failure(":INVALID_ARGUMENT", "summary must be a non-empty string", { field: "summary" });
	}
	if (!Array.isArray(nonGoals) || nonGoals.length === 0 || !nonGoals.every(isText)) {
		return failure(":INVALID_ARGUMENT", "non_goals must be a non-empty array of non-empty strings", {
			field: "non_goals",
		});
	}
	const validation = validateS1(markdown);
	if (!validation.ok) return validationFailure("s1", validation.errors);

	const missionStage = normalizeStage(mission.stage);

	if (isPlainObject(mission.frozen?.s1) && missionStage !== "s1") {
		const replayed = await replayS1Approval(deps, {
			root: options.root,
			slug,
			callId: gateCallId,
			mission,
		});
		const later = isLaterStage(missionStage, "s2");
		const finished = await finishStage(deps, later ? { ...replayed, replayAtLaterStage: true } : replayed, {
			root: options.root,
			slug,
			previousStage: "s1",
			nextStage: "s2",
		});
		return finished.ok ? { ...finished, payloadDigest: digest } : finished;
	}
	if (missionStage !== "s1") {
		return failure(":STAGE_MISMATCH", `expected stage s1, mission is at ${mission.stage}`, {
			stage: "s1",
			missionStage,
		});
	}

	const pendingRead = await readPending(deps, options.root, slug);
	if (!pendingRead.ok) return pendingRead;
	const existing = pendingRead.pending;
	if (isPlainObject(existing) && existing["call-id"] === callId) {
		const pendingDigest = existing["payload-digest"] ?? existing["payload-hash"];
		if (pendingDigest !== digest) {
			return replayMismatch(callId, pendingDigest, digest);
		}
		return { ...awaitingReceipt(existing), replayed: true, payloadDigest: digest };
	}

	const saved = await saveDocument(deps, options.root, slug, "s1", markdown, {
		callId: derivedCallId(gateCallId, "save"),
	});
	if (!saved.ok) return saved;
	const summarySaved = await saveS1Summary(deps, options.root, slug, summary, {
		callId: derivedCallId(gateCallId, "summary"),
	});
	if (!summarySaved.ok) return summarySaved;
	if (saved.replayed === true && isPlainObject(existing)) {
		return {
			ok: true,
			status: "awaiting-user",
			stage: "s1",
			slug,
			path: saved.path,
			sha256: saved.sha256,
			revision: saved.revision,
			summaryPath: summarySaved.path,
			summarySha256: summarySaved.sha256,
			suppressNudge: true,
			message: "An earlier S1 submission is saved; a newer S1 gate is waiting.",
			replayed: true,
			payloadDigest: digest,
			supersededBy: existing["call-id"] ?? null,
		};
	}

	const awaiting = {
		ok: true,
		status: "awaiting-user",
		stage: "s1",
		slug,
		path: saved.path,
		sha256: saved.sha256,
		revision: saved.revision,
		summaryPath: summarySaved.path,
		summarySha256: summarySaved.sha256,
		summary,
		nonGoals,
		suppressNudge: true,
		message: "S1 is saved. Wait for explicit human approval or a revision request.",
	};
	const pending = {
		stage: "s1",
		slug,
		"call-id": callId ?? null,
		"payload-digest": digest,
		path: saved.path,
		sha256: saved.sha256,
		revision: saved.revision,
		summaryPath: summarySaved.path,
		summarySha256: summarySaved.sha256,
		"submitted-at": now(deps),
		summary,
		"non-goals": nonGoals,
		receipt: awaiting,
	};
	const written = await writePending(deps, options.root, slug, pending);
	if (!written.ok) return written;
	const active = written.pending;

	const disk = await readStageText(deps, options.root, saved.path);
	if (!disk.ok) return disk;
	const decision = await askApproval(deps, {
		root: options.root,
		slug,
		pending: active,
		markdown: disk.text,
		signal: options.signal,
	});
	const applied = await applyS1Decision(deps, {
		root: options.root,
		slug,
		callId: gateCallId,
		pending: active,
		decision,
	});
	const finished = await finishStage(deps, applied, {
		root: options.root,
		slug,
		previousStage: "s1",
		nextStage: "s2",
	});
	return finished.ok ? { ...finished, payloadDigest: digest } : finished;
}

async function resumeS1(deps, root, slug, message) {
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	if (!isText(message)) {
		return failure(":INVALID_ARGUMENT", "message must be a non-empty string", { field: "message" });
	}
	const read = await readMissionOrError(deps, root, slug);
	if (!read.ok) return read;
	const mission = read.mission;
	if (isPlainObject(mission.frozen?.s1) && normalizeStage(mission.stage) !== "s1") {
		const pendingRead = await readPending(deps, root, slug);
		const pending = pendingRead.ok ? pendingRead.pending : null;
		const userCallId = pending?.["call-id"];
		const digest = pending?.["payload-digest"] ?? pending?.["payload-hash"];
		const gateCallId = userCallId !== undefined && digest ? effectiveGateCallId(userCallId, digest) : undefined;
		if (pending) await writePending(deps, root, slug, null);
		return replayS1Approval(deps, {
			root,
			slug,
			callId: gateCallId,
			mission,
		});
	}
	const pendingRead = await readPending(deps, root, slug);
	if (!pendingRead.ok) return pendingRead;
	const pending = pendingRead.pending;
	if (!pending) return { ok: true, status: "no-pending", pending: null };
	if (normalizeStage(mission.stage) !== "s1") {
		return failure(":STAGE_MISMATCH", "a pending S1 gate exists on a mission outside S1", {
			stage: "s1",
			missionStage: normalizeStage(mission.stage),
			pending: true,
		});
	}
	const decision = await resumeApproval(deps, { root, slug, pending, message });
	const userCallId = pending["call-id"];
	const digest = pending["payload-digest"] ?? pending["payload-hash"];
	const gateCallId = userCallId !== undefined && digest ? effectiveGateCallId(userCallId, digest) : undefined;
	return applyS1Decision(deps, {
		root,
		slug,
		callId: gateCallId,
		pending,
		decision,
		structure: { cases: [] },
	});
}

// ---------------------------------------------------------------------------
// S2-S4 automatic gates
// ---------------------------------------------------------------------------

async function advanceS2(deps, params = {}, options = {}) {
	const slug = params.slug;
	const callId = normalizeCallId(options.callId);
	if (callId === null) return failure(":INVALID_ARGUMENT", "call-id is malformed", { field: "call_id" });
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	const digest = callPayloadDigest("advance_s2", params);
	const gateCallId = callId === undefined ? undefined : effectiveGateCallId(callId, digest);
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const replayMismatchError = gateReplayMismatch(read.mission, callId, digest);
	if (replayMismatchError) return replayMismatchError;
	const missionStage = normalizeStage(read.mission.stage);
	const replaying = isPlainObject(read.mission.frozen?.s2) && missionStage !== "s2";
	if (!replaying && missionStage !== "s2") {
		return failure(":STAGE_MISMATCH", `expected stage s2, mission is at ${read.mission.stage}`, {
			stage: "s2",
			missionStage,
		});
	}
	const validation = validateS2(params.manual_tests_markdown, params.cases);
	if (!validation.ok) return validationFailure("s2", validation.errors);
	if (typeof deps.contract?.commitS2 !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.commitS2 is not available", { reason: "port-missing" });
	}
	let committed;
	try {
		committed = await deps.contract.commitS2(
			options.root,
			slug,
			{
				manual_tests_markdown: params.manual_tests_markdown,
				cases: validation.cases,
			},
			{
				...contractOptions(deps),
				callId: gateCallId,
				write: !replaying,
			},
		);
	} catch (error) {
		committed = { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
	}
	let advanced;
	if (committed && committed.ok === true) {
		advanced = withBriefing(committed, "s3", { replayed: committed.replayed === true || replaying });
	} else if (replaying && committed?.error?.code === ":STAGE_MISMATCH") {
		const cases = await readS2Cases(deps, options.root, slug);
		advanced = withBriefing(
			reconstructedFreeze(read.mission, "s2", {
				recovered: true,
				replayed: true,
				casesSha256: cases.ok ? cases.sha256 : null,
				caseIds: cases.ok ? cases.caseIds : [],
			}),
			"s3",
		);
	} else {
		return committed?.error
			? { ok: false, error: normalizeError(committed.error, ":INVALID_ARGUMENT") }
			: failure(":INVALID_ARGUMENT", "commitS2 returned no result");
	}
	const later = isLaterStage(missionStage, "s3");
	const result = await finishStage(deps, later ? { ...advanced, replayAtLaterStage: true } : advanced, {
		root: options.root,
		slug,
		previousStage: "s2",
		nextStage: "s3",
	});
	return result.ok
		? {
				...result,
				payloadDigest: digest,
				caseIds: Array.isArray(committed?.caseIds) ? committed.caseIds : validation.cases.map((entry) => entry.case_id),
			}
		: result;
}

async function advanceS3(deps, params = {}, options = {}) {
	const slug = params.slug;
	const callId = normalizeCallId(options.callId);
	if (callId === null) return failure(":INVALID_ARGUMENT", "call-id is malformed", { field: "call_id" });
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	const digest = callPayloadDigest("advance_s3", params);
	const gateCallId = callId === undefined ? undefined : effectiveGateCallId(callId, digest);
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const replayMismatchError = gateReplayMismatch(read.mission, callId, digest);
	if (replayMismatchError) return replayMismatchError;
	const missionStage = normalizeStage(read.mission.stage);
	const replaying = isPlainObject(read.mission.frozen?.s3) && missionStage !== "s3";
	if (!replaying) {
		if (missionStage !== "s3") {
			return failure(":STAGE_MISMATCH", `expected stage s3, mission is at ${read.mission.stage}`, {
				stage: "s3",
				missionStage,
			});
		}
		const prefix = await verifyContractPrefix(deps, options.root, slug, ["s1", "s1-summary", "s2", "s2-cases"]);
		if (!prefix.ok) return prefix;
	}
	const frozenCases = await readS2Cases(deps, options.root, slug);
	if (!frozenCases.ok) return frozenCases;
	const caseIds = Array.isArray(frozenCases.caseIds)
		? frozenCases.caseIds
		: (frozenCases.cases ?? []).map((entry) => entry.case_id);
	const validation = validateS3(params.dev_guide_markdown, params.modules, caseIds);
	if (!validation.ok) return validationFailure("s3", validation.errors);
	let advanced;
	if (replaying) {
		advanced = await replayStage(deps, {
			root: options.root,
			slug,
			stage: "s3",
			nextStage: "s4",
			callId: gateCallId,
			markdown: params.dev_guide_markdown,
			mission: read.mission,
			extra: { modules: params.modules },
		});
	} else {
		advanced = await completeStage(deps, {
			root: options.root,
			slug,
			stage: "s3",
			nextStage: "s4",
			callId: gateCallId,
			markdown: params.dev_guide_markdown,
			extra: { modules: params.modules },
		});
		if (!advanced.ok) return advanced;
	}
	const later = isLaterStage(missionStage, "s4");
	const result = await finishStage(deps, later ? { ...advanced, replayAtLaterStage: true } : advanced, {
		root: options.root,
		slug,
		previousStage: "s3",
		nextStage: "s4",
	});
	return result.ok ? { ...result, payloadDigest: digest, caseIds, modules: params.modules.length } : result;
}

async function forkSwarms(deps, root, slug, slices, signal) {
	const forkSlices = deps.runner?.forkSlices;
	if (typeof forkSlices !== "function") {
		return failure(":HOST_API_MISMATCH", "runner.forkSlices is not available", {
			reason: "port-missing",
			tool: "advance_s4",
		});
	}
	const base = isText(deps.base) ? deps.base : DEFAULT_BASE;
	try {
		const result = await forkSlices({ root, slug, slices, base, signal });
		return normalizePortResult(result, ":INSUFFICIENT_WORKTREES", "forkSlices returned no result");
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":INSUFFICIENT_WORKTREES") };
	}
}

function normalizeSlice(slice) {
	if (slice === null || typeof slice !== "object") return slice;
	return {
		slice_id: slice.slice_id,
		goal: slice.goal,
		inputs: Array.isArray(slice.inputs) ? [...slice.inputs] : slice.inputs,
		depends_on: Array.isArray(slice.depends_on) ? [...slice.depends_on] : [],
		done_when: slice.done_when,
		mapped_cases: Array.isArray(slice.mapped_cases) ? [...slice.mapped_cases] : slice.mapped_cases,
	};
}

async function advanceS4(deps, params = {}, options = {}) {
	const slug = params.slug;
	const callId = normalizeCallId(options.callId);
	if (callId === null) return failure(":INVALID_ARGUMENT", "call-id is malformed", { field: "call_id" });
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	if (!Array.isArray(params.slices)) {
		return failure(":INVALID_ARGUMENT", "slices must be an array", { field: "slices" });
	}
	const digest = callPayloadDigest("advance_s4", params);
	const gateCallId = callId === undefined ? undefined : effectiveGateCallId(callId, digest);
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const replayMismatchError = gateReplayMismatch(read.mission, callId, digest);
	if (replayMismatchError) return replayMismatchError;
	const missionStage = normalizeStage(read.mission.stage);
	const replaying = isPlainObject(read.mission.frozen?.s4) && missionStage !== "s4";
	if (missionStage !== "s4" && !replaying) {
		return failure(":STAGE_MISMATCH", `expected stage s4, mission is at ${read.mission.stage}`, {
			stage: "s4",
			missionStage,
		});
	}
	let frozenPrefixChecked;
	if (!replaying) {
		const prefix = await verifyContractPrefix(deps, options.root, slug, [
			"s1",
			"s1-summary",
			"s2",
			"s2-cases",
			"s3",
			"s3-modules",
		]);
		if (!prefix.ok) return prefix;
		frozenPrefixChecked = true;
	}
	if (typeof deps.runner?.forkSlices !== "function") {
		return failure(":HOST_API_MISMATCH", "runner.forkSlices is not available", {
			reason: "port-missing",
			tool: "advance_s4",
		});
	}
	const frozenCases = await readS2Cases(deps, options.root, slug);
	if (!frozenCases.ok) return frozenCases;
	const caseIds = Array.isArray(frozenCases.caseIds)
		? frozenCases.caseIds
		: (frozenCases.cases ?? []).map((entry) => entry.case_id);
	const frozenModules = Array.isArray(read.mission["s3-modules"])
		? read.mission["s3-modules"].map((module) => ({
				path: module.path,
				secret_owned: module["secret-owned"] ?? module.secret_owned,
				depends_on: module["depends-on"] ?? module.depends_on ?? [],
				mapped_cases: module["mapped-cases"] ?? module.mapped_cases,
			}))
		: read.mission["s3-modules"];
	const moduleCoverage = validateModuleCoverage(frozenModules, caseIds);
	if (!moduleCoverage.ok) return validationFailure("s4", moduleCoverage.errors);
	const slices = params.slices.map(normalizeSlice);
	const validation = validateS4(params.coordination_markdown, slices, caseIds);
	if (!validation.ok) return validationFailure("s4", validation.errors);
	let advanced;
	if (replaying) {
		advanced = await replayStage(deps, {
			root: options.root,
			slug,
			stage: "s4",
			nextStage: "s5",
			callId: gateCallId,
			markdown: params.coordination_markdown,
			mission: read.mission,
			extra: { slices },
		});
	} else {
		advanced = await completeStage(deps, {
			root: options.root,
			slug,
			stage: "s4",
			nextStage: "s5",
			callId: gateCallId,
			markdown: params.coordination_markdown,
			extra: { slices },
		});
		if (!advanced.ok) return advanced;
	}
	const fork = await forkSwarms(deps, options.root, slug, slices, options.signal);
	const result = fork.ok
		? { ...advanced, status: "s5-forked", fork }
		: {
				...advanced,
				status: "s5-fork-failed",
				fork,
				warning:
					"S4 is frozen and the mission is in S5, but forkSlices failed. Keep the contract frozen and retry the fork; do not rerun advance_s4.",
			};
	if (frozenPrefixChecked !== undefined) result.frozenPrefixChecked = frozenPrefixChecked;
	const later = isLaterStage(missionStage, "s5");
	const finished = await finishStage(deps, later ? { ...result, replayAtLaterStage: true } : result, {
		root: options.root,
		slug,
		previousStage: "s4",
		nextStage: "s5",
	});
	return finished.ok ? { ...finished, payloadDigest: digest } : finished;
}

// ---------------------------------------------------------------------------
// ask_user, devops, submit_review
// ---------------------------------------------------------------------------

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

function normalizeFindings(findings) {
	if (!Array.isArray(findings)) {
		return { ok: false, message: "findings must be an array" };
	}
	const normalized = [];
	for (let index = 0; index < findings.length; index += 1) {
		const finding = findings[index];
		if (!isPlainObject(finding)) {
			return { ok: false, message: `findings[${index}] must be an object` };
		}
		if (!isSpecificText(finding.key) || !isSpecificText(finding.value)) {
			return { ok: false, message: `findings[${index}] needs a non-empty key and value` };
		}
		normalized.push({ key: finding.key.trim(), value: finding.value.trim() });
	}
	return { ok: true, findings: normalized };
}

async function submitReview(deps, params = {}, options = {}) {
	const denied = roleAllowed(options, ["Reviewer"]);
	if (denied) return denied;
	const slug = options.slug;
	if (!validSlug(slug)) return missingSessionSlug("submit_review");
	const summary = params.summary_markdown;
	if (!isSpecificText(summary)) {
		return failure(":INVALID_ARGUMENT", "summary_markdown must be a non-empty, specific string", {
			field: "summary_markdown",
		});
	}
	const findings = normalizeFindings(params.findings);
	if (!findings.ok) {
		return failure(":INVALID_ARGUMENT", findings.message, { field: "findings" });
	}
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const stage = normalizeStage(read.mission.stage);
	if (stage !== "s5") {
		return failure(":STAGE_MISMATCH", "submit_review is available only in S5", { stage });
	}
	if (typeof deps.runner?.submitReview !== "function") {
		return failure(":HOST_API_MISMATCH", "runner.submitReview is not available", { reason: "port-missing" });
	}
	try {
		const result = await deps.runner.submitReview({
			root: options.root,
			slug,
			summary_markdown: summary,
			findings: findings.findings,
			slice_id: params.slice_id ?? null,
			tenure_id: params.tenure_id ?? null,
			request_id: options.callId ?? null,
		});
		const normalized = normalizePortResult(result, ":RESOURCES_NOT_QUIESCENT", "submitReview returned no result");
		if (!normalized.ok) return normalized;
		return {
			...normalized,
			ok: true,
			status: findings.findings.length === 0 ? "review-quiescent" : "review-open",
			slug,
			stage,
			findings: findings.findings.length,
		};
	} catch (error) {
		return { ok: false, error: herdLikeError(error, ":RESOURCES_NOT_QUIESCENT") };
	}
}

// ---------------------------------------------------------------------------
// Frozen-document human-edit realignment
// ---------------------------------------------------------------------------

function realignCallId(callId, stage) {
	if (callId === undefined) return undefined;
	const text = `${callId}:realign:${stage}`;
	return text.length <= 256 ? text : sha256(text);
}

const REALIGN_TARGETS = new Set(["s1", "s1-summary", "s2", "s2-cases", "s3", "s3-modules", "s4", "s4-slices"]);

function normalizeRealignTarget(value) {
	if (typeof value !== "string") return undefined;
	const target = value.trim().toLowerCase().replace(/^:/, "");
	return REALIGN_TARGETS.has(target) ? target : undefined;
}

async function realignFrozen(deps, params = {}, options = {}) {
	const slug = params.slug;
	const invalidSlug = slugFailure(slug);
	if (invalidSlug) return invalidSlug;
	const callId = normalizeCallId(options.callId);
	if (callId === null) return failure(":INVALID_ARGUMENT", "call-id is malformed", { field: "call_id" });
	if (typeof deps.contract?.realign !== "function") {
		return failure(":HOST_API_MISMATCH", "contract.realign is not available", { reason: "port-missing" });
	}
	const read = await readMissionOrError(deps, options.root, slug);
	if (!read.ok) return read;
	const mission = read.mission;
	if (normalizeStage(mission.stage) === "completed") {
		return failure(":APPROVAL_REQUIRED", "a completed mission cannot be realigned", {
			slug,
			reason: "completed",
		});
	}

	const requested = params.target ?? params.stage;
	const requestedTarget = requested === undefined ? undefined : normalizeRealignTarget(requested);
	if (requested !== undefined && requestedTarget === undefined) {
		return failure(":INVALID_ARGUMENT", "realign target is not a frozen control key", { target: requested });
	}
	if (requestedTarget === "s3-modules" && !Array.isArray(params.modules)) {
		return failure(":INVALID_ARGUMENT", "s3-modules realign requires the full modules array", {
			field: "modules",
			target: requestedTarget,
		});
	}
	if (requestedTarget === "s4-slices" && !Array.isArray(params.slices)) {
		return failure(":INVALID_ARGUMENT", "s4-slices realign requires the full slices array", {
			field: "slices",
			target: requestedTarget,
		});
	}

	const targets = [];
	const unchanged = [];
	if (requestedTarget !== undefined) {
		targets.push(requestedTarget);
	} else {
		for (const target of ["s1", "s1-summary", "s2", "s2-cases", "s3", "s4"]) {
			const frozen = mission.frozen?.[target];
			if (!isPlainObject(frozen) || !isText(frozen.path) || !isText(frozen.sha256)) continue;
			const doc = await readStageText(deps, options.root, frozen.path);
			if (!doc.ok) return doc;
			if (sha256(doc.text) !== frozen.sha256) targets.push(target);
			else unchanged.push(target);
		}
		if (Array.isArray(params.modules)) {
			const modulesPrefix = await verifyContractPrefix(deps, options.root, slug, ["s3-modules"]);
			if (modulesPrefix.ok) unchanged.push("s3-modules");
			else targets.push("s3-modules");
		}
	}
	if (targets.length === 0) {
		return {
			ok: true,
			status: "unchanged",
			revision: mission.revision,
			targets: [],
			unchanged,
			alignmentHint: `Frozen controls unchanged; revision ${mission.revision}.`,
		};
	}

	const applied = [];
	let revision = mission.revision;
	for (let index = 0; index < targets.length; index += 1) {
		const target = targets[index];
		const optionsForCall = {
			...contractOptions(deps),
			callId: realignCallId(callId, target),
		};
		if (params.modules !== undefined) optionsForCall.modules = params.modules;
		if (params.slices !== undefined) optionsForCall.slices = params.slices;
		if (params.structure !== undefined) optionsForCall.structure = params.structure;
		let result;
		try {
			result = await deps.contract.realign(options.root, slug, target, optionsForCall);
		} catch (error) {
			result = { ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") };
		}
		if (result?.ok !== true) {
			const error = result?.error
				? normalizeError(result.error, ":INVALID_ARGUMENT")
				: { code: ":INVALID_ARGUMENT", message: "contract.realign returned no result", data: {} };
			const pending = targets.slice(index);
			return {
				ok: false,
				error: {
					...error,
					data: {
						...(error.data ?? {}),
						target,
						applied: applied.map((entry) => entry.target),
						pending,
					},
				},
				applied,
				pending,
			};
		}
		revision = result.revision ?? revision;
		applied.push({
			target,
			status: result.status ?? "realigned",
			revision,
			sha256: result.sha256 ?? null,
			changedSections: Array.isArray(result.changedSections) ? result.changedSections : [],
			affected: isPlainObject(result.affected) ? result.affected : undefined,
		});
	}
	return {
		ok: true,
		status: applied.some((entry) => entry.status === "realigned") ? "realigned" : "unchanged",
		revision,
		targets: applied,
		unchanged,
		alignmentHint: applied
			.map(
				(entry) =>
					`${entry.target}: ${entry.status}${entry.revision === undefined ? "" : ` revision ${entry.revision}`}`,
			)
			.join("; "),
	};
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Build the gate service from injected ports.
 *
 * `deps.contract` is required and validated at construction time. `deps.host`,
 * `deps.runner`, `deps.documents`, `deps.root`, `deps.base`, `deps.now`, and
 * `deps.contractOptions` are optional. A missing optional port fails only the
 * tool that needs it. The `realign` method additionally requires
 * `contract.realign`; without it that method returns `:HOST_API_MISMATCH`.
 */
export function createGateService(deps) {
	const settings = settingsOf(deps);
	requireContract(settings);
	const service = {
		advanceS1: (params, options = {}) =>
			advanceS1(settings, params, { ...options, root: options.root ?? settings.root }),
		advanceS2: (params, options = {}) =>
			advanceS2(settings, params, { ...options, root: options.root ?? settings.root }),
		advanceS3: (params, options = {}) =>
			advanceS3(settings, params, { ...options, root: options.root ?? settings.root }),
		advanceS4: (params, options = {}) =>
			advanceS4(settings, params, { ...options, root: options.root ?? settings.root }),
		askUser: (params, options = {}) => askUser(settings, params, { ...options, root: options.root ?? settings.root }),
		devops: (params, options = {}) => devops(settings, params, { ...options, root: options.root ?? settings.root }),
		submitDevopsReport: (params, options = {}) =>
			submitDevopsReport(settings, params, { ...options, root: options.root ?? settings.root }),
		submitReview: (params, options = {}) =>
			submitReview(settings, params, { ...options, root: options.root ?? settings.root }),
		realign: (params, options = {}) =>
			realignFrozen(settings, params, { ...options, root: options.root ?? settings.root }),
		resumePendingApproval: (root, slug, message) => resumeS1(settings, root ?? settings.root, slug, message),
		currentBriefing,
	};
	return Object.freeze(service);
}

/**
 * Resume an asynchronous S1 approval after the human's next message.
 *
 * This is the standalone form of `createGateService(deps).resumePendingApproval`.
 * The fourth argument carries the injected ports; without it the call fails
 * because this module imports no default contract or host.
 */
export function resumePendingApproval(root, slug, message, deps) {
	return createGateService(deps).resumePendingApproval(root, slug, message);
}

/**
 * Re-read, re-hash, and realign every changed frozen S1-S4 document.
 *
 * This is the standalone form of `createGateService(deps).realign`. It needs
 * only `contract.readMission`, `contract.realign`, and a documents reader. It
 * never writes a stage document; it only calls `contract.realign`, which
 * updates the frozen hash and revision from the human's current disk bytes.
 */
export function realignFrozenDocuments(root, slug, options, deps) {
	const opts = isPlainObject(options) ? options : {};
	return realignFrozen(
		settingsOf(deps),
		{
			slug,
			target: opts.target ?? opts.stage,
			modules: opts.modules,
			slices: opts.slices,
			structure: opts.structure,
		},
		{ ...opts, root: root ?? opts.root },
	);
}

// ---------------------------------------------------------------------------
// Host registration
// ---------------------------------------------------------------------------

function schemaFor(pi) {
	const { Type } = pi.typebox;
	if (!Type) throw new TypeError("gate-tools: pi.typebox.Type is required");
	const gated = (properties, options = { additionalProperties: false }) => gatedObject(Type, properties, options);
	const slug = Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
		description: "Mission slug.",
	});
	return {
		slug,
		advanceS1: gated(
			{
				slug,
				brainstorm_markdown: Type.String({ minLength: 1, description: "Complete s1-brainstorm.md." }),
				summary: Type.String({ minLength: 1, description: "One-page summary for the human confirmation panel." }),
				non_goals: Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					description: "Explicit Non-Goals.",
				}),
			},
			{ additionalProperties: false },
		),
		advanceS2: gated(
			{
				slug,
				manual_tests_markdown: Type.String({ minLength: 1, description: "Complete s2-manual-tests.md." }),
				cases: Type.Array(
					Type.Object(
						{
							case_id: Type.String({ minLength: 1 }),
							path: Type.String({ minLength: 1 }),
							threshold: Type.Number({ minimum: 0, maximum: 100 }),
							steps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
							expected: Type.String({ minLength: 1 }),
							rubric: Type.String({ minLength: 1 }),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
			},
			{ additionalProperties: false },
		),
		advanceS3: gated(
			{
				slug,
				dev_guide_markdown: Type.String({ minLength: 1, description: "Complete s3-dev-guide.md." }),
				modules: Type.Array(
					Type.Object(
						{
							path: Type.String({ minLength: 1 }),
							secret_owned: Type.String({ minLength: 1 }),
							depends_on: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
							mapped_cases: Type.Array(Type.String({ minLength: 1 })),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
			},
			{ additionalProperties: false },
		),
		advanceS4: gated(
			{
				slug,
				coordination_markdown: Type.String({ minLength: 1, description: "Complete s4-coordination.md." }),
				slices: Type.Array(
					Type.Object(
						{
							slice_id: Type.String({ minLength: 1 }),
							goal: Type.String({ minLength: 1 }),
							inputs: Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }))]),
							depends_on: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
							done_when: Type.String({ minLength: 1 }),
							mapped_cases: Type.Array(Type.String({ minLength: 1 })),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
			},
			{ additionalProperties: false },
		),
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
		submitReview: gated(
			{
				summary_markdown: Type.String({ minLength: 1 }),
				findings: Type.Array(
					Type.Object(
						{
							key: Type.String({ minLength: 1 }),
							value: Type.String({ minLength: 1 }),
						},
						{ additionalProperties: false },
					),
				),
				slice_id: Type.Optional(Type.String({ minLength: 1 })),
				tenure_id: Type.Optional(Type.String({ minLength: 1 })),
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
 * Register the gate tools on the host extension API.
 *
 * The host supplies `pi.typebox`, `pi.registerTool`, and the call context. The
 * caller must supply `deps.contract`; `deps.host`, `deps.runner`, `deps.root`,
 * `deps.base`, `deps.roleOf`, `deps.slugOf`, `deps.slug`, `deps.now`, and
 * `deps.contractOptions` are optional. `deps.slugOf(ctx)` supplies the trusted
 * session slug for `submit_devops_report` and `submit_review`; those tools do
 * not accept a model-supplied slug. S1-S4 gate tools still take their mission
 * slug from the payload. Every tool's `execute` returns the host's
 * content-block shape; a rejected gate is `isError: true` and its text is EDN.
 *
 * Returns the same gate service, so the runner layer can hand an S5 initial
 * empty-ledger question to `service.askUser({question}, {slug})` without
 * bypassing the stage and ledger gates.
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
					return toolResult(failure(":INVALID_ARGUMENT", "workspace root is unavailable", { tool: name }));
				}
				const role = roleOfContext(deps, ctx);
				const slug = slugOfContext(deps, ctx);
				try {
					return toolResult(
						await call(params ?? {}, {
							root,
							callId: toolCallId,
							signal,
							role,
							slug,
						}),
					);
				} catch (error) {
					return toolFailure({ ok: false, error: herdLikeError(error, ":INVALID_ARGUMENT") });
				}
			},
		});
	};

	execute(
		"advance_s1",
		schemas.advanceS1,
		"Validate and save s1-brainstorm.md, then wait for explicit human approval. This is the only human approval gate. On approval, freeze the latest disk bytes and disclose S2.",
		(params, options) => {
			const denied = roleAllowed(options, ADVANCE_ROLES);
			return denied ?? service.advanceS1(params, options);
		},
	);
	execute(
		"advance_s2",
		schemas.advanceS2,
		"Validate and reconcile s2-manual-tests.md with cases, freeze it, auto-approve, advance to S3, and disclose S3.",
		(params, options) => {
			const denied = roleAllowed(options, ADVANCE_ROLES);
			return denied ?? service.advanceS2(params, options);
		},
	);
	execute(
		"advance_s3",
		schemas.advanceS3,
		"Validate the s3-dev-guide.md module DAG, freeze it, auto-approve, advance to S4, and disclose S4.",
		(params, options) => {
			const denied = roleAllowed(options, ADVANCE_ROLES);
			return denied ?? service.advanceS3(params, options);
		},
	);
	execute(
		"advance_s4",
		schemas.advanceS4,
		"Validate the s4-coordination.md Slice DAG against every S2 CASE, freeze S1-S4, write the contract line, start S5, fork ready Slices, and disclose S5.",
		(params, options) => {
			const denied = roleAllowed(options, ADVANCE_ROLES);
			return denied ?? service.advanceS4(params, options);
		},
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
	execute(
		"submit_review",
		schemas.submitReview,
		"Submit Reviewer findings. Non-empty findings open Phase B; empty findings require quiescence and clean --ff-only readiness. The mission slug comes from the bound session.",
		(params, options) => service.submitReview(params, options),
	);
	return service;
}
