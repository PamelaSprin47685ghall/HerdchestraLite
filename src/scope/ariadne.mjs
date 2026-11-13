/**
 * Time Leap++ + Ariadne's Thread.
 *
 * - Single active timeline (`"alpha"` at origin) with an O(1) Min-Deadline Stack.
 * - Compaction is a hard boundary: anchors before the latest `compaction` entry
 *   are invisible (`:PROGRAM_UNKNOWN`), so a leap never cuts across compaction.
 * - `time_leap({ target, experience, beacon_name, beacon_description })`:
 *     - Target MUST exist in the active post-compaction stack.
 *     - Pops `target` and all later frames, restores `currentTurn`, and rewrites
 *       messages from `target`'s toolCall onward into one `user` message
 *       (`Goal + experience`).
 *     - NO `ariadne_budget` / `ariadne_goal` on `time_leap` (re-anchor on next `clj_*`).
 *     - Leaves a named `beacon_description` + `messagesSnapshot` for the sealed
 *       branch so `ask_beacon` can query it while reusing its prefix cache.
 *     - Sealed beacons CANNOT be jumped back to or resurrected.
 */

import { herdError } from "../util/errors.mjs";

export const ARIADNE_BUDGET_FIELD = "ariadne_budget";
export const ARIADNE_GOAL_FIELD = "ariadne_goal";

function createEmptyVerse() {
	return {
		currentTurn: 0,
		turnDirty: false,
		stack: [],
		indexByProgram: new Map(),
	};
}

function topFrame(verse) {
	return verse.stack.length > 0 ? verse.stack[verse.stack.length - 1] : null;
}

function sliceAfterLatestCompaction(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		return { compactionKey: null, postEntries: [] };
	}
	let lastCompactionIdx = -1;
	let compactionKey = null;
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		const msg = entry?.message ?? entry;
		if (entry?.type === "compaction" || msg?.role === "compactionSummary") {
			lastCompactionIdx = i;
			compactionKey = entry?.id ?? `idx:${i}`;
		}
	}
	return {
		compactionKey,
		postEntries: lastCompactionIdx === -1 ? entries : entries.slice(lastCompactionIdx + 1),
	};
}

