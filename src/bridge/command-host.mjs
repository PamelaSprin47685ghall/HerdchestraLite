const BACKENDS = new Set(["tui", "print", "rpc", "acp", "subagent"]);

export function normalizeCommandResult(command, backend, outcome = {}) {
	const normalizedBackend = BACKENDS.has(backend) ? backend : "print";
	return {
		command,
		backend: normalizedBackend,
		mode: outcome.mode ?? null,
		status: outcome.status ?? "ok",
		consumed: outcome.consumed !== false,
		prompt: outcome.prompt ?? null,
		output: outcome.output ?? null,
		ui: normalizedBackend === "tui" ? outcome.ui ?? "present" : outcome.ui ?? "none",
		missing_deps: outcome.missing_deps ?? outcome.missingDeps ?? [],
		error: outcome.error ?? null,
	};
}

export function createCommandHost({ dispatch } = {}) {
	async function run(command, backend, input, runtime) {
		if (typeof dispatch !== "function") {
			return normalizeCommandResult(command, backend, { status: "error", error: "no-dispatch" });
		}
		try {
			const outcome = await dispatch({ command, backend, input, runtime });
			return normalizeCommandResult(command, backend, outcome ?? {});
		} catch (error) {
			return normalizeCommandResult(command, backend, { status: "error", error: String(error) });
		}
	}
	return {
		handle: (command, input, runtime) => run(command, "print", input, runtime),
		handleTui: (command, input, ctx) => run(command, "tui", input, ctx),
		handleBackend: (command, backend, input, runtime) => run(command, backend, input, runtime),
	};
}
