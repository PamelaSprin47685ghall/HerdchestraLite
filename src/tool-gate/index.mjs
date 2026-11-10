import { injectToolSchemas } from "./schema.mjs";
import { stripGateParameters } from "./strip.mjs";

/**
 * Tool-gate entry: makes every tool call carry two required arguments and
 * strips them again before execution.
 *
 * Failure isolation: this entry never throws at load time; when it is missing
 * or broken, the other two entries keep working and tool calls pass untouched.
 *
 * @param {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} pi
 */
export default function toolCallGate(pi) {
	pi.on("before_provider_request", (event) => {
		return injectToolSchemas(event.payload) ? event.payload : undefined;
	});

	pi.on("tool_call", (event) => {
		const input = stripGateParameters(event.input);
		if (input !== undefined) return { input };
	});
}
