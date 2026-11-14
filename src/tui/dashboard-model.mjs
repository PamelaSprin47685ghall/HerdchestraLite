/**
 * Pure dashboard model for Herdchestra Lite.
 *
 * Input: one control-state snapshot (`mission`, `workspaces`, `boards`,
 * `audit`, `focus`, `now`). Output: the compact view, the expanded five-layer
 * tenure view, the K-audit score table, and the `/herd-status` text.
 *
 * The board is also the review ledger: one flat task map per tenure plus
 * reviewer findings. The model never writes stage documents; it shows which
 * attach is expected and whether the review board is open or quiescent.
 *
 * This module owns every user-visible status word, count, waiting chain and
 * score. The TUI widget only chooses lines and width; `/herd-status` prints the
 * text below. Neither consumer formats business state a second time.
 *
 * Missing or malformed input never throws. Unreadable sections are omitted,
 * listed in `degradation.reasons`, and the remaining dashboard still renders.
 */

export const DASHBOARD_MODEL_VERSION = 1;

export const USER_STATES = Object.freeze({
	running: "进行中",
	delivered: "已交付",
	undelivered: "未交付",
});

export const AUDIT_PHASES = Object.freeze([
	Object.freeze({ key: "start", label: "审计员启动" }),
	Object.freeze({ key: "submit", label: "逐 CASE 提交" }),
	Object.freeze({ key: "aggregate", label: "汇总" }),
	Object.freeze({ key: "close", label: "结案/返工" }),
]);

