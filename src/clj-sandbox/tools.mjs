/**
 * Role-scoped sandbox tools.
 *
 * One tool per role (`clj_plan` .. `clj_auditor`) runs REPL input in an
 * agent-private evaluator session. The evaluator owns the CEK machine,
 * `where`, `park`, and replay. This module owns the role capability matrix,
 * VFS batch assembly, protected commit plumbing, `call` policy, bounded
 * output, and cancellation. Callers submit expressions directly; a named
 * program is generated internally only when park/unpark needs one.
 *
 * Every external capability is injected as a bare function that takes one EDN
 * map. The evaluator sees the map; the program never sees a host object.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ERROR_CODES, herdError, isHerdError, messageOf, renderError } from "../util/errors.mjs";
import { abandonedCapabilities, abortProgram, createSandboxSession, runProgram } from "./evaluator.mjs";
import { createObservationLedger } from "./observations.mjs";
import { EdnKeyword, renderReceipt } from "./ufss.mjs";
import {
	createBatch,
	runCall,
	commit as vfsCommit,
	glob as vfsGlob,
	list as vfsList,
	mkdir as vfsMkdir,
	move as vfsMove,
	readText as vfsRead,
	remove as vfsRemove,
	stat as vfsStat,
	write as vfsWrite,
} from "./vfs.mjs";

const KW_CACHE = new Map();

function kw(name) {
	let keyword = KW_CACHE.get(name);
	if (keyword === undefined) {
		keyword = new EdnKeyword(name);
		KW_CACHE.set(name, keyword);
	}
	return keyword;
}

function ednField(map, name) {
	if (!(map instanceof Map)) {
		return undefined;
	}
	for (const [key, value] of map) {
		if (key instanceof EdnKeyword && key.name === name) {
			return value;
		}
	}
	return undefined;
}

const WORKER_CAPABILITIES = Object.freeze([
	"cat",
	"read",
	"stat",
	"ls",
	"glob",
	"write",
	"mkdir",
	"rm",
	"mv",
	"where",
	"whereAll",
	"park",
	"unpark",
	"abandon",
]);

/**
 * Role by capability matrix from AGENTS.md §4.2.
 *
 * `worker` deliberately omits `call`. The session grants a denial stub for
 * that name so the program receives the required `:TOKEN_REQUIRED` rejection
 * instead of an unbound-symbol error.
 */
export const CAPABILITY_MATRIX = Object.freeze({
	plan: Object.freeze(["cat", "read", "where", "whereAll", "park", "unpark", "abandon"]),
	devops: Object.freeze([...WORKER_CAPABILITIES, "call"]),
	review: Object.freeze(["cat", "read", "stat", "ls", "glob", "where", "whereAll", "unpark", "abandon"]),
	worker: WORKER_CAPABILITIES,
	holder: Object.freeze([...WORKER_CAPABILITIES, "call"]),
	auditor: Object.freeze([...WORKER_CAPABILITIES, "call"]),
});

const CAPABILITY_NAMES = new Set([
	"cat",
	"read",
	"stat",
	"ls",
	"glob",
	"write",
	"mkdir",
	"rm",
	"mv",
	"where",
	"whereAll",
	"park",
	"unpark",
	"abandon",
	"call",
]);

const WRITE_ROLES = new Set(["worker", "holder", "auditor", "devops"]);
const CALL_DENIAL_ROLES = new Set(["worker"]);
const CALL_FORBIDDEN_ROLES = new Set();

const ROLE_ALIASES = new Map([
	["plan", "plan"],
	["planner", "plan"],
	["devops", "devops"],
	["plan-devops", "devops"],
	["plan-devops-role", "devops"],
	["review", "review"],
	["reviewer", "review"],
	["worker", "worker"],
	["swarm-worker", "worker"],
	["holder", "holder"],
	["swarm-holder", "holder"],
	["auditor", "auditor"],
	["manual-auditor", "auditor"],
]);

const ROLE_LABELS = Object.freeze({
	plan: "Plan",
	devops: "Plan DevOps",
	review: "Reviewer",
	worker: "Swarm Worker",
	holder: "Swarm Holder",
	auditor: "Manual Auditor",
});

const TOOL_NAMES = Object.freeze({
	plan: "clj_plan",
	devops: "clj_devops",
	review: "clj_review",
	worker: "clj_worker",
	holder: "clj_worker",
	auditor: "clj_auditor",
});

const GATE_FIELDS = new Set(["scope", "intent", "more_workers_without_hitting_mythical_man_month"]);

const TOOL_FIELDS = new Set(["name", "code", "i"]);
const CONFIGURED_SESSIONS = new WeakSet();

