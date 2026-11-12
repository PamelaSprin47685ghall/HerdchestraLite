/**
 * M0: the main assembly.
 *
 * This file connects the real modules through the host's public extension API:
 * prompts, the Scope ledger/projection, the stage gates, the board/worktree
 * lifecycle, the sandbox role tools, commands, and the dashboard. It does not
 * implement board/stage/swarm semantics itself, and it does not import the old
 * pi-goal, pi-context, editor-theme, or manual-acceptance runtime.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { buildSandboxTools, describeSandboxTool } from "./clj-sandbox/tools.mjs";
import { EdnKeyword, printUfss, readUfss } from "./clj-sandbox/ufss.mjs";
import { readHealth, recordHealth } from "./host/health.mjs";
import { COMMON_RULES_TEXT } from "./prompts/common.mjs";
import { buildCaseAuditorPrompt, ROLE_PROMPTS_EARLY, ROLE_PROMPTS_LATE } from "./prompts/roles.mjs";
import { buildUnattendedNudge, LANGUAGE_SKILL, rewriteVibeModeContext } from "./prompts/runtime-wires.mjs";
import { createSandboxedRunCommand, sandboxCapability } from "./sandbox/bwrap.mjs";
import { createAuditorSandbox } from "./sandbox/session.mjs";
import { askPreviousScope, assume, ledgerFor } from "./scope/ledger.mjs";
import { projectMessages, relocateCacheBreakpoints } from "./scope/projection.mjs";
import { gatedObject as sharedGatedObject, gatedPlainSchema as sharedGatedPlainSchema } from "./scope/schema.mjs";
import {
	commitS2,
	createMission,
	freezeStage,
	listMissions,
	readMission,
	readPendingGate,
	readS1Summary,
	readS2Cases,
	readS4Slices,
	realign,
	saveS1Summary,
	saveS2Cases,
	saveStageDocument,
	takeApprovalAuthority,
	verifyContract,
	verifyFrozenPrefix,
	writeDevopsSessionRef,
	writePendingGate,
} from "./stages/contract.mjs";
import { currentBriefing } from "./stages/disclosures.mjs";
import { registerGateTools } from "./stages/gate-tools.mjs";
import { aggregate, writeS5Report } from "./stages/scores.mjs";
import {
	AUDIT_SUBMISSION_SCHEMA,
	createFileSubmissionReader,
	deriveRepairSlices,
	snapshotWorkspace,
	startAuditBatch,
	writeSubmissionOnce,
} from "./swarm/auditors.mjs";
import {
	apply,
	createWriteGateControl,
	initialBoard,
	openBoard,
	readBoard,
	validateDependencyPaths,
} from "./swarm/board.mjs";
import { cancelTree, createRunnerPort, recover } from "./swarm/runner.mjs";
import {
	abandonSlice,
	enqueueSlice,
	forkSlices,
	gcWorktrees,
	joinSlice,
	readWorktreeState,
	worktreePaths,
} from "./swarm/worktree.mjs";
import { deriveDashboard } from "./tui/dashboard-model.mjs";
import { DASHBOARD_TOGGLE_SHORTCUT, mountDashboard } from "./tui/dashboard-widget.mjs";
import { writeFileAtomic } from "./util/atomic-write.mjs";
import { herdError, printEdn, renderError } from "./util/errors.mjs";
import { inspectLock, withLock } from "./util/file-lock.mjs";

const CALL_META_KEY = Symbol.for("herdchestra.callMeta.v1");
const MISSION_PORT_KEY = Symbol.for("herdchestra.mission.v1");
const ROLE_SURFACE_KEY = Symbol.for("herdchestra.roleSurfaces.v1");
let approvalAuthority;
let gateService;

const BOARD_TOOL_NAMES = Object.freeze([
	"board_split",
	"board_claim",
	"board_finish",
	"board_cancel",
	"board_replace",
	"board_release",
	"board_reopen",
	"board_comment",
	"board_update",
	"board_park_slot",
	"board_take_or_die",
]);

const WORKER_BOARD_TOOLS = BOARD_TOOL_NAMES;
const FORBIDDEN_BARE_TOOLS = Object.freeze([
	"apply_patch",
	"bash",
	"edit",
	"eval",
	"exec",
	"find",
	"glob",
	"grep",
	"hub",
	"ls",
	"powershell",
	"python",
	"read",
	"task",
	"write",
]);

const AUDITOR_SANDBOX = sandboxCapability();

const ROLE_SURFACES = Object.freeze({
	"Plan DevOps": Object.freeze(["clj_devops", "submit_devops_report", "ask_previous_scope", "assume", "yield"]),
	Reviewer: Object.freeze(["clj_review", "submit_review", "ask_previous_scope", "assume", "yield"]),
	"Swarm Worker": Object.freeze(["clj_worker", ...WORKER_BOARD_TOOLS, "ask_previous_scope", "assume", "yield"]),
	"Swarm Holder": Object.freeze([
		"clj_worker",
		...WORKER_BOARD_TOOLS,
		"board_take_or_die",
		"abandon_slice",
		"ask_previous_scope",
		"assume",
		"yield",
	]),
	"Manual Auditor": Object.freeze(
		AUDITOR_SANDBOX.available
			? ["clj_auditor", "submit_case_audit", "ask_previous_scope", "assume", "yield"]
			: ["submit_case_audit", "ask_previous_scope", "assume", "yield"],
	),
	"Blocker Oracle": Object.freeze(["clj_review", "submit_oracle_advice", "ask_previous_scope", "assume", "yield"]),
});

export async function boardRoleExitReady(state, ctx) {
	const artifactsDir = artifactsDirFromContext(state, ctx);
	const slug = state.slug ?? slugFromArtifactsPath(artifactsDir) ?? slugFromCwd(ctx?.cwd);
	const sliceId = sliceIdFromCwd(ctx?.cwd);
	if (!slug || !sliceId) return false;
	const board = await openBoard(state.root, slug, sliceId).store.read();
	if (board === null) return false;
	const actorId = sessionIdentity(state, ctx).agent_id;
	const actor = board.actors?.[actorId];
	if (actor?.["life-state"] !== "alive") return true;
	if (board.sleepers?.[actorId] !== undefined) return true;
	// Alive Worker/Holder is not a legal stop by board emptiness or R(a)=∅.
	// It must park in the board transaction or be structurally dead/retired.
	return false;
}

export const ROLE_EXIT_TOOLS = Object.freeze({
	"Plan DevOps": "submit_devops_report",
	Reviewer: "submit_review",
	"Swarm Worker": "board_finish",
	"Swarm Holder": "board_finish",
	"Manual Auditor": "submit_case_audit",
	"Blocker Oracle": "submit_oracle_advice",
});

const ROLE_PROMPTS = Object.freeze({
	"Plan DevOps": ROLE_PROMPTS_EARLY.planDevops,
	Reviewer: ROLE_PROMPTS_LATE.reviewer,
	"Swarm Worker": ROLE_PROMPTS_LATE.swarmWorker,
	"Swarm Holder": ROLE_PROMPTS_LATE.swarmWorker,
	"Blocker Oracle": ROLE_PROMPTS_LATE.blockerOracle,
});

const STAGE_SURFACES = Object.freeze({
	s1: Object.freeze(["clj_plan", "advance_s1", "ask_user", "devops", "ask_previous_scope", "assume"]),
	s2: Object.freeze(["clj_plan", "advance_s2", "realign_frozen", "devops", "ask_previous_scope", "assume"]),
	s3: Object.freeze(["clj_plan", "advance_s3", "realign_frozen", "devops", "ask_previous_scope", "assume"]),
	s4: Object.freeze(["clj_plan", "advance_s4", "realign_frozen", "devops", "ask_previous_scope", "assume"]),
	s5: Object.freeze([
		"ask_user",
		"realign_frozen",
		"fork_slices",
		"join_slice",
		"gc_worktrees",
		"ask_previous_scope",
		"assume",
	]),
});

const ROLE_TOKEN = /^\[HERD_ROLE: ([A-Za-z][A-Za-z0-9 _-]*) nonce=([A-Za-z0-9_-]{8,128})\]$/;

const sessions = new Map();
const extensionPaths = Object.freeze([fileURLToPath(new URL("./bootstrap-main.mjs", import.meta.url))]);

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function hostSettings(pi) {
	// 18.16 ExtensionAPI.pi is the host module namespace; its root export exposes
	// the live Settings proxy. ctx.getSettings()/pi.getSettings() are not public
	// ExtensionContext/ExtensionAPI members in that version. Undefined lets H1
	// fall back to its same-module Settings.instance.
	return pi?.pi?.settings;
}

function sessionIdOf(ctx) {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return id;
	} catch {
		// Fall through to a stable process-local key.
	}
	return "main";
}

function workspaceRoot(cwd) {
	let directory = resolve(typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd());
	for (let depth = 0; depth < 12; depth += 1) {
		if (existsSync(join(directory, "AGENTS.md")) || existsSync(join(directory, ".herd"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return resolve(cwd ?? process.cwd());
}

function stateFor(ctx) {
	const id = sessionIdOf(ctx);
	let state = sessions.get(id);
	if (!state) {
		state = {
			id,
			root: workspaceRoot(ctx?.cwd),
			slug: undefined,
			role: undefined,
			roleNonce: undefined,
			failedRole: false,
			mission: undefined,
			snapshot: undefined,
			tui: undefined,
			escUnsubscribe: undefined,
			settings: undefined,
			capabilities: undefined,
			model: undefined,
			modelRegistry: undefined,
			devopsSessions: new Map(),
			devopsCallId: undefined,
			devopsLastCallId: undefined,
			devopsReportSubmitted: undefined,
			eventBus: undefined,
			turnId: undefined,
			turnTools: new Set(),
			successfulTools: new Set(),
			idleAttempts: 0,
			idleTimer: undefined,
			upstreamAttempts: 0,
			upstreamTimer: undefined,
			stalled: undefined,
			auditAttempts: 0,
			auditRetryTimer: undefined,
			lastAuditFailure: undefined,
			lastToolCallId: undefined,
			auditInvalidated: false,
			cancelled: false,
			lastContext: ctx,
			sandbox: new Map(),
			runnerPorts: new Map(),
			agentLife: new Map(),
			agentTerms: new Map(),
		};
		sessions.set(id, state);
	}
	if (isObject(ctx)) {
		state.lastContext = ctx;
		if (typeof ctx.cwd === "string" && ctx.cwd.length > 0) state.root = workspaceRoot(ctx.cwd);
		if (ctx.model !== undefined) state.model = ctx.model;
		if (ctx.modelRegistry !== undefined) state.modelRegistry = ctx.modelRegistry;
	}
	return state;
}

export function missionStageKey(stage) {
	return typeof stage === "string" ? stage.trim().replace(/^:/, "").toLowerCase() : "";
}

function missionBriefing(stage) {
	const key = missionStageKey(stage);
	return key ? currentBriefing(key) : undefined;
}

function stageSurfaceFor(stage) {
	return STAGE_SURFACES[missionStageKey(stage)];
}

async function applyStageSurface(pi, stage) {
	const surface = stageSurfaceFor(stage);
	if (surface === undefined) return false;
	try {
		await pi.setActiveTools([...surface]);
		return true;
	} catch (error) {
		recordHealth({
			entry: "main.surface",
			status: "degraded",
			version: "1",
			degraded: true,
			error: String(error?.message ?? error),
		});
		return false;
	}
}

function appendPrompt(...parts) {
	return parts.filter((part) => typeof part === "string" && part.length > 0).join("\n\n");
}

function rewriteOutboundPayload(payload) {
	if (!isObject(payload)) return payload;
	const arrays = [payload.messages, payload.request?.messages, payload.body?.messages].filter(Array.isArray);
	for (const messages of arrays) {
		for (const message of messages) {
			if (
				isObject(message) &&
				message.role === "custom" &&
				message.customType === "vibe-mode-context" &&
				typeof message.content === "string"
			) {
				const next = rewriteVibeModeContext(message.content);
				if (next !== message.content) message.content = next;
			}
		}
	}
	return payload;
}

function rememberFocus(state, slug) {
	try {
		state.pi?.appendEntry?.("herd-focus", { slug });
	} catch {
		// Focus persistence is best effort; the current session still works.
	}
}

function publishMission(state) {
	const active = typeof state.slug === "string" && state.slug.length > 0;
	const stage = missionStageKey(state.mission?.stage);
	const blockedTools = [...FORBIDDEN_BARE_TOOLS];
	if (stage === "s5") blockedTools.push("clj_plan");
	const value = Object.freeze({
		active,
		slug: state.slug,
		role: state.role ?? "Coordinator",
		stage,
		blockedTools,
	});
	try {
		Object.defineProperty(globalThis, MISSION_PORT_KEY, {
			value,
			configurable: true,
			enumerable: false,
			writable: false,
		});
	} catch {
		// The gate still has its tool_call fallback.
	}
}

function publishRoleSurfaces() {
	try {
		Object.defineProperty(globalThis, ROLE_SURFACE_KEY, {
			value: ROLE_SURFACES,
			configurable: true,
			enumerable: false,
			writable: false,
		});
	} catch {
		// G1 keeps its built-in role surfaces.
	}
}

function missionApprovalPort(state) {
	if (!approvalAuthority || !state.slug) return undefined;
	if (state.approvalPort && state.approvalPortSlug === state.slug) return state.approvalPort;
	state.approvalPort = approvalAuthority.createPort(state.root, state.slug);
	state.approvalPortSlug = state.slug;
	return state.approvalPort;
}

function roleFromPrompt(text) {
	if (typeof text !== "string") return undefined;
	const first = text.split(/\r?\n/, 1)[0];
	const match = ROLE_TOKEN.exec(first);
	if (!match) return undefined;
	return Object.freeze({ role: match[1], nonce: match[2] });
}

function isSubagentContext(ctx) {
	const agent = ctx?.agent;
	return (
		isObject(agent) &&
		(agent.kind === "sub" || agent.kind === "subagent" || (Number.isFinite(agent.depth) && agent.depth > 0))
	);
}

function parsePrompt(event) {
	if (typeof event?.prompt === "string") return event.prompt;
	if (event?.messageType === "custom") return textOfContent(event.message?.content);
	return "";
}

async function readActiveMission(state) {
	if (!state.slug) return undefined;
	const read = await readMission(state.root, state.slug);
	if (read?.ok !== true) {
		state.mission = undefined;
		return undefined;
	}
	state.mission = await realignEditedFrozen(state, read.mission);
	return state.mission;
}

export async function realignEditedFrozen(state, mission) {
	if (!mission?.frozen || missionStageKey(mission.stage) === "completed") return mission;
	if (state.realignPending) return mission;
	try {
		const callId = `main-realign-${randomUUID()}`;
		if (!gateService?.realign) throw new Error("gate service realign is unavailable");
		const params = { slug: state.slug };
		if (Array.isArray(mission["s3-modules"])) params.modules = mission["s3-modules"];
		const slicesRead = await readS4Slices(state.root, state.slug);
		if (slicesRead?.ok === true && Array.isArray(slicesRead.slices)) params.slices = slicesRead.slices;
		const result = await gateService.realign(params, { root: state.root, callId });
		if (result?.ok !== true) {
			if (result?.error?.code === ":MAPPING_REALIGN_REQUIRED") {
				const data = isObject(result.error.data) ? result.error.data : {};
				const pending = {
					code: ":MAPPING_REALIGN_REQUIRED",
					message: result.error.message,
					data,
					expectedTool: "realign_frozen",
				};
				state.realignPending = pending;
				if (state.auditRunning) state.auditInvalidated = true;
				const nudge = [
					"[MAPPING_REALIGN_REQUIRED]",
					`Expected tool: realign_frozen`,
					`Mission stage: ${mission.stage}`,
					"Submit the complete modules and slices arrays through realign_frozen; do not ask the user and do not keep old mappings.",
					renderError(result.error),
				].join("\n");
				try {
					state.pi?.sendMessage?.({ customType: "herd-nudge", content: nudge, display: false }, { triggerTurn: true });
				} catch {
					// The pending marker remains observable to the next turn.
				}
				recordHealth({
					entry: "main.realign",
					status: "degraded",
					version: "1",
					degraded: true,
					error: "CASE mapping changed; realign_frozen is required",
					capabilities: { expectedTool: "realign_frozen" },
				});
				return mission;
			}
			throw new Error(result?.error?.message ?? "realign failed");
		}
		const realignedTargets = (result.targets ?? []).filter((entry) => entry.status === "realigned");
		if (result.status !== "realigned" && realignedTargets.length === 0) return mission;
		const affected = realignedTargets.flatMap((entry) => {
			const value = entry.affected;
			if (!isObject(value)) return [];
			return Object.entries(value).flatMap(([kind, list]) =>
				Array.isArray(list) ? list.map((item) => `${kind}:${String(item)}`) : [],
			);
		});
		const hint =
			result.alignmentHint ??
			`Frozen documents were realigned to revision ${result.revision ?? "?"}; review their changed sections before continuing.`;
		const fullHint = affected.length > 0 ? `${hint}; affected ${[...new Set(affected)].join(", ")}` : hint;
		try {
			state.pi?.sendMessage?.(
				{ customType: "herd-alignment", content: fullHint, display: false },
				{ deliverAs: "steer" },
			);
		} catch {
			// The durable realign already happened; the hint can be reread from the contract.
		}
		if (state.auditRunning) state.auditInvalidated = true;
		recordHealth({
			entry: "main.realign",
			status: "ok",
			version: "1",
			capabilities: {
				targets: realignedTargets.map((entry) => entry.target),
				affected,
				revision: result.revision,
			},
			degraded: false,
		});
		const reread = await readMission(state.root, state.slug);
		return reread?.ok === true ? reread.mission : mission;
	} catch (error) {
		recordHealth({
			entry: "main.realign",
			status: "degraded",
			version: "1",
			degraded: true,
			error: String(error?.message ?? error),
		});
		throw error;
	}
}

function persistedFocusSlug(ctx) {
	let branch;
	try {
		branch = ctx?.sessionManager?.getBranch?.() ?? [];
	} catch {
		return undefined;
	}
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isObject(entry) || entry.type !== "custom" || entry.customType !== "herd-focus") continue;
		const slug = entry.data?.slug;
		return typeof slug === "string" && slug.length > 0 ? slug : undefined;
	}
	return undefined;
}

async function restoreMissionFocus(state, ctx) {
	if (state.slug) return readActiveMission(state);
	const slug = persistedFocusSlug(ctx);
	if (!slug) return undefined;
	state.slug = slug;
	const mission = await readActiveMission(state);
	if (!mission) {
		state.slug = undefined;
		return undefined;
	}
	missionApprovalPort(state);
	publishMission(state);
	return mission;
}

function toolOk(value, details = {}) {
	return {
		content: [{ type: "text", text: printEdn(value) }],
		details: { ok: true, ...details },
	};
}

function toolFail(error, details = {}) {
	const reason = error instanceof Error ? error : herdError("INVALID_ARGUMENT", String(error ?? "failed"));
	return {
		isError: true,
		content: [{ type: "text", text: renderError(reason) }],
		details: { ok: false, ...details },
	};
}

function toolErrorFromResult(result) {
	if (result?.ok === true) return toolOk(result);
	const error = result?.error ?? result?.errors?.[0] ?? herdError("INVALID_ARGUMENT", "operation rejected");
	return toolFail(error, { result });
}

function slugFor(seed) {
	const base = String(seed)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "")
		.slice(0, 40);
	const suffix = randomUUID().slice(0, 6);
	return `${base || "mission"}-${suffix}`;
}

function boardHandleFor(state, sliceId) {
	if (!state.slug || !sliceId) return undefined;
	return openBoard(state.root, state.slug, sliceId);
}

export function missionBoardPort(root, slug) {
	const handleFor = (sliceId) => openBoard(root, slug, sliceId);
	return {
		async ensureSlice({ sliceId }) {
			const handle = handleFor(sliceId);
			if ((await handle.store.read()) === null) await handle.store.initialize(initialBoard());
			return handle;
		},
		async updateStatus(info) {
			const handle = handleFor(info.sliceId);
			const receipt = await handle.store.transaction(async (current) => {
				if (!current) throw herdError(":STALE_CONTROL", "Slice board is missing", { boardPath: handle.boardPath });
				const slice = { ...(current.slice ?? {}), "slice-id": info.sliceId, status: info.status };
				for (const [key, value] of Object.entries(info)) {
					if (value === undefined || key === "root" || key === "slug" || key === "sliceId") continue;
					slice[key.replaceAll("_", "-")] = value;
				}
				return {
					board: { ...current, slice, "board-version": (current["board-version"] ?? 0) + 1 },
					events: [],
					response: { ok: true },
					commit: true,
				};
			});
			if (receipt?.ok === false) {
				throw herdError(":STALE_CONTROL", "board status update was rejected", { boardPath: handle.boardPath, receipt });
			}
		},
		async assertHolder({ sliceId, actor }) {
			if (!actor || (actor.role && actor.role !== "holder")) return false;
			const agentId = actor.agent_id ?? actor.agentId;
			const termId = actor.term_id ?? actor.termId;
			const current = await handleFor(sliceId).store.read();
			if (!current) return false;
			const token = current["token-slot"] ?? {};
			if (token["holder-id"] !== agentId || token.state !== "held") return false;
			if (termId && token["term-id"] && token["term-id"] !== termId) return false;
			const boardActor = current.actors?.[agentId];
			return boardActor ? boardActor["life-state"] === "alive" : true;
		},
	};
}

function rememberActors(state, board) {
	const tenureTerm =
		typeof board?.tenure?.["term-id"] === "string" && board.tenure["term-id"].length > 0
			? board.tenure["term-id"]
			: Number.isInteger(board?.tenure?.term)
				? `T-${board.tenure.term}`
				: undefined;
	for (const [agentId, actor] of Object.entries(board?.actors ?? {})) {
		state.agentLife.set(agentId, actor?.["life-state"]);
		if (actor?.["life-state"] === "alive" && tenureTerm !== undefined) {
			state.agentTerms.set(agentId, tenureTerm);
		} else if (typeof actor?.["term-id"] === "string" && actor["term-id"].length > 0) {
			state.agentTerms.set(agentId, actor["term-id"]);
		}
	}
}

function retireSandbox(state) {
	for (const built of state.sandbox.values()) {
		try {
			built.retireSession?.();
		} catch {
			// A stale observation ledger must not block cancel.
		}
	}
	state.sandbox.clear();
}

export function sessionIdentity(state, ctx) {
	const agentId = state.role ? (state.roleNonce ?? state.id) : (ctx?.agent?.id ?? ctx?.agent?.name ?? state.id);
	return Object.freeze({
		agent_id: agentId,
		agentId,
		term_id: state.agentTerms?.get(agentId) ?? undefined,
		role: state.role === "Swarm Holder" ? "holder" : "normal",
		status: "alive",
		life_state: "alive",
	});
}

function writeGatePort(state, sliceId, ctx) {
	const agentId = sessionIdentity(state, ctx).agent_id;
	const lockPath = join(state.root, ".herd", "locks", `${sliceId}.write-w.lock`);
	return {
		runExclusive: (run) =>
			withLock(
				lockPath,
				{
					lock_id: `${sliceId}-writeW`,
					purpose: "writeW",
					slice_id: sliceId,
					owner_agent_id: agentId,
					pid: process.pid,
				},
				run,
			),
	};
}

async function finishBoardTask({ state, ctx, slug, sliceId, port, command, turnId, requestId, expectedBoardVersion }) {
	const dependencyPaths = validateDependencyPaths(command.dependencyPaths ?? []);
	if (dependencyPaths === null) {
		return {
			ok: false,
			error: herdError(":INVALID_ARGUMENT", "dependency_paths must be workspace-relative paths", {
				taskId: command.taskId ?? command.task_id,
				field: "dependency_paths",
			}),
		};
	}
	const finishArgs = {
		command: { ...command, dependencyPaths },
		actor: sessionIdentity(state, ctx),
		turnId,
		requestId,
		expectedBoardVersion,
	};
	const role = state.role === "Swarm Holder" ? "holder" : "worker";
	const built = sandboxToolFor(role, ctx, state);
	if (typeof built?.readSetForActor !== "function" || typeof built?.verifyObservedFacts !== "function") {
		return {
			ok: false,
			error: herdError(":STALE_CONTROL", "the sandbox observation ledger is unavailable", {
				field: "read-set",
				next: "rebuild the sandbox with a real term scope; do not finish on unverified file facts",
			}),
		};
	}
	const preflight = built.readSetForActor();
	if (preflight?.ok !== true) {
		return {
			ok: false,
			error: herdError(preflight?.code ?? ":STALE_CONTROL", "no observation credential for this actor", {
				reason: preflight?.reason ?? "read-set-unavailable",
			}),
		};
	}
	const observedPaths = Array.isArray(preflight.credential.entries)
		? preflight.credential.entries.map((entry) => entry.path)
		: [];
	if (dependencyPaths.length === 0 && observedPaths.length === 0) return port.finishTask(finishArgs);
	const workspace = worktreePaths(state.root, slug, sliceId).workspace;
	const dependencyAbsolute = dependencyPaths.map((relative) => {
		const target = resolve(workspace, relative);
		try {
			return realpathSync(target);
		} catch {
			return target;
		}
	});
	const factPaths = dependencyPaths.length > 0 ? dependencyAbsolute : observedPaths;
	const gate = writeGatePort(state, sliceId, ctx);
	const locked = await gate.runExclusive(async () => {
		const readSet = built.readSetForActor();
		if (readSet?.ok !== true) {
			return {
				ok: false,
				error: herdError(readSet?.code ?? ":STALE_CONTROL", "no observation credential for this actor", {
					reason: readSet?.reason ?? "read-set-unavailable",
				}),
			};
		}
		const verified = built.verifyObservedFacts(readSet.credential, factPaths);
		if (verified?.ok !== true) {
			return {
				ok: false,
				error: herdError(verified?.code ?? ":STALE_CONTROL", "observed dependency facts no longer match", {
					reason: verified?.reason ?? "read-set-verification-failed",
					missing: verified?.missing ?? [],
					conflicts: verified?.conflicts ?? [],
				}),
			};
		}
		return port.finishTask({ ...finishArgs, writeLockHeld: true });
	});
	if (locked?.ok !== true) {
		return {
			ok: false,
			error:
				locked?.error ??
				herdError(":RESOURCES_NOT_QUIESCENT", "the slice write lock is busy", {
					sliceId,
					lock: locked?.lock ?? null,
				}),
		};
	}
	let result = locked.value;
	if (result?.ok === true && result.relayPending === true) {
		const relayed = await port.relay();
		if (relayed?.ok === true) {
			try {
				built.retireActor?.();
			} catch {
				// The observation ledger is advisory after the tenure retires.
			}
			result = {
				...result,
				...relayed,
				relayed: true,
				relayDeferred: undefined,
			};
		} else {
			result = {
				...result,
				relayed: false,
				relayDeferred: {
					code: relayed?.error?.code ?? ":RESOURCES_NOT_QUIESCENT",
					message: relayed?.error?.message ?? "relay deferred after write-lock release",
				},
			};
		}
	}
	return result;
}

export async function claimFor(state, sliceId, ctx) {
	const actorId = sessionIdentity(state, ctx).agent_id;
	const handle = boardHandleFor(state, sliceId);
	if (!handle) return undefined;
	const board = await handle.store.read();
	const task = Object.values(board?.tasks ?? {}).find(
		(entry) => entry["claim-owner-id"] === actorId && entry["claim-id"],
	);
	if (!task) return undefined;
	return {
		claim_id: task["claim-id"],
		task_id: task["task-id"],
		status: "active",
	};
}

function readCallMeta(toolCallId) {
	try {
		const registry = globalThis[CALL_META_KEY];
		return registry instanceof Map ? registry.get(toolCallId) : undefined;
	} catch {
		return undefined;
	}
}

export function sandboxRoots(role, ctx, state) {
	const cwd = resolve(ctx?.cwd ?? state.root);
	const binding = role === "auditor" ? auditorBinding(state, ctx) : undefined;
	const artifactsDir = artifactsDirFromContext(state, ctx);
	const slug = state.slug ?? binding?.slug ?? slugFromArtifactsPath(artifactsDir) ?? "unscoped";
	const plans = join(state.root, "plans", slug);
	const sliceId = sliceIdFromCwd(cwd);
	const callLogDir = artifactsDir ?? join(state.root, ".herd", "artifacts", slug, binding?.batchId ?? sliceId ?? role);
	if (role === "auditor") {
		if (!binding) {
			throw herdError(":CAPABILITY_DENIED", "auditor case/batch context is missing", { cwd });
		}
		const evidence = join(state.root, "plans", binding.slug, "evidence", binding.caseId);
		const auditTmp = binding.auditTmp;
		const socketPath = binding.sandboxSocket;
		if (!auditTmp || !socketPath) {
			throw herdError(":CAPABILITY_DENIED", "auditor sandbox context is missing", {
				caseId: binding.caseId,
			});
		}
		mkdirSync(evidence, { recursive: true });
		const runCommand = createSandboxedRunCommand({
			root: state.root,
			evidenceRoot: evidence,
			auditTmp,
			socketDir: dirname(socketPath),
			socketPath,
			sessionName: binding.sandboxSession,
		});
		return {
			writeRoot: state.root,
			evidenceRoot: evidence,
			auditTmp,
			readRoots: [],
			callLogDir,
			io: { runCommand },
			sandbox: {
				available: AUDITOR_SANDBOX.available,
				socketPath,
				sessionName: binding.sandboxSession,
				runCommand,
			},
		};
	}
	if (role === "plan") {
		mkdirSync(plans, { recursive: true });
		return { writeRoot: plans, readRoots: [], callLogDir };
	}
	if (role === "devops") {
		mkdirSync(callLogDir, { recursive: true });
		return {
			writeRoot: state.root,
			readRoots: [],
			callLogDir,
		};
	}
	return {
		writeRoot: cwd,
		readRoots: [state.root, plans],
		callLogDir,
	};
}

export function auditorBinding(state, ctx) {
	const candidates = [
		ctx?.auditContext,
		ctx?.agent?.auditContext,
		ctx?.artifactsDir,
		ctx?.sessionManager?.getArtifactsDir?.(),
		ctx?.sessionManager?.getSessionFile?.(),
		state?.lastContext?.artifactsDir,
	];
	for (const candidate of candidates) {
		if (isObject(candidate)) {
			const slug = candidate.slug;
			const caseId = candidate.caseId ?? candidate.case_id ?? candidate.assignedCase;
			const batchId = candidate.batchId ?? candidate.batch_id;
			const artifactsDir = candidate.artifactsDir ?? candidate["artifacts-dir"];
			if (typeof slug === "string" && typeof caseId === "string") {
				const context = typeof artifactsDir === "string" ? readAuditContextDir(artifactsDir) : undefined;
				return {
					...(context ?? {}),
					slug,
					caseId,
					batchId: batchId ?? context?.batchId,
					artifactsDir: artifactsDir ?? context?.artifactsDir,
					auditTmp: candidate.auditTmp ?? candidate["audit-tmp"] ?? context?.auditTmp,
					sandboxSocket: candidate.sandboxSocket ?? candidate["sandbox-socket"] ?? context?.sandboxSocket,
					sandboxSession: candidate.sandboxSession ?? candidate["sandbox-session"] ?? context?.sandboxSession,
				};
			}
		}
		if (typeof candidate !== "string") continue;
		for (const directory of [candidate, dirname(candidate)]) {
			const context = readAuditContextDir(directory);
			if (context) return context;
		}
		const normalized = `/${candidate.replaceAll("\\", "/").replace(/^\/+/, "")}`;
		const marker = "/.herd/artifacts/";
		const at = normalized.indexOf(marker);
		if (at < 0) continue;
		const parts = normalized
			.slice(at + marker.length)
			.split("/")
			.filter(Boolean);
		if (parts[1] !== "audit") continue;
		const rest = parts.slice(2);
		if (rest.length === 0) continue;
		if (/^CASE-[A-Za-z0-9_-]+$/.test(rest[0])) {
			return { slug: parts[0], caseId: rest[0] };
		}
		if (rest.length >= 2 && /^CASE-[A-Za-z0-9_-]+$/.test(rest[1])) {
			return { slug: parts[0], batchId: rest[0], caseId: rest[1] };
		}
	}
	return undefined;
}

function evidencePorts(state, evidenceRoot, caseId, kind = "audit") {
	const actions = new Map();
	const control = {
		async markApplying(payload = {}) {
			const actionId = payload.actionId ?? payload.action_id ?? randomUUID();
			actions.set(actionId, { status: "applying", ...payload });
			return { ok: true, actionId };
		},
		async publishResult(payload = {}) {
			const actionId = payload.actionId ?? payload.action_id;
			if (actionId) actions.set(actionId, { status: "finished", ...payload });
			return { ok: true };
		},
		async markUncertain(payload = {}) {
			const actionId = payload.actionId ?? payload.action_id;
			if (actionId) actions.set(actionId, { status: "uncertain", ...payload });
			return { ok: true };
		},
		async markRunning(payload = {}) {
			const actionId = payload.actionId ?? payload.action_id;
			if (actionId) actions.set(actionId, { status: "running", ...payload });
			return { ok: true, actionId };
		},
		async verifyClaim() {
			return { ok: true };
		},
	};
	mkdirSync(join(state.root, ".herd", "locks"), { recursive: true });
	const lockPath = join(state.root, ".herd", "locks", `${state.slug ?? "unscoped"}-${kind}-${caseId}.write-w.lock`);
	const writeGate = {
		runExclusive: (run) =>
			withLock(
				lockPath,
				{
					lock_id: `${kind}-${caseId}`,
					purpose: kind === "devops" ? "plan-devops-call" : "auditor-evidence",
					slice_id: caseId,
					owner_agent_id: state.id,
					pid: process.pid,
				},
				run,
			),
	};
	return {
		writeGate,
		control,
		identity: { agent_id: state.id, status: "alive" },
		claim: { claim_id: `${kind}-${caseId}`, status: "active" },
		evidenceRoot,
	};
}

function sandboxToolFor(role, ctx, state) {
	const binding = role === "auditor" ? auditorBinding(state, ctx) : undefined;
	const slug = state.slug ?? binding?.slug ?? slugFromCwd(ctx?.cwd);
	const scopedState = slug ? { ...state, slug } : state;
	const actorIdentity = sessionIdentity(state, ctx);
	const termId = actorIdentity.term_id;
	const key = `${role}\u0000${ctx?.cwd ?? ""}\u0000${slug ?? ""}\u0000${binding?.batchId ?? ""}\u0000${binding?.caseId ?? ""}\u0000${termId ?? ""}`;
	let built = state.sandbox.get(key);
	if (built) return built;
	const roots = sandboxRoots(role, ctx, scopedState);
	const sliceId = sliceIdFromCwd(ctx?.cwd);
	const board = boardHandleFor(scopedState, sliceId);
	const sliceControl = board ? createWriteGateControl(board) : undefined;
	const sliceWriteGate = board && sliceId ? writeGatePort(scopedState, sliceId, ctx) : undefined;
	const standalonePorts =
		role === "auditor"
			? evidencePorts(
					scopedState,
					roots.evidenceRoot,
					binding?.caseId ?? "",
					binding?.batchId ? `audit-${binding.batchId}` : "audit",
				)
			: role === "devops"
				? evidencePorts(scopedState, undefined, "call", "devops")
				: undefined;
	built = buildSandboxTools({
		role,
		roots,
		ports: {
			callMeta: readCallMeta,
			writeGate: standalonePorts?.writeGate ?? sliceWriteGate,
			control: standalonePorts?.control ?? sliceControl,
			identity: standalonePorts?.identity ?? sessionIdentity(state, ctx),
			claim: standalonePorts?.claim ?? (() => claimFor(scopedState, sliceId, ctx)),
			agentId: actorIdentity.agent_id,
			termId,
			sessionKey: state.id,
		},
	});
	state.sandbox.set(key, built);
	return built;
}

function sliceIdFromCwd(cwd) {
	if (typeof cwd !== "string") return undefined;
	const match = /[\\/]\.herd-worktrees[\\/]([^\\/]+)[\\/]([^\\/]+)/.exec(cwd);
	return match ? match[2] : undefined;
}

function slugFromCwd(cwd) {
	if (typeof cwd !== "string") return undefined;
	const match = /[\\/]\.herd-worktrees[\\/]([^\\/]+)[\\/]/.exec(cwd);
	return match ? match[1] : undefined;
}

function artifactsDirFromContext(state, ctx) {
	const candidates = [
		ctx?.sessionManager?.getArtifactsDir?.(),
		ctx?.artifactsDir,
		ctx?.sessionManager?.getSessionFile?.(),
		state?.lastContext?.artifactsDir,
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate.length === 0) continue;
		return candidate.endsWith(".jsonl") ? dirname(candidate) : candidate;
	}
	return undefined;
}

function slugFromArtifactsPath(path) {
	if (typeof path !== "string") return undefined;
	const match = /[\\/]\.herd[\\/]artifacts[\\/]([^\\/]+)[\\/]/.exec(path);
	return match ? match[1] : undefined;
}

function ednField(map, key) {
	if (!(map instanceof Map)) return undefined;
	for (const [name, value] of map) {
		if (name instanceof EdnKeyword && name.name === key) return value;
	}
	return undefined;
}

function readAuditContextDir(directory) {
	try {
		const value = readUfss(readFileSync(join(directory, "audit-context.edn"), "utf8"));
		const slug = ednField(value, "slug");
		const batchId = ednField(value, "batch-id");
		const caseId = ednField(value, "case-id");
		if (typeof slug === "string" && typeof batchId === "string" && typeof caseId === "string") {
			return {
				slug,
				batchId,
				caseId,
				artifactsDir: ednField(value, "artifacts-dir") ?? directory,
				auditTmp: ednField(value, "audit-tmp"),
				sandboxSocket: ednField(value, "sandbox-socket"),
				sandboxSession: ednField(value, "sandbox-session"),
			};
		}
	} catch {
		// The context file is optional for non-auditor roles.
	}
	return undefined;
}

export function writeAuditSubmission(state, binding, params) {
	const result = writeSubmissionOnce({
		root: state.root,
		slug: binding.slug,
		batchId: binding.batchId,
		caseId: binding.caseId,
		submission: params,
	});
	if (result?.ok !== true) {
		throw herdError(result.code ?? ":INVALID_ARGUMENT", result.message ?? "submission write failed", {
			caseId: binding.caseId,
			batchId: binding.batchId,
			path: result.path,
		});
	}
	return result.path;
}

const DEVOPS_CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVOPS_NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const DEVOPS_CALL_LINE_RE = /^[ \t]*DevOps call:[ \t]*([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]*$/;

/** Allocate the private receipt namespace for one parent devops call. */
export function newDevopsCallId() {
	return `devops-${randomUUID()}`;
}

