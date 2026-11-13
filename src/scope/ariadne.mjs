/**
 * Time Leap++ + Ariadne's Thread.
 *
 * One active timeline per host session. Every `clj_*` call is an anchor frame
 * keyed by its immutable host `toolCallId`; the display name is only a label.
 * This is the whole reason leaps are deterministic: a leap cuts the message
 * list and the frame stack by the same physical toolCall id, never by a name
 * recovered from free text.
 *
 * Invariants:
 * - Compaction is a hard boundary. Anchors before the latest compaction are
 *   not in the active messages and are not leappable; they are not listed.
 * - `timeLeap` validates its target synchronously against the live stack and
 *   records the exact toolCallId. It never accepts a pending leap that cannot
 *   be resolved later.
 * - `resolvePendingLeap` is the only mutation point: it finds the target
 *   assistant message by toolCallId, cuts the stack back to that frame, seals
 *   the departed branch as a read-only Beacon, and returns the cut messages.
 *   If the target vanished between validation and resolution, it clears the
 *   pending leap and reports `PROGRAM_UNKNOWN` instead of leaving a half-state.
 * - Beacons are immutable snapshots; they can be queried but never jumped to.
 */

import { herdError } from "../util/errors.mjs";

export const ARIADNE_BUDGET_FIELD = "ariadne_budget";
export const ARIADNE_GOAL_FIELD = "ariadne_goal";

const CLJ_TOOL_NAME = /^clj_(plan|devops|review|worker|auditor)$/;
const BOUNDARY_ENTRY_TYPES = new Set(["compaction", "branch_summary", "reset_boundary"]);
const BOUNDARY_MESSAGE_ROLES = new Set(["compactionSummary", "branchSummary", "handoff"]);

function createEmptyVerse() {
	return {
		currentTurn: 0,
		turnDirty: false,
		stack: [],
	};
}

function topFrame(verse) {
	return verse.stack.length > 0 ? verse.stack[verse.stack.length - 1] : null;
}

function findFrame(verse, target) {
	if (typeof target !== "string" || target.length === 0) return null;
	for (let index = verse.stack.length - 1; index >= 0; index -= 1) {
		const frame = verse.stack[index];
		if (frame.programName === target || frame.toolCallId === target) return { frame, index };
	}
	return null;
}

function sliceAfterLatestBoundary(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		return { compactionKey: null, postEntries: [] };
	}
	let lastCompactionIdx = -1;
	let compactionKey = null;
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		const message = entry?.message ?? entry;
		if (BOUNDARY_ENTRY_TYPES.has(entry?.type) || BOUNDARY_MESSAGE_ROLES.has(message?.role)) {
			lastCompactionIdx = i;
			compactionKey = entry?.id ?? `idx:${i}`;
		}
	}
	return {
		compactionKey,
		postEntries: lastCompactionIdx === -1 ? entries : entries.slice(lastCompactionIdx + 1),
	};
}

function messageOf(entry) {
	return entry?.message ?? entry;
}

/**
 * Recover program names from tool results. Receipt details are authoritative;
 * the two text forms (JSON and UFSS) are compatibility fallbacks for hosts that
 * strip tool details while persisting the conversation.
 */
function programNamesFromResults(entries) {
	const names = new Map();
	for (const entry of entries ?? []) {
		const message = messageOf(entry);
		if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		const direct = message.details?.programName ?? message.details?.name;
		if (typeof direct === "string" && direct.length > 0) {
			names.set(message.toolCallId, direct);
			continue;
		}
		const text = Array.isArray(message.content)
			? message.content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n")
			: "";
		const quoted = /:(?:program-name|name)\s+("(?:[^"\\]|\\.)*")/.exec(text);
		if (quoted !== null) {
			try {
				const value = JSON.parse(quoted[1]);
				if (typeof value === "string" && value.length > 0) {
					names.set(message.toolCallId, value);
					continue;
				}
			} catch {
				// A malformed receipt is not an anchor.
			}
		}
		const raw = /:(?:program-name|name)\s+#+"([^"#\n]+)"#/.exec(text);
		if (raw !== null && raw[1].length > 0) names.set(message.toolCallId, raw[1]);
	}
	return names;
}

function callsOf(entry, nameByCallId) {
	const message = messageOf(entry);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	const calls = [];
	for (const block of message.content) {
		if (block?.type !== "toolCall" || typeof block.id !== "string" || !CLJ_TOOL_NAME.test(block.name)) continue;
		const name = block.arguments?.name ?? nameByCallId.get(block.id);
		if (typeof name !== "string" || name.length === 0) continue;
		calls.push({ id: block.id, toolName: block.name, arguments: block.arguments ?? {}, name });
	}
	return calls;
}