function invalidArgument(message, data = {}) {
	return herdError("INVALID_ARGUMENT", message, data);
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function normalizeRole(role) {
	if (typeof role !== "string") {
		throw invalidArgument("role must be a string", { role });
	}
	const normalized = role
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-");
	const key = ROLE_ALIASES.get(normalized);
	if (key === undefined) {
		throw invalidArgument(`unknown sandbox role: ${role}`, {
			role,
			allowed: Object.keys(CAPABILITY_MATRIX),
		});
	}
	return key;
}

function validateMatrix() {
	for (const [role, capabilities] of Object.entries(CAPABILITY_MATRIX)) {
		for (const capability of capabilities) {
			if (!CAPABILITY_NAMES.has(capability)) {
				throw invalidArgument(`unknown capability ${capability} in role ${role}`, {
					role,
					capability,
				});
			}
		}
	}
}

function requirePath(value, field) {
	if (typeof value !== "string" || value.length === 0) {
		throw invalidArgument(`${field} must be a non-empty path string`, { field, value });
	}
	return value;
}

function requireRootPath(value, field) {
	return resolve(requirePath(value, field));
}

function resolveAgainst(root, value) {
	return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

function hasOverlay(context) {
	return context.primary.overlay.size > 0 || (context.tmp !== null && context.tmp.overlay.size > 0);
}

function normalizeRoots(role, roots) {
	const source = typeof roots === "string" ? { writeRoot: roots } : roots;
	if (!isPlainObject(source)) {
		throw invalidArgument("roots must be a path string or an object", { roots });
	}

	const writeRoot = requireRootPath(source.writeRoot, "roots.writeRoot");

	const evidenceRoot =
		role === "auditor" ? resolveAgainst(writeRoot, requirePath(source.evidenceRoot, "roots.evidenceRoot")) : null;
	const auditTmp =
		role === "auditor" ? resolveAgainst(writeRoot, requirePath(source.auditTmp, "roots.auditTmp")) : null;

	let callLogDir = null;
	if (source.callLogDir !== undefined) {
		callLogDir = resolveAgainst(writeRoot, requirePath(source.callLogDir, "roots.callLogDir"));
	}
	const callCwd =
		source.callCwd === undefined || source.callCwd === null
			? null
			: resolveAgainst(writeRoot, requirePath(source.callCwd, "roots.callCwd"));

	const limits = source.limits === undefined ? {} : source.limits;
	if (!isPlainObject(limits)) {
		throw invalidArgument("roots.limits must be an object", { limits });
	}
	const baseLimits = { ...limits };

	const callLimits = source.callLimits === undefined ? {} : source.callLimits;
	if (!isPlainObject(callLimits)) {
		throw invalidArgument("roots.callLimits must be an object", { callLimits });
	}
	const normalizedCallLimits = { ...callLimits };
	if (normalizedCallLimits.logPath !== undefined && normalizedCallLimits.logPath !== null) {
		normalizedCallLimits.logPath = resolveAgainst(
			writeRoot,
			requirePath(normalizedCallLimits.logPath, "roots.callLimits.logPath"),
		);
	}

	return {
		writeRoot,
		evidenceRoot,
		auditTmp,
		callLogDir,
		callCwd,
		limits: baseLimits,
		callLimits: normalizedCallLimits,
		io: source.io,
		agentId: source.agentId,
		sandbox: source.sandbox,
	};
}

function kebabKey(key) {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
}

function codeValue(code) {
	if (typeof code !== "string") {
		return null;
	}
	const name = code.startsWith(":") ? code.slice(1) : code;
	return Object.hasOwn(ERROR_CODES, name) ? kw(name) : code;
}

/**
 * Convert a VFS result into an EDN value.
 *
 * VFS returns plain objects with camelCase keys and, on rejection, a real
 * `HerdError`. Neither is a valid EDN capability result. This conversion is
 * deliberately explicit: keywords for status/code/phase, kebab-case keys, and
 * error code/message/data without a stack or a live Error object.
 */
function toEdn(value, seen = new WeakSet()) {
	if (value === undefined || value === null) {
		return null;
	}
	if (
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "bigint"
	) {
		return value;
	}
	if (value instanceof EdnKeyword) {
		return value;
	}
	if (value instanceof Error) {
		const data = isHerdError(value) ? value.data : undefined;
		return new Map([
			[kw("code"), codeValue(value.code)],
			[kw("message"), messageOf(value)],
			[kw("data"), toEdn(data ?? {}, seen)],
		]);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw invalidArgument("cycle in sandbox result", { kind: "array" });
		}
		seen.add(value);
		try {
			return value.map((entry) => toEdn(entry, seen));
		} finally {
			seen.delete(value);
		}
	}
	if (value instanceof Set) {
		if (seen.has(value)) {
			throw invalidArgument("cycle in sandbox result", { kind: "set" });
		}
		seen.add(value);
		try {
			return new Set([...value].map((entry) => toEdn(entry, seen)));
		} finally {
			seen.delete(value);
		}
	}
	if (value instanceof Map) {
		if (seen.has(value)) {
			throw invalidArgument("cycle in sandbox result", { kind: "map" });
		}
		seen.add(value);
		try {
			const result = new Map();
			for (const [key, entry] of value) {
				result.set(toEdn(key, seen), toEdn(entry, seen));
			}
			return result;
		} finally {
			seen.delete(value);
		}
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) {
			throw invalidArgument("cycle in sandbox result", { kind: "object" });
		}
		seen.add(value);
		try {
			const result = new Map();
			for (const [key, entry] of Object.entries(value)) {
				const plainKey = kebabKey(key);
				let converted = toEdn(entry, seen);
				if (
					typeof entry === "string" &&
					entry.startsWith(":") &&
					(plainKey === "status" ||
						plainKey === "code" ||
						plainKey === "phase" ||
						plainKey === "reported-status" ||
						plainKey === "reported-code")
				) {
					converted = kw(entry.slice(1));
				}
				result.set(kw(plainKey), converted);
			}
			return result;
		} finally {
			seen.delete(value);
		}
	}
	return String(value);
}

function stampValue(stamp) {
	if (stamp === null || stamp === undefined) {
		return null;
	}
	return new Map([
		[kw("mtime-sec"), stamp.mtimeSec],
		[kw("mtime-nsec"), stamp.mtimeNsec],
		[kw("size"), stamp.size],
	]);
}

function statValue(snapshot) {
	return new Map([
		[kw("exists"), snapshot.exists],
		[kw("size"), snapshot.size],
		[kw("mtime-sec"), snapshot.mtimeSec],
		[kw("mtime-nsec"), snapshot.mtimeNsec],
		[kw("is-dir"), snapshot.isDir],
		[kw("is-file"), snapshot.isFile ?? false],
		[kw("is-symlink"), snapshot.isSymlink ?? false],
		[kw("virtual"), snapshot.virtual],
		[
			kw("stamp"),
			snapshot.exists && !snapshot.virtual && snapshot.size !== null
				? stampValue({
						mtimeSec: snapshot.mtimeSec,
						mtimeNsec: snapshot.mtimeNsec,
						size: snapshot.size,
					})
				: null,
		],
	]);
}

function listValue(result) {
	return new Map([
		[kw("exists"), result.exists],
		[
			kw("entries"),
			result.entries.map(
				(entry) =>
					new Map([
						[kw("name"), entry.name],
						[kw("is-dir"), entry.isDir],
						[kw("is-file"), entry.isFile],
						[kw("is-symlink"), entry.isSymlink],
						[kw("virtual"), entry.virtual],
					]),
			),
		],
	]);
}

function operationPath(result, keys) {
	const value = new Map();
	for (const key of keys) {
		if (Object.hasOwn(result, key)) {
			value.set(kw(kebabKey(key)), result[key]);
		}
	}
	return value;
}

function requireArgumentString(args, field) {
	const value = args[field];
	if (typeof value !== "string") {
		throw invalidArgument(`${field} must be a string`, { field, value });
	}
	return value;
}

function tokenRequired(role) {
	return herdError("TOKEN_REQUIRED", "call is available only to the current Swarm Holder", {
		role,
		next: "call board_take_or_die, win the token, and retry as Holder",
	});
}

function callNeedsLog() {
	return invalidArgument("call requires roots.callLogDir or roots.callLimits.logPath", {
		field: "roots.callLogDir",
		next: "give the sandbox a control-plane artifacts directory",
	});
}

async function resolvePort(value) {
	return typeof value === "function" ? await value() : value;
}

