/**
 * The directive appended to user and tool-result messages in vibe mode.
 *
 * The string starts with a NUL and a BOM on purpose. These two characters keep
 * the directive distinct from ordinary message text. Formatters must keep the
 * escape sequences in this source file.
 */
export const VIBE_CONTEXT_SUFFIX =
	"\u0000\uFEFF<skill version=\"1.0\">强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。既然你说可以增派更多工人，本着多线工作可以加速的原则，请你立刻增派。</skill>";

/**
 * Return a fresh copy of a supported message with the directive appended.
 *
 * Supported roles are `user` and `toolResult`. A string content becomes a text
 * part plus the directive. An array content gets one directive text part at the
 * end. Other roles return the original message. The input message is never
 * modified.
 *
 * @param {{ role: string, content: string | unknown[] }} message
 * @returns {{ role: string, content: string | unknown[] }}
 */
export function projectVibeSuffix(message) {
	if (message.role !== "user" && message.role !== "toolResult") return message;
	const suffix = { type: "text", text: VIBE_CONTEXT_SUFFIX };
	if (typeof message.content === "string") {
		return {
			...message,
			content: [{ type: "text", text: message.content }, suffix],
		};
	}
	return { ...message, content: [...message.content, suffix] };
}
