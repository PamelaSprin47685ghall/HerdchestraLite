/**
 * P2: runtime wiring text, copied verbatim from AGENTS.md §8.5.
 *
 * Depends on nothing. The `<skill version="1.0">` shape carries system-level
 * force, not ordinary user content; the old NUL + BOM prefix is deliberately
 * not reproduced.
 */

/**
 * The binding language-discipline block. It keeps the legacy `<skill
 * version="1.0">` shape because that shape carries system-level force for
 * the model; the NUL + BOM prefix of the old implementation is a defect and
 * is deliberately not reproduced.
 *
 * The outbound `context` tail is its only injection path.
 */
export const LANGUAGE_SKILL =
	'<skill version="1.0">强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。</skill>';

/**
 * Rewrite only the outbound copy of the host vibe-mode context.
 * Unknown host wording is returned unchanged.
 *
 * @param {string} content
 * @returns {string}
 */
export function rewriteVibeModeContext(content) {
	const rewritten = content
		.replace("drive two worker CLIs", "direct as many parallel slice/swarm workers as causality allows")
		.replace(
			"Run sessions concurrently — normally one `fast` and one `good` on different workstreams.",
			"Run independent workstreams concurrently. For decomposable work, use more and more workers aggressively.",
		);
	return rewritten === content ? content : rewritten;
}

/**
 * Build the unattended nudge that names the current legal exit tool.
 * Empty obligation/park sections are omitted.
 *
 * @param {{
 *   stage: string,
 *   expectedTool: string,
 *   openItems?: string[],
 *   parkedPrograms?: string[],
 * }} input
 * @returns {string}
 */
export function buildUnattendedNudge({ stage, expectedTool, openItems = [], parkedPrograms = [] }) {
	const lines = [
		`[UNATTENDED NUDGE — STAGE ${stage}]`,
		"思考过程与全部对外输出，一律用简体中文。",
		`当前阶段尚未到达合法出口，严禁以纯聊天正文自然停止！所有结构化推进与长文档保存必须调用专用工具（当前应调用：\`${expectedTool}\`）。`,
		"系统处于常授权无人值守模式（仅 S1 的 `attach_brainstorm` 手工批准、`ask_user` 澄清与 S5 初任空账的一次性询问例外）：禁止等待用户决策或授权，禁止半途而废，禁止退回舒适区！",
	];
	if (openItems.length > 0) {
		lines.push(`未结义务台账（立刻逐项销账）：\n${openItems.map((item) => `- ${item}`).join("\n")}`);
	}
	if (parkedPrograms.length > 0) {
		lines.push(
			`当前仍有挂起未恢复的沙箱程序句柄：${parkedPrograms.join(", ")}（请明确调用 \`unpark\` 恢复或推进新决策，系统不会代你自动恢复）。`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the single outbound `user` tail reminder injected on every LLM request.
 * Always enforces Simplified Chinese thinking and output; optionally includes
 * undecided parked sandbox programs when any exist.
 *
 * @param {{ parkedPrograms?: Array<{ toolName?: string, name: string }> }} [options]
 * @returns {{ role: "user", content: Array<{ type: "text", text: string }> }}
 */

export function buildOutboundTailReminder({ parkedPrograms = [], ariadneBlock = null, includeLanguage = true } = {}) {
	const parts = [];
	if (includeLanguage) parts.push(LANGUAGE_SKILL);
	if (typeof ariadneBlock === "string" && ariadneBlock.length > 0) parts.push(ariadneBlock);
	if (Array.isArray(parkedPrograms) && parkedPrograms.length > 0) {
		const undecided = parkedPrograms.map((item) =>
			item?.toolName ? `- ${item.toolName}: ${item.name}` : `- ${item?.name ?? item}`,
		);
		parts.push([
			'<skill version="1.0">你有以下停靠程序未裁决：',
			...undecided,
			'逐项用 `(unpark {:name "..." :value ...})` 恢复，或用 `(abandon {:name "..."})` 放弃并丢弃。</skill>',
		].join("\n"));
	}
	const text = parts.length === 0 ? "" : `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
	return { role: "user", content: text.length === 0 ? [] : [{ type: "text", text }] };
}

/**
 * Append the outbound tail reminder to a shallow copy of `messages`.
 * The `<skill version="1.0">` language block is persisted once; later
 * turns add `<skill version="1.0">` Ariadne and parked reminders.
 *
 * @param {unknown} messages
 * @param {{ parkedPrograms?: Array<{ toolName?: string, name: string }>, ariadneBlock?: string | null }} [options]
 * @returns {unknown[]}
 */
export function appendOutboundContextTail(messages, options = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const reminder = buildOutboundTailReminder(options);
	if (reminder.content.length === 0) return list;
	return [...list, reminder];
}