function combinedCommit(results, failed) {
	const applied = results.filter((entry) => entry.result.status === ":applied");
	const written = results.flatMap((entry) => entry.result.written ?? []);
	const pending = failed?.result.pending ?? [];
	const uncertain = failed?.result.uncertain ?? [];
	const conflicts = failed?.result.conflicts ?? [];
	const actionIds = results.map((entry) => entry.result.actionId).filter(Boolean);
	const recorded = results.every((entry) => entry.result.recorded !== false);
	const recordErrors = results
		.filter((entry) => entry.result.recorded === false)
		.map((entry) => `${entry.kind}: ${recordErrorText(entry.result.recordError)}`);
	const combined = {
		status: failed?.result.status ?? ":applied",
		code: failed?.result.code ?? null,
		actionId: actionIds[0] ?? null,
		actionIds,
		written,
		pending,
		uncertain,
		conflicts,
		recorded,
		partial: failed !== undefined && applied.length > 0,
		batches: results.map((entry) => ({
			kind: entry.kind,
			status: entry.result.status,
			actionId: entry.result.actionId ?? null,
			written: entry.result.written ?? [],
		})),
	};
	if (!recorded) {
		combined.recordError = recordErrors.join("; ");
	}
	return combined;
}

function recordErrorText(value) {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	if (value && typeof value === "object" && typeof value.message === "string") {
		return value.message;
	}
	if (value === undefined || value === null) {
		return "control publication failed";
	}
	return String(value);
}

function commitFailure(combined) {
	const code = combined.code ?? (combined.status === ":uncertain" ? ":BOARD_CONFLICT" : ":PREPARE_REJECTED");
	const message =
		combined.status === ":uncertain"
			? "protected commit ended uncertain; inspect reality before retrying"
			: "protected commit was rejected; no retry reuses the old plan";
	return herdError(code, message, {
		status: combined.status,
		actionId: combined.actionId,
		actionIds: combined.actionIds,
		written: combined.written,
		pending: combined.pending,
		uncertain: combined.uncertain,
		conflicts: combined.conflicts,
		recorded: combined.recorded,
		recordError: combined.recordError,
		partial: combined.partial,
		batches: combined.batches,
		next: "inspect disk, Git, and external effects; re-read before any new program",
	});
}

async function commitContext(context, ports, signal) {
	const entries = [];
	if (context.primary.overlay.size > 0 || context.primary.readSet.size > 0) {
		entries.push({ kind: "primary", batch: context.primary });
	}
	if (context.tmp !== null && (context.tmp.overlay.size > 0 || context.tmp.readSet.size > 0)) {
		entries.push({ kind: "tmp", batch: context.tmp });
	}
	const results = [];
	let failed;
	for (const entry of entries) {
		if (!ports.writeGate) {
			throw invalidArgument("commit requires a writeGate port", {
				missing: "writeGate",
				next: "pass the Slice write-gate port when building the sandbox",
			});
		}
		const result = await vfsCommit({
			batch: entry.batch,
			writeGate: ports.writeGate,
			control: ports.control,
			identity: await resolvePort(ports.identity),
			claim: await resolvePort(ports.claim),
			signal,
		});
		results.push({ kind: entry.kind, result });
		if (result.status !== ":applied") {
			failed = results[results.length - 1];
			break;
		}
	}

	const combined = combinedCommit(results, failed);
	if (failed !== undefined && failed.result.status === ":cancelled") {
		throw herdError(
			"UPSTREAM_ABORTED",
			combined.written.length > 0
				? "protected commit was cancelled after an earlier batch applied"
				: "protected commit was cancelled before applying",
			{
				status: ":cancelled",
				actionId: combined.actionId,
				written: combined.written,
				pending: combined.pending,
				uncertain: combined.uncertain,
				conflicts: combined.conflicts,
				partial: combined.partial,
				next: "inspect disk before any new program; do not replay the cancelled batch",
			},
		);
	}
	if (failed !== undefined) {
		throw commitFailure(combined);
	}
	if (results.length === 1) {
		return toEdn(results[0].result);
	}
	return toEdn(combined);
}

function planRepositoryRoot(context) {
	const writeRoot = resolve(context.roots.writeRoot);
	if (basename(dirname(writeRoot)) !== "plans") {
		return null;
	}
	return dirname(dirname(writeRoot));
}

function planCasesPath(context) {
	if (typeof context.roots.casesPath === "string") {
		return resolve(context.roots.casesPath);
	}
	if (typeof context.roots.missionDir === "string") {
		return join(resolve(context.roots.missionDir), "cases.edn");
	}
	const root = planRepositoryRoot(context);
	if (root === null) {
		return null;
	}
	return join(root, ".herd", "missions", basename(resolve(context.roots.writeRoot)), "cases.edn");
}

function resolvePlanCasesRequest(context, requested) {
	if (isAbsolute(requested)) {
		return resolve(requested);
	}
	const root = planRepositoryRoot(context);
	if (
		root !== null &&
		(requested === ".herd" || requested.startsWith(`.herd${sep}`) || requested.startsWith(".herd/"))
	) {
		return resolve(root, requested);
	}
	return resolve(context.roots.writeRoot, requested);
}

/**
 * Read the frozen CASE dataset for Plan. This is the only path under .herd
 * that Plan may read; it is a direct, locked read, not a VFS overlay read.
 */
function readPlanCases(context, requested) {
	const allowed = planCasesPath(context);
	if (allowed === null) {
		return null;
	}
	const absolute = resolvePlanCasesRequest(context, requested);
	if (absolute !== allowed) {
		return null;
	}
	const io = context.primary.io;
	let allowedReal;
	try {
		allowedReal = io.realpath(allowed);
	} catch {
		throw herdError("INVALID_ARGUMENT", "frozen CASE dataset is missing", { path: allowed });
	}
	const before = io.lstat(absolute);
	if (!before?.isFile() || before.isSymbolicLink()) {
		throw herdError("PATH_ESCAPE", "frozen CASE dataset must be a regular file", { path: absolute });
	}
	let real;
	try {
		real = io.realpath(absolute);
	} catch {
		throw herdError("INVALID_ARGUMENT", "frozen CASE dataset is missing", { path: absolute });
	}
	if (real !== allowedReal) {
		throw herdError("PATH_ESCAPE", "frozen CASE dataset resolves outside its frozen path", { path: absolute });
	}
	const bytes = io.readFile(absolute);
	const after = io.lstat(absolute);
	if (!after || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
		throw herdError("FILE_CONFLICT", "frozen CASE dataset changed during read", {
			path: absolute,
			reason: "changed-during-read",
		});
	}
	if (BigInt(bytes.length) > BigInt(context.primary.limits.fileBytes)) {
		throw herdError("LIMIT_EXCEEDED", "frozen CASE dataset exceeds the file limit", {
			path: absolute,
			limit: context.primary.limits.fileBytes,
		});
	}
	let content;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw herdError("INVALID_ARGUMENT", "frozen CASE dataset is not valid UTF-8", { path: absolute });
	}
	return new Map([
		[kw("content"), content],
		[
			kw("stamp"),
			stampValue({
				mtimeSec: before.mtimeNs / 1_000_000_000n,
				mtimeNsec: before.mtimeNs % 1_000_000_000n,
				size: before.size,
			}),
		],
		[kw("virtual"), false],
	]);
}

