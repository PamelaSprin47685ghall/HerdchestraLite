/**
 * Ariadne's Thread + Time Leap (O(1) Min-Deadline Stack + soft gate).
 *
 * - Each `clj_*` call with `ariadne_thread: L` + `ariadne_goal` pushes a new
 *   deadline `D = currentTurn + L` onto a persistent Min-Deadline Stack.
 * - Querying the tightest constraint (and ALL tied tightest ancestors) is O(1)
 *   via the stack top; `time_leap` pops back to `target_program` in O(1).
 * - Soft gate: when `remaining <= 0`, tools are NOT blocked; instead, the
 *   `<ARIADNE-THREAD>` block persistently reminds the LLM that it has wandered
 *   too far and forgotten its anchor.
 * - `applyTimeLeapToMessages` replaces the target `assistant` (`toolCall`)
 *   + `toolResult` (and everything after) with a single `user` message
 *   containing only the Goal at that point and `hint`, popping `target_program`
 *   itself so the LLM can re-anchor with a new `ariadne_thread` budget.
 */

import { herdError } from "../util/errors.mjs";

export const ARIADNE_THREAD_FIELD = "ariadne_thread";
export const ARIADNE_GOAL_FIELD = "ariadne_goal";

export function createAriadneStore() {
	const sessions = new Map();

	function getSession(sessionKey) {
		let s = sessions.get(sessionKey);
		if (!s) {
			s = {
				currentTurn: 0,
				turnDirty: false,
				justAnchored: false,
				stack: [],
				indexByProgram: new Map(),
				pendingLeap: null,
			};
			sessions.set(sessionKey, s);
		}
		return s;
	}

	function topFrame(s) {
		return s.stack.length > 0 ? s.stack[s.stack.length - 1] : null;
	}

	function validateAndApplyFork(sessionKey, params, programName, toolCallId, toolName) {
		const s = getSession(sessionKey);
		const hasThread = params[ARIADNE_THREAD_FIELD] !== undefined;
		const hasGoal = params[ARIADNE_GOAL_FIELD] !== undefined;

		if (hasGoal && !hasThread) {
			throw herdError("INVALID_ARGUMENT", `${ARIADNE_GOAL_FIELD} requires ${ARIADNE_THREAD_FIELD}`, {
				field: ARIADNE_GOAL_FIELD,
			});
		}

		const prev = topFrame(s);

		if (hasThread) {
			const turns = params[ARIADNE_THREAD_FIELD];
			if (!Number.isInteger(turns) || turns < 1) {
				throw herdError("INVALID_ARGUMENT", `${ARIADNE_THREAD_FIELD} must be an integer >= 1`, {
					field: ARIADNE_THREAD_FIELD,
					received: turns,
				});
			}
			const rawGoal = params[ARIADNE_GOAL_FIELD];
			if (typeof rawGoal !== "string" || rawGoal.trim().length === 0) {
				throw herdError(
					"INVALID_ARGUMENT",
					`${ARIADNE_GOAL_FIELD} must be a non-empty string when ${ARIADNE_THREAD_FIELD} is set`,
					{ field: ARIADNE_GOAL_FIELD },
				);
			}
			const goal = rawGoal.trim();
			const ownDeadline = s.currentTurn + turns;
			const entry = { programName, goal, deadlineTurn: ownDeadline };

			let minDeadline;
			let tightest;
			if (!prev || prev.minDeadline === null || ownDeadline < prev.minDeadline) {
				minDeadline = ownDeadline;
				tightest = [entry];
			} else if (ownDeadline === prev.minDeadline) {
				minDeadline = prev.minDeadline;
				tightest = [...prev.tightest, entry];
			} else {
				minDeadline = prev.minDeadline;
				tightest = prev.tightest;
			}

			const frame = {
				programName,
				toolCallId,
				toolName,
				turnAtCall: s.currentTurn,
				ownDeadline,
				ownGoal: goal,
				minDeadline,
				tightest,
			};
			s.indexByProgram.set(programName, s.stack.length);
			s.stack.push(frame);
			s.justAnchored = true;
			s.turnDirty = true;
			return { remaining: minDeadline - s.currentTurn, tightest };
		}

		const minDeadline = prev ? prev.minDeadline : null;
		const tightest = prev ? prev.tightest : [];

		const frame = {
			programName,
			toolCallId,
			toolName,
			turnAtCall: s.currentTurn,
			ownDeadline: null,
			ownGoal: null,
			minDeadline,
			tightest,
		};
		s.indexByProgram.set(programName, s.stack.length);
		s.stack.push(frame);
		s.turnDirty = true;
		return { remaining: minDeadline === null ? null : minDeadline - s.currentTurn, tightest };
	}

	function markTurnActive(sessionKey) {
		const s = getSession(sessionKey);
		s.turnDirty = true;
	}

	function settleTurn(sessionKey) {
		const s = getSession(sessionKey);
		if (!s.turnDirty) return { settled: false, currentTurn: s.currentTurn };
		s.turnDirty = false;
		if (s.justAnchored) {
			s.justAnchored = false;
			return { settled: true, currentTurn: s.currentTurn };
		}
		s.currentTurn += 1;
		return { settled: true, currentTurn: s.currentTurn };
	}

	function timeLeap(sessionKey, { target_program: targetProgram, hint }) {
		if (typeof targetProgram !== "string" || targetProgram.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "time_leap requires a non-empty target_program string", {
				field: "target_program",
			});
		}
		if (typeof hint !== "string" || hint.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "time_leap requires a non-empty hint string", {
				field: "hint",
			});
		}
		const s = getSession(sessionKey);
		const idx = s.indexByProgram.get(targetProgram);
		if (idx === undefined) {
			throw herdError("PROGRAM_UNKNOWN", `Unknown target_program for time_leap: ${targetProgram}`, {
				target_program: targetProgram,
				known: s.stack.map((f) => f.programName),
			});
		}

		const targetFrame = s.stack[idx];
		const prevTop = topFrame(s);
		const prevRemaining = prevTop && prevTop.minDeadline !== null ? prevTop.minDeadline - s.currentTurn : null;

		// Pop targetFrame itself (and everything after) so the LLM can choose a new budget at that point.
		const discarded = s.stack.splice(idx);
		for (const f of discarded) {
			s.indexByProgram.delete(f.programName);
		}
		s.currentTurn = targetFrame.turnAtCall;
		s.justAnchored = false;
		s.turnDirty = false;

		const restoredTop = topFrame(s);
		const nextRemaining =
			restoredTop && restoredTop.minDeadline !== null ? restoredTop.minDeadline - s.currentTurn : null;
		const refunded = nextRemaining !== null && prevRemaining !== null ? Math.max(0, nextRemaining - prevRemaining) : 0;
		const targetGoal = targetFrame.ownGoal ?? targetFrame.tightest?.[0]?.goal ?? null;

		s.pendingLeap = {
			targetProgram,
			targetToolCallId: targetFrame.toolCallId,
			targetGoal,
			hint: hint.trim(),
		};

		return {
			targetProgram,
			remaining: nextRemaining,
			refunded,
			tightest: restoredTop ? restoredTop.tightest : [],
		};
	}

	function consumePendingLeap(sessionKey) {
		const s = getSession(sessionKey);
		const leap = s.pendingLeap;
		s.pendingLeap = null;
		return leap;
	}

	function status(sessionKey) {
		const s = getSession(sessionKey);
		const top = topFrame(s);
		if (!top || top.minDeadline === null) {
			return { initialized: false, currentTurn: s.currentTurn, remaining: null, tightest: [] };
		}
		return {
			initialized: true,
			currentTurn: s.currentTurn,
			remaining: top.minDeadline - s.currentTurn,
			tightest: top.tightest,
		};
	}

	function formatAriadneBlock(sessionKey) {
		const st = status(sessionKey);
		if (!st.initialized) return null;
		const anchors = st.tightest.map((t) => `- ${t.programName}（目标：${t.goal}）`).join("\n");
		const lines = ["<ARIADNE-THREAD>"];
		if (st.remaining <= 0) {
			const overdue = Math.abs(st.remaining);
			lines.push(
				`【警告：你出门太久忘本了！已超期 ${overdue} 回合（剩余 ${st.remaining} 回合）】`,
				"你已经走出了祖先立下的安全线，继续盲目往下走很容易彻底偏离初衷。",
				"最紧的限制来自以下历史时刻：",
				anchors,
				"请认真反思：如果当前路线走偏了，请立刻调用 `time_leap` 回到上述某个程序名并带上教训；如果确认方向正确，请在下次 `clj_*` 中重新立下明确的 `ariadne_thread` 与 `ariadne_goal`。",
			);
		} else {
			lines.push(`当前 Ariadne's Thread 剩余 ${st.remaining} 回合（受限于最紧历史时刻）：`, anchors);
		}
		lines.push("</ARIADNE-THREAD>");
		return lines.join("\n");
	}

	return {
		validateAndApplyFork,
		markTurnActive,
		settleTurn,
		timeLeap,
		consumePendingLeap,
		status,
		formatAriadneBlock,
	};
}

