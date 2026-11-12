/**
 * Everything Everywhere All at Once — Verse-Jumping + Ariadne's Thread.
 *
 * - Origin universe is `"alpha"` (Alphaverse).
 * - DRY parameters shared by `clj_*` and `verse_jump`:
 *     - `thread`: positive integer turn budget (Ariadne's Thread, 1 turn = 1 point)
 *     - `goal`:   string north-star objective paired with `thread`
 * - `verse_jump({ target, experience, thread?, goal? })`:
 *     - Freezes the leaving universe with `cutCallId = verse_jump's own toolCallId`.
 *     - When jumping back to a previously activated universe, it truncates from
 *       that saved `cutCallId` and replaces it with the incoming `user` message
 *       — the exact same code path used when forking from an ordinary `clj_*`
 *       program's `toolCallId` (100% DRY).
 *     - Computes LCA depth between the leaving and target stacks so turn
 *       restoration/budgeting stays faithful to the tree geometry.
 * - `<ARIADNE-THREAD>` and `<OTHER-VERSES>` are persisted every turn via `hackContext`.
 */

import { herdError } from "../util/errors.mjs";

export const ARIADNE_THREAD_FIELD = "ariadne_thread";
export const ARIADNE_GOAL_FIELD = "ariadne_goal";
export const ALPHA_VERSE = "alpha";

function createEmptyVerse(verseName = ALPHA_VERSE) {
	return {
		verseName,
		currentTurn: 0,
		turnDirty: false,
		justAnchored: false,
		stack: [],
		indexByProgram: new Map(),
	};
}

function cloneVerse(verse, verseName, sliceEnd) {
	const stack = sliceEnd === undefined ? [...verse.stack] : verse.stack.slice(0, sliceEnd);
	const indexByProgram = new Map();
	for (let i = 0; i < stack.length; i += 1) {
		indexByProgram.set(stack[i].programName, i);
	}
	return {
		verseName,
		currentTurn: verse.currentTurn,
		turnDirty: false,
		justAnchored: false,
		stack,
		indexByProgram,
	};
}

function topFrame(verse) {
	return verse.stack.length > 0 ? verse.stack[verse.stack.length - 1] : null;
}

function lcaDepth(stackA, stackB) {
	const limit = Math.min(stackA.length, stackB.length);
	let i = 0;
	while (i < limit && stackA[i].programName === stackB[i].programName) {
		i += 1;
	}
	return i;
}