function classifyRead(context, requested) {
	return { batch: context.primary, path: requested };
}

function classifyWrite(context, requested) {
	return { batch: context.primary, path: requested };
}

function classifyMove(context, source, target) {
	return { batch: context.primary, source, target };
}

function callControlAdapter(control) {
	if (!control || typeof control !== "object") {
		return control;
	}
	const adapter = {};
	for (const method of ["markApplying", "markRunning", "markUncertain", "verifyClaim"]) {
		if (typeof control[method] === "function") {
			adapter[method] = async (payload) => control[method].call(control, payload);
		}
	}
	if (typeof control.publishResult === "function") {
		adapter.publishResult = async (payload) => {
			if ((payload?.status === ":completed" || payload?.status === ":failed") && payload.stdioClosed === false) {
				return control.markUncertain.call(control, {
					...payload,
					status: ":outcome-unknown",
					reportedStatus: payload.status,
					unconfirmedExit: true,
					code: payload.code ?? ":BOARD_CONFLICT",
				});
			}
			return control.publishResult.call(control, payload);
		};
	}
	return adapter;
}

function auditorSandboxReady(context) {
	if (context?.role !== "auditor") return true;
	const sandbox = context?.sandbox;
	const runCommand = context?.roots?.io?.runCommand;
	return sandbox?.available === true && typeof sandbox.runCommand === "function" && runCommand === sandbox.runCommand;
}

function ednArgsToObject(args) {
	if (args instanceof Map) {
		const out = {};
		for (const [key, value] of args) {
			out[key instanceof EdnKeyword ? key.name : String(key)] = value;
		}
		return out;
	}
	if (args && typeof args === "object") return { ...args };
	return {};
}