function devopsReportDir(state, ctx) {
	// Diagnostic/storage fallback used for slug inference.
	return artifactsDirFromContext(state, ctx);
}

function devopsReceiptDir(ctx) {
	// The host may expose a per-agent artifacts directory through
	// sessionManager.getArtifactsDir(), while the transcript file remains at
	// <parent-issued-artifactsDir>/<agentId>.jsonl. The parent only knows the
	// parent-issued base, so receipts must use the session file's directory.
	// Never fall back to the per-agent artifacts directory: that would write a
	// valid report where the parent does not read it.
	const sessionFile = ctx?.sessionManager?.getSessionFile?.();
	if (typeof sessionFile !== "string" || sessionFile.length === 0) {
		throw herdError(":HOST_API_MISMATCH", "devops report has no child session file path", {
			next: "the host must persist the child transcript under the parent-issued artifacts directory",
		});
	}
	return dirname(sessionFile);
}

/**
 * Read the internal call-id from the parent-authored task text.
 *
 * The model never supplies this value; `runDevops` injects it into the task
 * and `before_agent_start` stores it on the child's state before any tool can
 * run.
 */
function devopsCallIdFromText(text) {
	if (typeof text !== "string") return undefined;
	let found;
	for (const line of text.split(/\r?\n/)) {
		if (found) break;
		const match = DEVOPS_CALL_LINE_RE.exec(line);
		if (match && DEVOPS_CALL_ID_RE.test(match[1])) found = match[1];
	}
	return found;
}