export function createAriadneStore() {
	const sessions = new Map();

	function getSession(sessionKey) {
		let session = sessions.get(sessionKey);
		if (!session) {
			session = {
				active: createEmptyVerse(),
				beacons: new Map(),
				usedNames: new Map(),
				compactionKey: null,
				pendingLeap: null,
			};
			sessions.set(sessionKey, session);
		}
		return session;
	}

	function remainingTurns(verse) {
		const top = topFrame(verse);
		if (!top || top.budgetCount === 0) return null;
		return top.budgetSum / top.budgetCount - verse.currentTurn;
	}

	function budgetEntries(verse) {
		const out = [];
		for (const frame of verse.stack) {
			if (frame.ownDeadline === null) continue;
			out.push({
				programName: frame.programName,
				goal: frame.ownGoal,
				remaining: frame.ownDeadline - verse.currentTurn,
				updatedBudget: frame.ownDeadline - frame.turnAtCall,
			});
		}
		return out;
	}

	function nearestGoal(verse, upTo = verse.stack.length - 1) {
		for (let i = upTo; i >= 0; i -= 1) {
			const goal = verse.stack[i]?.ownGoal;
			if (goal != null) return goal;
		}
		return null;
	}

	function pushFrame(verse, params, { programName, toolCallId, toolName, replay = false }) {
		const hasBudget = params[ARIADNE_BUDGET_FIELD] !== undefined;
		const hasGoal = params[ARIADNE_GOAL_FIELD] !== undefined;
		const previous = topFrame(verse);
		let ownDeadline = null;
		let ownGoal = null;

		if (hasBudget) {
			const turns = params[ARIADNE_BUDGET_FIELD];
			if (!Number.isInteger(turns) || turns < 1) {
				if (!replay) {
					throw herdError("INVALID_ARGUMENT", `${ARIADNE_BUDGET_FIELD} must be an integer >= 1`, {
						field: ARIADNE_BUDGET_FIELD,
						received: turns,
					});
				}
			} else {
				const rawGoal = params[ARIADNE_GOAL_FIELD];
				if (typeof rawGoal !== "string" || rawGoal.trim().length === 0) {
					if (!replay) {
						throw herdError(
							"INVALID_ARGUMENT",
							`${ARIADNE_GOAL_FIELD} must be a non-empty string when ${ARIADNE_BUDGET_FIELD} is set`,
							{ field: ARIADNE_GOAL_FIELD },
						);
					}
				} else {
					ownGoal = rawGoal.trim();
				}
				ownDeadline = verse.currentTurn + 1 + turns;
			}
		} else if (hasGoal && typeof params[ARIADNE_GOAL_FIELD] === "string") {
			const goal = params[ARIADNE_GOAL_FIELD].trim();
			if (goal.length > 0) ownGoal = goal;
		}

		verse.stack.push({
			programName,
			toolCallId,
			toolName,
			turnAtCall: verse.currentTurn,
			ownDeadline,
			ownGoal,
			budgetSum: (previous ? previous.budgetSum : 0) + (ownDeadline === null ? 0 : ownDeadline),
			budgetCount: (previous ? previous.budgetCount : 0) + (ownDeadline === null ? 0 : 1),
		});
		verse.turnDirty = true;
		return { remaining: remainingTurns(verse), budgets: budgetEntries(verse) };
	}

	function validateAndApplyFork(sessionKey, params, programName, toolCallId, toolName) {
		const session = getSession(sessionKey);
		const existingCallId = session.usedNames.get(programName);
		if (existingCallId !== undefined) {
			if (existingCallId !== toolCallId) {
				throw herdError("NAME_TAKEN", `Program name already used: ${programName}`, { programName });
			}
			return {};
		}
		if (session.active.stack.some((frame) => frame.toolCallId === toolCallId)) return {};
		const result = pushFrame(session.active, params, { programName, toolCallId, toolName });
		session.usedNames.set(programName, toolCallId);
		return result;
	}

	function recoverHistory(sessionKey, entries, activeEntries = entries, _getBranch = null, currentCallId = null) {
		const session = getSession(sessionKey);
		const nameByCallId = programNamesFromResults(entries);

		for (const entry of entries ?? []) {
			for (const call of callsOf(entry, nameByCallId)) {
				if (call.id === currentCallId) continue;
				if (!session.usedNames.has(call.name)) session.usedNames.set(call.name, call.id);
			}
		}

		const { compactionKey, postEntries } = sliceAfterLatestBoundary(activeEntries);
		if (session.compactionKey !== compactionKey) {
			session.compactionKey = compactionKey;
			session.active = createEmptyVerse();
			session.usedNames.clear();
			session.pendingLeap = null;
		}

		for (const entry of postEntries) {
			for (const call of callsOf(entry, nameByCallId)) {
				if (call.id === currentCallId) continue;
				if (!session.usedNames.has(call.name)) session.usedNames.set(call.name, call.id);
			}
		}
		for (const entry of postEntries) {
			for (const call of callsOf(entry, nameByCallId)) {
				if (call.id === currentCallId) continue;
				const verse = session.active;
				if (verse.stack.some((frame) => frame.toolCallId === call.id || frame.programName === call.name)) continue;
				pushFrame(verse, call.arguments, {
					programName: call.name,
					toolCallId: call.id,
					toolName: call.toolName,
					replay: true,
				});
				verse.currentTurn += 1;
			}
		}
		session.active.turnDirty = false;
	}

	function markTurnActive(sessionKey) {
		getSession(sessionKey).active.turnDirty = true;
	}

	function settleTurn(sessionKey) {
		const verse = getSession(sessionKey).active;
		if (!verse.turnDirty) return { settled: false, currentTurn: verse.currentTurn };
		verse.turnDirty = false;
		verse.currentTurn += 1;
		return { settled: true, currentTurn: verse.currentTurn };
	}

	function listBeacons(sessionKey) {
		const session = getSession(sessionKey);
		const out = [];
		for (const beacon of session.beacons.values()) {
			out.push({ name: beacon.name, description: beacon.description });
		}
		return out;
	}

	function getBeacon(sessionKey, targetName) {
		if (typeof targetName !== "string" || targetName.trim().length === 0) return null;
		return getSession(sessionKey).beacons.get(targetName.trim()) ?? null;
	}

	function retireSession(sessionKey) {
		if (typeof sessionKey !== "string" || sessionKey.length === 0) return false;
		return sessions.delete(sessionKey);
	}

	function timeLeap(sessionKey, params) {
		if (params[ARIADNE_BUDGET_FIELD] !== undefined || params[ARIADNE_GOAL_FIELD] !== undefined) {
			throw herdError(
				"INVALID_ARGUMENT",
				`time_leap does not accept ${ARIADNE_BUDGET_FIELD} or ${ARIADNE_GOAL_FIELD}; re-anchor on your next clj_* call`,
				{ field: params[ARIADNE_BUDGET_FIELD] !== undefined ? ARIADNE_BUDGET_FIELD : ARIADNE_GOAL_FIELD },
			);
		}
		const target = params.target;
		const experience = params.experience;
		const beaconNameParam = params.beacon_name;
		const beaconDescription = params.beacon_description;
		if (typeof target !== "string" || target.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "time_leap requires a non-empty target string", { field: "target" });
		}
		if (typeof experience !== "string" || experience.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "time_leap requires a non-empty experience string", { field: "experience" });
		}
		if (typeof beaconNameParam !== "string" || beaconNameParam.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "time_leap requires a non-empty beacon_name string", { field: "beacon_name" });
		}
		if (typeof beaconDescription !== "string" || beaconDescription.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "time_leap requires a non-empty beacon_description string", {
				field: "beacon_description",
			});
		}

		const session = getSession(sessionKey);
		const targetName = target.trim();
		if (session.beacons.has(targetName)) {
			throw herdError("NAME_TAKEN", `beacon ${targetName} is read-only and cannot be a time_leap target`, {
				target: targetName,
			});
		}
		const found = findFrame(session.active, targetName);
		if (!found) {
			throw herdError("PROGRAM_UNKNOWN", `time_leap target is not an anchor on the current timeline: ${targetName}`, {
				target: targetName,
				available: session.active.stack.map((frame) => ({ name: frame.programName, goal: frame.ownGoal })),
				next: "choose a post-compaction clj_* anchor listed in `available`",
			});
		}
		if (session.pendingLeap !== null) {
			throw herdError("STALE_CONTROL", "a time_leap is already pending resolution", {
				target: session.pendingLeap.targetProgram,
				next: "wait for the next context hook to resolve it before requesting another leap",
			});
		}
		const beaconName = beaconNameParam.trim();
		if (session.beacons.has(beaconName)) {
			throw herdError("NAME_TAKEN", `Beacon name already exists: ${beaconName}`, {
				name: beaconName,
				beacons: [...session.beacons.keys()],
			});
		}

		session.pendingLeap = {
			targetProgram: found.frame.programName,
			targetCallId: found.frame.toolCallId,
			targetGoal: found.frame.ownGoal ?? nearestGoal(session.active, found.index),
			experience: experience.trim(),
			beaconName,
			beaconDescription: beaconDescription.trim(),
		};
		return {
			pending: true,
			target: found.frame.programName,
			targetCallId: found.frame.toolCallId,
			beaconName,
		};
	}

	function resolvePendingLeap(sessionKey, messages, { leafId = null } = {}) {
		const session = getSession(sessionKey);
		const pending = session.pendingLeap;
		if (!pending) return null;
		const list = Array.isArray(messages) ? messages : [];

		let messageIndex = -1;
		for (let index = 0; index < list.length; index += 1) {
			const message = list[index];
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			if (message.content.some((block) => block?.type === "toolCall" && block.id === pending.targetCallId)) {
				messageIndex = index;
				break;
			}
		}
		if (messageIndex === -1) {
			session.pendingLeap = null;
			return {
				found: false,
				target: pending.targetProgram,
				code: "PROGRAM_UNKNOWN",
				reason: "the target toolCall is no longer present in the active messages (compaction boundary or host trimming)",
			};
		}

		const found = findFrame(session.active, pending.targetCallId);
		if (!found) {
			session.pendingLeap = null;
			return {
				found: false,
				target: pending.targetProgram,
				code: "STALE_CONTROL",
				reason: "the target anchor is no longer in the live frame stack",
			};
		}

		session.pendingLeap = null;
		const verse = session.active;
		const targetFrame = found.frame;
		verse.stack.length = found.index;
		verse.currentTurn = targetFrame.turnAtCall;
		verse.turnDirty = false;
		session.usedNames = new Map(verse.stack.map((frame) => [frame.programName, frame.toolCallId]));

		session.beacons.set(pending.beaconName, {
			name: pending.beaconName,
			description: pending.beaconDescription,
			leafId,
			messagesSnapshot: null,
		});

		const targetGoal = targetFrame.ownGoal ?? pending.targetGoal ?? nearestGoal(verse);
		const userMessage = buildTimeLeapUserMessage({ targetGoal, experience: pending.experience });
		const remaining = remainingTurns(verse);
		return {
			found: true,
			target: targetFrame.programName,
			targetCallId: targetFrame.toolCallId,
			beaconName: pending.beaconName,
			messages: [...list.slice(0, messageIndex), userMessage],
			cutCallId: targetFrame.toolCallId,
			targetGoal,
			remaining,
			updatedBudget: remaining,
			budgets: budgetEntries(verse),
		};
	}

	function attachBeaconSnapshot(sessionKey, beaconName, messages, leafId) {
		if (!beaconName) return;
		const session = getSession(sessionKey);
		const beacon = session.beacons.get(beaconName);
		if (!beacon) return;
		if (leafId !== undefined && leafId !== null) beacon.leafId = leafId;
		if (Array.isArray(messages)) beacon.messagesSnapshot = [...messages];
	}

	function status(sessionKey) {
		const session = getSession(sessionKey);
		const verse = session.active;
		return {
			initialized: remainingTurns(verse) !== null,
			currentTurn: verse.currentTurn,
			remaining: remainingTurns(verse),
			budgets: budgetEntries(verse),
			beacons: listBeacons(sessionKey),
		};
	}

	function formatAriadneBlock(sessionKey) {
		const state = status(sessionKey);
		if (!state.initialized) return null;
		if (state.remaining <= 0) {
			return '<skill version="1.0">警告：你出门太久忘本了！Ariadne 线团早已放尽，你还在迷宫深处独自打转——最危险的不是走错，而是忘了最初为什么要出发。在当前时间线上设置新目标无法重置已绷断的线——唯一的解法就是用 `time_leap` 跳回过去。优先选不含无关上下文的锚点；近期锚点不合适时积极考虑远期锚点，这样才能恢复 budget 到锚点处的值。尽量多恢复一点。用 experience 回传该锚点当时还不知道的信息，完整回传；额外地，你需要事无巨细列出哪些用户需求已经完成、哪些部分完成、哪些未开始，避免重复做。完成清单不能替代正常 experience。任何没有关键工作的 idle 时刻都必须优先考虑立刻 `time_leap`：超期线每多留一回合，上下文越长、跳转成本越高，等于持续烧钱。</skill>';
		}
		return `<skill version="1.0">如果你在未来跳回这里，你将剩余 ${formatTurns(state.remaining)} 回合，恰好是你当前 Ariadne 到期前还能进行的回合数。</skill>`;
	}

	return {
		validateAndApplyFork,
		recoverHistory,
		markTurnActive,
		settleTurn,
		timeLeap,
		resolvePendingLeap,
		attachBeaconSnapshot,
		listBeacons,
		getBeacon,
		retireSession,
		status,
		formatAriadneBlock,
	};
}

function formatTurns(value) {
	if (!Number.isFinite(value)) return String(value);
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const RESUME_NOTE =
	"The handoff below records the actual latest state at leap time. Verify files, tests, and commits first; finished items stay finished and must not be re-closed or replayed; partially finished items continue from their latest observed state; immediately start the next new unit of work.";

function buildTimeLeapUserMessage({ targetGoal, experience }) {
	const sections = [];
	if (targetGoal) sections.push(`Goal: ${targetGoal}`);
	sections.push(RESUME_NOTE);
	sections.push(experience);
	return {
		role: "user",
		content: [{ type: "text", text: sections.join("\n\n") }],
	};
}