function hostResultText(result) {
	if (result && Array.isArray(result.content)) {
		return result.content
			.filter((block) => block && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	}
	if (typeof result === "string") return result;
	return "";
}

function makeCapabilityTable(context, ports, execution) {
	const table = {};
	const capabilities = new Set(CAPABILITY_MATRIX[context.role]);

	if (capabilities.has("read")) {
		table.read = async (args) => {
			const requested = requireArgumentString(args, "path");
			if (typeof ports.hostRead !== "function") {
				const target = classifyRead(context, requested);
				const result = vfsRead(target.batch, target.path);
				return new Map([
					[kw("content"), result.content],
					[kw("stamp"), stampValue(result.stamp)],
					[kw("virtual"), result.virtual],
				]);
			}
			const result = await ports.hostRead(ednArgsToObject(args));
			return new Map([
				[kw("path"), requested],
				[kw("content"), hostResultText(result)],
				[kw("host"), true],
			]);
		};
	}
	if (capabilities.has("cat")) {
		table.cat = (args) => {
			const requested = requireArgumentString(args, "path");
			if (context.role === "plan") {
				const frozen = readPlanCases(context, requested);
				if (frozen !== null) {
					return frozen;
				}
			}
			const target = classifyRead(context, requested);
			const result = vfsRead(target.batch, target.path);
			return new Map([
				[kw("content"), result.content],
				[kw("stamp"), stampValue(result.stamp)],
				[kw("virtual"), result.virtual],
			]);
		};
	}
	if (capabilities.has("stat")) {
		table.stat = (args) => {
			const requested = requireArgumentString(args, "path");
			const target = classifyRead(context, requested);
			return statValue(vfsStat(target.batch, target.path));
		};
	}
	if (capabilities.has("ls")) {
		table.ls = (args) => {
			const requested = requireArgumentString(args, "path");
			const target = classifyRead(context, requested);
			return listValue(vfsList(target.batch, target.path));
		};
	}
	if (capabilities.has("glob")) {
		table.glob = async (args) => {
			const pattern = requireArgumentString(args, "pattern");
			if (pattern.length === 0) {
				throw invalidArgument("pattern must be a non-empty string", { field: "pattern", value: pattern });
			}
			const requested = args.path === undefined || args.path === null ? "" : requireArgumentString(args, "path");
			const dot = args.dot === true;
			const onlyFiles = args.onlyFiles !== false && args["only-files"] !== false;
			const result = await vfsGlob(context.primary, pattern, requested, { dot, onlyFiles });
			return new Map([
				[kw("exists"), result.exists],
				[kw("entries"), result.entries],
			]);
		};
	}
	if (capabilities.has("write")) {
		table.write = async (args) => {
			const requested = requireArgumentString(args, "path");
			if (typeof ports.hostWrite !== "function") {
				const target = classifyWrite(context, requested);
				const result = vfsWrite(target.batch, target.path, requireArgumentString(args, "content"));
				return operationPath(result, ["path", "bytes", "replaced"]);
			}
			try {
				const result = await ports.hostWrite(ednArgsToObject(args));
				return new Map([
					[kw("path"), requested],
					[kw("content"), hostResultText(result)],
					[kw("host"), true],
				]);
			} catch (error) {
				// Host write is unavailable in default mode; preserve the protected VFS path.
				const target = classifyWrite(context, requested);
				const result = vfsWrite(target.batch, target.path, requireArgumentString(args, "content"));
				return operationPath(result, ["path", "bytes", "replaced"]);
			}
		};
	}
	if (capabilities.has("mkdir")) {
		table.mkdir = (args) => {
			const target = classifyWrite(context, requireArgumentString(args, "path"));
			return operationPath(vfsMkdir(target.batch, target.path), ["path"]);
		};
	}
	if (capabilities.has("rm")) {
		table.rm = (args) => {
			const target = classifyWrite(context, requireArgumentString(args, "path"));
			return operationPath(vfsRemove(target.batch, target.path), ["path"]);
		};
	}
	if (capabilities.has("mv")) {
		table.mv = (args) => {
			const source = requireArgumentString(args, "source");
			const target = requireArgumentString(args, "target");
			if (context.role === "auditor") {
				const move = classifyMove(context, source, target);
				return operationPath(vfsMove(move.batch, move.source, move.target), ["source", "target"]);
			}
			return operationPath(vfsMove(context.primary, source, target), ["source", "target"]);
		};
	}
	if (context.role === "auditor" && !auditorSandboxReady(context)) {
		table.call = () => {
			throw herdError("CAPABILITY_DENIED", "auditor call requires an active bwrap sandbox", {
				role: context.role,
				next: "start the per-auditor bwrap session; never fall back to an unsandboxed shell",
			});
		};
	} else if (CALL_FORBIDDEN_ROLES.has(context.role)) {
		table.call = () => {
			throw herdError("CAPABILITY_DENIED", "this role cannot call a black-box shell", {
				role: context.role,
				next: "choose a role with the call capability",
			});
		};
	} else if (CALL_DENIAL_ROLES.has(context.role)) {
		table.call = () => {
			throw tokenRequired(context.role);
		};
	} else if (capabilities.has("call")) {
		table.call = async (args, callCtx) => {
			if (!auditorSandboxReady(context)) {
				throw herdError("CAPABILITY_DENIED", "auditor call requires an active bwrap sandbox", {
					role: context.role,
					next: "start the per-auditor bwrap session; never fall back to an unsandboxed shell",
				});
			}
			const rawArgv = args.argv;
			const argv =
				Array.isArray(rawArgv) ||
				(rawArgv !== null && typeof rawArgv === "object" && typeof rawArgv[Symbol.iterator] === "function")
					? [...rawArgv]
					: rawArgv;
			if (
				!Array.isArray(argv) ||
				argv.length === 0 ||
				argv.some((arg) => typeof arg !== "string") ||
				argv[0].length === 0
			) {
				throw invalidArgument("call argv must be a non-empty string array", { argv });
			}
			if (execution.signal?.aborted === true) {
				throw herdError("UPSTREAM_ABORTED", "call was cancelled before drain", {
					argv,
				});
			}
			if (!context.roots.callLogDir && !context.roots.callLimits.logPath) {
				throw callNeedsLog();
			}
			if (!ports.writeGate) {
				throw invalidArgument("call requires a writeGate port", {
					missing: "writeGate",
					next: "pass the Slice write-gate port when building the sandbox",
				});
			}
			if (!ports.control || typeof ports.control !== "object") {
				throw invalidArgument("call requires a control port", {
					missing: "control",
					next: "pass the board control port when building the sandbox",
				});
			}
			for (const method of ["markApplying", "markRunning", "publishResult", "markUncertain"]) {
				if (typeof ports.control[method] !== "function") {
					throw invalidArgument(`call requires control.${method}`, {
						missing: `control.${method}`,
						next: "pass a board control port with the full commit/call surface",
					});
				}
			}
			const callControl = callControlAdapter(ports.control);
			const identity = await resolvePort(ports.identity);
			const claim = await resolvePort(ports.claim);
			if (identity === undefined || identity === null) {
				throw invalidArgument("call requires an identity port", { missing: "identity" });
			}
			if (claim === undefined || claim === null) {
				throw invalidArgument("call requires a claim port", { missing: "claim" });
			}
			let cwd = context.roots.callCwd ?? undefined;
			if (args.cwd !== undefined && args.cwd !== null) {
				const requestedCwd = requireArgumentString(args, "cwd");
				cwd = context.roots.callCwd === null ? requestedCwd : resolveAgainst(context.roots.callCwd, requestedCwd);
			}
			const targetCwd = cwd;
			const actionId = randomUUID();
			const limits = { ...context.roots.callLimits, actionId };
			if (context.roots.callLogDir) {
				mkdirSync(context.roots.callLogDir, { recursive: true });
				limits.logRoot = context.roots.callLogDir;
				limits.logPath = join(context.roots.callLogDir, `${actionId}.log`);
			}
			let drainedFacts = null;
			ports.onCallActivity?.({ active: true, program: context.programName });
			try {
				if (execution.signal?.aborted === true) {
					throw herdError("UPSTREAM_ABORTED", "call was cancelled before drain", {
						argv,
					});
				}
				drainedFacts = hasOverlay(context) ? await commitContext(context, ports, execution.signal ?? undefined) : null;
				const result = await runCall({
					batch: context.primary,
					argv,
					cwd: targetCwd,
					writeGate: ports.writeGate,
					control: callControl,
					identity,
					claim,
					limits,
					signal: execution.signal ?? undefined,
					onCallHandle: (handle) => {
						if (callCtx?.program) {
							callCtx.program.activeCallHandle = handle;
						}
					},
				});
				if (result.stdioClosed === false && (result.status === ":completed" || result.status === ":failed")) {
					result.reportedStatus = result.status;
					result.status = ":outcome-unknown";
					result.unconfirmedExit = true;
					result.code = result.code ?? ":BOARD_CONFLICT";
				}
				if (drainedFacts !== null && (result.drained === undefined || result.drained?.status === ":noop")) {
					result.drained = drainedFacts;
					const drainedWritten = drainedFacts instanceof Map ? ednField(drainedFacts, "written") : drainedFacts.written;
					if (Array.isArray(drainedWritten)) {
						result.written = drainedWritten;
					}
				}
				const converted = toEdn(result);
				execution.lastCall = result.status === ":outcome-unknown" || result.status === ":cancelled" ? converted : null;
				return converted;
			} catch (error) {
				if (drainedFacts !== null && isHerdError(error)) {
					error.data = { ...(error.data ?? {}), drained: toEdn(drainedFacts) };
				}
				throw error;
			} finally {
				ports.onCallActivity?.({ active: false, program: context.programName });
			}
		};
	}

	return table;
}

function firstNonEmptyString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return "";
}

function observationScopeFor(ports, roots) {
	const provided = ports.observationScope;
	if (provided !== null && typeof provided === "object") {
		return {
			sessionKey: provided.sessionKey,
			actorId: provided.actorId,
			termId: provided.termId,
		};
	}
	const agentId = firstNonEmptyString(ports.agentId, roots.agentId);
	const identity = ports.identity !== null && typeof ports.identity === "object" ? ports.identity : null;
	const claim = ports.claim !== null && typeof ports.claim === "object" ? ports.claim : null;
	const actorId = firstNonEmptyString(ports.actorId, agentId, "sandbox-actor");
	return {
		sessionKey: firstNonEmptyString(ports.sessionKey, agentId, actorId, "sandbox-session"),
		actorId,
		termId: firstNonEmptyString(ports.termId, identity?.term_id, identity?.termId, claim?.term_id, claim?.termId),
	};
}

function createContext(role, roots, observations = null, observationScope = null, programName = null) {
	const primary = createBatch({
		writeRoot: roots.writeRoot,
		limits: roots.limits,
		io: roots.io,
		observations,
		observationScope,
	});
	return {
		role,
		roots,
		primary,
		tmp: null,
		sandbox: roots.sandbox,
		programName,
	};
}

const PARAMETER_TEXT = Object.freeze({
	programName: "Optional REPL name for park/unpark; auto-generated when omitted.",
	code: "Bare ClojureScript REPL input. Any number of top-level forms; the last value is returned.",
	intent: "Concrete zh-cn action intent. Deadline = UTF-8 bytes * 50ms + 1000ms.",
});