function lastUserText(ctx) {
	let entries;
	try {
		entries = ctx?.sessionManager?.getEntries?.();
	} catch {
		return undefined;
	}
	if (!Array.isArray(entries)) return undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const message = entries[index]?.message;
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) continue;
		const parts = content
			.map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text : undefined))
			.filter((part) => typeof part === "string");
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

function devopsReportPath(directory, callId) {
	return join(directory, "devops-reports", `${callId}.edn`);
}

export function writeDevopsReport(state, ctx, report) {
	const directory = devopsReceiptDir(ctx);
	if (!directory) throw herdError(":HOST_API_MISMATCH", "devops report has no framework artifacts directory", {});
	let callId = state?.devopsCallId;
	if (typeof callId !== "string" || !DEVOPS_CALL_ID_RE.test(callId)) {
		// Follow-up turns may not emit before_agent_start on every host. The
		// current parent prompt is still trusted; accept it only if it is not
		// the call-id already consumed by this child.
		const fallback = devopsCallIdFromText(lastUserText(ctx));
		if (fallback && fallback === state?.devopsLastCallId) {
			throw herdError(":INVALID_ARGUMENT", "devops report already submitted for this call", {
				callId: fallback,
			});
		}
		if (fallback) callId = fallback;
	}
	if (typeof callId !== "string" || !DEVOPS_CALL_ID_RE.test(callId)) {
		throw herdError(":HOST_API_MISMATCH", "devops report has no trusted parent call-id", {});
	}
	const receiptDirectory = join(directory, "devops-reports");
	mkdirSync(receiptDirectory, { recursive: true });
	const record = new Map([
		[new EdnKeyword("status"), report.status],
		[new EdnKeyword("report-markdown"), report.report_markdown],
		[new EdnKeyword("inspected-paths"), report.inspected_paths],
	]);
	writeFileAtomic(receiptDirectory, `${callId}.edn`, printUfss(record));
	state.devopsLastCallId = callId;
	state.devopsReportSubmitted = callId;
	state.devopsCallId = undefined;
}

export function readDevopsReport(directory, callId) {
	if (typeof callId !== "string" || !DEVOPS_CALL_ID_RE.test(callId)) return undefined;
	try {
		const value = readUfss(readFileSync(devopsReportPath(directory, callId), "utf8"));
		const status = ednField(value, "status");
		const reportMarkdown = ednField(value, "report-markdown");
		const inspectedPaths = ednField(value, "inspected-paths");
		if (typeof status !== "string" || typeof reportMarkdown !== "string" || !Array.isArray(inspectedPaths)) {
			return undefined;
		}
		return {
			status,
			report_markdown: reportMarkdown,
			inspected_paths: inspectedPaths,
		};
	} catch {
		return undefined;
	}
}

export function devopsReportAfterChildFailure(outcome, directory, callId) {
	const report = readDevopsReport(directory, callId);
	if (!report) return undefined;
	return {
		ok: true,
		status: report.status === "blocked" ? "blocked" : "devops-report",
		report,
		agentId: outcome?.agentId,
		callId,
		childError: outcome?.error ?? { code: ":AGENT_SPAWN_FAILED", message: "devops child failed" },
	};
}

function boardToolContext(state, ctx) {
	const artifactsDir = artifactsDirFromContext(state, ctx);
	const slug = state.slug ?? slugFromArtifactsPath(artifactsDir) ?? slugFromCwd(ctx?.cwd);
	const sliceId = sliceIdFromCwd(ctx?.cwd);
	if (!slug || !sliceId) {
		throw herdError(":HOST_API_MISMATCH", "board tool needs trusted mission and Slice context", {});
	}
	return { slug, sliceId };
}

function boardFields(value = {}) {
	const fields = {};
	const map = {
		goal: "goal",
		remaining_work: "remainingWork",
		done_when: "doneWhen",
		needs_token: "needsToken",
	};
	for (const [from, to] of Object.entries(map)) {
		if (value[from] !== undefined) fields[to] = value[from];
	}
	return fields;
}

function boardChild(value = {}) {
	return {
		goal: value.goal,
		remainingWork: value.remaining_work,
		doneWhen: value.done_when,
		needsToken: value.needs_token === true,
	};
}

export function trustedMissionSlug(state, ctx) {
	return state.slug ?? slugFromArtifactsPath(devopsReportDir(state, ctx)) ?? slugFromCwd(ctx?.cwd);
}

function trustedDevopsSlug(state, ctx, fallback) {
	return trustedMissionSlug(state, ctx) ?? fallback;
}

function gatedObject(properties, options = { additionalProperties: false }) {
	return sharedGatedObject(Type, properties, options);
}

function gatedPlainSchema(schema) {
	return sharedGatedPlainSchema(schema);
}

function registerSandboxTool(pi, toolName, role) {
	pi.registerTool({
		name: toolName,
		label: toolName,
		description: describeSandboxTool(toolName),
		parameters: gatedObject(
			{
				name: Type.String({ minLength: 1 }),
				code: Type.String({ minLength: 1 }),
				intent: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			try {
				const effectiveRole = role === "worker" && state.role === "Swarm Holder" ? "holder" : role;
				const built = sandboxToolFor(effectiveRole, ctx, state);
				return await built.tool.execute(toolCallId, params, signal);
			} catch (error) {
				return toolFail(error, { tool: toolName });
			}
		},
	});
}

function registerBoardTools(pi) {
	const child = Type.Object(
		{
			goal: Type.String({ minLength: 1 }),
			remaining_work: Type.String({ minLength: 1 }),
			done_when: Type.String({ minLength: 1 }),
			needs_token: Type.Boolean(),
		},
		{ additionalProperties: false },
	);
	const replacement = Type.Object(
		{
			goal: Type.String({ minLength: 1 }),
			remaining_work: Type.String({ minLength: 1 }),
			done_when: Type.String({ minLength: 1 }),
			needs_token: Type.Boolean(),
		},
		{ additionalProperties: false },
	);
	const specs = [
		{
			name: "board_split",
			description: "Split a parent task before claiming; children become ready and the parent waits.",
			properties: {
				parent_id: Type.String({ minLength: 1 }),
				expected_board_version: Type.Number(),
				children: Type.Array(child, { minItems: 1 }),
				remaining_work: Type.String({ minLength: 1 }),
				wait_for: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			},
			toCommand: (params) => ({
				type: "split",
				parentId: params.parent_id,
				expectedBoardVersion: params.expected_board_version,
				children: params.children.map(boardChild),
				remainingWork: params.remaining_work,
				...(params.wait_for === undefined ? {} : { waitFor: params.wait_for }),
			}),
		},
		{
			name: "board_claim",
			description: "Claim one ready task and receive a unique claim id.",
			properties: {
				task_id: Type.String({ minLength: 1 }),
				atomicity_reason: Type.String({ minLength: 1 }),
			},
			toCommand: (params) => ({
				type: "claim",
				taskId: params.task_id,
				atomicityReason: params.atomicity_reason,
			}),
		},
		{
			name: "board_finish",
			description: "Finish one claimed task; dependency paths are checked as file facts.",
			properties: {
				task_id: Type.String({ minLength: 1 }),
				claim_id: Type.String({ minLength: 1 }),
				result_summary: Type.String({ minLength: 1 }),
				dependency_paths: Type.Array(Type.String({ minLength: 1 })),
			},
			toCommand: (params) => ({
				type: "finish",
				taskId: params.task_id,
				claimId: params.claim_id,
				resultSummary: params.result_summary,
				dependencyPaths: params.dependency_paths,
			}),
		},
		{
			name: "board_cancel",
			description: "Cancel a leaf task with a reason.",
			properties: { task_id: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) },
			toCommand: (params) => ({ type: "cancel", taskId: params.task_id, reason: params.reason }),
		},
		{
			name: "board_replace",
			description: "Replace one leaf task and update its parent wait set.",
			properties: {
				task_id: Type.String({ minLength: 1 }),
				replacement,
				reason: Type.String({ minLength: 1 }),
			},
			toCommand: (params) => ({
				type: "replace",
				taskId: params.task_id,
				replacement: boardChild(params.replacement),
				reason: params.reason,
			}),
		},
		{
			name: "board_release",
			description: "Release a claim before entering applying.",
			properties: { task_id: Type.String({ minLength: 1 }), claim_id: Type.String({ minLength: 1 }) },
			toCommand: (params) => ({ type: "release", taskId: params.task_id, claimId: params.claim_id }),
		},
		{
			name: "board_reopen",
			description: "Reopen a done task with a reason and optional evidence.",
			properties: {
				task_id: Type.String({ minLength: 1 }),
				reason: Type.String({ minLength: 1 }),
				evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			},
			toCommand: (params) => ({
				type: "reopen",
				taskId: params.task_id,
				reason: params.reason,
				evidence: params.evidence,
			}),
		},
		{
			name: "board_comment",
			description: "Append a comment to a task without changing its state.",
			properties: { task_id: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) },
			toCommand: (params) => ({ type: "comment", taskId: params.task_id, text: params.text }),
		},
		{
			name: "board_update",
			description: "Update allowed task fields without bypassing split/claim/finish.",
			properties: {
				task_id: Type.String({ minLength: 1 }),
				fields: Type.Object({}, { additionalProperties: true }),
			},
			toCommand: (params) => ({ type: "update", taskId: params.task_id, fields: boardFields(params.fields) }),
		},
		{
			name: "board_park_slot",
			description: "Park this slot only when the observed board version still has no progressable work.",
			properties: { observed_board_version: Type.Number() },
			toCommand: (params) => ({ type: "parkSlot", observedBoardVersion: params.observed_board_version }),
		},
		{
			name: "board_take_or_die",
			description: "Irreversibly compete for the Holder token.",
			properties: {
				request_id: Type.String({ minLength: 1 }),
				confirm: Type.String({ minLength: 1 }),
				handoff_markdown: Type.String({ minLength: 1 }),
			},
			toCommand: (params) => ({
				type: "takeOrDie",
				confirm: params.confirm,
				handoffMarkdown: params.handoff_markdown,
			}),
		},
	];
	for (const spec of specs) {
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: spec.description,
			parameters: gatedObject(spec.properties, { additionalProperties: false }),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const state = stateFor(ctx);
				const { slug, sliceId } = boardToolContext(state, ctx);
				const handle = openBoard(state.root, slug, sliceId);
				if (handle.durable !== true) {
					recordHealth({
						entry: "board.persistence",
						status: "degraded",
						version: "1",
						capabilities: { durable: false },
						degraded: true,
						error: "no durable board store was injected; board transitions are process-local",
					});
				}
				const command = spec.toCommand(params);
				if (spec.name === "board_finish") {
					const current = await readBoard(handle).catch(() => null);
					if (isObject(current)) rememberActors(state, current);
					const port = runnerPortFor(state, slug, sliceId);
					if (typeof port.finishTask !== "function") {
						return toolFail(
							herdError(":HOST_API_MISMATCH", "runner port cannot atomically finish board tasks", {
								slice_id: sliceId,
							}),
						);
					}
					const result = await finishBoardTask({
						state,
						ctx,
						slug,
						sliceId,
						port,
						command,
						turnId: state.turnId ?? toolCallId,
						requestId: params.request_id ?? toolCallId,
						expectedBoardVersion: params.expected_board_version,
					});
					if (isObject(result?.board)) rememberActors(state, result.board);
					return toolErrorFromResult(result);
				}
				let result = await apply({
					board: handle,
					command,
					actor: sessionIdentity(state, ctx),
					turnId: state.turnId ?? toolCallId,
					requestId: params.request_id ?? toolCallId,
					expectedBoardVersion: params.expected_board_version,
				});
				if (isObject(result?.board)) rememberActors(state, result.board);
				if (result?.ok === true && (command.type === "release" || command.type === "reopen")) {
					try {
						const wake = await wakeRunnerAfterBoardCommand(state, slug, sliceId, command);
						if (wake?.ok === false) {
							recordHealth({
								entry: "main.board-wake",
								status: "degraded",
								version: "1",
								degraded: true,
								error: `${wake.error?.code ?? ":HOST_API_MISMATCH"}: ${wake.error?.message ?? "runner wake failed"}`,
							});
						}
						result = { ...result, wake };
					} catch (error) {
						recordHealth({
							entry: "main.board-wake",
							status: "degraded",
							version: "1",
							degraded: true,
							error: String(error?.message ?? error),
						});
						result = { ...result, wake: { ok: false, error: { message: String(error?.message ?? error) } } };
					}
				}
				return toolErrorFromResult(result);
			},
		});
	}
}

