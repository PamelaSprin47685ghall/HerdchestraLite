/**
 * Adapt Pi's extension API for pi-context.
 *
 * pi-context is a full Pi extension written against Pi's API. omp's legacy Pi
 * shim runs it; this facade fills the gaps the shim cannot: the `/acm` command
 * contract, automatic activation, xdev compact history rewriting, and entry
 * labels.
 *
 * Inputs: the host extension API.
 * Output: the PiFacade pi-context registers against, plus its session
 * activator.
 * Old location: vibe-workers.ts createPiFacade, VW 2076-2228.
 * No fallback: when no `/acm` handler is registered, activation is a no-op;
 * when the session manager cannot set entry labels, the failure is reported on
 * stderr.
 */

import { createCommandContext, createPiContext } from "./command-context.mjs";
import { beginXdevCompact, clearXdevCompact, isXdevCompactCall, pendingXdevCompact } from "./xdev-compact.mjs";

/**
 * @param {import("../host/imports.mjs").ExtensionAPI} pi
 * @returns {{
 *   api: any,
 *   activate: (ctx: import("../host/imports.mjs").ExtensionContext) => void,
 * }}
 */
export function createPiFacade(pi) {
	/** @type {any} */
	let base;
	const commands = new Map();
	const clearSessionXdevCompact = (ctx) => {
		clearXdevCompact(ctx.sessionManager.getSessionId());
	};
	const registerEvent = pi.on.bind(pi);
	const registerTool = pi.registerTool;
	const registerCommand = pi.registerCommand;
	const registerMessageRenderer = pi.registerMessageRenderer;
	const sendMessage = pi.sendMessage;
	const sendUserMessage = pi.sendUserMessage;
	/** @param {any} ctx */
	const activate = (ctx) => {
		const handler = commands.get("acm");
		if (!handler) return;
		const commandContext = createCommandContext(ctx, () => clearSessionXdevCompact(ctx));
		// Auto-activation is silent; the explicit command still reports itself.
		const quietContext = Object.create(commandContext);
		// The host defines a handler context's `ui` as a non-writable own property, and
		// an inherited non-writable property rejects plain assignment in strict mode.
		// Shadow it with an own property instead.
		Object.defineProperty(quietContext, "ui", {
			value: new Proxy(commandContext.ui, {
				get(target, property) {
					if (property === "notify") {
						return (message, type) => {
							if (message === "Agentic Context Management enabled.") return;
							target.notify(message, type);
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
			writable: true,
			enumerable: true,
			configurable: true,
		});
		void Promise.resolve(handler("", quietContext)).catch((error) => {
			console.error("pi-context: auto-activation failed", error);
		});
	};
	const api = {
		on(event, handler) {
			registerEvent(event, (payload, ctx) => {
				if (event === "session_shutdown") clearSessionXdevCompact(ctx);
				const piCtx =
					event === "agent_end" && pendingXdevCompact(ctx.sessionManager.getSessionId()) ? createPiContext(ctx) : ctx;
				base = piCtx;
				return handler(payload, piCtx);
			});
		},
		registerTool(tool) {
			const execute = tool.execute;
			registerTool({
				...tool,
				async execute(id, params, signal, onUpdate, ctx) {
					const xdevCompact = tool.name === "context_compact" && isXdevCompactCall(ctx, id);
					const piCtx = xdevCompact ? createPiContext(ctx) : ctx;
					if (xdevCompact) {
						beginXdevCompact(ctx.sessionManager.getSessionId(), id);
					}
					base = piCtx;
					return execute(id, params, signal, onUpdate, piCtx);
				},
			});
		},
		registerCommand(name, options) {
			commands.set(name, options.handler);
			if (name === "acm") {
				registerCommand(name, {
					...options,
					async handler(args, ctx) {
						if (args) return options.handler(args, ctx);
						ctx.ui.notify("Agentic context management is always on.", "info");
					},
				});
				return;
			}
			registerCommand(name, {
				...options,
				async handler(args, ctx) {
					base = ctx;
					return options.handler(args, ctx);
				},
			});
		},
		registerMessageRenderer(customType, renderer) {
			registerMessageRenderer(customType, renderer);
		},
		sendMessage(message, options) {
			sendMessage(message, options);
		},
		sendUserMessage(content, options) {
			// Pi's command dispatch runs /acm and hands back a command context.
			// omp's sendUserMessage only queues text, so run the registered
			// handler against a shimmed command context instead.
			if (typeof content === "string" && content.trim() === "/acm" && base) {
				const handler = commands.get("acm");
				if (handler) {
					const commandContext = createCommandContext(base, () => clearSessionXdevCompact(base));
					void Promise.resolve(handler("", commandContext)).catch((error) => {
						console.error("pi-context: /acm shim failed", error);
					});
					return;
				}
			}
			sendUserMessage(content, options);
		},
		setLabel(entryId, label) {
			if (label === undefined) {
				pi.setLabel(entryId);
				return;
			}
			// omp's ExtensionAPI.setLabel only sets the extension display label;
			// entry labels live on the session manager.
			const sessionManager = base?.sessionManager;
			if (sessionManager?.appendLabelChange) {
				sessionManager.appendLabelChange(entryId, label);
				return;
			}
			console.error("pi-context: session manager cannot set entry labels");
		},
		getActiveTools: () => pi.getActiveTools(),
		getAllTools: () => pi.getAllTools(),
	};
	return { api, activate };
}
