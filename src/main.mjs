/**
 * Main entry: composes prompts, context projection, pi-context, pi-goal, and
 * manual acceptance into one omp extension.
 *
 * Inputs: the host extension API.
 * Output: nothing; every domain registers through `pi` in the order below.
 * Failure isolation: this entry never throws at load time, so a missing or
 * incompatible host leaves only this entry inert; `tool-gate` and
 * `editor-theme` load independently.
 * Old location: vibe-workers.ts default factory, VW 2436-2503.
 *
 * Assembly order is fixed by the development guide (9.0): prompts, context,
 * session capture, pi-context, pi-goal, manual acceptance tools, the auditor,
 * then the session_start retry. Do not reorder.
 */

import { rewriteVibeModeContext } from "./context/vibe-context-rewrite.mjs";
import { projectVibeSuffix } from "./context/vibe-suffix.mjs";
import { AgentSession, goalExtension, piContextExtension } from "./host/imports.mjs";
import { registerManualAcceptanceTools } from "./manual-acceptance/tools.mjs";
import { createPiFacade } from "./pi-context/facade.mjs";
import { installLiveSessionCapture } from "./pi-context/session-capture.mjs";
import { createGoalFacade } from "./pi-goal/facade.mjs";
import { installManualAcceptanceAuditor, isManualAcceptanceAuditorInstalled } from "./pi-goal/install-auditor.mjs";
import { loadContextManagementSkill } from "./prompts/context-skill.mjs";
import { MANUAL_ACCEPTANCE_PROTOCOL } from "./prompts/manual-protocol.mjs";
import { METHOD_DISCIPLINE } from "./prompts/method-discipline.mjs";
import { REPO_AWARE_RULES } from "./prompts/repo-aware-rules.mjs";

// Read once: omp does not discover skills bundled inside an extension dependency.
const contextManagementSkill = loadContextManagementSkill();

/**
 * @param {import("./host/imports.mjs").ExtensionAPI} pi
 */
export default function vibeWorkers(pi) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: [
			...event.systemPrompt,
			...REPO_AWARE_RULES,
			METHOD_DISCIPLINE,
			...(contextManagementSkill ? [contextManagementSkill] : []),
			MANUAL_ACCEPTANCE_PROTOCOL,
		],
	}));

	pi.on("context", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (
				message.role === "custom" &&
				message.customType === "vibe-mode-context" &&
				typeof message.content === "string"
			) {
				const content = rewriteVibeModeContext(message.content);
				if (content === message.content) return message;
				changed = true;
				return { ...message, content };
			}
			if (message.role === "user" || message.role === "toolResult") {
				const projected = projectVibeSuffix(message);
				if (projected === message) return message;
				changed = true;
				return projected;
			}
			return message;
		});
		if (changed) return { messages };
	});

	installLiveSessionCapture(AgentSession);

	const piContext = createPiFacade(pi);
	piContextExtension(piContext.api);
	pi.on("session_start", (_event, ctx) => piContext.activate(ctx));

	const goal = createGoalFacade(pi);
	registerManualAcceptanceTools(pi);
	goalExtension(goal.api);
	installManualAcceptanceAuditor(goal);

	if (goal.wasGoalCommandRenamed()) {
		// Keep pi-goal-x's hints and runtime command view on the alias; the
		// /goal-settings editor still shows the persisted value.
		const goalCore = goal.api._goalCore;
		if (typeof goalCore === "object" && goalCore !== null) {
			// pi-goal-x assigns this hook itself; the wrapper only adjusts loadedCommands.
			goalCore.loadedCommands = { ...(goalCore.loadedCommands ?? {}), goal: ["goal-x"] };
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// The module remembers whether any core installed the visible auditor.
		if (!isManualAcceptanceAuditorInstalled()) installManualAcceptanceAuditor(goal);
		void goal.startSession(ctx);
	});
}