function registerSpawnTools(pi) {
	pi.registerTool({
		name: "fork_slices",
		label: "Fork Slices",
		description: "Create the ready Slice worktrees and start their tenure runners.",
		parameters: gatedObject(
			{
				slug: Type.String({ minLength: 1 }),
				slices: Type.Array(Type.Object({}, { additionalProperties: true }), { minItems: 1 }),
				base: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			try {
				const handles = await forkSlices({
					root: state.root,
					slug: params.slug,
					slices: params.slices,
					base: params.base ?? "HEAD",
					deps: { board: missionBoardPort(state.root, params.slug) },
				});
				for (const handle of handles) {
					const slice = {
						root: state.root,
						slug: params.slug,
						slice_id: handle.slice_id,
						workspace: handle.workspace,
						base: handle.base_commit,
					};
					const port = createRunnerPort({ slice, deps: runnerDeps(state, slice) });
					state.runnerPorts.set(handle.slice_id, port);
					const started = await port.startSlice(handle);
					if (started?.ok !== true) return toolErrorFromResult(started);
				}
				return toolOk({ ok: true, handles });
			} catch (error) {
				return toolFail(error);
			}
		},
	});
	pi.registerTool({
		name: "join_slice",
		label: "Join Slice",
		description: "Drain one completed Slice from the FIFO queue and fast-forward it.",
		parameters: gatedObject({ slug: Type.String({ minLength: 1 }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			try {
				const joined = await joinSlice({
					root: state.root,
					slug: params.slug,
					deps: { board: missionBoardPort(state.root, params.slug) },
				});
				if (joined?.status === "none") void runMissionAudit(state);
				return toolOk(joined);
			} catch (error) {
				return toolFail(error);
			}
		},
	});
	pi.registerTool({
		name: "abandon_slice",
		label: "Abandon Slice",
		description: "Retire one Slice with a recorded reason.",
		parameters: gatedObject(
			{
				slug: Type.String({ minLength: 1 }),
				slice_id: Type.String({ minLength: 1 }),
				reason: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			if (state.role !== "Swarm Holder") {
				return toolFail(herdError(":CAPABILITY_DENIED", "only a Swarm Holder may abandon a Slice", {}));
			}
			try {
				return toolOk(
					await abandonSlice({
						root: state.root,
						slug: params.slug,
						sliceId: params.slice_id,
						reason: params.reason,
						actor: sessionIdentity(state, ctx),
						deps: { board: missionBoardPort(state.root, params.slug) },
					}),
				);
			} catch (error) {
				return toolFail(error);
			}
		},
	});
	pi.registerTool({
		name: "gc_worktrees",
		label: "GC Worktrees",
		description: "Collect joined or abandoned Slice worktrees after the retention window.",
		parameters: gatedObject(
			{
				slug: Type.String({ minLength: 1 }),
				retain_days: Type.Optional(Type.Number({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			try {
				return toolOk(
					await gcWorktrees({
						root: state.root,
						slug: params.slug,
						retainDays: params.retain_days,
						deps: { board: missionBoardPort(state.root, params.slug) },
					}),
				);
			} catch (error) {
				return toolFail(error);
			}
		},
	});
}

function registerRealignTool(pi) {
	const moduleSchema = Type.Object(
		{
			path: Type.String({ minLength: 1 }),
			secret_owned: Type.String({ minLength: 1 }),
			depends_on: Type.Array(Type.String({ minLength: 1 })),
			mapped_cases: Type.Array(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	);
	const sliceSchema = Type.Object(
		{
			slice_id: Type.String({ minLength: 1 }),
			goal: Type.String({ minLength: 1 }),
			inputs: Type.String({ minLength: 1 }),
			depends_on: Type.Array(Type.String({ minLength: 1 })),
			done_when: Type.String({ minLength: 1 }),
			mapped_cases: Type.Array(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	);
	pi.registerTool({
		name: "realign_frozen",
		label: "Realign Frozen Contract",
		description:
			"Structured realignment after a human edit or CASE change. When CASE mappings changed, pass the complete modules and slices arrays; never derive mappings from chat.",
		parameters: gatedObject(
			{
				slug: Type.String({ minLength: 1 }),
				target: Type.Optional(Type.String({ minLength: 1 })),
				modules: Type.Optional(Type.Array(moduleSchema, { minItems: 1 })),
				slices: Type.Optional(Type.Array(sliceSchema, { minItems: 1 })),
			},
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			const slug = params.slug || state.slug;
			if (!slug) return toolFail(herdError(":INVALID_ARGUMENT", "realign_frozen needs a mission slug"));
			const payload = { slug };
			if (params.target !== undefined) payload.target = params.target;
			if (params.modules !== undefined) {
				payload.modules = params.modules.map((entry) => ({
					path: entry.path,
					secret_owned: entry.secret_owned,
					depends_on: entry.depends_on,
					"mapped-cases": entry.mapped_cases,
				}));
			}
			if (params.slices !== undefined) {
				payload.slices = params.slices.map((entry) => ({
					slice_id: entry.slice_id,
					goal: entry.goal,
					inputs: entry.inputs,
					depends_on: entry.depends_on,
					done_when: entry.done_when,
					"mapped-cases": entry.mapped_cases,
				}));
			}
			const result = await gateService.realign(payload, {
				root: state.root,
				callId: `main-realign-${toolCallId}`,
			});
			if (result?.ok !== true) return toolErrorFromResult(result);
			const reread = await readMission(state.root, slug);
			if (reread?.ok === true) state.mission = reread.mission;
			state.realignPending = null;
			if (state.auditRunning) state.auditInvalidated = true;
			const hint =
				result.alignmentHint ??
				`Frozen contract realigned to revision ${result.revision ?? "?"}; old audits are invalid.`;
			try {
				state.pi?.sendMessage?.(
					{ customType: "herd-alignment", content: hint, display: false },
					{ deliverAs: "steer" },
				);
			} catch {
				// The durable state is authoritative; the hint is advisory.
			}
			if (!state.auditRunning && missionStageKey(state.mission?.stage) === "s5") {
				void runMissionAudit(state);
			}
			return toolOk(result);
		},
	});
}

function registerScopeAndAuditTools(pi) {
	pi.registerTool({
		name: "ask_previous_scope",
		label: "Ask Previous Scope",
		description: "Read the previous Scope conclusion from the session ledger.",
		parameters: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			try {
				const ledger = ledgerFor(state.id, state.id);
				return toolOk(
					askPreviousScope(ledger, {
						questions: typeof params?.query === "string" ? params.query : "",
						callId: toolCallId,
						deliver: (steer) => {
							if (typeof state.pi?.sendMessage !== "function") {
								throw new Error("host steer port is unavailable");
							}
							const content = steer.answer_edn ?? printEdn(steer.answer);
							return state.pi.sendMessage(
								{ customType: "herd-scope-answer", content, display: false },
								{ deliverAs: "steer" },
							);
						},
					}),
				);
			} catch (error) {
				return toolFail(error);
			}
		},
	});
	pi.registerTool({
		name: "assume",
		label: "Assume",
		description: "Record one explicit lemma in the Scope ledger.",
		parameters: Type.Object({ lemma: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			try {
				return toolOk(assume(ledgerFor(state.id, state.id), params.lemma));
			} catch (error) {
				return toolFail(error);
			}
		},
	});
	pi.registerTool({
		name: "submit_case_audit",
		label: "Submit Case Audit",
		description: "Submit one Manual Auditor's CASE verdict and evidence paths.",
		parameters: gatedPlainSchema(AUDIT_SUBMISSION_SCHEMA),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!AUDITOR_SANDBOX.available) {
				return toolFail(herdError(":CAPABILITY_DENIED", "auditor sandbox is unavailable", {}));
			}
			if (typeof params?.case_id !== "string") return toolFail(herdError("INVALID_ARGUMENT", "case_id is required"));
			const state = stateFor(ctx);
			const binding = auditorBinding(state, ctx);
			if (!binding) {
				return toolFail(herdError(":HOST_API_MISMATCH", "auditor batch/case context is missing", {}));
			}
			if (params.case_id !== binding.caseId) {
				return toolFail(
					herdError(":AUDIT_UNKNOWN_CASE", "submission case_id does not match the assigned CASE", {
						assigned: binding.caseId,
						submitted: params.case_id,
					}),
				);
			}
			try {
				writeAuditSubmission(state, binding, params);
				return toolOk({ ok: true, case_id: binding.caseId, batch_id: binding.batchId });
			} catch (error) {
				return toolFail(error);
			}
		},
	});
	pi.registerTool({
		name: "submit_oracle_advice",
		label: "Submit Oracle Advice",
		description: "Deliver one read-only Blocker Oracle's proposed alternatives.",
		parameters: gatedObject(
			{
				task_id: Type.String({ minLength: 1 }),
				advice_markdown: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			const slug = state.slug ?? slugFromCwd(ctx?.cwd);
			const sliceId = sliceIdFromCwd(ctx?.cwd);
			if (!slug || !sliceId) {
				return toolFail(herdError(":HOST_API_MISMATCH", "oracle advice needs a mission and Slice context", {}));
			}
			const board = boardHandleFor({ ...state, slug }, sliceId);
			if (!board) return toolFail(herdError(":STALE_CONTROL", "oracle advice has no board", {}));
			try {
				const result = await apply({
					board,
					command: { type: "comment", taskId: params.task_id, text: params.advice_markdown },
					actor: sessionIdentity(state, ctx),
					turnId: "oracle",
					requestId: `oracle-${params.task_id}-${createHash("sha256").update(params.advice_markdown).digest("hex").slice(0, 12)}`,
				});
				return toolErrorFromResult(result);
			} catch (error) {
				return toolFail(error);
			}
		},
	});
}

function extensionToolApi(pi) {
	const api = Object.create(pi);
	if (!pi.typebox || typeof pi.typebox.Type !== "function") api.typebox = { Type };
	api.registerTool = (tool) => {
		if (tool?.name !== "submit_devops_report" || typeof tool.execute !== "function") {
			return pi.registerTool(tool);
		}
		const execute = tool.execute;
		const wrapped = {
			...tool,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const state = stateFor(ctx);
				const slug = trustedDevopsSlug(state, ctx, params?.slug);
				if (typeof slug !== "string" || slug.length === 0) {
					return toolFail(herdError(":HOST_API_MISMATCH", "devops slug context is missing", {}));
				}
				const normalized = { ...params, slug };
				const result = await execute(toolCallId, normalized, signal, onUpdate, ctx);
				if (result?.isError !== true && result?.details?.ok !== false) {
					try {
						writeDevopsReport(state, ctx, normalized);
					} catch (error) {
						return toolFail(error);
					}
				}
				return result;
			},
		};
		return pi.registerTool(wrapped);
	};
	return api;
}

function charWidth(char) {
	const code = char.codePointAt(0);
	return code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1faff))
		? 2
		: 1;
}

function wrapPlainLine(line, width) {
	const limit = Math.max(1, width);
	const rows = [];
	let current = "";
	let used = 0;
	for (const char of line.replaceAll("\t", "    ")) {
		const cells = charWidth(char);
		if (current.length > 0 && used + cells > limit) {
			rows.push(current);
			current = "";
			used = 0;
		}
		current += char;
		used += cells;
	}
	rows.push(current);
	return rows;
}

function truncatePlain(text, width) {
	const limit = Math.max(1, width);
	if (limit === 1) return text.length > 0 ? "…" : "";
	let out = "";
	let used = 0;
	for (const char of text) {
		const cells = charWidth(char);
		if (used + cells > limit - 1) return `${out}…`;
		out += char;
		used += cells;
	}
	return out;
}

/**
 * Public `ctx.ui.custom` screen for S1 manual approval. It renders the full
 * disk Markdown and owns PageUp/PageDown/Home/End scrolling and an explicit
 * reject/approve/revise choice. Approval never happens by default.
 */
export function createS1ApprovalComponent({ markdown, title, keybindings, rows = 24, requestRender = () => {}, done }) {
	let offset = 0;
	let choice = "reject";
	let settled = false;
	let cachedWidth;
	let bodyLines;
	const choices = ["reject", "approve", "revise"];
	const matches = (data, action) => typeof keybindings?.matches === "function" && keybindings.matches(data, action);
	const bodyHeight = () => Math.max(1, Math.floor(rows) - 3);
	const invalidate = () => {
		cachedWidth = undefined;
		bodyLines = undefined;
	};
	const finish = (decision) => {
		if (settled) return;
		settled = true;
		done({ decision });
	};
	const ensureLines = (width) => {
		if (bodyLines && cachedWidth === width) return;
		cachedWidth = width;
		bodyLines = String(markdown ?? "")
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.flatMap((line) => wrapPlainLine(line, width - 2));
		offset = Math.max(0, Math.min(offset, Math.max(0, bodyLines.length - bodyHeight())));
	};
	const choiceLabel = (name) => {
		const text = name === "approve" ? "批准" : name === "revise" ? "修改" : "拒绝";
		return choice === name ? `[ ${text} ]` : `  ${text}  `;
	};
	return {
		render(width) {
			const actualWidth = Math.max(4, Math.floor(width));
			ensureLines(actualWidth);
			const height = bodyHeight();
			const maxOffset = Math.max(0, bodyLines.length - height);
			if (offset > maxOffset) offset = maxOffset;
			const visible = bodyLines.slice(offset, offset + height);
			const total = bodyLines.length;
			const position =
				total === 0 ? "0/0" : `${Math.min(total, offset + 1)}-${Math.min(total, offset + visible.length)}/${total}`;
			const header = truncatePlain(`${title ?? "S1 文档审批"}  ${position}`, actualWidth);
			const actions = truncatePlain(
				`${choiceLabel("reject")} ${choiceLabel("approve")} ${choiceLabel("revise")}`,
				actualWidth,
			);
			const hint = truncatePlain("↑/↓ PgUp/PgDn Home/End 滚动 · ←/→/Tab 选择 · Enter 确认 · Esc 取消", actualWidth);
			return [header, ...visible.map((line) => truncatePlain(line, actualWidth)), actions, hint];
		},
		handleInput(data) {
			// Input can arrive before the host's first paint. Keep the scroll
			// state meaningful by preparing the wrapped view at the last known
			// width (80 columns is the conservative fallback).
			ensureLines(cachedWidth ?? 80);
			if (matches(data, "tui.select.cancel")) {
				finish("pending");
				return;
			}
			if (matches(data, "tui.select.confirm")) {
				finish(choice === "reject" ? "pending" : choice);
				return;
			}
			if (matches(data, "tui.editor.cursorLeft")) {
				choice = choices[(choices.indexOf(choice) - 1 + choices.length) % choices.length];
				requestRender();
				return;
			}
			if (matches(data, "tui.editor.cursorRight") || matches(data, "tui.input.tab")) {
				choice = choices[(choices.indexOf(choice) + 1) % choices.length];
				requestRender();
				return;
			}
			const height = bodyHeight();
			const maxOffset = Math.max(0, (bodyLines?.length ?? 0) - height);
			if (matches(data, "tui.select.pageUp") || matches(data, "tui.altScreen.pageUp")) {
				offset = Math.max(0, offset - height);
			} else if (matches(data, "tui.select.pageDown") || matches(data, "tui.altScreen.pageDown")) {
				offset = Math.min(maxOffset, offset + height);
			} else if (matches(data, "tui.select.up")) {
				offset = Math.max(0, offset - 1);
			} else if (matches(data, "tui.select.down")) {
				offset = Math.min(maxOffset, offset + 1);
			} else if (matches(data, "tui.altScreen.top") || matches(data, "tui.editor.cursorLineStart")) {
				offset = 0;
			} else if (matches(data, "tui.altScreen.bottom") || matches(data, "tui.editor.cursorLineEnd")) {
				offset = maxOffset;
			} else {
				return;
			}
			requestRender();
		},
		invalidate,
	};
}

function gateHost(pi) {
	const ctxFor = (state) => state.lastContext;
	const stateForSlug = (slug) =>
		[...sessions.values()].find((entry) => entry.slug === slug) ?? [...sessions.values()][0];
	const confirmWith = async (args, message) => {
		const state = [...sessions.values()].find((entry) => entry.slug === args.slug) ?? [...sessions.values()][0];
		const ctx = state ? ctxFor(state) : undefined;
		if (!ctx?.ui || ctx.hasUI === false || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
			return { decision: "pending", reason: "custom-ui-unavailable" };
		}
		if (typeof args?.root !== "string" || typeof args?.slug !== "string" || args.slug.length === 0) {
			return {
				decision: "error",
				error: { code: ":HOST_API_MISMATCH", message: "S1 approval needs a workspace root and mission slug" },
			};
		}
		const documentPath = join(args.root, "plans", args.slug, "s1-brainstorm.md");
		let markdown;
		try {
			markdown = readFileSync(documentPath, "utf8");
		} catch (error) {
			return {
				decision: "error",
				error: {
					code: ":STALE_CONTROL",
					message: "the disk S1 document is not readable; refusing to approve memory text",
					data: { path: documentPath, cause: String(error?.message ?? error) },
				},
			};
		}
		try {
			const result = await ctx.ui.custom(
				(tui, _theme, keybindings, done) =>
					createS1ApprovalComponent({
						markdown,
						title: message,
						keybindings,
						rows: tui?.terminal?.rows ?? tui?.height ?? 24,
						requestRender: () => tui?.requestRender?.(),
						done,
					}),
				{
					overlay: true,
					overlayOptions: {
						fullscreen: true,
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
						margin: 0,
					},
					blocked: { kind: "permission", message: "S1 manual approval" },
					...(args.signal ? { signal: args.signal } : {}),
				},
			);
			if (result?.decision === "approve") return { decision: "approve" };
			if (result?.decision === "revise") {
				const feedback =
					typeof ctx.ui.input === "function"
						? await ctx.ui.input("Revise S1", "What should change?", args.signal ? { signal: args.signal } : undefined)
						: undefined;
				if (typeof feedback === "string" && feedback.trim().length > 0) {
					return { decision: "revise", feedback };
				}
			}
			return { decision: "pending", reason: "operator-not-approved" };
		} catch (error) {
			return {
				decision: "pending",
				reason: "custom-ui-error",
				error: { code: ":HOST_API_MISMATCH", message: String(error?.message ?? error) },
			};
		}
	};
	return Object.freeze({
		confirm: (args) => confirmWith(args, "批准磁盘上的 S1 完整文档？"),
		resumeApproval: (args) => confirmWith(args, "批准待处理的磁盘 S1 完整文档？"),
		async askUser(args) {
			const state = [...sessions.values()].find((entry) => entry.slug === args.slug) ?? [...sessions.values()][0];
			const ctx = state ? ctxFor(state) : undefined;
			if (!ctx?.ui || typeof ctx.ui.input !== "function") return { ok: true, pending: true };
			const answer = await ctx.ui.input(String(args.question ?? "Question"), String(args.recommended_default ?? ""));
			if (typeof answer !== "string" || answer.trim().length === 0) return { ok: true, pending: true };
			return { ok: true, answer };
		},
		async runDevops(args) {
			const state = stateForSlug(args.slug);
			if (!state) return { ok: false, error: { code: ":HOST_API_MISMATCH", message: "no active session" } };
			const read = await readMission(state.root, args.slug);
			if (read?.ok !== true) {
				return {
					ok: false,
					error: read?.error ?? { code: ":STAGE_MISMATCH", message: `mission unreadable: ${args.slug}` },
				};
			}
			if (read.valid === false) {
				return { ok: false, error: read.error ?? { code: ":STAGE_MISMATCH", message: "mission is invalid" } };
			}
			const mission = read.mission;
			if (!mission) {
				return { ok: false, error: { code: ":STAGE_MISMATCH", message: `mission not found: ${args.slug}` } };
			}
			state.mission = mission;
			let saved = state.devopsSessions.get(args.slug);
			if (!saved) {
				const restored = devopsSessionFromMission(mission);
				if (restored.ok !== true) {
					recordHealth({
						entry: "main.devops",
						status: "failed",
						version: "1",
						degraded: true,
						error: `${restored.error.code}: ${restored.error.message}`,
					});
					return { ok: false, error: restored.error };
				}
				if (restored.session) {
					saved = { ...restored.session, persisted: true };
					state.devopsSessions.set(args.slug, saved);
				}
			}
			const recorded = mission["devops-session"];
			if (saved && recorded !== undefined && recorded !== null) {
				const checked = devopsSessionFromMission(mission);
				if (checked.ok !== true) return { ok: false, error: checked.error };
				if (checked.session?.agentId !== saved.agentId) {
					return {
						ok: false,
						error: {
							code: ":STALE_CONTROL",
							message: "in-memory Plan DevOps session disagrees with the mission record",
						},
					};
				}
			}
			const name = saved?.agentName ?? `PlanDevOps-${args.slug}-${randomUUID().slice(0, 8)}`;
			const intent = String(args.verbose_intent ?? args.intent ?? "");
			const callId = newDevopsCallId();
			const signal = args.signal;
			const prompt = `Mission slug: ${args.slug}\nDevOps call: ${callId}\n${intent}`;
			const reportDirectory = saved?.artifactsDir ?? join(state.root, ".herd", "artifacts", args.slug, name);
			const outcome = saved
				? await continueDevopsSession(state, saved, prompt, signal)
				: await startAgent(
						{
							role: "Plan DevOps",
							name,
							prompt,
							task: prompt,
							cwd: state.root,
							tools: [...ROLE_SURFACES["Plan DevOps"]],
							artifactsDir: reportDirectory,
							keepAlive: true,
							parentToolCallId: state.lastToolCallId,
							signal,
						},
						state,
					);
			if (outcome?.ok !== true) {
				const error = outcome?.error ?? { code: ":AGENT_SPAWN_FAILED", message: "devops failed" };
				// submit_devops_report is the terminal protocol output. A child
				// that writes a valid receipt and then fails on a post-report
				// `yield` must not make the parent discard that receipt.
				const submitted = devopsReportAfterChildFailure(outcome, reportDirectory, callId);
				recordHealth({
					entry: "main.devops",
					status: submitted ? "degraded" : "failed",
					version: "1",
					degraded: true,
					error: `${error.code ?? ":AGENT_SPAWN_FAILED"}: ${error.message ?? "devops failed"}${
						typeof error.data?.reason === "string" ? ` (${error.data.reason})` : ""
					}`,
				});
				if (!submitted) return { ok: false, error };
				return submitted;
			}
			if (!saved) {
				const remembered = rememberDevopsSession(state, args.slug, outcome, name);
				if (remembered.ok !== true) return { ok: false, error: remembered.error };
				saved = remembered.session;
			}
			if (saved.persisted !== true) {
				const persisted = await persistDevopsSession(state, args.slug, saved);
				if (persisted?.ok !== true) {
					const error = persisted?.error ?? { code: ":HOST_API_MISMATCH", message: "devops session not persisted" };
					recordHealth({
						entry: "main.devops",
						status: "failed",
						version: "1",
						degraded: true,
						error: `${error.code}: ${error.message}`,
					});
					return { ok: false, error };
				}
				saved.persisted = true;
			}
			const report = readDevopsReport(saved?.artifactsDir ?? reportDirectory, callId);
			if (!report) {
				return {
					ok: false,
					status: "blocked",
					error: {
						code: ":AUDIT_MISSING",
						message: "Plan DevOps ended without a successful structured submit_devops_report",
					},
					agentId: outcome.agentId,
					callId,
				};
			}
			return {
				ok: true,
				status: report.status === "blocked" ? "blocked" : "devops-report",
				report,
				agentId: outcome.agentId,
				callId,
			};
		},
		async onStageChange({ root, slug, stage }) {
			const state = stateForSlug(slug);
			if (!state) return { ok: false, error: { code: ":HOST_API_MISMATCH", message: "no active session" } };
			state.slug = slug;
			state.root = root ?? state.root;
			const read = await readMission(state.root, slug);
			if (read?.ok === true) state.mission = read.mission;
			publishMission(state);
			await applyStageSurface(pi, stage);
			await refreshDashboard(state);
			return { ok: true, stage };
		},
	});
}

function gateRunner() {
	return Object.freeze({
		async forkSlices({ root, slug, slices, base }) {
			const handles = await forkSlices({
				root,
				slug,
				slices,
				base: base ?? "HEAD",
				deps: { board: missionBoardPort(root, slug) },
			});
			const started = [];
			for (const handle of handles) {
				const state = [...sessions.values()].find((entry) => entry.slug === slug) ?? [...sessions.values()][0];
				if (!state) continue;
				const slice = { root, slug, slice_id: handle.slice_id, workspace: handle.workspace, base: handle.base_commit };
				const port = createRunnerPort({ slice, deps: runnerDeps(state, slice) });
				state.runnerPorts.set(handle.slice_id, port);
				const result = await port.startSlice(handle);
				started.push(result);
				if (result?.ok !== true) return { ok: false, error: result?.error };
			}
			return { ok: true, handles, started };
		},
		async assertInitialEmptyLedger({ root, slug }) {
			try {
				const worktrees = readWorktreeState({ root, slug });
				if (!worktrees.exists) return { ok: true };
				for (const sliceId of Object.keys(worktrees.slices ?? {})) {
					const handle = openBoard(root, slug, sliceId);
					const board = await readBoard(handle);
					if (board === null) {
						return {
							ok: false,
							error: { code: ":STALE_CONTROL", message: `slice board missing: ${sliceId}` },
						};
					}
					if (board.tenure?.["initial-ask-used"] === true) {
						return {
							ok: false,
							error: {
								code: ":ASK_FORBIDDEN_OUTSIDE_S1",
								message: `initial empty-ledger question already used: ${sliceId}`,
							},
						};
					}
					if (Object.keys(board.tasks ?? {}).length > 0) {
						return { ok: false, error: { code: ":NO_PROGRESSABLE_WORK", message: "board already has tasks" } };
					}
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, error: { code: ":INVALID_ARGUMENT", message: String(error?.message ?? error) } };
			}
		},
		async submitReview(args) {
			const state = [...sessions.values()].find((entry) => entry.slug === args.slug) ?? [...sessions.values()][0];
			if (!state) return { ok: false, error: { code: ":HOST_API_MISMATCH", message: "no active session" } };
			const sliceId = args.slice_id ?? sliceIdFromCwd(args.workspace) ?? firstSlice(state);
			if (!sliceId) return { ok: false, error: { code: ":INVALID_ARGUMENT", message: "no Slice to review" } };
			const slice = {
				root: state.root,
				slug: args.slug,
				slice_id: sliceId,
				workspace: worktreePaths(state.root, args.slug, sliceId).workspace,
				base: "HEAD",
			};
			const port = state.runnerPorts.get(sliceId) ?? createRunnerPort({ slice, deps: runnerDeps(state, slice) });
			state.runnerPorts.set(sliceId, port);
			return port.runTenure({ findings: args.findings, termId: args.tenure_id });
		},
	});
}

function firstSlice(state) {
	try {
		const worktrees = readWorktreeState({ root: state.root, slug: state.slug });
		return worktrees.exists ? Object.keys(worktrees.slices ?? {})[0] : undefined;
	} catch {
		return undefined;
	}
}

export function writeLockHeld(lock) {
	// A stale marker is evidence, not permission: the file must be removed by
	// recovery/operator confirmation before $W can be considered absent.
	return lock?.exists === true;
}

function runnerPortFor(state, slug, sliceId) {
	const existing = state.runnerPorts.get(sliceId);
	if (existing) return existing;
	const slice = {
		root: state.root,
		slug,
		slice_id: sliceId,
		workspace: worktreePaths(state.root, slug, sliceId).workspace,
	};
	const port = createRunnerPort({ slice, deps: runnerDeps(state, slice) });
	state.runnerPorts.set(sliceId, port);
	return port;
}

export async function wakeRunnerAfterBoardCommand(state, slug, sliceId, command) {
	if (command?.type !== "release" && command?.type !== "reopen") return undefined;
	return runnerPortFor(state, slug, sliceId).wake();
}

function runnerDeps(state, slice) {
	const board = boardHandleFor(state, slice.slice_id);
	const slug =
		state.slug ??
		slugFromCwd(slice.workspace) ??
		slugFromArtifactsPath(artifactsDirFromContext(state, state.lastContext));
	return {
		root: state.root,
		slug,
		board,
		openBoard,
		agents: {
			start: (request) => startAgent(request, state),
		},
		worktree: {
			enqueue: (args) => enqueueSlice({ ...args, deps: { board } }),
		},
		askUser: async ({ question }) => {
			if (!gateService) return { ok: false, error: { code: ":HOST_API_MISMATCH", message: "gate service missing" } };
			const result = await gateService.askUser(
				{
					slug,
					question,
					context: "S5 initial empty ledger",
					recommended_default: "Proceed with the next valid mission action.",
				},
				{ root: state.root },
			);
			return result?.answer ?? result;
		},
		ff: {
			ready: ({ workspace } = {}) => ffReady(state, workspace),
		},
		writeLock: {
			held: () => {
				try {
					const lockPath = join(state.root, ".herd", "locks", `${slice.slice_id}.write-w.lock`);
					const lock = inspectLock(lockPath, {
						agentState: (agentId) => state.agentLife.get(agentId),
					});
					return writeLockHeld(lock);
				} catch {
					// Cannot prove the lock is absent; keep quiescence blocked.
					return true;
				}
			},
		},
		artifactsDir: join(state.root, ".herd", "artifacts", slug ?? "unscoped", slice.slice_id),
		settings: state.settings ?? hostSettings(state.pi),
		modelRegistry: state.modelRegistry,
		eventBus: state.eventBus,
		contracts: contractPaths(slug ? { ...state, slug } : state),
		seed: state.mission?.seed,
		slots: 4,
		buildNudge: (input) => buildUnattendedNudge(input ?? {}),
		sendNudge: (text) => {
			try {
				state.pi?.sendMessage?.({ customType: "herd-nudge", content: text, display: false }, { triggerTurn: true });
			} catch {
				// A failed nudge must not break the mission.
			}
		},
	};
}

function ffReady(state, workspace) {
	if (typeof workspace !== "string" || workspace.length === 0) return { ok: false, reason: "workspace-missing" };
	const base = spawnSync("git", ["-C", state.root, "rev-parse", "HEAD"], { encoding: "utf8" });
	const head = spawnSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" });
	if (base.status !== 0 || head.status !== 0) {
		return { ok: false, reason: "git-unavailable" };
	}
	const ancestor = spawnSync(
		"git",
		["-C", workspace, "merge-base", "--is-ancestor", base.stdout.trim(), head.stdout.trim()],
		{ encoding: "utf8" },
	);
	return ancestor.status === 0
		? { ok: true }
		: { ok: false, reason: "ff-not-ready", base: base.stdout.trim(), head: head.stdout.trim() };
}

function contractPaths(state) {
	return ["s1", "s2", "s3", "s4"].map((stage) =>
		join(
			state.root,
			"plans",
			state.slug,
			`${stage}-${stage === "s1" ? "brainstorm" : stage === "s2" ? "manual-tests" : stage === "s3" ? "dev-guide" : "coordination"}.md`,
		),
	);
}

export function hostEventBus(pi) {
	// 18.16 exposes the live bus as `pi.events`; ExtensionContext has no
	// eventBus field. Undefined degrades to memory-only subagent visibility.
	const events = pi?.events;
	return isObject(events) ? events : undefined;
}

export function inheritedSessionFile(state, request = {}) {
	if (typeof request.sessionFile === "string" && request.sessionFile.length > 0) return request.sessionFile;
	const value = state?.lastContext?.sessionManager?.getSessionFile?.();
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parentContextFor(state, request = {}) {
	return {
		parentAgentId:
			typeof request.parentAgentId === "string"
				? request.parentAgentId
				: typeof state?.lastContext?.agent?.id === "string"
					? state.lastContext.agent.id
					: undefined,
		parentToolCallId: typeof request.parentToolCallId === "string" ? request.parentToolCallId : undefined,
	};
}

function devopsAgentDefinition(agentName, model) {
	const prompt = ROLE_PROMPTS["Plan DevOps"];
	if (typeof prompt !== "string" || prompt.length === 0) return undefined;
	return {
		name: agentName,
		description: `Plan DevOps: ${agentName}`,
		systemPrompt: appendPrompt(COMMON_RULES_TEXT, prompt, LANGUAGE_SKILL),
		tools: [...ROLE_SURFACES["Plan DevOps"]],
		model: [...model],
		source: "project",
	};
}

function devopsArtifactsDir(outcome) {
	if (typeof outcome?.artifactsDir === "string" && outcome.artifactsDir.length > 0) return outcome.artifactsDir;
	const artifacts = outcome?.artifacts;
	if (artifacts?.persisted !== true) return undefined;
	return typeof artifacts.dir === "string" && artifacts.dir.length > 0 ? artifacts.dir : undefined;
}

function validDevopsModel(value) {
	return (
		Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)
	);
}

export function rememberDevopsSession(state, slug, outcome, agentName) {
	const model = validDevopsModel(outcome?.modelPatterns) ? outcome.modelPatterns : outcome?.agentDefinition?.model;
	const artifactsDir = devopsArtifactsDir(outcome);
	if (
		typeof outcome?.agentId !== "string" ||
		!isObject(outcome.agentDefinition) ||
		typeof artifactsDir !== "string" ||
		typeof outcome.roleNonce !== "string" ||
		!DEVOPS_NONCE_RE.test(outcome.roleNonce) ||
		typeof agentName !== "string" ||
		!validDevopsModel(model)
	) {
		return {
			ok: false,
			error: {
				code: ":HOST_API_MISMATCH",
				message:
					"first Plan DevOps turn did not expose definition, identity, model, and a persisted artifacts directory",
				data: {
					agentId: outcome?.agentId ?? null,
					hasDefinition: isObject(outcome?.agentDefinition),
					hasArtifactsDir: typeof artifactsDir === "string",
					hasRoleNonce: typeof outcome?.roleNonce === "string",
					hasModel: validDevopsModel(model),
				},
			},
		};
	}
	const session = {
		agentId: outcome.agentId,
		agentDefinition: outcome.agentDefinition,
		artifactsDir,
		agentName,
		roleNonce: outcome.roleNonce,
		model: [...model],
	};
	state.devopsSessions.set(slug, session);
	return { ok: true, session };
}

/**
 * Restore the one Plan DevOps child from the mission's authoritative EDN.
 *
 * The persisted entry is bound to the current mission id (the S1-S4 tenure)
 * and records the revision at registration. A missing field means this
 * mission has never spawned an investigator; a malformed or foreign entry is
 * an explicit error, not permission to spawn a second one.
 */
export function devopsSessionFromMission(mission) {
	const raw = mission?.["devops-session"];
	if (raw === undefined || raw === null) return { ok: true, session: undefined };
	if (!isObject(raw)) {
		return {
			ok: false,
			error: { code: ":STALE_CONTROL", message: "mission devops-session is malformed" },
		};
	}
	if (raw["mission-id"] !== mission?.["mission-id"]) {
		return {
			ok: false,
			error: { code: ":STALE_CONTROL", message: "devops session belongs to a different mission tenure" },
		};
	}
	if (
		!Number.isInteger(raw.revision) ||
		raw.revision < 0 ||
		!Number.isInteger(mission?.revision) ||
		raw.revision > mission.revision
	) {
		return {
			ok: false,
			error: { code: ":STALE_CONTROL", message: "devops session revision is not bound to this mission" },
		};
	}
	const agentId = raw["agent-id"];
	const artifactsDir = raw["artifacts-dir"];
	const agentName = raw["agent-name"];
	const roleNonce = raw["role-nonce"];
	const model = raw.model;
	if (
		typeof agentId !== "string" ||
		typeof artifactsDir !== "string" ||
		typeof agentName !== "string" ||
		typeof roleNonce !== "string" ||
		!DEVOPS_NONCE_RE.test(roleNonce) ||
		!validDevopsModel(model)
	) {
		return {
			ok: false,
			error: { code: ":STALE_CONTROL", message: "mission devops-session is incomplete" },
		};
	}
	const agentDefinition = devopsAgentDefinition(agentName, model);
	if (!agentDefinition) {
		return {
			ok: false,
			error: { code: ":HOST_API_MISMATCH", message: "Plan DevOps prompt is unavailable for recovery" },
		};
	}
	return {
		ok: true,
		session: {
			agentId,
			agentDefinition,
			artifactsDir,
			agentName,
			roleNonce,
			model: [...model],
		},
	};
}

export async function persistDevopsSession(state, slug, session) {
	const result = await writeDevopsSessionRef(state.root, slug, {
		agentId: session.agentId,
		artifactsDir: session.artifactsDir,
		agentName: session.agentName,
		roleNonce: session.roleNonce,
		model: session.model,
	});
	if (result?.ok === true && result.mission) state.mission = result.mission;
	return result;
}

export async function continueDevopsSession(state, session, message, signal, continueFn) {
	if (
		typeof session?.agentId !== "string" ||
		typeof session?.artifactsDir !== "string" ||
		typeof session?.roleNonce !== "string" ||
		!DEVOPS_NONCE_RE.test(session.roleNonce)
	) {
		return { ok: false, error: { code: ":INVALID_ARGUMENT", message: "devops session state is incomplete" } };
	}
	if (!isObject(session.agentDefinition)) {
		return { ok: false, error: { code: ":HOST_API_MISMATCH", message: "devops AgentDefinition is missing" } };
	}
	let fn = continueFn;
	if (typeof fn !== "function") {
		const host = await import("./host/subprocess.mjs");
		fn = host.continueAgent;
	}
	if (typeof fn !== "function") {
		return {
			ok: false,
			error: {
				code: ":CAPABILITY_DENIED",
				message: "host follow-up turns are unavailable; refusing to spawn a new Plan DevOps",
			},
		};
	}
	const followMessage = `[HERD_ROLE: Plan DevOps nonce=${session.roleNonce}]\n${message}`;
	return fn({
		id: session.agentId,
		agent: session.agentDefinition,
		message: followMessage,
		eventBus: state.eventBus,
		artifactsDir: session.artifactsDir,
		parentToolCallId: state.lastToolCallId,
		...(signal === undefined ? {} : { signal }),
	});
}

async function startAgent(request, state) {
	const role = request.role;
	const surface = ROLE_SURFACES[role];
	if (!surface) {
		return { ok: false, error: { code: ":CAPABILITY_DENIED", message: `unknown role: ${role}` } };
	}
	const prompt = ROLE_PROMPTS[role];
	if (!prompt && role !== "Manual Auditor") {
		return { ok: false, error: { code: ":CAPABILITY_DENIED", message: `no prompt for role: ${role}` } };
	}
	const defaultSystemPrompt = appendPrompt(COMMON_RULES_TEXT, prompt ?? "", LANGUAGE_SKILL);
	try {
		const { spawnAgent } = await import("./host/subprocess.mjs");
		const name =
			role === "Swarm Holder" && typeof request.name === "string" && request.name.startsWith("Worker-")
				? request.name.replace(/^Worker-/, "Holder-")
				: request.name;
		const task = request.task ?? request.prompt;
		const options = {
			...request,
			role,
			name,
			systemPrompt: request.systemPrompt ?? defaultSystemPrompt,
			task,
			cwd: request.cwd,
			tools: request.tools ?? surface,
			capabilities: request.capabilities ?? state.capabilities,
			model:
				request.model ??
				(role === "Swarm Worker" || role === "Swarm Holder" || role === "Plan DevOps" ? undefined : state.model),
			modelRegistry: request.modelRegistry ?? state.modelRegistry,
			settings: request.settings ?? state.settings ?? hostSettings(state.pi),
			roleNonce: request.roleNonce ?? request.agentId ?? randomUUID().replaceAll("-", ""),
			preloadedExtensionPaths: request.preloadedExtensionPaths ?? extensionPaths,
			artifactsDir:
				request.artifactsDir ?? join(state.root, ".herd", "artifacts", state.slug ?? "unscoped", request.name),
			eventBus: request.eventBus ?? state.eventBus,
			...parentContextFor(state, request),
			sessionFile: inheritedSessionFile(state, request),
			signal: request.signal,
			allowModelFallback: request.allowModelFallback === true,
		};
		delete options.prompt;
		const outcome = await spawnAgent(options);
		return outcome?.ok === true ? { ...outcome, agentName: name } : outcome;
	} catch (error) {
		return { ok: false, error: { code: ":AGENT_SPAWN_FAILED", message: String(error?.message ?? error) } };
	}
}

async function caseSpecsFor(state) {
	let mission = state.mission ?? (await readActiveMission(state));
	if (!mission) return { ok: false, error: "mission-missing" };
	const casesRead = await readS2Cases(state.root, state.slug);
	if (casesRead?.ok !== true) {
		return { ok: false, error: casesRead?.error?.message ?? "frozen cases.edn is unavailable" };
	}
	const summaryRead = await readS1Summary(state.root, state.slug);
	if (summaryRead?.ok !== true) {
		return { ok: false, error: summaryRead?.error?.message ?? "frozen S1 summary is unavailable" };
	}
	const fresh = await readMission(state.root, state.slug);
	if (fresh?.ok !== true) return { ok: false, error: "mission cannot be re-read before audit" };
	mission = fresh.mission;
	const frozenCases = mission.frozen?.["s2-cases"]?.sha256;
	const frozenSummary = mission.frozen?.["s1-summary"]?.sha256;
	if (frozenCases !== casesRead.sha256 || frozenSummary !== summaryRead.sha256) {
		return {
			ok: false,
			error: "frozen contract changed while preparing the audit; retry from the new revision",
			code: ":CONTRACT_HASH_MISMATCH",
		};
	}
	const cases = [];
	for (let index = 0; index < casesRead.cases.length; index += 1) {
		const raw = casesRead.cases[index];
		const caseId = raw?.["case-id"] ?? raw?.case_id;
		if (
			typeof caseId !== "string" ||
			caseId.length === 0 ||
			typeof raw?.path !== "string" ||
			typeof raw?.threshold !== "number" ||
			!Array.isArray(raw?.steps) ||
			raw.steps.length === 0 ||
			typeof raw?.expected !== "string" ||
			typeof raw?.rubric !== "string"
		) {
			return { ok: false, error: `cases[${index}] is missing a required CASE field` };
		}
		cases.push({
			case_id: caseId,
			path: raw.path,
			threshold: raw.threshold,
			steps: [...raw.steps],
			expected: raw.expected,
			rubric: raw.rubric,
		});
	}
	return {
		ok: true,
		mission,
		cases,
		caseEdn: {
			bytes: Buffer.from(casesRead.bytes, "utf8"),
			sha256: casesRead.sha256,
		},
		s1Summary: {
			path: summaryRead.path,
			bytes: Buffer.from(summaryRead.bytes, "utf8"),
			sha256: summaryRead.sha256,
		},
	};
}

function snapshotFileSignature(file) {
	const stamp = file?.stamp ?? {};
	return [
		file?.path,
		file?.sha256,
		String(stamp.mtimeSec ?? stamp["mtime-sec"] ?? ""),
		String(stamp.mtimeNsec ?? stamp["mtime-nsec"] ?? ""),
		String(stamp.size ?? ""),
	].join("\u0000");
}

function compareProtectedSnapshots(before, after, reportPath) {
	const beforeFiles = new Map(
		(Array.isArray(before?.files) ? before.files : []).map((file) => [file.path, snapshotFileSignature(file)]),
	);
	const afterFiles = new Map(
		(Array.isArray(after?.files) ? after.files : []).map((file) => [file.path, snapshotFileSignature(file)]),
	);
	for (const [path, signature] of afterFiles) {
		if (path === reportPath) continue;
		if (!beforeFiles.has(path) || beforeFiles.get(path) !== signature) return `changed:${path}`;
	}
	for (const path of beforeFiles.keys()) {
		if (path === reportPath) continue;
		if (!afterFiles.has(path)) return `removed:${path}`;
	}
	return undefined;
}

async function recheckMission(batch, args) {
	const live = await verifyContract(args.root, args.slug);
	if (live?.ok !== true) {
		return {
			ok: false,
			code: live?.error?.code ?? ":CONTRACT_HASH_MISMATCH",
			message: live?.error?.message ?? "live contract cannot be verified",
		};
	}
	const expected = batch.contractVerification?.hashes ?? {};
	for (const [stage, hash] of Object.entries(expected)) {
		if (live.contract?.hashes?.[stage] !== hash) {
			return {
				ok: false,
				code: ":CONTRACT_HASH_MISMATCH",
				message: `frozen ${stage} changed during the report write`,
			};
		}
	}
	const after = snapshotWorkspace(args.root);
	if (after?.ok !== true) {
		return { ok: false, code: ":AUDIT_WORKSPACE_MUTATED", message: "workspace snapshot failed" };
	}
	const reportRelative = `plans/${args.slug}/s5-report.md`;
	const changed = compareProtectedSnapshots(args.snapshotBefore, after, reportRelative);
	if (changed !== undefined) {
		return { ok: false, code: ":AUDIT_WORKSPACE_MUTATED", message: changed };
	}
	let bytes;
	try {
		bytes = readFileSync(args.reportPath);
	} catch (error) {
		return { ok: false, code: ":APPROVAL_REQUIRED", message: String(error?.message ?? error) };
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== args.reportSha256) {
		return { ok: false, code: ":APPROVAL_REQUIRED", message: "s5-report.md changed after writing" };
	}
	return {
		ok: true,
		missionId: args.missionId,
		revision: args.revision,
		reportSha256: digest,
		contractLine: args.contract?.contractLine,
		snapshotDigest: after.digest,
	};
}

async function startRepairSlices(state, slices) {
	const handles = await forkSlices({
		root: state.root,
		slug: state.slug,
		slices,
		base: "HEAD",
		deps: { board: missionBoardPort(state.root, state.slug) },
	});
	const started = [];
	for (const handle of handles) {
		const slice = {
			root: state.root,
			slug: state.slug,
			slice_id: handle.slice_id,
			workspace: handle.workspace,
			base: handle.base_commit,
		};
		const port = createRunnerPort({ slice, deps: runnerDeps(state, slice) });
		state.runnerPorts.set(handle.slice_id, port);
		const result = await port.startSlice(handle);
		started.push(result);
		if (result?.ok !== true) throw new Error(result?.error?.message ?? "repair Slice failed to start");
	}
	return started;
}

export function auditReady(state) {
	if (!state.slug) return false;
	let snapshot;
	try {
		snapshot = readWorktreeState({ root: state.root, slug: state.slug });
	} catch {
		return false;
	}
	if (!snapshot.exists) return false;
	const slices = Object.values(snapshot.slices ?? {});
	if (slices.length === 0) return false;
	if ((snapshot.queue ?? []).length > 0) return false;
	if (slices.some((slice) => ["creating", "running", "reviewing", "swarming", "joining"].includes(slice.status))) {
		return false;
	}
	return slices.some((slice) => slice.status === "joined");
}

function scheduleAuditRetry(state, message, retryable = true) {
	state.auditAttempts += 1;
	state.lastAuditFailure = message;
	const notify = (text, type = "warning") => {
		try {
			state.lastContext?.ui?.notify?.(text, type);
		} catch {
			// Notification is best effort.
		}
	};
	if (state.cancelled || state.lastContext?.signal?.aborted) {
		notify(`S5 审计已取消：${message}`, "warning");
		return;
	}
	if (!retryable) {
		recordHealth({
			entry: "main.audit",
			status: "failed",
			version: "1",
			degraded: true,
			error: message,
		});
		notify(`S5 审计不可自动重试，保持未交付：${message}`, "error");
		return;
	}
	const delayMs = Math.min(300_000, 1000 * 2 ** Math.min(state.auditAttempts - 1, 8));
	notify(`S5 审计未完成（${message}），${delayMs}ms 后自动重试。`);
	clearTimeout(state.auditRetryTimer);
	state.auditRetryTimer = setTimeout(() => {
		state.auditRetryTimer = undefined;
		void runMissionAudit(state);
	}, delayMs);
	state.auditRetryTimer?.unref?.();
}

async function runMissionAudit(state) {
	if (!state.slug || state.role || state.auditRunning || state.cancelled) return;
	if (!AUDITOR_SANDBOX.available) {
		recordHealth({
			entry: "main.audit",
			status: "blocked",
			version: "1",
			degraded: true,
			error: `auditor sandbox unavailable: ${AUDITOR_SANDBOX.reason ?? "bwrap/tmux missing"}`,
		});
		state.lastContext?.ui?.notify?.(
			`S5 审计被阻断：auditor sandbox 不可用（${AUDITOR_SANDBOX.reason ?? "bwrap/tmux missing"}）。`,
			"error",
		);
		return;
	}
	clearTimeout(state.auditRetryTimer);
	state.auditRetryTimer = undefined;
	const mission = await readActiveMission(state);
	if (missionStageKey(mission?.stage) !== "s5") return;
	const specs = await caseSpecsFor(state);
	if (specs.ok !== true) {
		scheduleAuditRetry(state, `S5 审计无法启动：${specs.error}`, false);
		return;
	}
	state.auditRunning = true;
	state.auditInvalidated = false;
	const notify = (message, type = "info") => {
		try {
			state.lastContext?.ui?.notify?.(message, type);
		} catch {
			// Notification is best effort.
		}
	};
	try {
		const auditMission = specs.mission ?? mission;
		const contract = {
			missionId: auditMission["mission-id"],
			revision: auditMission.revision,
			contractLine: auditMission["contract-line"],
			frozen: auditMission.frozen,
		};
		const batch = await startAuditBatch({
			root: state.root,
			slug: state.slug,
			caseSpecs: specs.cases,
			caseEdn: specs.caseEdn,
			s1Summary: specs.s1Summary,
			contract,
			deps: {
				spawnAgent: (options) => startAgent(options, state),
				settings: state.settings ?? hostSettings(state.pi),
				capabilities: state.capabilities,
				createAuditorSandbox,
				eventBus: state.eventBus,
				modelRegistry: state.modelRegistry,
				model: state.model,
				preloadedExtensionPaths: extensionPaths,
				systemPrompt: appendPrompt(COMMON_RULES_TEXT, LANGUAGE_SKILL),
				buildPrompt: ({ caseSpec, s1Summary }) =>
					buildCaseAuditorPrompt({
						mission: {
							missionId: contract.missionId,
							slug: state.slug,
							contractLine: contract.contractLine,
							s1Summary,
						},
						caseSpec,
					}),
				collectSubmission: ({ caseId, auditor }) => {
					const directory = auditor?.artifactsDir
						? resolve(state.root, auditor.artifactsDir)
						: join(state.root, ".herd", "artifacts", state.slug, "audit", caseId);
					const context = readAuditContextDir(directory);
					if (!context) {
						return {
							ok: false,
							error: herdError(":AUDIT_MISSING", "audit context is missing", { caseId, directory }),
						};
					}
					const reader = createFileSubmissionReader({
						root: state.root,
						slug: context.slug,
						batchId: context.batchId,
					});
					const result = reader({ caseId });
					return result?.ok === true ? { submissions: [result.submission] } : { ok: false, error: result?.error };
				},
				verifyContract: (_expected, context = {}) =>
					verifyContract(context.root ?? state.root, context.slug ?? state.slug),
				timeoutMs: 30 * 60 * 1000,
				baseTmpDir: "/tmp",
				signal: state.lastContext?.signal,
			},
		});
		if (state.auditInvalidated) {
			state.auditInvalidated = false;
			scheduleAuditRetry(state, "冻结文档在审计期间发生人类编辑，当前批次作废");
			return;
		}
		if (batch?.ok !== true || !batch.aggregateInput) {
			scheduleAuditRetry(state, `S5 审计批次未完成：${batch?.errors?.[0]?.message ?? batch?.state ?? "unknown"}`);
			return;
		}
		const result = aggregate({
			...batch.aggregateInput,
			audit: {
				environment: `omp ${process.env.OMP_VERSION ?? "unknown"}`,
				host: process.env.OMP_VERSION ?? "unknown",
			},
			// B3 already verified the contract before the batch; T2's post-report
			// recheck is the second, independent gate. Reuse the batch receipt
			// here instead of adding a third verification path.
			ports: {
				verifyContract: () => ({ ok: batch.contractVerification?.ok === true }),
			},
		});
		if (result?.verdict !== "PASS" || result?.ok === false) {
			const repair = deriveRepairSlices({ aggregateResult: result });
			notify(`S5 审计未全 PASS，已生成修复切片：${repair?.mappedCases?.join(", ") ?? "无"}`, "warning");
			if (Array.isArray(repair?.repairSlices) && repair.repairSlices.length > 0) {
				try {
					await startRepairSlices(state, repair.repairSlices);
					state.auditAttempts = 0;
				} catch (error) {
					scheduleAuditRetry(state, `修复切片启动失败：${String(error?.message ?? error)}`);
					return;
				}
				return;
			}
			scheduleAuditRetry(state, "审计未通过且没有可派生的修复 Slice", false);
			return;
		}
		const approvalPort = missionApprovalPort(state);
		if (!approvalPort) {
			scheduleAuditRetry(state, "S5 审计全 PASS，但批准 authority 不可用", false);
			return;
		}
		const report = await writeS5Report(state.root, state.slug, result, {
			approvalPort,
			recheckPort: (args) => recheckMission(batch, args),
			caseIds: specs.cases.map((entry) => entry.case_id),
		});
		if (report?.ok === true) {
			state.auditAttempts = 0;
			state.lastAuditFailure = undefined;
			notify(`S5 全 PASS，已交付：${report.path}`, "info");
		} else {
			scheduleAuditRetry(state, `S5 报告/批准失败：${report?.errors?.[0]?.message ?? report?.code ?? "unknown"}`);
		}
	} catch (error) {
		scheduleAuditRetry(state, `S5 审计异常：${String(error?.message ?? error)}`);
	} finally {
		state.auditRunning = false;
	}
}

function isEscapeInput(data) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the raw key, not a display character.
	return data === "\x1b" || /^\x1b\[27(?:;\d+)*u$/.test(data);
}

function escapeLayer(ctx, state, data) {
	if (!isEscapeInput(data) || state.role) return undefined;
	if (state.tui?.expanded === true) {
		state.tui.toggle();
		return { consume: true };
	}
	const pendingPath = state.slug ? join(state.root, ".herd", "missions", state.slug, "pending-gate.edn") : undefined;
	if (pendingPath && existsSync(pendingPath)) {
		ctx?.ui?.notify?.("S1 待批准：请先批准或修改文档，再用 /herd-cancel 取消。", "warning");
		return { consume: true };
	}
	if (!state.slug) return undefined;
	const slug = state.slug;
	state.cancelled = true;
	void cancelTree({ root: state.root, slug, reason: "operator-esc" })
		.then((result) => {
			retireSandbox(state);
			ctx?.ui?.notify?.(`已按 Esc 取消：${printEdn(result)}`, "warning");
		})
		.catch((error) => {
			ctx?.ui?.notify?.(`Esc 取消失败：${String(error?.message ?? error)}`, "error");
		});
	return { consume: true };
}

function registerCommands(pi) {
	const notify = (ctx, message, type = "info") => {
		try {
			ctx?.ui?.notify?.(message, type);
		} catch {
			// UI failure must not break the command path.
		}
	};
	pi.registerCommand("herd", {
		description: "Start a new Herdchestra Lite mission from a seed.",
		async handler(args, ctx) {
			const seed = String(args ?? "").trim();
			if (!seed) return notify(ctx, "用法：/herd <seed>", "warning");
			const state = stateFor(ctx);
			const slug = slugFor(seed);
			const created = await createMission(state.root, { slug, seed });
			if (created?.ok !== true) return notify(ctx, `创建使命失败：${created?.error?.message ?? "unknown"}`, "error");
			state.slug = slug;
			state.mission = created.mission;
			state.devopsSessions.delete(slug);
			state.cancelled = false;
			state.stalled = undefined;
			rememberFocus(state, slug);
			missionApprovalPort(state);
			publishMission(state);
			await applyStageSurface(pi, "s1");
			await refreshDashboard(state);
			if (typeof ctx?.ui?.notify === "function") notify(ctx, `使命 ${slug} 已创建，进入 S1。`);
			try {
				pi.sendUserMessage(seed, { expandPromptTemplates: false });
			} catch (error) {
				notify(ctx, `无法启动 S1 回合：${String(error?.message ?? error)}`, "error");
			}
		},
	});
	pi.registerCommand("herd-status", {
		description: "Show the current mission dashboard or health.",
		async handler(args, ctx) {
			const state = stateFor(ctx);
			const mode = String(args ?? "").trim();
			if (mode === "health") {
				const health = readHealth();
				const lines = health.entries.map(
					(entry) =>
						`${entry.entry}: ${entry.status}${entry.degraded ? " (degraded)" : ""}${entry.error ? ` — ${entry.error}` : ""}`,
				);
				return notify(ctx, lines.length > 0 ? lines.join("\n") : "没有 health 记录。");
			}
			const model = state.tui?.model ?? state.snapshot ?? deriveDashboard({});
			const text = mode === "verbose" ? model.expanded.text : model.compact.text;
			return notify(ctx, text);
		},
	});
	pi.registerCommand("herd-list", {
		description: "List known missions.",
		async handler(_args, ctx) {
			const state = stateFor(ctx);
			const list = await listMissions(state.root);
			if (list?.ok !== true) return notify(ctx, `无法列出使命：${list?.error?.message ?? "unknown"}`, "error");
			const lines = list.missions.map((entry) => `${entry.slug}  ${entry.mission.stage}`);
			return notify(ctx, lines.length > 0 ? lines.join("\n") : "没有使命。");
		},
	});
	pi.registerCommand("herd-focus", {
		description: "Focus one mission by slug.",
		async handler(args, ctx) {
			const slug = String(args ?? "").trim();
			const state = stateFor(ctx);
			const read = await readMission(state.root, slug);
			if (read?.ok !== true) return notify(ctx, `无法聚焦 ${slug}：${read?.error?.message ?? "unknown"}`, "error");
			state.slug = slug;
			state.mission = read.mission;
			state.cancelled = false;
			state.stalled = undefined;
			rememberFocus(state, slug);
			missionApprovalPort(state);
			publishMission(state);
			await applyStageSurface(pi, read.mission.stage);
			await refreshDashboard(state);
			return notify(ctx, `已聚焦 ${slug}（${read.mission.stage}）。`);
		},
	});
	pi.registerCommand("herd-unfocus", {
		description: "Clear the focused mission.",
		async handler(_args, ctx) {
			const state = stateFor(ctx);
			state.slug = undefined;
			state.mission = undefined;
			rememberFocus(state, null);
			await refreshDashboard(state);
			publishMission(state);
			return notify(ctx, "已取消聚焦。");
		},
	});
	pi.registerCommand("herd-cancel", {
		description: "Cancel the focused mission's active runner trees.",
		async handler(_args, ctx) {
			const state = stateFor(ctx);
			if (!state.slug) return notify(ctx, "没有聚焦的使命。", "warning");
			state.cancelled = true;
			const result = await cancelTree({ root: state.root, slug: state.slug, reason: "operator" });
			retireSandbox(state);
			return notify(ctx, printEdn(result));
		},
	});
	pi.registerCommand("herd-recovery", {
		description: "Scan the six recovery windows for the focused mission.",
		async handler(args, ctx) {
			const state = stateFor(ctx);
			if (!state.slug) return notify(ctx, "没有聚焦的使命。", "warning");
			const repair = String(args ?? "").trim() === "repair";
			const confirm = async (info) => {
				if (typeof ctx?.ui?.confirm !== "function") return false;
				const detail = typeof info === "string" ? info : (info?.message ?? info?.reason ?? "Proceed?");
				return ctx.ui.confirm("Recovery repair", String(detail));
			};
			const result = await recover({
				root: state.root,
				slug: state.slug,
				repair,
				deps: { ...runnerDeps(state, { slice_id: "recovery" }), confirm },
			});
			const error = result?.error;
			const view =
				error instanceof Error
					? {
							...result,
							error: {
								code: error.code ?? ":INVALID_ARGUMENT",
								message: error.message ?? String(error),
								data: isObject(error.data) ? error.data : {},
							},
						}
					: result;
			return notify(ctx, printEdn(view));
		},
	});
	pi.registerCommand("herd-settings", {
		description: "Show effective mission and task model settings.",
		async handler(_args, ctx) {
			const state = stateFor(ctx);
			let settings;
			try {
				settings = hostSettings(state.pi);
			} catch (error) {
				return notify(ctx, `设置不可用：${String(error?.message ?? error)}`, "error");
			}
			const lines = [];
			if (settings) {
				for (const key of ["task.maxRuntimeMs", "modelRoles", "task.model"]) {
					try {
						const value = settings.get?.(key);
						if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value)}`);
					} catch {
						// Skip unreadable keys.
					}
				}
				try {
					lines.push(`modelRoles: ${JSON.stringify(settings.getModelRoles?.() ?? {})}`);
				} catch {
					// The model roles probe is optional.
				}
			}
			return notify(ctx, lines.length > 0 ? lines.join("\n") : "没有可显示的有效设置。");
		},
	});
}

async function refreshDashboard(state) {
	if (!state.slug) {
		state.snapshot = deriveDashboard({});
		state.tui?.update(state.snapshot);
		return;
	}
	const mission = await readActiveMission(state);
	let slices = [];
	try {
		const worktrees = readWorktreeState({ root: state.root, slug: state.slug });
		if (worktrees.exists) slices = Object.values(worktrees.slices ?? {});
	} catch {
		slices = [];
	}
	const boards = [];
	for (const slice of slices) {
		try {
			const handle = openBoard(state.root, state.slug, slice.slice_id);
			const board = await readBoard(handle);
			if (board !== null) {
				rememberActors(state, board);
				boards.push(board);
			}
		} catch {
			// A missing board is shown as degraded by the dashboard input.
		}
	}
	state.snapshot = deriveDashboard({
		mission,
		slices,
		boards,
		now: Date.now(),
	});
	state.tui?.update(state.snapshot);
}

function mountSessionDashboard(ctx, state) {
	if (state.tui) return state.tui;
	state.tui = mountDashboard(ctx, () => state.snapshot ?? deriveDashboard({}), {
		recordHealth: (entry) => recordHealth(entry),
		shortcutProvided: true,
		getTerminalSize: () => ({ columns: process.stdout.columns, rows: process.stdout.rows }),
	});
	return state.tui;
}

/**
 * Main activation.
 *
 * @param {import("./host/imports.mjs").ExtensionAPI} pi
 */
export function classifyAgentEnd(event, { userAborted = false } = {}) {
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	const last = [...messages].reverse().find((message) => message?.role === "assistant");
	if (!last) return { kind: "empty" };
	if (last.stopReason === "aborted") {
		return userAborted ? { kind: "aborted" } : { kind: "transient", reason: "upstream" };
	}
	const status = Number.isFinite(last.errorStatus) ? last.errorStatus : undefined;
	const text = typeof last.errorMessage === "string" ? last.errorMessage : "";
	if (status === 401 || status === 403 || /invalid api key|unauthorized|authentication failed|no api key/i.test(text)) {
		return { kind: "stalled", reason: "auth", status };
	}
	if (status === 402 || /insufficient_quota|quota|balance|credit|billing/i.test(text)) {
		return { kind: "stalled", reason: "balance", status };
	}
	if (
		(status === 404 && /model/i.test(text)) ||
		/model.*(not found|unavailable|does not exist)|no such model/i.test(text)
	) {
		return { kind: "stalled", reason: "model", status };
	}
	if (status === 400 || status === 422) return { kind: "stalled", reason: "request", status };
	if (status === 429 || (status !== undefined && status >= 500 && status < 600)) {
		return { kind: "transient", reason: "upstream", status };
	}
	if (last.stopReason === "error") return { kind: "transient", reason: "provider", status };
	return { kind: "empty" };
}

const IDLE_NUDGE_DELAYS = [0, 30_000, 60_000, 120_000, 240_000, 300_000];
const UPSTREAM_NUDGE_DELAYS = [5_000, 10_000, 20_000, 40_000, 80_000];

function sendHerdNudge(pi, state, stage, expectedTool, openItems) {
	if ((!state.slug && !state.role) || state.cancelled || state.stalled) return;
	const nudge = buildUnattendedNudge({ stage, expectedTool, openItems });
	try {
		pi.sendMessage({ customType: "herd-nudge", content: nudge, display: false }, { triggerTurn: true });
	} catch (error) {
		recordHealth({
			entry: "main.nudge",
			status: "degraded",
			version: "1",
			degraded: true,
			error: String(error?.message ?? error),
		});
	}
}

function scheduleIdleNudge(pi, state, stage, expectedTool, progress) {
	if ((!state.slug && !state.role) || state.cancelled || state.stalled) return;
	if (state.idleTimer !== undefined) return;
	const attempt = state.idleAttempts;
	const delay = progress ? 0 : IDLE_NUDGE_DELAYS[Math.min(attempt, IDLE_NUDGE_DELAYS.length - 1)];
	state.idleAttempts = progress ? 0 : attempt + 1;
	state.idleTimer = setTimeout(() => {
		state.idleTimer = undefined;
		sendHerdNudge(pi, state, stage, expectedTool, [
			progress ? "本轮有进展；立即继续，不要自然停止" : "当前回合没有合法出口，继续推进",
		]);
	}, delay);
	state.idleTimer?.unref?.();
}

function scheduleUpstreamNudge(pi, state, stage, expectedTool, failure) {
	if ((!state.slug && !state.role) || state.cancelled || state.stalled) return;
	if (state.upstreamTimer !== undefined) return;
	const attempt = state.upstreamAttempts;
	if (attempt >= UPSTREAM_NUDGE_DELAYS.length) {
		state.stalled = { kind: "stalled", reason: "upstream-budget", status: failure.status };
		recordHealth({
			entry: "main.stalled",
			status: "failed",
			version: "1",
			degraded: true,
			error: `upstream retry budget exhausted${failure.status ? ` (${failure.status})` : ""}; no further nudge`,
		});
		state.lastContext?.ui?.notify?.("上游瞬态重试预算耗尽，模型调用已 stalled。", "error");
		return;
	}
	const delay = UPSTREAM_NUDGE_DELAYS[attempt];
	state.upstreamAttempts = attempt + 1;
	state.upstreamTimer = setTimeout(() => {
		state.upstreamTimer = undefined;
		sendHerdNudge(pi, state, stage, expectedTool, [
			`上游瞬态失败（${failure.reason}${failure.status ? ` ${failure.status}` : ""}），按退避继续`,
		]);
	}, delay);
	state.upstreamTimer?.unref?.();
}

export default async function activate(pi) {
	if (approvalAuthority === undefined) approvalAuthority = takeApprovalAuthority();
	publishRoleSurfaces();
	const toolApi = extensionToolApi(pi);
	gateService = registerGateTools(toolApi, {
		contract: {
			commitS2,
			createMission,
			freezeStage,
			readMission,
			listMissions,
			readPendingGate,
			readS1Summary,
			readS2Cases,
			realign,
			saveS1Summary,
			saveS2Cases,
			saveStageDocument,
			verifyFrozenPrefix,
			writePendingGate,
		},
		host: gateHost(pi),
		runner: gateRunner(),
		root: process.cwd(),
		base: "HEAD",
		roleOf: (ctx) => stateFor(ctx).role ?? "Coordinator",
		slugOf: (ctx) => trustedMissionSlug(stateFor(ctx), ctx),
	});
	registerBoardTools(toolApi);
	registerSpawnTools(toolApi);
	registerRealignTool(toolApi);
	registerScopeAndAuditTools(toolApi);
	registerSandboxTool(toolApi, "clj_plan", "plan");
	registerSandboxTool(toolApi, "clj_devops", "devops");
	registerSandboxTool(toolApi, "clj_review", "review");
	registerSandboxTool(toolApi, "clj_worker", "worker");
	if (AUDITOR_SANDBOX.available) registerSandboxTool(toolApi, "clj_auditor", "auditor");
	registerCommands(pi);

	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut(DASHBOARD_TOGGLE_SHORTCUT, {
			description: "Toggle the Herdchestra dashboard",
			handler: (ctx) => {
				const state = stateFor(ctx);
				state.tui?.toggle();
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const state = stateFor(ctx);
		state.pi = pi;
		state.settings = hostSettings(pi);
		try {
			const { detectCapabilities } = await import("./host/imports.mjs");
			state.capabilities = detectCapabilities(pi, ctx);
		} catch (error) {
			state.capabilities = undefined;
			recordHealth({
				entry: "main.capabilities",
				status: "degraded",
				version: "1",
				degraded: true,
				error: String(error?.message ?? error),
			});
		}
		state.modelRegistry = ctx?.modelRegistry;
		state.model = ctx?.model;
		state.eventBus = hostEventBus(pi);
		if (!isSubagentContext(ctx)) await restoreMissionFocus(state, ctx);
		mountSessionDashboard(ctx, state);
		if (!state.escUnsubscribe && typeof ctx?.ui?.onTerminalInput === "function") {
			state.escUnsubscribe = ctx.ui.onTerminalInput((data) => escapeLayer(ctx, state, data));
		} else if (typeof ctx?.ui?.onTerminalInput !== "function") {
			recordHealth({
				entry: "main.esc",
				status: "degraded",
				version: "1",
				degraded: true,
				error: "onTerminalInput is unavailable; use /herd-cancel",
			});
		}
		missionApprovalPort(state);
		publishMission(state);
		await refreshDashboard(state);
		if (state.slug) {
			const recovery = await recover({
				root: state.root,
				slug: state.slug,
				deps: runnerDeps(state, { slice_id: "recovery" }),
			});
			if (recovery?.ok !== true) {
				recordHealth({
					entry: "main.recovery",
					status: "degraded",
					version: "1",
					degraded: true,
					error: String(recovery?.error?.message ?? "recovery scan did not complete"),
				});
			} else {
				for (const entry of recovery.scanned?.board?.slices ?? []) {
					if (entry.relayPending !== true) continue;
					const slice = {
						root: state.root,
						slug: state.slug,
						slice_id: entry.sliceId,
						workspace: worktreePaths(state.root, state.slug, entry.sliceId).workspace,
					};
					const port =
						state.runnerPorts.get(entry.sliceId) ?? createRunnerPort({ slice, deps: runnerDeps(state, slice) });
					state.runnerPorts.set(entry.sliceId, port);
					await port.relay();
				}
			}
		}
		if (!isSubagentContext(ctx) && missionStageKey(state.mission?.stage) === "s5" && auditReady(state)) {
			void runMissionAudit(state);
		}
		recordHealth({
			entry: "main",
			status: "ok",
			version: "1",
			capabilities: {
				stages: true,
				scope: true,
				swarm: true,
				sandbox: true,
				approvalAuthority: Boolean(approvalAuthority),
				tui: Boolean(ctx?.ui?.setWidget),
				extensionEntries: extensionPaths.length,
			},
			degraded: false,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = stateFor(ctx);
		const fromNudge = event?.messageType === "custom" && event?.message?.customType === "herd-nudge";
		if (!fromNudge) {
			clearTimeout(state.idleTimer);
			clearTimeout(state.upstreamTimer);
			state.idleTimer = undefined;
			state.upstreamTimer = undefined;
			state.idleAttempts = 0;
			state.upstreamAttempts = 0;
			state.stalled = undefined;
		}
		state.turnId = randomUUID();
		state.turnTools.clear();
		state.successfulTools.clear();
		const prompt = parsePrompt(event);
		if (isSubagentContext(ctx)) {
			if (state.failedRole) {
				try {
					await pi.setActiveTools([]);
				} catch {
					// The host identity already marks this session unusable.
				}
				return { systemPrompt: event.systemPrompt };
			}
			const token = state.role === undefined ? roleFromPrompt(prompt) : undefined;
			const role = token?.role ?? state.role;
			if (!role || !ROLE_SURFACES[role]) {
				state.failedRole = true;
				try {
					await pi.setActiveTools([]);
				} catch {
					// Fail closed below.
				}
				recordHealth({
					entry: "main.role",
					status: "failed",
					version: "1",
					capabilities: { roleNarrowing: false },
					degraded: true,
					error: token ? `unknown role token: ${token.role}` : "subagent has no role token",
				});
				return { systemPrompt: event.systemPrompt };
			}
			state.role = role;
			state.roleNonce = token?.nonce ?? state.roleNonce;
			if (role === "Plan DevOps") state.devopsCallId = devopsCallIdFromText(prompt);
			try {
				const pending = pi.setActiveTools([...ROLE_SURFACES[role]]);
				if (pending && typeof pending.then === "function") await pending;
			} catch (error) {
				state.failedRole = true;
				recordHealth({
					entry: "main.role",
					status: "failed",
					version: "1",
					capabilities: { roleNarrowing: false },
					degraded: true,
					error: String(error?.message ?? error),
				});
			}
			return { systemPrompt: appendPrompt(event.systemPrompt, LANGUAGE_SKILL) };
		}
		// A role token in the main session is untrusted prose, not an identity.
		state.role = undefined;
		const mission = await readActiveMission(state);
		const stage = mission?.stage;
		if (stage !== undefined) await applyStageSurface(pi, stage);
		return {
			systemPrompt: appendPrompt(event.systemPrompt, COMMON_RULES_TEXT, missionBriefing(stage), LANGUAGE_SKILL),
		};
	});

	pi.on("context", (event, ctx) => {
		const state = stateFor(ctx);
		if (!state.slug || state.role) return undefined;
		try {
			const messages = projectMessages({
				messages: event.messages,
				ledger: ledgerFor(state.id, state.id),
				currentBriefing: missionBriefing(state.mission?.stage),
			});
			return { messages };
		} catch (error) {
			recordHealth({
				entry: "main.context",
				status: "degraded",
				version: "1",
				degraded: true,
				error: String(error?.message ?? error),
			});
			return undefined;
		}
	});

	pi.on("before_provider_request", (event) => {
		try {
			rewriteOutboundPayload(event.payload);
			relocateCacheBreakpoints(event.payload);
		} catch {
			// Projection failure must not drop the request.
		}
		return event.payload;
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const state = stateFor(ctx);
		if (typeof event?.toolCallId === "string") state.lastToolCallId = event.toolCallId;
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const state = stateFor(ctx);
		state.idleAttempts = 0;
		state.upstreamAttempts = 0;
		clearTimeout(state.idleTimer);
		clearTimeout(state.upstreamTimer);
		state.idleTimer = undefined;
		state.upstreamTimer = undefined;
		state.stalled = undefined;
		if (typeof event?.toolName === "string") {
			state.turnTools.add(event.toolName);
			if (event.isError !== true) state.successfulTools.add(event.toolName);
		}
		state.lastToolCallId = undefined;
		if (event?.isError === true) {
			recordHealth({
				entry: "main.tool",
				status: "degraded",
				version: "1",
				degraded: true,
				error: `${event.toolName ?? "tool"} failed`,
			});
		}
		void refreshDashboard(state);
	});

	pi.on("turn_end", (_event, ctx) => {
		const state = stateFor(ctx);
		if (state.role || missionStageKey(state.mission?.stage) !== "s5") return;
		for (const port of state.runnerPorts.values()) {
			port.nudge?.turnEnd?.({
				stage: "s5",
				expectedTool: "submit_review",
				progress: state.turnTools.size > 0,
				waitingForHuman: false,
			});
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const state = stateFor(ctx);
		if ((!state.slug && !state.role) || state.cancelled) return;
		if (event?.willContinue === true) return;
		const failure = classifyAgentEnd(event, {
			userAborted: event?.userAborted === true || event?.abortReason === "user",
		});
		if (failure.kind === "aborted") return;
		if (failure.kind === "stalled") {
			state.stalled = failure;
			clearTimeout(state.idleTimer);
			clearTimeout(state.upstreamTimer);
			state.idleTimer = undefined;
			state.upstreamTimer = undefined;
			recordHealth({
				entry: "main.stalled",
				status: "failed",
				version: "1",
				degraded: true,
				error: `provider ${failure.reason}${failure.status ? ` (${failure.status})` : ""}; no retry`,
			});
			state.lastContext?.ui?.notify?.(`模型调用已 stalled（${failure.reason}），不再注入 nudge。`, "error");
			return;
		}
		if (failure.kind === "empty") {
			state.upstreamAttempts = 0;
			clearTimeout(state.upstreamTimer);
			state.upstreamTimer = undefined;
		}
		if (state.role) {
			const expectedTool = ROLE_EXIT_TOOLS[state.role];
			if (!expectedTool) return;
			if (state.role === "Plan DevOps" && state.devopsReportSubmitted !== undefined) {
				const activeCall = state.devopsCallId;
				if (activeCall === undefined || activeCall === state.devopsReportSubmitted) return;
			}
			if (state.successfulTools.has("ask_user")) return;
			if (state.role === "Swarm Worker" || state.role === "Swarm Holder") {
				if (await boardRoleExitReady(state, ctx)) return;
			} else if (state.successfulTools.has(expectedTool)) {
				return;
			}
			let stage = missionStageKey(state.mission?.stage);
			if (!stage) {
				const slug = state.slug ?? slugFromArtifactsPath(artifactsDirFromContext(state, ctx)) ?? slugFromCwd(ctx?.cwd);
				if (slug) {
					const read = await readMission(state.root, slug);
					if (read?.ok === true) {
						state.slug = slug;
						state.mission = read.mission;
						stage = missionStageKey(read.mission?.stage);
					}
				}
			}
			stage ||= "s5";
			if (failure.kind === "transient") {
				scheduleUpstreamNudge(pi, state, stage, expectedTool, failure);
			} else {
				scheduleIdleNudge(pi, state, stage, expectedTool, state.turnTools.size > 0);
			}
			return;
		}
		const stage = missionStageKey(state.mission?.stage);
		if (!stage || stage === "completed" || stage === "s5") return;
		const pending = await readPendingGate(state.root, state.slug);
		if (pending?.ok === true && pending.pending !== null) return;
		const expectedTool = `advance_${stage}`;
		if (state.turnTools.has(expectedTool)) return;
		if (failure.kind === "transient") {
			scheduleUpstreamNudge(pi, state, stage, expectedTool, failure);
		} else {
			scheduleIdleNudge(pi, state, stage, expectedTool, state.turnTools.size > 0);
		}
	});
}