const MAX_LIST_LINES = 20;
const PROGRESS_WIDTH = 10;
const ACTIVE_ACTION_PHASES = new Set(["applying", "running", "uncertain"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const field = (record, ...names) => {
	if (!isRecord(record)) return undefined;
	for (const name of names) {
		const aliases = new Set([name]);
		if (name.includes("_")) aliases.add(name.replaceAll("_", "-"));
		const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
		if (kebab !== name) {
			aliases.add(kebab);
			aliases.add(kebab.replaceAll("-", "_"));
		}
		for (const alias of aliases) {
			if (record[alias] !== undefined && record[alias] !== null) return record[alias];
			const keywordName = `:${alias}`;
			if (record[keywordName] !== undefined && record[keywordName] !== null) return record[keywordName];
		}
	}
	return undefined;
};

const atom = (value) => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (isRecord(value) && typeof value.name === "string" && value.name.trim()) return value.name.trim();
	return undefined;
};

const tokenText = (value) => {
	const text = atom(value);
	if (!text) return undefined;
	return text.startsWith(":") ? text.slice(1) : text;
};

const numberOrNull = (value) => {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const integerOrNull = (value) => {
	const number = numberOrNull(value);
	return number === null ? null : Math.trunc(number);
};

const boolValue = (value) => {
	if (value === true || value === 1) return true;
	if (typeof value === "string") {
		const text = value.trim().toLowerCase().replace(/^:/, "");
		return text === "true" || text === "yes" || text === "1";
	}
	return false;
};

const asArray = (value) => {
	if (Array.isArray(value)) return value;
	if (value instanceof Set) return [...value];
	if (value instanceof Map) return [...value.values()];
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	return [];
};

const asEntries = (value) => {
	if (Array.isArray(value)) return value.map((item, index) => [index, item]);
	if (value instanceof Map) return [...value.entries()];
	if (isRecord(value)) return Object.entries(value);
	return [];
};

const unique = (values) => [
	...new Set(values.filter((value) => value !== undefined && value !== null && value !== "")),
];

const singleLine = (value) => {
	let result = "";
	for (const character of String(value ?? "")) {
		const codePoint = character.codePointAt(0);
		const control =
			codePoint !== undefined && ((codePoint >= 0 && codePoint < 32) || (codePoint >= 0x7f && codePoint <= 0x9f));
		result += control ? " " : character;
	}
	return result;
};

const singleLines = (lines) => lines.map((line) => singleLine(line));

const formatCount = (value) => {
	if (!Number.isFinite(value)) return "—";
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000)}B`;
	if (absolute >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
	if (absolute >= 1_000) return `${trimFixed(value / 1_000)}k`;
	return String(Math.trunc(value));
};

const trimFixed = (value) => {
	const fixed = value.toFixed(1);
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
};

const formatDuration = (milliseconds) => {
	if (!Number.isFinite(milliseconds)) return "—";
	const total = Math.max(0, Math.trunc(milliseconds / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
};

const toTimestamp = (value) => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
	return null;
};

const normalizeStage = (value) => {
	const text = tokenText(value);
	if (!text) return null;
	const direct = /^s?\s*([1-5])$/i.exec(text);
	if (direct) return `S${direct[1]}`;
	if (/^(completed|closed|done|finished)$/i.test(text)) return "S5";
	const embedded = /s\s*([1-5])/i.exec(text);
	return embedded ? `S${embedded[1]}` : null;
};

export const STAGE_ATTACH = Object.freeze({
	S1: Object.freeze({ tool: "attach_brainstorm", document: "brainstorm.md" }),
	S2: Object.freeze({ tool: "attach_manual_tests", document: "s2-cases.edn" }),
	S3: Object.freeze({ tool: "attach_dev_guide", document: "dev-guide.md" }),
	S4: Object.freeze({ tool: "attach_coordination", document: "coordination.md" }),
});

const normalizeTenure = (mission) => {
	const raw = field(mission, "tenure", "tenureId", "tenure_id", "tenure-id", "term", "termId", "term_id", "term-id");
	if (isRecord(raw)) {
		const index = integerOrNull(field(raw, "index", "term", "number", "n"));
		const id = atom(field(raw, "id", "term_id", "termId", "tenure_id", "tenureId", "tenure-id", "name")) ?? (index === null ? null : `T-${index}`);
		return {
			id,
			index,
			askUsed: boolValue(field(raw, "initialAskUsed", "initial_ask_used", "askUsed", "ask_used")),
		};
	}
	const text = atom(raw);
	if (!text) return { id: null, index: null, askUsed: false };
	const numeric = /^(?:t-?)?(\d+)$/i.exec(text);
	return { id: text, index: numeric ? Number(numeric[1]) : null, askUsed: false };
};

const normalizeUserState = (value) => {
	const text = tokenText(value);
	if (!text) return null;
	if (text === "进行中" || /^(running|active|in[_-]?progress|working)$/i.test(text)) return "running";
	if (text === "已交付" || /^(delivered|completed|done|finished)$/i.test(text)) return "delivered";
	if (text === "未交付" || /^(undelivered|cancelled|canceled|failed|aborted)$/i.test(text)) return "undelivered";
	return null;
};

const approvalIsValid = (approval) => {
	if (!approval) return false;
	if (isRecord(approval)) {
		if (approval.valid === false || approval.verified === false) return false;
		if (approval.valid === true || approval.verified === true) return true;
		return Object.keys(approval).length > 0;
	}
	return true;
};

const normalizeOutcome = (mission) => {
	const outcome = field(mission, "outcome", "result");
	const reason =
		atom(field(outcome, "reason", "summary", "why")) ??
		atom(field(mission, "undeliveredReason", "undelivered_reason", "cancelReason", "cancel_reason"));
	const lessons =
		atom(field(outcome, "lessons", "lesson", "lessonsLearned")) ?? atom(field(mission, "lessons", "lessons_learned"));
	const retry = atom(field(outcome, "retry", "retryEntry", "retry_entry"));
	return { reason, lessons, retry };
};

const normalizeTokens = (mission) => {
	const raw = field(mission, "tokens", "usage", "token_usage", "tokenUsage");
	let input = null;
	let output = null;
	let total = null;
	if (typeof raw === "number") {
		total = numberOrNull(raw);
	} else if (isRecord(raw)) {
		input = numberOrNull(field(raw, "input", "inputTokens", "input_tokens", "prompt"));
		output = numberOrNull(field(raw, "output", "outputTokens", "output_tokens", "completion"));
		total = numberOrNull(field(raw, "total", "totalTokens", "total_tokens", "tokens"));
	}
	if (total === null) {
		total = numberOrNull(field(mission, "totalTokens", "total_tokens"));
	}
	if (total === null && (input !== null || output !== null)) total = (input ?? 0) + (output ?? 0);
	return {
		input,
		output,
		total,
		label: total === null ? null : formatCount(total),
	};
};

const normalizeMission = (mission, now, degradation) => {
	if (!isRecord(mission)) {
		if (mission !== undefined && mission !== null) degradation.push("mission-unreadable");
		return null;
	}
	const slug = atom(field(mission, "slug", "mission_id", "missionId"));
	const seed = atom(field(mission, "seed", "goal"));
	const title = atom(field(mission, "title", "name")) ?? seed ?? slug ?? "未命名使命";
	const rawStage = field(mission, "stage", "currentStage", "current_stage");
	const stage = normalizeStage(rawStage) ?? (normalizeUserState(rawStage) === "delivered" ? "S5" : null);
	const approval = field(mission, "approval", "approvalToken", "approval_token");
	const approved = approvalIsValid(approval);
	const explicitUserState = normalizeUserState(field(mission, "userState", "user_state"));
	const explicitStatus = normalizeUserState(field(mission, "status", "state"));
	const cancelled = boolValue(field(mission, "cancelled", "canceled", "undelivered", "aborted"));
	const completedStage = /^(completed|closed|done|finished)$/i.test(tokenText(rawStage) ?? "");
	let userStateKey;
	if (explicitUserState) userStateKey = explicitUserState;
	else if (explicitStatus === "delivered") userStateKey = approved ? "delivered" : "running";
	else if (explicitStatus) userStateKey = explicitStatus;
	else if (cancelled) userStateKey = "undelivered";
	else if (completedStage && approved) userStateKey = "delivered";
	else userStateKey = "running";

	const startedAt = toTimestamp(
		field(
			mission,
			"startedAt",
			"started_at",
			"started-at",
			"createdAt",
			"created_at",
			"created-at",
			"createdAtMs",
			"created_ms",
		),
	);
	const endedAt = toTimestamp(field(mission, "endedAt", "ended_at", "completedAt", "completed_at", "finishedAt"));
	const explicitElapsed = numberOrNull(field(mission, "elapsedMs", "elapsed_ms", "elapsed"));
	const elapsedMs =
		explicitElapsed !== null
			? Math.max(0, explicitElapsed)
			: startedAt === null
				? null
				: Math.max(0, (endedAt ?? now) - startedAt);
	const tokens = normalizeTokens(mission);
	const outcome = normalizeOutcome(mission);
	const reportPath = atom(field(mission, "reportPath", "report_path", "report-path", "report"));
	const tenure = normalizeTenure(mission);
	const stageAttach = stage === null ? undefined : STAGE_ATTACH[stage];
	const attachedDocuments = unique(
		asArray(field(mission, "attached", "attachedDocuments", "attached_documents", "deliveredDocuments"))
			.map((value) => atom(value))
			.filter(Boolean),
	);
	const explicitAttachReady = field(mission, "attachReady", "attach_ready", "attach-ready");
	const attachReady =
		explicitAttachReady === undefined
			? stageAttach !== undefined && attachedDocuments.includes(stageAttach.document)
			: boolValue(explicitAttachReady);
	const attach = {
		ready: attachReady,
		expectedTool: attachReady
			? null
			: (atom(
					field(
						mission,
						"attachExpected",
						"attach_expected",
						"attach-expected",
						"expectedAttach",
						"expected_attach",
						"expectedAttachTool",
						"expectedTool",
						"expected-tool",
					),
				) ??
				stageAttach?.tool ??
				null),
		expectedDocument: attachReady
			? null
			: (atom(
					field(
						mission,
						"attachDocument",
						"attach_document",
						"attach-document",
						"expectedDocument",
						"expected_document",
						"expected-document",
						"deliverable",
					),
				) ??
				stageAttach?.document ??
				null),
	};

	if (userStateKey === "undelivered") {
		if (!outcome.reason) {
			degradation.push("undelivered-reason-missing");
			outcome.reason = "未提供具体理由";
		}
		if (!outcome.lessons) {
			degradation.push("undelivered-lessons-missing");
			outcome.lessons = "未提供教训";
		}
	}
	if (userStateKey === "delivered" && !reportPath) degradation.push("delivered-report-missing");

	return {
		slug: slug ?? null,
		title,
		stage,
		tenure,
		attach,
		userStateKey,
		userState: USER_STATES[userStateKey],
		approval: approved,
		elapsedMs,
		elapsedLabel: elapsedMs === null ? null : formatDuration(elapsedMs),
		tokens,
		outcome,
		reportPath,
	};
};

const normalizeSliceStatus = (value) => {
	const text = tokenText(value);
	if (!text) return "unknown";
	const normalized = text.toLowerCase().replaceAll("_", "-");
	if (/^(running|active|in-progress|working|started)$/.test(normalized)) return "running";
	if (/^(queued|pending|waiting|ready)$/.test(normalized)) return "queued";
	if (/^(reviewing|review|auditing)$/.test(normalized)) return "reviewing";
	if (/^(joined|merged|done|completed|finished)$/.test(normalized)) return "done";
	if (/^(abandoned|cancelled|canceled|failed|stopped)$/.test(normalized)) return "abandoned";
	return "unknown";
};

const summarizeEvent = (value) => {
	const text = atom(value);
	if (text) return text;
	if (isRecord(value)) {
		const at = atom(field(value, "at", "time", "timestamp"));
		const kind = atom(field(value, "kind", "type", "event"));
		const summary = atom(field(value, "summary", "message", "text"));
		const body = summary ?? kind;
		if (body && at) return `${at} ${body}`;
		return body;
	}
	return undefined;
};

const normalizeSlices = (input, degradation) => {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input) && !(input instanceof Map) && !isRecord(input)) {
		degradation.push("slices-unreadable");
		return [];
	}
	const singleSlice =
		isRecord(input) &&
		(field(input, "slice_id", "sliceId", "workspace", "workspace_path", "workspacePath", "id") !== undefined ||
			field(input, "status", "state", "phase") !== undefined);
	const entries =
		input instanceof Map
			? [...input.entries()]
			: Array.isArray(input)
				? input.map((item) => [undefined, item])
				: singleSlice
					? [[undefined, input]]
					: Object.entries(input);
	const slices = [];
	for (const [key, raw] of entries) {
		if (isRecord(raw)) {
			const id = atom(field(raw, "slice_id", "sliceId", "id")) ?? atom(key);
			if (!id) continue;
			slices.push({
				id,
				status: normalizeSliceStatus(field(raw, "status", "state", "phase")),
				reviewer: atom(field(raw, "reviewer", "owner", "owner_id", "ownerId", "agent", "agent_id", "agentId")),
				rootTaskCount: integerOrNull(field(raw, "rootTaskCount", "root_task_count", "roots")),
				lastEvent: summarizeEvent(field(raw, "lastEvent", "last_event", "recentEvent", "event")),
			});
		} else {
			const id = atom(key);
			if (!id) continue;
			slices.push({
				id,
				status: normalizeSliceStatus(raw),
				reviewer: undefined,
				rootTaskCount: null,
				lastEvent: undefined,
			});
		}
	}
	return slices;
};

const normalizeTaskState = (value) => {
	const text = tokenText(value);
	if (!text) return "unknown";
	const normalized = text.toLowerCase().replaceAll("_", "-");
	if (/^(ready|open|todo|available)$/.test(normalized)) return "ready";
	if (/^(waiting|blocked|parked|sleeping|blocked-by)$/.test(normalized)) return "waiting";
	if (/^(done|completed|finished|closed)$/.test(normalized)) return "done";
	return "unknown";
};

const normalizeTask = (raw, key, index) => {
	if (!isRecord(raw)) return null;
	const id = atom(field(raw, "id", "task_id", "taskId")) ?? atom(key) ?? `?${index + 1}`;
	const title = atom(field(raw, "title", "name", "goal", "description")) ?? id;
	const waitFor = asArray(field(raw, "wait_for", "waitFor", "wait-for", "blocked_by", "blockedBy", "depends_on"))
		.map(
			(value) =>
				atom(value) ??
				atom(field(value, "id", "task_id", "taskId")) ??
				atom(field(value, "condition", "condition_text", "conditionText")),
		)
		.filter(Boolean);
	return {
		id,
		title,
		state: boolValue(field(raw, "waiting"))
			? "waiting"
			: normalizeTaskState(field(raw, "state", "status")),
		parent: atom(field(raw, "parent", "parent_id", "parentId")),
		children: unique(
			asArray(field(raw, "child_keys", "childKeys", "child-keys", "children"))
				.map((value) => atom(value))
				.filter(Boolean),
		),
		waitFor: unique(waitFor),
		needsToken: boolValue(field(raw, "needs_token", "needsToken", "needs-token", "token")),
		owner: atom(field(raw, "owner", "owner_id", "ownerId", "assignee", "agent_id", "agentId")),
	};
};

const summarizeAction = (value) => {
	const text = atom(value);
	if (text) return text;
	if (!isRecord(value)) return undefined;
	const id = atom(field(value, "id", "action_id", "actionId"));
	const title = atom(field(value, "title", "summary", "name", "kind", "type"));
	const state = tokenText(field(value, "state", "status"));
	const body = [id, title].filter(Boolean).join(" ");
	if (!body) return undefined;
	return state ? `${body} [:${state}]` : body;
};

const normalizeActor = (raw, key, index) => {
	if (!isRecord(raw)) return null;
	const slotId = atom(field(raw, "slot_id", "slotId", "slot-id", "id", "slot")) ?? atom(key) ?? `slot-${index + 1}`;
	const lifeRaw = tokenText(field(raw, "life_state", "lifeState", "life-state", "state", "status"));
	const life = lifeRaw ? lifeRaw.toLowerCase().replaceAll("_", "-") : "unknown";
	return {
		slotId,
		agentId: atom(field(raw, "agent_id", "agentId", "agent-id", "agent", "id")),
		lifeState: life,
		reincarnations: integerOrNull(field(raw, "reincarnations", "reincarnation", "incarnation", "turnover")) ?? 0,
		action: summarizeAction(
			field(raw, "current_action", "currentAction", "active_action_id", "activeActionId", "action", "working_on"),
		),
	};
};

const normalizeHolder = (value) => {
	if (!value) return null;
	if (typeof value === "string" || typeof value === "number") {
		return { agentId: atom(value), termId: null, slotId: null };
	}
	if (!isRecord(value)) return null;
	const agentId = atom(field(value, "agent_id", "agentId", "agent", "id"));
	const termId = atom(field(value, "term_id", "termId", "term-id", "term"));
	const slotId = atom(field(value, "slot_id", "slotId", "slot"));
	if (!agentId && !termId && !slotId) return null;
	return { agentId, termId, slotId };
};

const normalizeTokenSlot = (value) => {
	if (!value) return null;
	if (!isRecord(value)) {
		const holder = normalizeHolder(value);
		return holder ? { holder, responsibility: [], waiting: [] } : null;
	}
	const holderValue = field(value, "holder", "current_holder", "currentHolder", "owner");
	const holderId = atom(holderValue);
	const termId = atom(field(value, "term_id", "termId", "term-id", "holder_term_id", "holderTermId", "holder-term-id"));
	const holder =
		(isRecord(holderValue) ? normalizeHolder(holderValue) : null) ??
		normalizeHolder({
			agent_id: holderId ?? atom(field(value, "holder_id", "holderId", "holder-id", "holder_agent_id", "holderAgentId", "holder-agent-id")),
			term_id: termId,
			slot_id: field(value, "holder_slot_id", "holderSlotId"),
		});
	if (holder && !holder.termId && termId) holder.termId = termId;
	const responsibility = asArray(field(value, "responsibility", "responsibility_set", "responsibilitySet", "duties"))
		.map((item) => atom(item) ?? atom(field(item, "id", "task_id", "taskId", "title")))
		.filter(Boolean);
	const waiting = asArray(field(value, "waiting", "waiting_tasks", "waitingTasks", "queued"))
		.map((item) => atom(item) ?? atom(field(item, "id", "task_id", "taskId", "title")))
		.filter(Boolean);
	return { holder, responsibility: unique(responsibility), waiting: unique(waiting) };
};

const normalizeWriteLock = (value) => {
	if (!value) return null;
	if (!isRecord(value)) {
		const holder = normalizeHolder(value);
		return holder ? { holder, action: undefined, queue: [], lastConflict: undefined } : null;
	}
	const holderValue = field(value, "holder", "owner", "agent");
	const holderId = atom(holderValue);
	const termId = atom(field(value, "owner_term_id", "ownerTermId", "owner-term-id", "holder_term_id", "holderTermId", "holder-term-id", "term_id", "term-id"));
	const holder =
		(isRecord(holderValue) ? normalizeHolder(holderValue) : null) ??
		normalizeHolder({
			agent_id: holderId ?? atom(field(value, "owner_agent_id", "ownerAgentId", "owner-agent-id", "holder_agent_id", "holderAgentId", "holder-agent-id")),
			term_id: termId,
			slot_id: field(value, "holder_slot_id", "holderSlotId"),
		});
	if (holder && !holder.termId && termId) holder.termId = termId;
	return {
		holder,
		action: summarizeAction(field(value, "action", "current_action", "currentAction", "purpose", "lock_id", "lockId")),
		queue: unique(
			asArray(field(value, "queue", "waiting", "waiting_queue", "waitingQueue"))
				.map((item) => atom(item) ?? atom(field(item, "agent_id", "agentId", "id", "title")))
				.filter(Boolean),
		),
		lastConflict: atom(field(value, "lastConflict", "last_conflict", "conflict", "reason")),
	};
};

const looksLikeLock = (value) =>
	isRecord(value) &&
	["holder", "owner", "owner_agent_id", "ownerAgentId", "holder_id", "holderId", "lock_id", "lockId"].some(
		(key) => key in value,
	);

const normalizeWriteLocks = (input) => {
	const locks = new Map();
	const add = (value, fallbackId) => {
		if (!looksLikeLock(value)) return;
		const lock = normalizeWriteLock(value);
		if (!lock) return;
		const sliceId = atom(field(value, "slice_id", "sliceId")) ?? fallbackId ?? "";
		locks.set(sliceId, lock);
	};
	if (!input) return locks;
	if (Array.isArray(input)) {
		for (const value of input) add(value, undefined);
		return locks;
	}
	if (input instanceof Map) {
		for (const [key, value] of input) add(value, atom(key));
		return locks;
	}
	if (!isRecord(input)) return locks;
	if (looksLikeLock(input)) {
		add(input, "");
		return locks;
	}
	for (const [key, value] of Object.entries(input)) add(value, key);
	return locks;
};

const normalizeFindings = (value) => {
	const findings = [];
	for (const [key, raw] of asEntries(value)) {
		if (isRecord(raw)) {
			const findingKey = atom(field(raw, "key", "id", "finding_key", "findingKey")) ?? atom(key);
			const findingValue = atom(field(raw, "value", "text", "finding", "summary", "note"));
			if (findingKey && findingValue) findings.push({ key: findingKey, value: findingValue });
			continue;
		}
		const findingKey = atom(key);
		const findingValue = atom(raw);
		if (findingKey && findingValue) findings.push({ key: findingKey, value: findingValue });
	}
	return findings;
};

const normalizeReview = (raw) => {
	const present =
		field(
			raw,
			"review",
			"review_ledger",
			"reviewLedger",
			"review-board",
			"reviewBoard",
			"findings",
			"summary_markdown",
			"summaryMarkdown",
		) !== undefined;
	const value = field(raw, "review", "review_ledger", "reviewLedger", "review-board", "reviewBoard");
	const board = isRecord(value) ? value : raw;
	const byKey = new Map();
	for (const finding of normalizeFindings(
		field(board, "findings", "open_findings", "openFindings", "review_findings"),
	)) {
		byKey.set(finding.key, finding.value);
	}
	const findings = [...byKey.entries()].map(([key, findingValue]) => ({ key, value: findingValue }));
	const summaryMarkdown = atom(
		field(board, "summary_markdown", "summaryMarkdown", "review_summary", "reviewSummary"),
	);
	return {
		present,
		summaryMarkdown,
		findings,
		open: present && findings.length > 0,
		quiescent: present && findings.length === 0,
	};
};

const normalizeBoard = (raw) => {
	const tasksRaw = field(raw, "tasks", "task_map", "taskMap");
	const tasks = [];
	for (const [key, value] of asEntries(tasksRaw)) {
		const task = normalizeTask(value, key, tasks.length);
		if (task) tasks.push(task);
	}
	const actions = [];
	for (const [key, value] of asEntries(field(raw, "actions", "action_map", "actionMap"))) {
		if (!isRecord(value)) continue;
		actions.push({
			id: atom(field(value, "id", "action_id", "actionId")) ?? atom(key) ?? `action-${actions.length + 1}`,
			state: tokenText(field(value, "phase", "state", "status")),
			owner: atom(field(value, "owner", "agent_id", "agentId", "agent", "holder")),
			taskId: atom(field(value, "task_id", "taskId")),
		});
	}
	const actors = [];
	for (const [key, value] of asEntries(field(raw, "actors", "actor_map", "actorMap", "slots"))) {
		const actor = normalizeActor(value, key, actors.length);
		if (actor) actors.push(actor);
	}
	const tokenSlot = normalizeTokenSlot(field(raw, "token_slot", "tokenSlot", "token-slot", "token"));
	if (tokenSlot?.holder?.agentId) {
		const holderId = tokenSlot.holder.agentId;
		if (tokenSlot.responsibility.length === 0) {
			const responsibility = [];
			for (const task of tasks) {
				if (task.state !== "ready" && task.state !== "waiting") continue;
				if (task.needsToken) responsibility.push(task.id);
				else if (task.owner === holderId) responsibility.push(task.id);
			}
			for (const action of actions) {
				if (action.owner === holderId && ACTIVE_ACTION_PHASES.has(action.state ?? "")) {
					responsibility.push(action.id);
				}
			}
			tokenSlot.responsibility = unique(responsibility);
		}
	} else if (tokenSlot?.waiting.length === 0) {
		tokenSlot.waiting = unique(
			tasks
				.filter((task) => task.needsToken && (task.state === "ready" || task.state === "waiting"))
				.map((task) => task.id),
		);
	}
	const review = normalizeReview(raw);
	const tenure = normalizeTenure(raw);
	const lock = normalizeWriteLock(
		field(raw, "lock", "board_lock", "boardLock", "board-lock", "write_lock", "writeLock", "write-lock"),
	);
	return {
		sliceId: atom(field(raw, "slice_id", "sliceId", "slice-id", "id", "workspace_id", "workspaceId", "workspace-id")),
		stage: normalizeStage(field(raw, "stage", "current_stage", "currentStage", "current-stage")),
		version: integerOrNull(field(raw, "board_version", "boardVersion", "board-version", "version")),
		tenure,
		review,
		tasks,
		actions,
		actors,
		tokenSlot,
		lock,
	};
};

const looksLikeBoard = (value) =>
	isRecord(value) &&
	[
		"tasks",
		"task_map",
		"taskMap",
		"actions",
		"actors",
		"token-slot",
		"tokenSlot",
		"review",
		"findings",
		"tenure",
		"board_lock",
		"write-lock",
		"writeLock",
	].some(
		(key) => key in value,
	);

const normalizeBoards = (input, slices, degradation) => {
	const boards = new Map();
	const add = (raw, fallbackId) => {
		if (!isRecord(raw)) return;
		const nested = field(raw, "board", "snapshot", "state");
		if (looksLikeBoard(nested)) {
			const wrapperId = atom(field(raw, "slice_id", "sliceId", "id"));
			raw = nested;
			fallbackId = wrapperId ?? fallbackId;
		}
		const board = normalizeBoard(raw);
		const id = board.sliceId ?? fallbackId ?? "";
		if (!boards.has(id) || id === "") boards.set(id, board);
	};
	if (input === undefined || input === null) return boards;
	if (input instanceof Map) {
		for (const [key, value] of input) add(value, atom(key));
		return boards;
	}
	if (Array.isArray(input)) {
		for (const value of input) add(value, undefined);
		return boards;
	}
	if (!isRecord(input)) {
		degradation.push("boards-unreadable");
		return boards;
	}
	if (looksLikeBoard(input)) {
		add(input, slices[0]?.id);
		return boards;
	}
	for (const [key, value] of Object.entries(input)) {
		if (looksLikeBoard(value)) add(value, key);
		else {
			for (const item of asArray(value)) add(item, key);
		}
	}
	return boards;
};

const boardFor = (boards, sliceId) => {
	if (!boards || boards.size === 0) return undefined;
	if (sliceId !== undefined && sliceId !== null) {
		const exact = boards.get(sliceId);
		if (exact) return exact;
	}
	return boards.get("") ?? undefined;
};

const sliceIdsOf = (slices, boards) => {
	const ids = slices.map((slice) => slice.id);
	for (const id of boards.keys()) if (id) ids.push(id);
	return unique(ids);
};

const taskLookup = (board) => new Map((board?.tasks ?? []).map((task) => [task.id, task]));

const rootTasks = (board) => {
	const tasks = board?.tasks ?? [];
	const byId = taskLookup(board);
	const declared = new Set(tasks.flatMap((task) => task.children));
	return tasks.filter((task) => (!task.parent || !byId.has(task.parent)) && !declared.has(task.id));
};

const childrenOf = (board, parentId) => {
	const parent = taskLookup(board).get(parentId);
	const declared = new Set(parent?.children ?? []);
	return (board?.tasks ?? []).filter((task) => task.parent === parentId || declared.has(task.id));
};

const sortTasks = (tasks) => {
	const rank = { waiting: 0, ready: 1, unknown: 2, done: 3 };
	return [...tasks].sort((left, right) => rank[left.state] - rank[right.state] || left.id.localeCompare(right.id));
};

const taskLine = (task, depth) => {
	const indent = "  ".repeat(depth + 1);
	const details = [`:${task.state}`];
	if (task.waitFor.length > 0) details.push(`wait-for: ${task.waitFor.join(", ")} → :ready`);
	if (task.needsToken) details.push("需令牌");
	if (task.owner) details.push(`owner: ${task.owner}`);
	return `${indent}- ${task.id} ${task.title} [${details.join("; ")}]`;
};

const renderTaskForest = (board) => {
	const roots = sortTasks(rootTasks(board));
	if (roots.length === 0) return ["无任务"];
	const lines = [];
	const append = (task, depth) => {
		if (lines.length >= MAX_LIST_LINES) return;
		lines.push(taskLine(task, depth));
		for (const child of sortTasks(childrenOf(board, task.id))) append(child, depth + 1);
	};
	for (const task of roots) append(task, 0);
	const total = (board?.tasks ?? []).length;
	if (lines.length < total) lines.push(`… 其余 ${total - lines.length} 个任务未展开`);
	return lines;
};

const attachLine = (attach) =>
	attach.ready
		? "交付物 已 attach"
		: `交付物 待 attach · 下一步 ${attach.expectedTool ?? "attach"}${
				attach.expectedDocument ? ` → ${attach.expectedDocument}` : ""
			}`;

const reviewLine = (review, stage) => {
	if (!review?.present) return "审查 尚无 review 记录";
	if (review.open) return `审查 发现 ${review.findings.length} 项 · wake-all`;
	return stage === "S5" ? "审查 quiescent · 进入 K 审计" : "审查 quiescent";
};

const renderTenure = (mission, board, review) => {
	const lines = [
		`阶段 ${mission.stage ?? "—"} · 任期 ${mission.tenure.id ?? "—"}${
			board?.version !== null && board?.version !== undefined ? ` · 板 v${board.version}` : ""
		}`,
		mission.stage === "S5" ? "工作区 单一主工作区 · Reviewer 1 · Swarm board 1" : attachLine(mission.attach),
		reviewLine(review, mission.stage),
	];
	if (board?.tenure?.askUsed) lines.push("首问已用");
	if (review?.summaryMarkdown) lines.push(`审查摘要 ${review.summaryMarkdown}`);
	if (review?.open) lines.push(`findings: ${review.findings.map((entry) => entry.key).join(", ")}`);
	return lines;
};

const renderWorkspaces = (workspaces, boards, stage) => {
	if (workspaces.length === 0) {
		return [stage === "S5" ? "尚无工作区（S5 为单一主工作区）" : "尚无工作区（S1–S4 只有 Plan tenure）"];
	}
	const lines = [];
	for (const workspace of workspaces.slice(0, MAX_LIST_LINES)) {
		const board = boardFor(boards, workspace.id);
		const roots = board ? rootTasks(board).length : (workspace.rootTaskCount ?? 0);
		const parts = [
			`${workspace.id}`,
			`:${workspace.status}`,
			`Reviewer ${workspace.reviewer ?? "—"}`,
			`根任务 ${roots}`,
		];
		if (board?.review?.present) {
			parts.push(
				board.review.open ? `findings ${board.review.findings.length} · wake-all` : "findings 0 · quiescent",
			);
		}
		if (workspace.lastEvent) parts.push(`最近: ${workspace.lastEvent}`);
		lines.push(parts.join(" · "));
	}
	if (workspaces.length > MAX_LIST_LINES) lines.push(`… 其余 ${workspaces.length - MAX_LIST_LINES} 个工作区`);
	return lines;
};

const renderSlots = (board) => {
	if (!board) return ["看板未加载"];
	const actors = board.actors.slice(0, MAX_LIST_LINES);
	if (actors.length === 0) return ["无个体快照"];
	return actors.map((actor) => {
		const parts = [actor.slotId, actor.agentId ?? "agent —", `:${actor.lifeState}`, `转世 ${actor.reincarnations}`];
		if (actor.action) parts.push(`动作 ${actor.action}`);
		return parts.join(" · ");
	});
};

const renderToken = (board) => {
	if (!board) return ["看板未加载"];
	const slot = board.tokenSlot;
	if (!slot) return ["令牌槽未加载"];
	const lines = [];
	if (slot.holder) {
		const holder = [slot.holder.agentId ?? "agent —"];
		if (slot.holder.termId) holder.push(`term ${slot.holder.termId}`);
		if (slot.holder.slotId) holder.push(`slot ${slot.holder.slotId}`);
		lines.push(`Holder ${holder.join(" · ")}`);
	} else {
		lines.push("Holder 空 · 令牌空闲");
	}
	lines.push(`责任: ${slot.responsibility.length > 0 ? slot.responsibility.join(", ") : "空"}`);
	lines.push(`等待令牌: ${slot.waiting.length > 0 ? slot.waiting.join(", ") : "无"}`);
	return lines;
};

const renderWriteLock = (board) => {
	if (!board) return ["看板未加载"];
	const lock = board.lock;
	if (!lock?.holder) return ["board.lock 空闲"];
	const parts = ["board.lock", `持有人 ${lock.holder.agentId ?? "agent —"}`];
	if (lock.holder.termId) parts.push(`term ${lock.holder.termId}`);
	if (lock.action) parts.push(`动作 ${lock.action}`);
	parts.push(`队列 ${lock.queue.length}`);
	if (lock.lastConflict) parts.push(`最近冲突 ${lock.lastConflict}`);
	return [parts.join(" · ")];
};

const pickFocusTask = (board, requestedTaskId) => {
	const tasks = board?.tasks ?? [];
	if (requestedTaskId) {
		const requested = tasks.find((task) => task.id === requestedTaskId);
		if (requested) return requested;
	}
	return (
		sortTasks(tasks.filter((task) => task.state === "waiting"))[0] ??
		sortTasks(tasks.filter((task) => task.state === "ready"))[0] ??
		null
	);
};

const normalizeFocus = (input, slices, boards) => {
	const focus = isRecord(input) ? input : typeof input === "string" ? { text: input } : {};
	const sliceId = atom(field(focus, "sliceId", "slice_id", "slice-id", "slice")) ?? slices[0]?.id ?? null;
	const board = boardFor(boards, sliceId);
	const requestedTaskId = atom(field(focus, "taskId", "task_id", "task"));
	const customLine = atom(field(focus, "text", "line", "summary"));
	if (customLine) {
		return {
			sliceId,
			taskId: requestedTaskId ?? null,
			line: customLine,
			kind: tokenText(field(focus, "kind", "state")) ?? "custom",
			waitingChain: asArray(field(focus, "waitingChain", "waiting_chain"))
				.map(atom)
				.filter(Boolean),
		};
	}
	const task = pickFocusTask(board, requestedTaskId);
	if (task) {
		const line =
			task.state === "waiting" && task.waitFor.length > 0
				? `${task.id} ${task.title} · 等待 [${task.waitFor.join(", ")}]（解除后回 :ready）`
				: `${task.id} ${task.title} · :${task.state}${task.needsToken ? " · 需令牌" : ""}`;
		return {
			sliceId,
			taskId: task.id,
			line,
			kind: task.state,
			waitingChain: task.state === "waiting" ? [task.id, ...task.waitFor] : [task.id],
		};
	}
	if (!board) {
		return { sliceId, taskId: null, line: "看板尚未加载", kind: "unavailable", waitingChain: [] };
	}
	return {
		sliceId,
		taskId: null,
		line: board.tasks.length === 0 ? "暂无任务" : "无可立即推进任务（等待外部条件）",
		kind: "blocked",
		waitingChain: [],
	};
};

const scoreValue = (value) => {
	if (value === undefined || value === null) return { present: false, valid: false, value: null };
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100) {
		return { present: true, valid: false, value: typeof value === "number" ? value : null };
	}
	return { present: true, valid: true, value };
};

const normalizeCaseRow = (raw, fallbackId, degradation) => {
	const row = isRecord(raw) ? raw : {};
	const caseId = atom(field(row, "case_id", "caseId", "case-id", "id", "case")) ?? atom(fallbackId);
	const threshold = numberOrNull(field(row, "threshold", "passThreshold", "pass_threshold"));
	const user = scoreValue(field(row, "user_score", "userScore", "user-score", "user"));
	const developer = scoreValue(field(row, "developer_score", "developerScore", "developer-score", "developer"));
	const submittedFlag = field(row, "submitted", "complete", "completed");
	const submitted = submittedFlag === undefined ? user.present || developer.present : boolValue(submittedFlag);
	const evidence = asArray(field(row, "evidence_paths", "evidencePaths", "evidence"))
		.map((item) => atom(item))
		.filter(Boolean);
	const explicitPassed = field(row, "passed", "pass");
	const explicitVerdict = tokenText(field(row, "verdict", "status"));
	const explicitFail =
		explicitPassed === false || (typeof explicitVerdict === "string" && explicitVerdict.toLowerCase() === "fail");
	return {
		caseId,
		threshold,
		user,
		developer,
		submitted,
		evidence: unique(evidence),
		explicitFail,
		duplicate: false,
		notes: [],
		degradation,
	};
};

const mergeCaseSubmission = (row, raw, degradation) => {
	const submission = isRecord(raw) ? raw : {};
	const user = scoreValue(field(submission, "user_score", "userScore", "user-score", "user"));
	const developer = scoreValue(field(submission, "developer_score", "developerScore", "developer-score", "developer"));
	const threshold = numberOrNull(field(submission, "threshold", "passThreshold", "pass_threshold"));
	const evidence = asArray(field(submission, "evidence_paths", "evidencePaths", "evidence"))
		.map((item) => atom(item))
		.filter(Boolean);
	const submittedFlag = field(submission, "submitted", "complete", "completed");
	const explicitPassed = field(submission, "passed", "pass");
	const explicitVerdict = tokenText(field(submission, "verdict", "status"));
	if (user.present || developer.present) {
		row.user = user;
		row.developer = developer;
		row.submitted = true;
	}
	if (submittedFlag !== undefined) row.submitted = boolValue(submittedFlag);
	if (threshold !== null) row.threshold = threshold;
	if (evidence.length > 0) row.evidence = unique([...row.evidence, ...evidence]);
	if (explicitPassed === false) row.explicitFail = true;
	if (typeof explicitVerdict === "string" && explicitVerdict.toLowerCase() === "fail") row.explicitFail = true;
	if (row.duplicate) degradation.push(`audit-duplicate:${row.caseId}`);
	return row;
};

const finalizeCaseRow = (row) => {
	const notes = [];
	let verdict;
	const final = row.user.valid && row.developer.valid ? Math.min(row.user.value, row.developer.value) : null;
	if (row.duplicate) {
		verdict = "INVALID";
		notes.push("重复提交");
	} else if (!row.submitted) {
		verdict = "PENDING";
	} else if (!row.user.present || !row.developer.present) {
		verdict = "PENDING";
		notes.push("提交不完整");
	} else if (!row.user.valid || !row.developer.valid) {
		verdict = "INVALID";
		notes.push("分数必须是 0–100 的整数");
	} else if (row.threshold === null || row.threshold < 0 || row.threshold > 100) {
		verdict = "INVALID";
		notes.push("缺少合法 threshold");
	} else if (row.explicitFail) {
		verdict = "FAIL";
	} else {
		verdict = final >= row.threshold ? "PASS" : "FAIL";
	}
	const userValue = row.user.present ? (row.user.valid ? row.user.value : "—") : "—";
	const developerValue = row.developer.present ? (row.developer.valid ? row.developer.value : "—") : "—";
	const minValue = row.user.valid && row.developer.valid ? Math.min(row.user.value, row.developer.value) : "—";
	const thresholdValue = row.threshold === null ? "—" : row.threshold;
	const parts = [
		`${row.caseId ?? "CASE-?"} user_score=${userValue}`,
		`developer_score=${developerValue}`,
		`min=${minValue}`,
		`threshold=${thresholdValue}`,
		verdict,
	];
	if (notes.length > 0) parts.push(notes.join("; "));
	if (row.evidence.length > 0) parts.push(`证据 ${row.evidence[0]}`);
	return {
		caseId: row.caseId ?? "CASE-?",
		userScore: row.user.valid ? row.user.value : null,
		developerScore: row.developer.valid ? row.developer.value : null,
		final,
		min: final,
		score: final,
		threshold: row.threshold,
		verdict,
		passed: verdict === "PASS",
		submitted: row.submitted,
		evidencePaths: row.evidence,
		line: singleLine(parts.join(" ")),
	};
};

const resolvePhaseIndex = (audit, counts) => {
	const explicitIndex = integerOrNull(field(audit, "phaseIndex", "phase_index", "phaseNumber", "phase_number"));
	if (explicitIndex !== null && explicitIndex >= 0 && explicitIndex <= 3) return explicitIndex;
	const phaseText = tokenText(field(audit, "phase", "phaseKey", "phase_key", "status", "stage"));
	if (phaseText) {
		const normalized = phaseText.toLowerCase().replaceAll("_", "-");
		const byKey = AUDIT_PHASES.findIndex((phase) => phase.key === normalized);
		if (byKey >= 0) return byKey;
		const byLabel = AUDIT_PHASES.findIndex((phase) => phase.label === phaseText);
		if (byLabel >= 0) return byLabel;
		const numeric = /^([1-4])$/.exec(normalized);
		if (numeric) return Number(numeric[1]) - 1;
		if (/^(auditors?|starting|launch|launching)$/.test(normalized)) return 0;
		if (/^(cases?|collecting|submissions?|submitted|running)$/.test(normalized)) return 1;
		if (/^(summary|aggregation|aggregating)$/.test(normalized)) return 2;
		if (/^(closed|done|finished)$/.test(normalized)) return 3;
		if (/^(rework|repair|approval|report)$/.test(normalized)) return 3;
	}
	if (boolValue(field(audit, "closed", "finished"))) return 3;
	if (counts.submitted > 0) return 2;
	return 0;
};

const normalizeAudit = (input, degradation) => {
	const audit = isRecord(input) ? input : Array.isArray(input) ? { submissions: input } : {};
	if (input !== undefined && input !== null && !isRecord(input) && !Array.isArray(input)) {
		degradation.push("audit-unreadable");
	}
	const rosterRaw = field(audit, "cases", "case_specs", "caseSpecs", "requirements");
	const rosterEntries =
		rosterRaw instanceof Map
			? [...rosterRaw.entries()]
			: Array.isArray(rosterRaw)
				? rosterRaw.map((entry) => [undefined, entry])
				: isRecord(rosterRaw)
					? Object.entries(rosterRaw)
					: [];
	const submissionsRaw = field(audit, "submissions", "results", "scores", "rows");
	const rowsById = new Map();
	const order = [];
	const ensureRow = (caseId) => {
		let row = rowsById.get(caseId);
		if (!row) {
			row = normalizeCaseRow({}, caseId, degradation);
			rowsById.set(caseId, row);
			order.push(caseId);
		}
		return row;
	};
	for (const [key, entry] of rosterEntries) {
		const row = normalizeCaseRow(entry, key, degradation);
		if (!row.caseId) {
			degradation.push("audit-case-unreadable");
			continue;
		}
		if (rowsById.has(row.caseId)) {
			row.duplicate = true;
			degradation.push(`audit-duplicate:${row.caseId}`);
		}
		rowsById.set(row.caseId, row);
		if (!order.includes(row.caseId)) order.push(row.caseId);
	}
	const submissionEntries =
		submissionsRaw instanceof Map
			? [...submissionsRaw.entries()].map(([key, value]) => [atom(key), value])
			: Array.isArray(submissionsRaw)
				? submissionsRaw.map((value) => [undefined, value])
				: isRecord(submissionsRaw)
					? Object.entries(submissionsRaw)
					: [];
	const seenSubmissions = new Set();
	for (const [key, value] of submissionEntries) {
		const caseId = atom(field(value, "case_id", "caseId", "case-id", "id", "case")) ?? atom(key);
		if (!caseId) {
			degradation.push("audit-submission-unreadable");
			continue;
		}
		const row = ensureRow(caseId);
		if (seenSubmissions.has(caseId)) {
			row.duplicate = true;
			degradation.push(`audit-duplicate:${caseId}`);
			continue;
		}
		seenSubmissions.add(caseId);
		mergeCaseSubmission(row, value, degradation);
	}
	const cases = order.map((caseId) => finalizeCaseRow(rowsById.get(caseId)));
	const counts = {
		submitted: cases.filter((entry) => entry.submitted).length,
		total: 0,
		pass: cases.filter((entry) => entry.verdict === "PASS").length,
		fail: cases.filter((entry) => entry.verdict === "FAIL").length,
		pending: cases.filter((entry) => entry.verdict === "PENDING").length,
		invalid: cases.filter((entry) => entry.verdict === "INVALID").length,
	};
	const reportedTotal = integerOrNull(field(audit, "total", "caseCount", "case_count", "K", "k"));
	counts.total = Math.max(reportedTotal ?? 0, cases.length);
	const reportedSubmitted = integerOrNull(
		field(audit, "submitted", "submittedCount", "submitted_count", "submittedK", "submitted_k"),
	);
	if (reportedSubmitted !== null) {
		counts.submitted = Math.max(counts.submitted, Math.min(counts.total, Math.max(0, reportedSubmitted)));
	}
	counts.pending += Math.max(0, counts.total - cases.length);
	const explicitActive = field(audit, "active", "running", "inProgress", "in_progress");
	const closed = boolValue(field(audit, "closed", "finished"));
	const active = closed
		? false
		: explicitActive === undefined
			? counts.total > 0 || field(audit, "phase", "phaseIndex", "phase_index") !== undefined
			: boolValue(explicitActive);
	const phaseIndex = closed ? 3 : resolvePhaseIndex(audit, counts);
	const phaseKey = counts.total > 0 || active ? AUDIT_PHASES[phaseIndex].key : null;
	const phases = AUDIT_PHASES.map((phase, index) => ({
		...phase,
		status: closed || index < phaseIndex ? "done" : index === phaseIndex ? "current" : "pending",
	}));
	const auditorsRaw = field(audit, "auditors", "agents");
	const auditors = typeof auditorsRaw === "number" ? Math.max(0, Math.trunc(auditorsRaw)) : asArray(auditorsRaw).length;
	const rowsForTable = cases.map((entry) => entry.line);
	if (counts.total > cases.length) rowsForTable.push(`… 其余 ${counts.total - cases.length} 个 CASE 尚未登记`);
	return {
		active,
		closed,
		phaseIndex,
		phaseKey,
		phaseLabel: phaseKey ? AUDIT_PHASES[phaseIndex].label : null,
		phases,
		cases,
		rows: cases,
		counts,
		auditors,
		lines: rowsForTable,
		progressLabel: `已提交 ${counts.submitted} / ${counts.total}`,
		countsLabel: `PASS ${counts.pass} · FAIL ${counts.fail} · PENDING ${counts.pending}${
			counts.invalid > 0 ? ` · INVALID ${counts.invalid}` : ""
		}`,
	};
};

const buildWorkspaceSummary = (workspaces, stage) => {
	const counts = { running: 0, reviewing: 0, done: 0, abandoned: 0, unknown: 0, total: workspaces.length };
	for (const workspace of workspaces) counts[workspace.status] = (counts[workspace.status] ?? 0) + 1;
	const filled =
		counts.total === 0
			? 0
			: Math.max(0, Math.min(PROGRESS_WIDTH, Math.round((counts.done / counts.total) * PROGRESS_WIDTH)));
	const bar = `${"█".repeat(filled)}${"░".repeat(PROGRESS_WIDTH - filled)}`;
	if (counts.total === 0) {
		const emptyLabel = stage === "S5" ? "工作区 0 · 主工作区未启动" : "工作区 0 · S1–S4 只有 Plan tenure";
		return { counts, progressBar: `[${bar}]`, label: emptyLabel, line: emptyLabel };
	}
	const parts = [
		`工作区 ${counts.total} [${bar}]`,
		`运行 ${counts.running}`,
		`审查 ${counts.reviewing}`,
		`完成 ${counts.done}`,
		`放弃 ${counts.abandoned}`,
	];
	if (counts.unknown > 0) parts.push(`未知 ${counts.unknown}`);
	return {
		counts,
		progressBar: `[${bar}]`,
		label: parts.join(" · "),
		line: parts.join(" · "),
	};
};

const buildCompact = ({ mission, workspaceSummary, focus, review, audit, degradation }) => {
	if (!mission) {
		const lines = singleLines([
			"Herdchestra Lite · 无活跃使命",
			"运行 /herd <需求> 创建使命",
			"Ctrl+Shift+T 展开 · /herd-status verbose 查看完整视图",
		]);
		return { regime: "compact", lines, text: lines.join("\n"), essentialCount: 2 };
	}
	const lines = [];
	const title = mission.slug
		? `Herdchestra Lite · ${mission.title === mission.slug ? mission.slug : `${mission.title} · ${mission.slug}`}`
		: `Herdchestra Lite · ${mission.title}`;
	lines.push(title);
	const status = [
		`状态 ${mission.userState}`,
		`阶段 ${mission.stage ?? "—"}`,
		`任期 ${mission.tenure.id ?? "—"}`,
	];
	if (mission.elapsedLabel) status.push(`耗时 ${mission.elapsedLabel}`);
	if (mission.tokens.label) status.push(`Token ${mission.tokens.label}`);
	lines.push(status.join(" · "));
	lines.push(workspaceSummary.line);
	lines.push(
		mission.stage === "S5" ? "工作区 单一主工作区 · Reviewer 1 · Swarm board 1" : attachLine(mission.attach),
	);
	lines.push(reviewLine(review, mission.stage));
	lines.push(`焦点 ${focus.line}`);
	if (mission.userStateKey === "undelivered") {
		lines.push(`原因 ${mission.outcome.reason} · 教训 ${mission.outcome.lessons}`);
		if (mission.outcome.retry) lines.push(`可重试 ${mission.outcome.retry}`);
	}
	if (audit.phaseKey) {
		lines.push(`审计 ${audit.phaseLabel} · ${audit.progressLabel} · ${audit.countsLabel}`);
	}
	if (mission.userStateKey === "delivered" && mission.reportPath) lines.push(`报告 ${mission.reportPath}`);
	if (mission.userStateKey === "delivered" && !mission.reportPath) lines.push("报告 未提供（缺陷）");
	const essentialCount = lines.length;
	const hint =
		mission.userStateKey === "running"
			? "Esc 取消 · Ctrl+Shift+T 展开 · /herd-status verbose 详情"
			: "Ctrl+Shift+T 展开 · /herd-status verbose 详情";
	lines.push(hint);
	if (degradation.length > 0) lines.push(`降级 ${degradation.length} 项 · /herd-status health 查看`);
	const safeLines = singleLines(lines);
	return { regime: "compact", lines: safeLines, text: safeLines.join("\n"), essentialCount };
};

const buildAuditPanel = (audit) => {
	const layers = AUDIT_PHASES.map((phase, index) => {
		const status = audit.phases[index].status;
		const marker = status === "done" ? "[完成]" : status === "current" ? "[当前]" : "[待]";
		const lines = [];
		if (phase.key === "start") {
			lines.push(
				`审计员 ${audit.auditors > 0 ? `${audit.auditors} 名` : "数量未提供"} · CASE ${audit.counts.total} 个`,
			);
		} else if (phase.key === "submit") {
			lines.push(`${audit.progressLabel} · ${audit.countsLabel}`);
			const pending = audit.cases.filter((entry) => entry.verdict === "PENDING").map((entry) => entry.caseId);
			if (pending.length > 0) lines.push(`待提交/待补全: ${pending.join(", ")}`);
		} else if (phase.key === "aggregate") {
			lines.push(`${audit.countsLabel}`);
			lines.push("只有全部 CASE PASS 才允许结案");
		} else if (phase.key === "close") {
			if (audit.counts.fail > 0) lines.push("存在 FAIL：转入返工 Slice，不结案");
			else if (audit.counts.submitted < audit.counts.total || audit.counts.pending > 0)
				lines.push("等待全部 CASE 提交后汇总");
			else if (audit.counts.invalid > 0) lines.push("存在 INVALID 提交：修复后重审");
			else lines.push("全部 CASE PASS：等待一次性批准");
		}
		return { key: `audit-${phase.key}`, title: `${index}. ${phase.label} ${marker}`, lines };
	});
	const safeLayers = layers.map((layer) => ({ ...layer, lines: singleLines(layer.lines) }));
	const lines = [];
	for (const layer of safeLayers) {
		lines.push(layer.title);
		lines.push(...layer.lines);
	}
	lines.push("审计得分");
	lines.push(...audit.lines);
	lines.push(`汇总 ${audit.progressLabel} · ${audit.countsLabel}`);
	lines.push("Esc 收起 · Ctrl+Shift+T 切换紧凑 · /herd-status verbose 完整层级");
	const safeLines = singleLines(lines);
	return {
		regime: "audit",
		layers: safeLayers,
		lines: safeLines,
		text: safeLines.join("\n"),
		essentialCount: Math.min(safeLines.length, 8),
	};
};

const buildExpanded = ({ mission, slices, boards, focus, review, audit, degradation }) => {
	if (!mission) {
		const lines = singleLines([
			"Herdchestra Lite · 无活跃使命",
			"运行 /herd <需求> 创建使命",
			"展开态需要活跃使命；/herd-status verbose 仍可查看当前状态",
		]);
		return { regime: "expanded", layers: [], lines, text: lines.join("\n"), essentialCount: 2 };
	}
	if (audit.active) return buildAuditPanel(audit);
	const selectedSliceId = focus.sliceId ?? slices[0]?.id ?? null;
	const board = boardFor(boards, selectedSliceId);
	const layers = [
		{
			key: "tenure",
			title: "0. 任期与交付物",
			lines: [...renderTenure(mission, board, review), ...renderWorkspaces(slices, boards, mission.stage)],
		},
		{
			key: "tasks",
			title: "1. 任务树 · review board",
			lines: [
				"图例：等待解除回 :ready；只有 :done 表示任务完成。",
				...(board ? renderTaskForest(board) : ["看板未加载"]),
			],
		},
		{ key: "slots", title: "2. 槽位与个体", lines: renderSlots(board) },
		{ key: "token", title: "3. 令牌与责任", lines: renderToken(board) },
		{ key: "lock", title: "4. board.lock", lines: renderWriteLock(board) },
	];
	const safeLayers = layers.map((layer) => ({ ...layer, lines: singleLines(layer.lines) }));
	const lines = [];
	for (const layer of safeLayers) {
		lines.push(layer.title);
		lines.push(...layer.lines);
	}
	if (audit.counts.total > 0) {
		lines.push("审计得分");
		lines.push(...audit.lines);
		lines.push(`汇总 ${audit.progressLabel} · ${audit.countsLabel}`);
	}
	lines.push("Esc 收起 · Ctrl+Shift+T 切换紧凑 · /herd-status verbose 完整层级");
	if (degradation.length > 0) lines.push(`降级 ${degradation.length} 项 · /herd-status health 查看`);
	const safeLines = singleLines(lines);
	return {
		regime: "expanded",
		layers: safeLayers,
		lines: safeLines,
		text: safeLines.join("\n"),
		essentialCount: Math.min(safeLines.length, 6),
	};
};

const deepFreeze = (value) => {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
		return Object.freeze(value);
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		return Object.freeze(value);
	}
	return value;
};

/**
 * Derive every dashboard surface from one control-state snapshot.
 *
 * @param {{
 *   mission?: object,
 *   workspaces?: object[] | Map<string, object> | Record<string, object>,
 *   slices?: object[] | Map<string, object> | Record<string, object>,
 *   boards?: object[] | Map<string, object> | Record<string, object>,
 *   audit?: object,
 *   focus?: object,
 *   writeLock?: object | object[] | Record<string, object>,
 *   locks?: object | object[] | Record<string, object>,
 *   now?: number | Date | string,
 * }} [input]
 * @returns {object} frozen dashboard model
 */
export function deriveDashboard(input = {}) {
	const now = toTimestamp(input.now) ?? Date.now();
	const degradation = [];
	const mission = normalizeMission(input.mission, now, degradation);
	const slices = normalizeSlices(input.workspaces ?? input.slices, degradation);
	const boards = normalizeBoards(input.boards, slices, degradation);
	const writeLocks = normalizeWriteLocks(input.writeLock ?? input.locks);
	const workspaceIds = sliceIdsOf(slices, boards);
	const sliceRows = workspaceIds.map(
		(id) =>
			slices.find((slice) => slice.id === id) ?? {
				id,
				status: "unknown",
				reviewer: undefined,
				rootTaskCount: null,
			},
	);
	const audit = normalizeAudit(input.audit, degradation);
	const focus = normalizeFocus(input.focus, sliceRows, boards);
	const focusBoard = boardFor(boards, focus.sliceId);
	if (focusBoard && !focusBoard.lock && writeLocks.size > 0) {
		const lock =
			writeLocks.get(focus.sliceId) ??
			writeLocks.get("") ??
			(writeLocks.size === 1 ? writeLocks.values().next().value : undefined);
		if (lock) focusBoard.lock = lock;
	}
	const review =
		focusBoard?.review?.present === true ? { ...focusBoard.review, stage: mission?.stage ?? null } : null;
	const workspaceSummary = buildWorkspaceSummary(sliceRows, mission?.stage ?? null);
	const compact = buildCompact({ mission, workspaceSummary, focus, review, audit, degradation });
	const expanded = buildExpanded({ mission, slices: sliceRows, boards, focus, audit, review, degradation });
	const status = {
		userState: mission?.userState ?? null,
		userStateKey: mission?.userStateKey ?? null,
		stage: mission?.stage ?? null,
		tenure: mission?.tenure.id ?? null,
		attachReady: mission?.attach.ready ?? false,
		expectedAttach: mission?.attach.expectedTool ?? null,
		reviewOpen: review?.open ?? false,
		findings: review?.findings.length ?? 0,
		singleWorkspace: mission?.stage === "S5",
		compactText: compact.text,
		verboseText: expanded.text,
		text: compact.text,
	};
	const model = {
		version: DASHBOARD_MODEL_VERSION,
		empty: mission === null,
		mission,
		workspaces: { items: sliceRows, ...workspaceSummary },
		focus,
		review,
		audit,
		compact,
		expanded,
		status,
		degradation: { degraded: degradation.length > 0, reasons: unique(degradation) },
	};
	return deepFreeze(model);
}

/**
 * Return the same text `/herd-status` and the widget consume.
 *
 * @param {object} model
 * @param {{ mode?: "compact"|"expanded"|"verbose" }} [options]
 * @returns {string}
 */
export function renderDashboardText(model, options = {}) {
	const mode = options.mode ?? "compact";
	if (mode === "expanded" || mode === "verbose") return model?.expanded?.text ?? "";
	return model?.compact?.text ?? "";
}