export function createAriadneStore() {
	const sessions = new Map();

	function getSession(sessionKey) {
		let s = sessions.get(sessionKey);
		if (!s) {
			s = {
				active: createEmptyVerse(ALPHA_VERSE),
				activatedVerses: new Map(),
				pendingJump: null,
			};
			sessions.set(sessionKey, s);
		}
		return s;
	}

	function pushStackFrame(v, params, programName, toolCallId, toolName) {
		const hasThread = params[ARIADNE_THREAD_FIELD] !== undefined;
		const hasGoal = params[ARIADNE_GOAL_FIELD] !== undefined;

		if (hasGoal && !hasThread) {
			throw herdError("INVALID_ARGUMENT", `${ARIADNE_GOAL_FIELD} requires ${ARIADNE_THREAD_FIELD}`, {
				field: ARIADNE_GOAL_FIELD,
			});
		}

		const prev = topFrame(v);

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
					{
						field: ARIADNE_GOAL_FIELD,
					},
				);
			}
			const goal = rawGoal.trim();
			const ownDeadline = v.currentTurn + turns;
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
				turnAtCall: v.currentTurn,
				ownDeadline,
				ownGoal: goal,
				minDeadline,
				tightest,
			};
			v.indexByProgram.set(programName, v.stack.length);
			v.stack.push(frame);
			v.justAnchored = true;
			v.turnDirty = true;
			return { remaining: minDeadline - v.currentTurn, tightest };
		}

		const minDeadline = prev ? prev.minDeadline : null;
		const tightest = prev ? prev.tightest : [];
		const frame = {
			programName,
			toolCallId,
			toolName,
			turnAtCall: v.currentTurn,
			ownDeadline: null,
			ownGoal: null,
			minDeadline,
			tightest,
		};
		v.indexByProgram.set(programName, v.stack.length);
		v.stack.push(frame);
		v.turnDirty = true;
		return { remaining: minDeadline === null ? null : minDeadline - v.currentTurn, tightest };
	}

	function validateAndApplyFork(sessionKey, params, programName, toolCallId, toolName) {
		const s = getSession(sessionKey);
		return pushStackFrame(s.active, params, programName, toolCallId, toolName);
	}

	function markTurnActive(sessionKey) {
		getSession(sessionKey).active.turnDirty = true;
	}

	function settleTurn(sessionKey) {
		const v = getSession(sessionKey).active;
		if (!v.turnDirty) return { settled: false, currentTurn: v.currentTurn };
		v.turnDirty = false;
		if (v.justAnchored) {
			v.justAnchored = false;
			return { settled: true, currentTurn: v.currentTurn };
		}
		v.currentTurn += 1;
		return { settled: true, currentTurn: v.currentTurn };
	}

	function hiddenActivatedVerses(s) {
		const hidden = [];
		for (const verse of s.activatedVerses.values()) {
			if (verse.verseName === s.active.verseName) continue;
			if (!verse.cutCallId && s.active.indexByProgram.has(verse.verseName)) continue;
			hidden.push({ verseName: verse.verseName, goal: verse.goal, beacon: verse.beacon ?? null });
		}
		return hidden;
	}

	function verseJump(sessionKey, params, { jumpCallId = null, leafId = null, parkedNames = [] } = {}) {
		const targetProgram = params.target;
		const experience = params.experience;
		if (typeof targetProgram !== "string" || targetProgram.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "verse_jump requires a non-empty target string", {
				field: "target",
			});
		}
		if (typeof experience !== "string" || experience.trim().length === 0) {
			throw herdError("INVALID_ARGUMENT", "verse_jump requires a non-empty experience string", {
				field: "experience",
			});
		}
		if (params.beacon !== undefined && (typeof params.beacon !== "string" || params.beacon.trim().length === 0)) {
			throw herdError("INVALID_ARGUMENT", "verse_jump beacon must be a non-empty string when provided", {
				field: "beacon",
			});
		}

		const s = getSession(sessionKey);
		const existingActivated = s.activatedVerses.get(targetProgram);
		const stackIdx = s.active.indexByProgram.get(targetProgram);

		if (!existingActivated && stackIdx === undefined) {
			throw herdError("PROGRAM_UNKNOWN", `Unknown target for verse_jump: ${targetProgram}`, {
				target: targetProgram,
				activatedVerses: [...s.activatedVerses.keys()],
				currentHistory: s.active.stack.map((f) => f.programName),
			});
		}

		if (Array.isArray(parkedNames) && parkedNames.length > 0) {
			const targetIndex =
				existingActivated && stackIdx === undefined
					? existingActivated.verse.indexByProgram
					: new Map(s.active.stack.slice(0, stackIdx).map((f, i) => [f.programName, i]));
			const orphans = parkedNames.filter((name) => typeof name === "string" && !targetIndex.has(name));
			if (orphans.length > 0) {
				throw herdError(
					"RESOURCES_NOT_QUIESCENT",
					`Target universe ${JSON.stringify(targetProgram)} does not know about your parked programs (${orphans.join(", ")}). Resolve them via (unpark ...) or (abandon ...) before jumping.`,
					{ target: targetProgram, orphans },
				);
			}
		}

		const leavingVerse = s.active;
		const leavingTop = topFrame(leavingVerse);
		const leavingName = leavingVerse.verseName || ALPHA_VERSE;
		const leavingGoal = leavingTop?.ownGoal ?? leavingTop?.tightest?.[0]?.goal ?? null;
		const prevRemaining =
			leavingTop && leavingTop.minDeadline !== null ? leavingTop.minDeadline - leavingVerse.currentTurn : null;

		if (leavingName !== targetProgram) {
			const prevBeacon = s.activatedVerses.get(leavingName)?.beacon ?? null;
			const beacon = params.beacon !== undefined ? params.beacon.trim() : prevBeacon;
			s.activatedVerses.set(leavingName, {
				verseName: leavingName,
				goal: leavingGoal,
				beacon,
				cutCallId: jumpCallId,
				leafId,
				messagesSnapshot: null,
				verse: cloneVerse(leavingVerse, leavingName),
			});
		}

		let cutCallId;
		let targetGoal;
		let lca;
		let kind;

		if (existingActivated && stackIdx === undefined) {
			kind = "resume-verse";
			lca = lcaDepth(leavingVerse.stack, existingActivated.verse.stack);
			s.active = cloneVerse(existingActivated.verse, targetProgram);
			cutCallId = existingActivated.cutCallId;
			targetGoal = existingActivated.goal;
		} else {
			kind = "fork-history";
			const targetFrame = leavingVerse.stack[stackIdx];
			lca = stackIdx;
			s.active = cloneVerse(leavingVerse, targetProgram, stackIdx);
			s.active.currentTurn = targetFrame.turnAtCall;
			cutCallId = targetFrame.toolCallId;
			targetGoal = targetFrame.ownGoal ?? targetFrame.tightest?.[0]?.goal ?? null;

			s.activatedVerses.set(targetProgram, {
				verseName: targetProgram,
				goal: targetGoal,
				beacon: null,
				cutCallId: null,
				leafId: null,
				messagesSnapshot: null,
				verse: cloneVerse(s.active, targetProgram),
			});
		}

		// DRY: if verse_jump carries `thread` + `goal`, apply it identically to `clj_*`!
		if (params[ARIADNE_THREAD_FIELD] !== undefined || params[ARIADNE_GOAL_FIELD] !== undefined) {
			pushStackFrame(s.active, params, `${targetProgram}#jump`, jumpCallId, "verse_jump");
		}

		const nextTop = topFrame(s.active);
		const nextRemaining = nextTop && nextTop.minDeadline !== null ? nextTop.minDeadline - s.active.currentTurn : null;
		const lcaDistance = Math.max(0, leavingVerse.stack.length - lca);
		const refunded =
			nextRemaining !== null && prevRemaining !== null ? Math.max(0, nextRemaining - prevRemaining) : lcaDistance;
		const otherVerses = hiddenActivatedVerses(s);

		s.pendingJump = {
			kind,
			leavingName,
			targetProgram,
			cutCallId,
			targetLeafId: existingActivated?.leafId ?? null,
			fallbackMessages: existingActivated?.messagesSnapshot ?? null,
			targetGoal: params[ARIADNE_GOAL_FIELD]?.trim() || targetGoal,
			experience: experience.trim(),
			otherVerses,
		};

		return {
			kind,
			target: targetProgram,
			lcaDepth: lca,
			lcaDistance,
			remaining: nextRemaining,
			refunded,
			tightest: nextTop ? nextTop.tightest : [],
			otherVerses,
		};
	}

	function attachLeavingSnapshot(sessionKey, leavingName, messages, leafId) {
		if (!leavingName) return;
		const s = getSession(sessionKey);
		const saved = s.activatedVerses.get(leavingName);
		if (!saved) return;
		if (leafId !== undefined && leafId !== null) saved.leafId = leafId;
		if (Array.isArray(messages)) saved.messagesSnapshot = [...messages];
	}

	function consumePendingJump(sessionKey) {
		const s = getSession(sessionKey);
		const jump = s.pendingJump;
		s.pendingJump = null;
		return jump;
	}

	function status(sessionKey) {
		const s = getSession(sessionKey);
		const v = s.active;
		const top = topFrame(v);
		const otherVerses = hiddenActivatedVerses(s);
		if (!top || top.minDeadline === null) {
			return {
				initialized: false,
				verseName: v.verseName,
				currentTurn: v.currentTurn,
				remaining: null,
				tightest: [],
				otherVerses,
			};
		}
		return {
			initialized: true,
			verseName: v.verseName,
			currentTurn: v.currentTurn,
			remaining: top.minDeadline - v.currentTurn,
			tightest: top.tightest,
			otherVerses,
		};
	}

	function formatAriadneBlock(sessionKey) {
		const st = status(sessionKey);
		const parts = [];
		if (st.initialized) {
			const anchors = st.tightest.map((t) => `- ${t.programName}（目标：${t.goal}）`).join("\n");
			const lines = ["<ARIADNE-THREAD>"];
			if (st.remaining <= 0) {
				const overdue = Math.abs(st.remaining);
				lines.push(
					`【阿里阿德涅之线已绷断 · 出门太久忘本了！（已超期 ${overdue} 回合，剩余 ${st.remaining} 回合）】`,
					"线团早已放尽，你还在迷宫深处独自打转——最危险的不是走错，而是忘了最初为什么要出发。",
					"此刻在时间线上勒得最紧的祖先锚点：",
					anchors,
					"给自己十秒钟清醒一下：如果这条路已经走偏，别硬扛，立刻用 `verse_jump` 把聚光灯令牌连同你在未来踩坑换来的**完整主观体验（`experience` 写得越丰富越具体越好！）**跳回上面的分支或平行宇宙重开；如果确认方向依然锐利，就在下次 `clj_*` 重新系上一根清晰的 `ariadne_thread` 与 `ariadne_goal`。",
				);
			} else {
				lines.push(`【阿里阿德涅之线 · 距最紧锚点还剩 ${st.remaining} 回合】`, anchors);
			}
			lines.push("</ARIADNE-THREAD>");
			parts.push(lines.join("\n"));
		}
		if (st.otherVerses.length > 0) {
			const verseLines = st.otherVerses.map(formatVerseEntry);
			parts.push(
				[
					"<OTHER-VERSES>",
					"以下平行宇宙曾主动接过或交出过聚光灯令牌，但不在你当前世界线的历史视野内（随时可用 `verse_jump` 把令牌+experience 跳回它们继续演化）：",
					...verseLines,
					"</OTHER-VERSES>",
				].join("\n"),
			);
		}
		return parts.length > 0 ? parts.join("\n\n") : null;
	}

	return {
		validateAndApplyFork,
		markTurnActive,
		settleTurn,
		verseJump,
		attachLeavingSnapshot,
		consumePendingJump,
		status,
		formatAriadneBlock,
	};
}