export function createAriadneStore() {
	const sessions = new Map();

	function getSession(sessionKey) {
		let s = sessions.get(sessionKey);
		if (!s) {
			s = {
				active: createEmptyVerse(),
				beacons: new Map(),
				usedNames: new Map(),
				compactionKey: null,
				pendingLeap: null,
			};
			sessions.set(sessionKey, s);
		}
		return s;
	}

	function remainingTurns(v) {
		const top = topFrame(v);
		if (!top || top.budgetCount === 0) return null;
		return top.budgetSum / top.budgetCount - v.currentTurn;
	}

	function budgetEntries(v) {
		const out = [];
		for (const frame of v.stack) {
			if (frame.ownDeadline === null) continue;
			out.push({
				programName: frame.programName,
				goal: frame.ownGoal,
				remaining: frame.ownDeadline - v.currentTurn,
				updatedBudget: frame.ownDeadline - frame.turnAtCall,
			});
		}
		return out;
	}

	function nearestGoal(v, upTo = v.stack.length - 1) {
		for (let i = upTo; i >= 0; i -= 1) {
			const goal = v.stack[i]?.ownGoal;
			if (goal != null) return goal;
		}
		return null;
	}

	function pushStackFrame(v, params, programName, toolCallId, toolName, { replay = false } = {}) {
		const hasThread = params[ARIADNE_BUDGET_FIELD] !== undefined;
		const hasGoal = params[ARIADNE_GOAL_FIELD] !== undefined;

		if (hasGoal && !hasThread && !replay) {
			throw herdError("INVALID_ARGUMENT", `${ARIADNE_GOAL_FIELD} requires ${ARIADNE_BUDGET_FIELD}`, {
				field: ARIADNE_GOAL_FIELD,
			});
		}

		const prev = topFrame(v);
		let ownDeadline = null;
		let ownGoal = null;

		if (hasThread) {
			const turns = params[ARIADNE_BUDGET_FIELD];
			if (!Number.isInteger(turns) || turns < 1) {
				throw herdError("INVALID_ARGUMENT", `${ARIADNE_BUDGET_FIELD} must be an integer >= 1`, {
					field: ARIADNE_BUDGET_FIELD,
					received: turns,
				});
			}
			const rawGoal = params[ARIADNE_GOAL_FIELD];
			if (typeof rawGoal !== "string" || rawGoal.trim().length === 0) {
				throw herdError(
					"INVALID_ARGUMENT",
					`${ARIADNE_GOAL_FIELD} must be a non-empty string when ${ARIADNE_BUDGET_FIELD} is set`,
					{ field: ARIADNE_GOAL_FIELD },
				);
			}
			ownGoal = rawGoal.trim();
			ownDeadline = v.currentTurn + 1 + turns;
		} else if (replay && hasGoal && typeof params[ARIADNE_GOAL_FIELD] === "string") {
			// Replayed history may contain partially recorded anchors (older
			// receipts, host-trimmed arguments). Keep the goal for orientation;
			// no deadline is invented.
			const replayGoal = params[ARIADNE_GOAL_FIELD].trim();
			if (replayGoal.length > 0) ownGoal = replayGoal;
		}

		const frame = {
			programName,
			toolCallId,
			toolName,
			turnAtCall: v.currentTurn,
			ownDeadline,
			ownGoal,
			budgetSum: (prev ? prev.budgetSum : 0) + (ownDeadline === null ? 0 : ownDeadline),
			budgetCount: (prev ? prev.budgetCount : 0) + (ownDeadline === null ? 0 : 1),
		};
		v.indexByProgram.set(programName, v.stack.length);
		v.stack.push(frame);
		v.turnDirty = true;
		return { remaining: remainingTurns(v), budgets: budgetEntries(v) };
	}

	function validateAndApplyFork(sessionKey, params, programName, toolCallId, toolName) {
		const s = getSession(sessionKey);
		const old = s.usedNames.get(programName);
		const active = s.active.indexByProgram.has(programName);
		if (active && old !== toolCallId) throw herdError("NAME_TAKEN", `Program name already used: ${programName}`);
		if (active) return {};
		const result = pushStackFrame(s.active, params, programName, toolCallId, toolName);
		s.usedNames.set(programName, toolCallId);
		return result;
	}

	function recoverHistory(sessionKey, entries, activeEntries = entries, _getBranch = null, currentCallId = null) {
		const s = getSession(sessionKey);
		const resultNames = new Map();
		for (const entry of entries ?? []) {
			const m = entry?.message ?? entry;
			if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
			const text = Array.isArray(m.content) ? m.content.map((block) => block?.text ?? "").join("\n") : "";
			const match = /:(?:program-name|name)\s+("(?:[^"\\]|\\.)*")/.exec(text);
			let name = m.details?.programName ?? m.details?.name;
			if (name === undefined && match) {
				try {
					name = JSON.parse(match[1]);
				} catch {
					/* Invalid receipt is not an anchor. */
				}
			}
			if (typeof name === "string") resultNames.set(m.toolCallId, name);
		}
		const calls = (items) =>
			(items ?? []).flatMap((entry) => {
				const message = entry?.message ?? entry;
				return message?.role === "assistant" && Array.isArray(message.content)
					? message.content
							.filter(
								(block) =>
									block?.type === "toolCall" &&
									/^clj_(plan|devops|review|worker|auditor)$/.test(block.name) &&
									typeof block.id === "string" &&
									(typeof block.arguments?.name === "string" || resultNames.has(block.id)),
							)
							.map((block) => ({
								...block,
								arguments: { ...block.arguments, name: block.arguments?.name ?? resultNames.get(block.id) },
							}))
					: [];
			});

		for (const entry of entries ?? []) {
			for (const call of calls([entry])) {
				if (call.id === currentCallId) continue;
				if (!s.usedNames.has(call.arguments.name)) s.usedNames.set(call.arguments.name, call.id);
			}
		}

		// Compaction is a hard boundary: if compaction advanced, drop pre-compaction anchors.
		const { compactionKey, postEntries } = sliceAfterLatestCompaction(activeEntries);
		if (s.compactionKey !== compactionKey) {
			s.compactionKey = compactionKey;
			s.active = createEmptyVerse();
		}
		for (const call of calls(postEntries)) {
			if (call.id === currentCallId) continue;
			if (s.active.indexByProgram.has(call.arguments.name)) continue;
			pushStackFrame(s.active, call.arguments, call.arguments.name, call.id, call.name);
			s.active.currentTurn += 1;
			s.active.turnDirty = false;
		}
	}

	function markTurnActive(sessionKey) {
		getSession(sessionKey).active.turnDirty = true;
	}

	function settleTurn(sessionKey) {
		const v = getSession(sessionKey).active;
		if (!v.turnDirty) return { settled: false, currentTurn: v.currentTurn };
		v.turnDirty = false;
		v.currentTurn += 1;
		return { settled: true, currentTurn: v.currentTurn };
	}

	function listBeacons(sessionKey) {
		const s = getSession(sessionKey);
		const out = [];
		for (const b of s.beacons.values()) {
			out.push({ name: b.name, description: b.description });
		}
		return out;
	}

	function getBeacon(sessionKey, targetName) {
		if (typeof targetName !== "string" || targetName.trim().length === 0) return null;
		const s = getSession(sessionKey);
		return s.beacons.get(targetName.trim()) ?? null;
	}

	function retireSession(sessionKey) {
		if (typeof sessionKey !== "string" || sessionKey.length === 0) return false;
		return sessions.delete(sessionKey);
	}

	function timeLeap(sessionKey, params) {
		if (params[ARIADNE_BUDGET_FIELD] !== undefined || params[ARIADNE_GOAL_FIELD] !== undefined) {
			throw herdError(
				'INVALID_ARGUMENT',
				`time_leap does not accept ${ARIADNE_BUDGET_FIELD} or ${ARIADNE_GOAL_FIELD}; re-anchor on your next clj_* call`,
				{ field: params[ARIADNE_BUDGET_FIELD] !== undefined ? ARIADNE_BUDGET_FIELD : ARIADNE_GOAL_FIELD },
			);
		}
		const targetProgram = params.target;
		const experience = params.experience;
		const beaconNameParam = params.beacon_name;
		const beaconDescription = params.beacon_description;
		if (typeof targetProgram !== 'string' || targetProgram.trim().length === 0) {
			throw herdError('INVALID_ARGUMENT', 'time_leap requires a non-empty target string', { field: 'target' });
		}
		if (typeof experience !== 'string' || experience.trim().length === 0) {
			throw herdError('INVALID_ARGUMENT', 'time_leap requires a non-empty experience string', { field: 'experience' });
		}
		if (typeof beaconNameParam !== 'string' || beaconNameParam.trim().length === 0) {
			throw herdError('INVALID_ARGUMENT', 'time_leap requires a non-empty beacon_name string', { field: 'beacon_name' });
		}
		if (typeof beaconDescription !== 'string' || beaconDescription.trim().length === 0) {
			throw herdError('INVALID_ARGUMENT', 'time_leap requires a non-empty beacon_description string', { field: 'beacon_description' });
		}
		const s = getSession(sessionKey);
		const targetName = targetProgram.trim();
		if (s.beacons.has(targetName)) {
			throw herdError('NAME_TAKEN', `NAME_TAKEN: beacon ${targetName} is read-only and cannot be a time_leap target`, {
				target: targetName,
				beacons: [...s.beacons.keys()],
			});
		}
		const beaconName = beaconNameParam.trim();
		if (s.beacons.has(beaconName)) {
			throw herdError('NAME_TAKEN', `Beacon name already exists: ${beaconName}`, { name: beaconName, beacons: [...s.beacons.keys()] });
		}
		const targetFrame = s.active.stack.find((frame) => frame.programName === targetName);
		s.pendingLeap = {
			targetProgram: targetProgram.trim(),
			experience: experience.trim(),
			beaconName,
			beaconDescription: beaconDescription.trim(),
			targetGoal: targetFrame?.ownGoal ?? nearestGoal(s.active),
		};
		return { pending: true, target: targetProgram.trim(), beaconName };
	}

	function findTargetCall(messages, targetProgram) {
		let found = null;
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
				if (!/^clj_(plan|devops|review|worker|auditor)$/.test(block.name)) continue;
				if (block.arguments?.name !== targetProgram) continue;
				found = {
					index,
					toolCallId: block.id,
					goal:
						typeof block.arguments?.[ARIADNE_GOAL_FIELD] === 'string' ? block.arguments[ARIADNE_GOAL_FIELD] : null,
				};
			}
		}
		return found;
	}

	function rebuildFrames(v, messages) {
		v.stack.length = 0;
		v.indexByProgram.clear();
		for (const message of messages) {
			if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
				if (!/^clj_(plan|devops|review|worker|auditor)$/.test(block.name)) continue;
				const name = block.arguments?.name;
				if (typeof name !== 'string' || name.length === 0) continue;
				pushStackFrame(v, block.arguments, name, block.id, block.name, { replay: true });
				v.currentTurn += 1;
			}
		}
		v.turnDirty = false;
	}

	function resolvePendingLeap(sessionKey, messages, { leafId = null } = {}) {
		const s = getSession(sessionKey);
		const pending = s.pendingLeap;
		if (!pending) return null;
		s.pendingLeap = null;
		const list = Array.isArray(messages) ? messages : [];
		const found = findTargetCall(list, pending.targetProgram);
		if (found === null) return { found: false, target: pending.targetProgram };
		const v = s.active;
		const stackIndex = v.indexByProgram.get(pending.targetProgram);
		if (stackIndex !== undefined) {
			// The live stack still knows this anchor (the common case: the leap
			// happens in the same process that forked it). Keep its real budgets
			// and frame identity instead of re-deriving weaker data from message
			// arguments, then cut back to the target anchor (keep its prefix).
			const targetFrame = v.stack[stackIndex];
			for (const frame of v.stack.slice(stackIndex)) {
				v.indexByProgram.delete(frame.programName);
			}
			v.stack.length = stackIndex;
			v.currentTurn = targetFrame.turnAtCall;
			v.turnDirty = false;
		} else {
			// After a restart or compaction the stack is gone; rebuild the prefix
			// from durable message history as a best-effort orientation.
			rebuildFrames(v, list.slice(0, found.index));
		}
		const targetGoal = found.goal ?? pending.targetGoal ?? nearestGoal(v);
		s.beacons.set(pending.beaconName, {
			name: pending.beaconName,
			description: pending.beaconDescription,
			leafId,
			messagesSnapshot: null,
		});
		const userMessage = buildTimeLeapUserMessage({ targetGoal, experience: pending.experience });
		const remaining = remainingTurns(v);
		return {
			found: true,
			target: pending.targetProgram,
			beaconName: pending.beaconName,
			messages: [...list.slice(0, found.index), userMessage],
			cutCallId: found.toolCallId,
			targetGoal,
			remaining,
			updatedBudget: remaining,
			budgets: budgetEntries(v),
		};
	}

	function attachBeaconSnapshot(sessionKey, beaconName, messages, leafId) {
		if (!beaconName) return;
		const s = getSession(sessionKey);
		const saved = s.beacons.get(beaconName);
		if (!saved) return;
		if (leafId !== undefined && leafId !== null) saved.leafId = leafId;
		if (Array.isArray(messages)) saved.messagesSnapshot = [...messages];
	}

	function status(sessionKey) {
		const s = getSession(sessionKey);
		const v = s.active;
		const remaining = remainingTurns(v);
		const budgets = budgetEntries(v);
		const beacons = listBeacons(sessionKey);
		return {
			initialized: remaining !== null,
			currentTurn: v.currentTurn,
			remaining,
			budgets,
			beacons,
		};
	}

	function formatAriadneBlock(sessionKey) {
		const st = status(sessionKey);
		if (!st.initialized) return null;
		if (st.remaining <= 0) {
			return '<skill version="1.0">警告：你出门太久忘本了！Ariadne 线团早已放尽，你还在迷宫深处独自打转——最危险的不是走错，而是忘了最初为什么要出发。在当前时间线上设置新目标无法重置已绷断的线——唯一的解法就是用 `time_leap` 跳回过去。优先选不含无关上下文的锚点；近期锚点不合适时积极考虑远期锚点，这样才能恢复 budget 到锚点处的值。尽量多恢复一点。用 experience 回传该锚点当时还不知道的信息，完整回传；额外地，你需要事无巨细列出哪些用户需求已经完成、哪些部分完成、哪些未开始，避免重复做。完成清单不能替代正常 experience。任何没有关键工作的 idle 时刻都必须优先考虑立刻 `time_leap`：超期线每多留一回合，上下文越长、跳转成本越高，等于持续烧钱。</skill>';
		}
		return `<skill version="1.0">如果你在未来跳回这里，你将剩余 ${formatTurns(st.remaining)} 回合，恰好是你当前 Ariadne 到期前还能进行的回合数。</skill>`;
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

