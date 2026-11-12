/**
 * P2: runtime wiring text and schemas, copied verbatim from AGENTS.md §8.5.
 *
 * Depends on nothing. The language suffix keeps the NUL + BOM prefix so the
 * host treats it as system-level discipline, not ordinary user content.
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
	'<skill version="1.0">强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。你必须维持住并行工人与切片推进力度，本着按因果最大化并发的原则，严禁越干越少或退化为单线串行。</skill>';

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

export const TOOL_GATE_DEFINITIONS = Object.freeze({
	how_many_more_workers_are_allowed_without_hitting_mythical_man_month: {
		type: "integer",
		description:
			"Maintain aggressive causal parallelism (Brooks check: disjoint contracts/slices ready to run concurrently; target total workload in turns / 100). Never skimp on dispatching independent work.",
	},
	intent: {
		type: "string",
		minLength: 1,
		description:
			"Concise zh-cn action intent after passing the 3 introspection gates; allocates execution deadline (UTF-8 byteLength * 50ms).",
	},
	scope: {
		type: "object",
		additionalProperties: false,
		required: ["kind"],
		properties: {
			kind: { type: "string", enum: ["resetScope", "keepLast", "removeLast", "meToo"] },
			new_scope_goal: { type: "string", minLength: 1 },
			new_scope_retention_budget: { type: "integer", minimum: 1 },
			replacement: { type: "string", minLength: 1 },
		},
		description: "Mandatory Scope annotation (`COMMON # Scope`). Stripped before tool execution.",
	},
});

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
		"系统处于常授权无人值守模式（仅 S1 的 `advance_s1` 手工批准、`ask_user` 澄清与 S5 初任空账的一次性询问例外）：禁止等待用户决策或授权，禁止半途而废，禁止退回舒适区！",
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
function messageText(message) {
	if (!message || typeof message !== "object") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((block) => (block && typeof block.text === "string" ? block.text : "")).join("\n");
}

const LANGUAGE_SKILL_MARKER = '<skill version="1.0">';

function hasLanguageSkill(messages) {
	if (!Array.isArray(messages)) return false;
	return messages.some((msg) => messageText(msg).includes(LANGUAGE_SKILL_MARKER));
}

export function buildOutboundTailReminder({ parkedPrograms = [], includeLanguage = true } = {}) {
	const content = [];
	if (includeLanguage) {
		content.push({ type: "text", text: LANGUAGE_SKILL });
	}
	if (Array.isArray(parkedPrograms) && parkedPrograms.length > 0) {
		const undecided = parkedPrograms.map((item) =>
			item?.toolName ? `- ${item.toolName}: ${item.name}` : `- ${item?.name ?? item}`,
		);
		content.push({
			type: "text",
			text: [
				"<system-reminder>",
				"<UNDECIDED-PARKED-PROGRAMS>",
				"The following sandbox programs are still parked and undecided (holding continuations and memory).",
				'Resolve each one by calling `(unpark {:name "..." :value ...})` to resume or `(abandon {:name "..."})` to abort and discard it:',
				...undecided,
				"</UNDECIDED-PARKED-PROGRAMS>",
				"</system-reminder>",
			].join("\n"),
		});
	}
	return { role: "user", content };
}

/**
 * Append the outbound tail reminder to a shallow copy of `messages`.
 * The `<skill version="1.0">` language block is persisted once; later
 * turns add only the optional parked-program reminder.
 *
 * @param {unknown} messages
 * @param {{ parkedPrograms?: Array<{ toolName?: string, name: string }> }} [options]
 * @returns {unknown[]}
 */
export function appendOutboundContextTail(messages, options = {}) {
	const parkedPrograms = Array.isArray(options?.parkedPrograms) ? options.parkedPrograms : [];
	const alreadyHasLang = hasLanguageSkill(messages);
	if (alreadyHasLang && parkedPrograms.length === 0) {
		return Array.isArray(messages) ? messages : [];
	}
	const reminder = buildOutboundTailReminder({
		parkedPrograms,
		includeLanguage: !alreadyHasLang,
	});
	return Array.isArray(messages) ? [...messages, reminder] : [reminder];
}
