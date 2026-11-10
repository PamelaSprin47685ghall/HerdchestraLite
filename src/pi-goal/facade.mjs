/**
 * pi-goal-x is a full Pi extension. omp's legacy shim runs it; the wrapper
 * renames its guided `/goal` to `/goal-x` so omp's built-in `/goal` keeps
 * working. Everything else is active in every mode.
 *
 * Inputs: the host extension API.
 * Output: the pi-goal facade, a session starter, and the command-rename flag.
 * Old location: vibe-workers.ts createGoalFacade, VW 2254-2437.
 * No fallback: registration is deferred until the host's `session_start`.
 */

import { adaptGoalDraftPrompt } from "../prompts/plan-only.mjs";
import { wrapGoalTool } from "./tool-wrap.mjs";
import { goalUi } from "./ui.mjs";

/** @param {unknown} value */
function isFollowUpOptions(value) {
	return typeof value === "object" && value !== null && "deliverAs" in value && value.deliverAs === "followUp";
}

/**
 * @param {object} pi
 * @returns {{
 *   api: object,
 *   startSession: (ctx: object) => Promise<void>,
 *   wasGoalCommandRenamed: () => boolean,
 * }}
 */
export function createGoalFacade(pi) {
	let startedSessionId;
	let flushed = false;
	let renamedGoalCommand = false;
	let lastContext;
	let pendingToolUpdate = Promise.resolve();
	const sessionStartHandlers = [];
	const pendingEvents = [];
	const pendingTools = [];
	const pendingCommands = [];
	const pendingRenderers = [];
	const registerEvent = pi.on.bind(pi);
	const registerTool = pi.registerTool;
	const registerCommand = pi.registerCommand;
	const registerMessageRenderer = pi.registerMessageRenderer;

	const goalContext = (ctx, event) => {
		lastContext = ctx;
		const derived = Object.create(ctx);
		// The host's `ui` is inherited as non-writable, so shadow it.
		Object.defineProperty(derived, "ui", {
			value: goalUi(ctx.ui),
			writable: true,
			enumerable: true,
			configurable: true,
		});
		if (event && typeof event === "object" && "signal" in event && event.signal instanceof AbortSignal) {
			derived.signal = event.signal;
		}
		return derived;
	};

	const flush = () => {
		if (flushed) return;
		flushed = true;

		for (const { event, handler } of pendingEvents) {
			registerEvent(event, (payload, ctx) => {
				return handler(payload, goalContext(ctx, payload));
			});
		}

		for (const tool of pendingTools) {
			const wrapped = wrapGoalTool(pi, () => api._goalCore, tool);
			registerTool({
				...wrapped,
				async execute(id, params, signal, onUpdate, ctx) {
					lastContext = ctx;
					const toolContext = goalContext(ctx, undefined);
					return wrapped.execute(id, params, signal, onUpdate, toolContext);
				},
			});
		}

		for (const { name, options } of pendingCommands) {
			registerCommand(name, {
				...options,
				async handler(args, ctx) {
					lastContext = ctx;
					return options.handler(args, goalContext(ctx, undefined));
				},
			});
		}

		for (const { customType, renderer } of pendingRenderers) {
			registerMessageRenderer(customType, renderer);
		}
	};

	const startSession = async (ctx) => {
		// Subagents inherit the extension list; goal ownership stays with the
		// session the user is driving.
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (startedSessionId === sessionId) return;
		startedSessionId = sessionId;
		lastContext = ctx;
		flush();
		for (const handler of sessionStartHandlers) {
			await handler({ type: "session_start" }, goalContext(ctx, undefined));
		}
	};

	const api = {
		events: pi.events,
		on(event, handler) {
			if (event === "session_start") {
				sessionStartHandlers.push(handler);
				return;
			}
			pendingEvents.push({ event, handler });
		},
		registerTool(tool) {
			pendingTools.push(tool);
		},
		registerCommand(name, options) {
			// omp's built-in /goal is dispatched before extension commands and refuses
			// to run in vibe mode. Expose pi-goal-x's guided goal under /goal-x so the
			// two commands coexist.
			if (name === "goal") {
				renamedGoalCommand = true;
				pendingCommands.push({ name: "goal-x", options });
				return;
			}
			pendingCommands.push({ name, options });
		},
		registerMessageRenderer(customType, renderer) {
			pendingRenderers.push({ customType, renderer });
		},
		sendMessage(message, options) {
			pi.sendMessage(message, options);
		},
		sendUserMessage(content, options) {
			const adapted = typeof content === "string" ? adaptGoalDraftPrompt(content) : content;
			// omp appends the vibe-mode context as a custom message. A follow-up-only
			// idle drain refuses to resume from that tail, so a guided goal draft
			// would sit in the queue forever. A steer resumes from any tail.
			const send = () => {
				if (lastContext?.isIdle() && isFollowUpOptions(options)) {
					pi.sendUserMessage(adapted, { ...options, deliverAs: "steer" });
					return;
				}
				pi.sendUserMessage(adapted, options);
			};
			void pendingToolUpdate.finally(send);
		},
		setActiveTools(names) {
			// pi-goal-x does not await this before sending the drafting prompt;
			// hold that prompt until the new profile is actually active.
			pendingToolUpdate = pi.setActiveTools(names).catch((error) => {
				console.error("pi-goal-x: setActiveTools failed", error);
			});
			return pendingToolUpdate;
		},
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		getActiveTools: () => pi.getActiveTools(),
		getCommands: () => pi.getCommands(),
	};

	return { api, startSession, wasGoalCommandRenamed: () => renamedGoalCommand };
}
