/**
 * Managed `systemPrompt` wrapper (`hack_system_prompt`).
 *
 * Mirrors `hack-context.mjs`: wrap `pi.on("before_agent_start", ...)` so the
 * host receives one managed, idempotent system-prompt block.
 *
 * Guarantees:
 * - String and content-block-array prompts both supported.
 * - Re-injection replaces the managed region instead of stacking copies.
 * - A throwing handler fails open with the host's original prompt and records
 *   a degraded health entry; the host main loop never sees the exception.
 * - No stage briefings are imported here; callers own the block text.
 */

import { recordHealth } from "./health.mjs";

export const SYSTEM_PROMPT_BLOCK_START = "<!-- herdchestra:system-prompt v1 -->";
export const SYSTEM_PROMPT_BLOCK_END = "<!-- /herdchestra:system-prompt -->";

const MANAGED_RE = /<!-- herdchestra:system-prompt v1 -->[\s\S]*?<!-- \/herdchestra:system-prompt -->/;

function wrapBlock(block) {
	return `${SYSTEM_PROMPT_BLOCK_START}\n${block}\n${SYSTEM_PROMPT_BLOCK_END}`;
}

function hasManagedRegion(text) {
	return typeof text === "string" && text.includes(SYSTEM_PROMPT_BLOCK_START);
}

/**
 * Insert or replace the managed region in a system prompt.
 *
 * @param {unknown} current host system prompt (string, block array, or empty)
 * @param {string} block managed body
 * @returns {unknown} prompt with exactly one managed region
 */
export function injectSystemPromptBlock(current, block) {
	if (typeof block !== "string" || block.trim().length === 0) return current;
	const managed = wrapBlock(block);
	if (typeof current === "string") {
		if (hasManagedRegion(current)) return current.replace(MANAGED_RE, () => managed);
		return current.length === 0 ? managed : `${current}\n\n${managed}`;
	}
	if (Array.isArray(current)) {
		const strIndex = current.findIndex((part) => typeof part === "string" && hasManagedRegion(part));
		if (strIndex !== -1) {
			const next = current.slice();
			next[strIndex] = next[strIndex].replace(MANAGED_RE, () => managed);
			return next;
		}
		const objIndex = current.findIndex(
			(part) => part && typeof part === "object" && part.type === "text" && hasManagedRegion(part.text),
		);
		if (objIndex !== -1) {
			const next = current.slice();
			next[objIndex] = { ...next[objIndex], text: next[objIndex].text.replace(MANAGED_RE, () => managed) };
			return next;
		}
		const hasContentBlocks = current.some((part) => part && typeof part === "object" && part.type === "text");
		if (hasContentBlocks) {
			return [...current, { type: "text", text: managed }];
		}
		return [...current, managed];
	}
	if (current == null) return managed;
	return current;
}

/**
 * Remove the managed region, restoring the host prompt as closely as possible.
 *
 * @param {unknown} current
 * @returns {unknown}
 */
export function stripSystemPromptBlock(current) {
	if (typeof current === "string") {
		if (!hasManagedRegion(current)) return current;
		return current
			.replace(MANAGED_RE, "")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd();
	}
	if (Array.isArray(current)) {
		const next = [];
		for (const part of current) {
			if (typeof part === "string") {
				if (!hasManagedRegion(part)) {
					next.push(part);
				} else {
					const text = part
						.replace(MANAGED_RE, "")
						.replace(/\n{3,}/g, "\n\n")
						.trimEnd();
					if (text.length > 0) next.push(text);
				}
				continue;
			}
			if (!part || typeof part !== "object" || part.type !== "text" || !hasManagedRegion(part.text)) {
				next.push(part);
				continue;
			}
			const text = part.text.replace(MANAGED_RE, "").trimEnd();
			if (text.length > 0) next.push({ ...part, text });
		}
		return next;
	}
	return current;
}

function promptOf(event, result) {
	if (result && typeof result === "object" && "systemPrompt" in result) return result.systemPrompt;
	return event?.systemPrompt;
}

/**
 * Register a `before_agent_start` hook that writes one managed prompt block.
 *
 * @param {any} pi
 * @param {(event: any, ctx: any) => any} handler side effects and/or `{ systemPrompt }`
 * @param {{ block?: string, entry?: string }} [options]
 * @returns {{ ok: true } | { ok: false, error: { code: string, message: string } }}
 */
export function hackSystemPrompt(pi, handler, options = {}) {
	if (!pi || typeof pi.on !== "function") {
		return {
			ok: false,
			error: { code: ":HOST_API_MISMATCH", message: "before_agent_start requires pi.on" },
		};
	}
	if (typeof handler !== "function") {
		throw new TypeError("hackSystemPrompt: handler function is required");
	}
	const block = typeof options.block === "string" ? options.block : "";
	const entry = typeof options.entry === "string" && options.entry.length > 0 ? options.entry : "clj.systemPrompt";
	pi.on("before_agent_start", async (event, ctx) => {
		const original = event?.systemPrompt;
		try {
			const result = await handler(event, ctx);
			return { systemPrompt: injectSystemPromptBlock(promptOf(event, result), block) };
		} catch (error) {
			recordHealth({
				entry,
				status: "degraded",
				version: "1",
				capabilities: { systemPromptBlock: false },
				degraded: true,
				error: error instanceof Error ? error.message : String(error),
			});
			return { systemPrompt: original };
		}
	});
	recordHealth({
		entry,
		status: "ok",
		version: "1",
		capabilities: { systemPromptBlock: block.length > 0 },
		degraded: false,
	});
	return { ok: true };
}