/**
 * Rewrite `messages` for a Time Leap back to `leap.targetProgram`:
 * Replaces the target `assistant` (`toolCall`) + `toolResult` (and everything
 * after) with a single `user` message containing only the Goal at that point
 * and `hint`.
 */
export function applyTimeLeapToMessages(messages, leap) {
	if (!Array.isArray(messages) || !leap) return messages;
	const { targetToolCallId, targetProgram, targetGoal, hint } = leap;

	let assistantIdx = -1;
	let resolvedCallId = targetToolCallId;

	if (typeof resolvedCallId === "string" && resolvedCallId.length > 0) {
		assistantIdx = messages.findIndex(
			(m) =>
				m &&
				m.role === "assistant" &&
				Array.isArray(m.content) &&
				m.content.some((b) => b && b.type === "toolCall" && b.id === resolvedCallId),
		);
	}

	if (assistantIdx === -1) {
		const needle = `:name ${JSON.stringify(targetProgram)}`;
		const resultIdx = messages.findIndex((m) => {
			if (m?.role !== "toolResult") return false;
			const blocks = Array.isArray(m.content) ? m.content : [];
			return blocks.some((b) => typeof b?.text === "string" && b.text.includes(needle));
		});
		if (resultIdx !== -1 && typeof messages[resultIdx]?.toolCallId === "string") {
			resolvedCallId = messages[resultIdx].toolCallId;
			assistantIdx = messages.findIndex(
				(m) =>
					m &&
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					m.content.some((b) => b && b.type === "toolCall" && b.id === resolvedCallId),
			);
		}
		if (assistantIdx === -1 && resultIdx !== -1) {
			assistantIdx = resultIdx;
		}
	}

	if (assistantIdx === -1) return messages;

	const text = targetGoal ? `Goal: ${targetGoal}\n\n${hint}` : hint;
	const userMessage = {
		role: "user",
		content: [{ type: "text", text }],
	};
	return [...messages.slice(0, assistantIdx), userMessage];
}
