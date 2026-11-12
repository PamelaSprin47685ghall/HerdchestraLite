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
 * - `applyTimeLeapToMessages` strips any sibling `toolCall`s (e.g. `p2`) from
 *   the target `assistant` message and replaces `p1`'s `toolResult` with `hint`
 *   so `p1` + its replaced `toolResult` becomes the exact end of history.
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

		// Pop everything after targetFrame in O(popped)
		const discarded = s.stack.splice(idx + 1);
		for (const f of discarded) {
			s.indexByProgram.delete(f.programName);
		}
		s.currentTurn = targetFrame.turnAtCall;
		s.justAnchored = false;
		s.turnDirty = false;

		const nextRemaining = targetFrame.minDeadline === null ? null : targetFrame.minDeadline - s.currentTurn;
		const refunded = prevRemaining !== null ? Math.max(0, nextRemaining - prevRemaining) : 0;

		s.pendingLeap = {
			targetProgram,
			targetToolCallId: targetFrame.toolCallId,
			targetToolName: targetFrame.toolName,
			hint: hint.trim(),
		};

		return {
			targetProgram,
			remaining: nextRemaining,
			refunded,
			tightest: targetFrame.tightest,
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
 * - Finds the `assistant` message containing `targetToolCallId` (or matching
 *   `:name "<targetProgram>"` in its `toolResult`), strips all sibling
 *   `toolCall` blocks (like `p2`) from that `assistant` message so ONLY `p1`'s
 *   `toolCall` remains, replaces `p1`'s `toolResult` with `hint`, and drops
 *   everything after it.
 */
export function applyTimeLeapToMessages(messages, leap) {
	if (!Array.isArray(messages) || !leap) return messages;
	const { targetToolCallId, targetToolName, targetProgram, hint } = leap;

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

	let resultIdx = -1;
	if (typeof resolvedCallId === "string" && resolvedCallId.length > 0) {
		resultIdx = messages.findIndex((m) => m && m.role === "toolResult" && m.toolCallId === resolvedCallId);
	}
	if (resultIdx === -1) {
		const needle = `:name ${JSON.stringify(targetProgram)}`;
		resultIdx = messages.findIndex((m) => {
			if (m?.role !== "toolResult") return false;
			const blocks = Array.isArray(m.content) ? m.content : [];
			return blocks.some((b) => typeof b?.text === "string" && b.text.includes(needle));
		});
		if (resultIdx !== -1 && typeof messages[resultIdx]?.toolCallId === "string") {
			resolvedCallId = messages[resultIdx].toolCallId;
			if (assistantIdx === -1) {
				assistantIdx = messages.findIndex(
					(m) =>
						m &&
						m.role === "assistant" &&
						Array.isArray(m.content) &&
						m.content.some((b) => b && b.type === "toolCall" && b.id === resolvedCallId),
				);
			}
		}
	}

	if (resultIdx === -1) return messages;

	const origResult = messages[resultIdx];
	const replacedResult = {
		...origResult,
		role: "toolResult",
		toolCallId: origResult.toolCallId ?? resolvedCallId,
		toolName: origResult.toolName ?? targetToolName,
		content: [
			{
				type: "text",
				text: `<TIME-LEAP-HINT target=${JSON.stringify(targetProgram)}>\n${hint}\n</TIME-LEAP-HINT>`,
			},
		],
		isError: false,
	};

	if (assistantIdx !== -1 && assistantIdx < resultIdx) {
		const origAssistant = messages[assistantIdx];
		const filteredContent = origAssistant.content.filter(
			(b) => !(b && b.type === "toolCall" && b.id !== resolvedCallId),
		);
		const trimmedAssistant = {
			...origAssistant,
			content: filteredContent,
		};
		return [...messages.slice(0, assistantIdx), trimmedAssistant, replacedResult];
	}

	return [...messages.slice(0, resultIdx), replacedResult];
}