function parameters() {
	return {
		type: "object",
		additionalProperties: false,
		required: ["code", "intent"],
		properties: {
			name: {
				type: "string",
				minLength: 1,
				description: PARAMETER_TEXT.programName,
			},
			code: {
				type: "string",
				minLength: 1,
				description: PARAMETER_TEXT.code,
			},
			intent: {
				type: "string",
				minLength: 1,
				description: PARAMETER_TEXT.intent,
			},
		},
	};
}

const ROLE_DENIALS = Object.freeze({
	plan: "No stat, ls, write, mkdir, rm, mv, or call; only cat is bound for contract files and attachments.",
	devops: "Privileged worker: every Worker capability plus call. No token required.",
	review: "No write, mkdir, rm, mv, call, or park; cat, stat, and ls are read-only.",
	worker:
		"No call in a Swarm Worker session; call returns :TOKEN_REQUIRED. A Swarm Holder session grants call under the token.",
	holder: "Writes stage in a private VFS and commit under the injected write gate; call needs the holder token.",
	auditor:
		"write, mkdir, rm, and mv are limited to plans/<slug>/evidence/<case_id>/ and the dedicated /tmp audit root; call runs only inside the per-auditor bwrap sandbox.",
});

function toolDescription(role) {
	const capabilities = CAPABILITY_MATRIX[role].join(", ");
	return `Run ClojureScript REPL input in the ${ROLE_LABELS[role]} sandbox. Bound capabilities: ${capabilities}. ${ROLE_DENIALS[role]}

Tool-First: pass data that the system must parse through its dedicated parameter; a string parameter is a full document channel, not a one-line field, and free-form prose is valid there whenever the tool only stores or displays it. Chat XML tags are not a system data channel. Prose meant for the human reader is fine.

Submit bare REPL input: any number of top-level expressions; the last value is the receipt. Every capability is a bare function taking ONE EDN map—never a receiver, never positional args: (cat {:path ...}), (stat {:path ...}), (ls {:path ...}), (glob {:pattern ... :path ... :exec (fn [p] ...)}), (write {:path ... :content ...}), (mkdir {:path ...}), (rm {:path ...}), (mv {:source ... :target ...}), (where {:content ... :needle ...}), (whereAll {:content ... :needle ...}), (park {:payload ...}), (unpark {:name ... :value ...}), (abandon {:name ...}), (call {:argv ["prog" "arg"] :cwd ...}).

Batch VFS: write/mkdir/rm/mv mutate an in-memory overlay first. The batch commits atomically only when the program returns normally; an exception, (park ...), or a conflict leaves disk untouched. A stamp conflict returns :FILE_CONFLICT. (where ...) requires exactly one UTF-16 match and otherwise parks with :nearest or :candidates; resume with (unpark {:name ... :value [b e]}). (whereAll ...) returns all spans and [] on zero matches. Receipts and structured literals are EDN + UFSS; never hand-build JSON escaping.

call is argv-only: no shell, pipes, redirects, globbing, or &&. Every call must include a non-empty :alternative map (1+ pair) naming built-in tools or other approaches and why they were not chosen; the framework ignores it. clj_* grants a single free 1000ms total call-wait grace at fork time; once cumulative call wait exceeds it, the program backgrounds immediately (:state :forked) and you collect results with wait (deadline = 1000ms + UTF-8 bytes * 50ms). If you want guaranteed synchronous return, do not use call.`;
}

const TOOL_DESCRIPTION_BY_NAME = Object.freeze({
	clj_plan: toolDescription("plan"),
	clj_devops: toolDescription("devops"),
	clj_review: toolDescription("review"),
	clj_worker: toolDescription("worker"),
	clj_auditor: toolDescription("auditor"),
});

/**
 * Return the static host-tool description for one registered tool name.
 *
 * Registration happens before any per-session bundle exists, so the host must
 * use this pure description instead of a generic role blurb. The clj_worker
 * text covers both Worker (call refused) and Holder (call granted) because the
 * same registered tool serves both sessions.
 */
const HOST_READ_WRITE_NOTE =
	"`cat` returns exact byte-for-byte content. `read` delegates to the host read tool and guarantees only readability, not exact fidelity. `write` delegates to the host write tool.";

export function describeSandboxTool(toolName) {
	const description = TOOL_DESCRIPTION_BY_NAME[toolName];
	if (typeof description !== "string") {
		throw invalidArgument(`unknown sandbox tool: ${toolName}`, { toolName });
	}
	return `${description}\n\n${HOST_READ_WRITE_NOTE}`;
}

function success(text, details = {}) {
	return { content: [{ type: "text", text }], details };
}

function failure(name, error) {
	const receipt = new Map([
		[kw("name"), name ?? null],
		[kw("state"), kw("failed")],
		[
			kw("error"),
			new Map([
				[kw("code"), codeValue(error?.code ?? ":INVALID_ARGUMENT")],
				[kw("message"), messageOf(error)],
				[kw("data"), toEdn(isHerdError(error) ? error.data : {})],
			]),
		],
	]);
	let text;
	try {
		text = renderReceipt(receipt);
	} catch {
		text = renderError(error);
	}
	return {
		isError: true,
		content: [{ type: "text", text }],
		details: { code: error?.code ?? null },
	};
}

function receiptState(receipt) {
	if (!(receipt instanceof Map)) {
		return null;
	}
	const state = ednField(receipt, "state");
	return state instanceof EdnKeyword ? state.name : null;
}

function receiptFailure(text, receipt) {
	let code;
	const error = ednField(receipt, "error");
	const value = ednField(error, "code");
	if (value instanceof EdnKeyword) code = `:${value.name}`;
	return {
		isError: true,
		content: [{ type: "text", text }],
		details: code === undefined ? {} : { code },
	};
}

async function readCallMeta(ports, toolCallId) {
	if (typeof toolCallId !== "string" || toolCallId.length === 0) {
		throw herdError("INTENT_REQUIRED", "sandbox tool calls need a tool call id for CallMeta", {
			field: "toolCallId",
		});
	}

	let meta;
	try {
		if (typeof ports.callMeta === "function") {
			meta = await ports.callMeta(toolCallId);
		} else if (ports.callMeta && typeof ports.callMeta.read === "function") {
			meta = await ports.callMeta.read(toolCallId);
		} else if (ports.callMeta && typeof ports.callMeta.readCallMeta === "function") {
			meta = await ports.callMeta.readCallMeta(toolCallId);
		} else if (typeof ports.readCallMeta === "function") {
			meta = await ports.readCallMeta(toolCallId);
		}
	} catch (error) {
		throw herdError("HOST_API_MISMATCH", "CallMeta lookup failed", {
			toolCallId,
			cause: messageOf(error),
		});
	}

	if (!isPlainObject(meta)) {
		throw herdError("INTENT_REQUIRED", "CallMeta is missing for this sandbox call", {
			toolCallId,
			next: "the tool gate must write intentBytes or deadlineAt before stripping intent",
		});
	}
	const deadlineAt = meta.deadlineAt;
	const intentBytes = meta.intentBytes;
	const hasDeadline = Number.isFinite(deadlineAt);
	const hasBytes = Number.isFinite(intentBytes) && intentBytes >= 0;
	if (!hasDeadline && !hasBytes) {
		throw herdError("INTENT_REQUIRED", "CallMeta has no deadline", {
			toolCallId,
			next: "record intentBytes or deadlineAt before stripping intent",
		});
	}
	const result = {};
	if (hasDeadline) result.deadlineAt = deadlineAt;
	if (hasBytes) result.intentBytes = intentBytes;
	return result;
}