function formatVerseEntry(v) {
	const goalPart = v.goal ? `（Goal: ${v.goal}）` : "";
	const beaconPart = v.beacon ? ` — Beacon: ${v.beacon}` : "";
	return `- ${v.verseName}${goalPart}${beaconPart}`;
}

function buildVerseJumpUserMessage({ targetGoal, experience, otherVerses = [] }) {
	const sections = [];
	if (targetGoal) sections.push(`Goal: ${targetGoal}`);
	sections.push(experience);
	if (Array.isArray(otherVerses) && otherVerses.length > 0) {
		sections.push(
			[
				"<OTHER-VERSES>",
				"以下平行宇宙曾主动接过或交出过聚光灯令牌，但不在当前历史内可见：",
				...otherVerses.map(formatVerseEntry),
				"</OTHER-VERSES>",
			].join("\n"),
		);
	}
	return {
		role: "user",
		content: [{ type: "text", text: sections.join("\n\n") }],
	};
}

function cutFromToolCall(messages, cutCallId, targetProgram, userMessage) {
	let assistantIdx = -1;
	let resolvedCallId = cutCallId;

	if (typeof resolvedCallId === "string" && resolvedCallId.length > 0) {
		assistantIdx = messages.findIndex(
			(m) =>
				m &&
				m.role === "assistant" &&
				Array.isArray(m.content) &&
				m.content.some((b) => b && b.type === "toolCall" && b.id === resolvedCallId),
		);
	}

	if (assistantIdx === -1 && targetProgram) {
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

	if (assistantIdx === -1) return [...messages, userMessage];
	return [...messages.slice(0, assistantIdx), userMessage];
}

/**
 * DRY message rewriting for both `fork-history` and `resume-verse`:
 * both locate `cutCallId` (the target `clj_*` call OR the leaving universe's
 * `verse_jump` call) and replace from its `assistant` message onward with
 * the single `user` message (`Goal + experience + <OTHER-VERSES>`).
 */
export function applyVerseJumpToMessages(messages, jump, sessionManager = null) {
	if (!Array.isArray(messages) || !jump) return { messages };
	const userMessage = buildVerseJumpUserMessage(jump);

	if (jump.kind === "resume-verse") {
		let base = Array.isArray(jump.fallbackMessages) ? [...jump.fallbackMessages] : [];
		let branchSwitched = false;
		if (
			jump.targetLeafId &&
			sessionManager &&
			typeof sessionManager.getBranch === "function" &&
			typeof sessionManager.branch === "function"
		) {
			sessionManager.branch(jump.targetLeafId);
			branchSwitched = true;
			const entries = sessionManager.getBranch();
			if (Array.isArray(entries)) {
				base = entries.filter((e) => e && e.type === "message" && e.message).map((e) => e.message);
			}
		}
		const next = cutFromToolCall(base, jump.cutCallId, jump.targetProgram, userMessage);
		return { messages: next, branchSwitched };
	}

	return { messages: cutFromToolCall(messages, jump.cutCallId, jump.targetProgram, userMessage) };
}