function validateParams(params) {
	if (!isPlainObject(params)) {
		throw invalidArgument("sandbox tool parameters must be an object", {
			received: typeof params,
		});
	}
	for (const key of Object.keys(params)) {
		if (GATE_FIELDS.has(key)) {
			throw invalidArgument("gate field reached the sandbox tool before stripping", {
				field: key,
				next: "the tool gate must strip scope and intent first",
			});
		}
		if (!TOOL_FIELDS.has(key)) {
			throw invalidArgument(`unknown sandbox tool field: ${key}`, { field: key });
		}
	}
	const providedName = params.name;
	if (providedName !== undefined && (typeof providedName !== "string" || providedName.length === 0)) {
		throw invalidArgument("name must be a non-empty string when provided", {
			field: "name",
			value: providedName,
		});
	}
	const code = params.code;
	if (typeof code !== "string" || code.trim().length === 0) {
		throw invalidArgument("code must be a non-empty string", { field: "code", value: code });
	}
	const name = providedName ?? `repl-${randomUUID().slice(0, 12)}`;
	const trimmed = code.trimStart();
	if (trimmed.startsWith("(defprogram")) {
		throw invalidArgument("code must be bare REPL input; the defprogram wrapper is no longer accepted", {
			field: "code",
		});
	}
	const source = `(defprogram ${name} []\n${code}\n)`;
	return { name, code: source };
}

/**
 * Build the role tool and its evaluator session.
 *
 * `roots` fields:
 * - `writeRoot`: required directory. Relative paths resolve against it;
 *   absolute paths and `..` are unrestricted.
 * - `evidenceRoot`, `auditTmp`: resolved for auditor callers; no containment
 *   check is applied.
 * - `callLogDir`: directory for complete `call` logs.
 * - `limits`: VFS file/batch/operation limits.
 * - `callLimits`: VFS `runCall` inline/log limits.
 * - `io`: optional VFS host adaptation port.
 *
 * All relative root fields resolve against `writeRoot`.
 *
 * `ports` fields: `writeGate`, `control`, `identity`, `claim`, `callMeta`
 * (or `readCallMeta`), `agentId`. Optional `observations` shares an
 * observation ledger; `observationScope` or `sessionKey`/`actorId`/`termId`
 * overrides the derived actor-term scope.
 * Identity and claim may be functions and are resolved before every commit
 * or call. An AbortSignal cancels only the current program through
 * `abortProgram`; the session remains usable for later calls.
 *
 * Returns `{role, toolName, capabilities, session, tool, tools, execute,
 * observations, observationScope, readSetForActor, verifyObservedFacts,
 * retireActor, retireSession}`. `tools` is an array so a host can register it
 * directly. `verifyObservedFacts` is synchronous and must run while the caller
 * holds the write gate, before taking the board lock.
 */
export function buildSandboxTools({ role, session, roots, ports = {} } = {}) {
	validateMatrix();
	if (!isPlainObject(ports)) {
		throw invalidArgument("ports must be an object", { ports });
	}
	const key = normalizeRole(role);
	const normalizedRoots = normalizeRoots(key, roots);
	const observationScope = observationScopeFor(ports, normalizedRoots);
	const observationEnabled = observationScope.termId.length > 0;
	const observationLedger = observationEnabled ? (ports.observations ?? createObservationLedger()) : null;
	const declaredCapabilities = [...CAPABILITY_MATRIX[key]];
	const capabilities = new Set(declaredCapabilities);
	if (CALL_DENIAL_ROLES.has(key) || CALL_FORBIDDEN_ROLES.has(key)) {
		capabilities.add("call");
	}

	const contexts = new WeakMap();
	const pendingExecutions = new Map();
	const executionsByProgram = new WeakMap();
	const replay = { receipts: new Map(), inFlight: new Map() };
	const REPLAY_LIMIT = 1024;

	function payloadKey(request) {
		return JSON.stringify([toolName, request.name, request.code]);
	}

	function cloneResult(result) {
		return {
			...result,
			content: result.content.map((block) => ({ ...block })),
			details: { ...(result.details ?? {}) },
		};
	}

	function rememberReceipt(toolCallId, key, result) {
		if (replay.receipts.size >= REPLAY_LIMIT) {
			const oldest = replay.receipts.keys().next().value;
			replay.receipts.delete(oldest);
		}
		replay.receipts.set(toolCallId, { key, result });
	}

	function replayMismatch(toolCallId) {
		return herdError("CALL_REPLAY_MISMATCH", "call-id was reused with a different payload", {
			callId: toolCallId,
		});
	}

	const createCapabilities = ({ program }) => {
		if (!program || typeof program !== "object") {
			throw invalidArgument("createCapabilities needs an evaluator program");
		}
		const context = createContext(
			key,
			normalizedRoots,
			observationEnabled ? observationLedger : null,
			observationEnabled ? observationScope : null,
			program.name,
		);
		const execution = pendingExecutions.get(program.name) ?? {
			active: true,
			signal: null,
			toolCallId: null,
			lastCall: null,
		};
		executionsByProgram.set(program, execution);
		contexts.set(program, context);
		return makeCapabilityTable(context, ports, execution);
	};

	const sessionPorts = {
		commit: async ({ program }) => {
			const context = contexts.get(program);
			if (context === undefined) {
				throw invalidArgument("program has no sandbox VFS context", {
					program: program?.name ?? null,
				});
			}
			try {
				const hasOverlay = context.primary.overlay.size > 0 || (context.tmp !== null && context.tmp.overlay.size > 0);
				const hasFacts =
					hasOverlay || context.primary.readSet.size > 0 || (context.tmp !== null && context.tmp.readSet.size > 0);
				if (!hasFacts) {
					return null;
				}
				if (!hasOverlay && !WRITE_ROLES.has(context.role)) {
					return null;
				}
				const execution = executionsByProgram.get(program) ?? { signal: null };
				const result = await commitContext(context, ports, execution.signal ?? undefined);
				return result;
			} finally {
				contexts.delete(program);
			}
		},
		discard: async ({ program }) => {
			contexts.delete(program);
		},
		...(ports.onCallActivity ? { onCallActivity: ports.onCallActivity } : {}),
	};

	let sandboxSession = session;
	if (sandboxSession === undefined || sandboxSession === null) {
		sandboxSession = createSandboxSession({
			agentId: normalizedRoots.agentId ?? ports.agentId ?? "sandbox",
			role: key,
			allowedCapabilities: [...capabilities],
			createCapabilities,
			ports: sessionPorts,
			limits: ports.limits,
		});
		sandboxSession.roots = normalizedRoots;
	} else {
		if (
			typeof sandboxSession !== "object" ||
			!(sandboxSession.programs instanceof Map) ||
			sandboxSession.programs.size > 0
		) {
			throw invalidArgument("session must be a fresh evaluator session", {
				field: "session",
			});
		}
		if (CONFIGURED_SESSIONS.has(sandboxSession)) {
			throw invalidArgument("session already belongs to another sandbox tool", {
				field: "session",
			});
		}
		sandboxSession.allowedCapabilities = capabilities;
		sandboxSession.createCapabilities = createCapabilities;
		sandboxSession.role = key;
		sandboxSession.roots = normalizedRoots;
		const mergedPorts = { ...(sandboxSession.ports ?? {}), ...sessionPorts };
		delete mergedPorts.drain;
		sandboxSession.ports = mergedPorts;
	}
	CONFIGURED_SESSIONS.add(sandboxSession);

	const toolName = TOOL_NAMES[key];
	const runExecution = async (request, signal, toolCallId) => {
		const execution = {
			active: true,
			signal: signal ?? null,
			toolCallId: toolCallId ?? null,
			lastCall: null,
		};
		pendingExecutions.set(request.name, execution);
		let abortListener = null;
		try {
			const callMeta = await readCallMeta(ports, toolCallId);
			if (signal?.aborted === true) {
				throw herdError("UPSTREAM_ABORTED", "sandbox call was cancelled before it started", {
					program: request.name,
				});
			}
			if (signal && typeof signal.addEventListener === "function") {
				abortListener = () => {
					try {
						abortProgram(sandboxSession, request.name, "operator");
					} catch {
						// Cancellation must not replace the program result.
					}
				};
				signal.addEventListener("abort", abortListener, { once: true });
			}
			if (signal?.aborted === true) {
				throw herdError("UPSTREAM_ABORTED", "sandbox call was cancelled before it started", {
					program: request.name,
				});
			}
			const receipt = await runProgram(sandboxSession, {
				name: request.name,
				code: request.code,
				callMeta,
				callId: toolCallId,
			});
			const finalState = receiptState(receipt);
			if (finalState === "completed" || finalState === "failed") {
				contexts.delete(sandboxSession.programs.get(request.name));
			}
			if (receipt instanceof Map) {
				const abandoned = abandonedCapabilities(sandboxSession, request.name);
				if (abandoned.length > 0) {
					receipt.set(kw("abandoned-capabilities"), abandoned);
				}
			}
			if (receipt instanceof Map && execution.lastCall !== null && !receipt.has(kw("interrupted-call"))) {
				receipt.set(kw("interrupted-call"), execution.lastCall);
			}
			let text;
			try {
				text = renderReceipt(receipt);
			} catch (error) {
				return failure(request.name, error);
			}
			return finalState === "failed" ? receiptFailure(text, receipt) : success(text);
		} catch (error) {
			return failure(request.name, error);
		} finally {
			if (abortListener !== null && typeof signal?.removeEventListener === "function") {
				signal.removeEventListener("abort", abortListener);
			}
			pendingExecutions.delete(request.name);
			execution.active = false;
			execution.signal = null;
			execution.toolCallId = null;
			execution.lastCall = null;
		}
	};
	const tool = {
		name: toolName,
		label: `Clojure Sandbox (${ROLE_LABELS[key]})`,
		description: toolDescription(key),
		parameters: parameters(),
		async execute(toolCallId, params, signal) {
			let request;
			try {
				request = validateParams(params);
			} catch (error) {
				return failure(null, error);
			}

			const id = typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : null;
			const key = payloadKey(request);
			if (id !== null) {
				const cached = replay.receipts.get(id);
				if (cached !== undefined) {
					if (cached.key !== key) {
						return failure(request.name, replayMismatch(id));
					}
					return cloneResult(cached.result);
				}
				const running = replay.inFlight.get(id);
				if (running !== undefined) {
					if (running.key !== key) {
						return failure(request.name, replayMismatch(id));
					}
					return cloneResult(await running.promise);
				}
			}

			// Same-agent tool calls may arrive concurrently from the host. The
			// evaluator and VFS are per program, but the call/abort state and the
			// protected commit path are per tool bundle. Serialize the bundles
			// instead of rejecting the later call: no same-agent parallel channel
			// is introduced, and both tool results remain observable.
			const promise = runExecution(request, signal, id);
			if (id !== null) {
				replay.inFlight.set(id, { key, promise });
			}
			let result;
			try {
				result = await promise;
			} catch (error) {
				result = failure(request.name, error);
			} finally {
				if (id !== null) {
					replay.inFlight.delete(id);
				}
			}
			if (id !== null) {
				rememberReceipt(id, key, result);
			}
			return cloneResult(result);
		},
	};

	return {
		role: key,
		toolName,
		capabilities: declaredCapabilities,
		grantedCapabilities: [...capabilities],
		session: sandboxSession,
		tool,
		tools: [tool],
		execute: tool.execute,
		observations: observationEnabled ? observationLedger : null,
		observationScope: observationEnabled ? { ...observationScope } : null,
		readSetForActor: () =>
			observationEnabled
				? observationLedger.readSetForActor(observationScope)
				: {
						ok: false,
						code: ":STALE_CONTROL",
						reason: "term-id-required",
						next: "pass ports.termId and rebuild the tool",
					},
		verifyObservedFacts: (credential, paths) =>
			observationEnabled
				? observationLedger.verifyObservedFacts(credential, paths)
				: {
						ok: false,
						code: ":STALE_CONTROL",
						reason: "term-id-required",
						checked: [],
						missing: Array.isArray(paths) ? paths : [],
					},
		retireActor: () =>
			observationEnabled
				? observationLedger.retireActor(observationScope)
				: { ok: false, code: ":STALE_CONTROL", reason: "term-id-required" },
		retireSession: () =>
			observationEnabled ? observationLedger.retireSession(observationScope.sessionKey) : { ok: true, retired: 0 },
	};
}
