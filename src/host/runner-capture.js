/**
 * Capture the live ExtensionRunner from the host's own AgentSession.
 *
 * The package root (`@oh-my-pi/pi-coding-agent`) re-exports the exact
 * AgentSession class the running host instantiates. Its public
 * `extensionRunner` getter is read by the host before every tool dispatch, so
 * wrapping that one getter observes the real runner without importing a deep
 * `ExtensionRunner` module (which can resolve to an unused bundled copy).
 *
 * The runner is remembered per SessionManager. A caller selects it with the
 * extension context it already owns; there is no global 'last runner'
 * fallback, because that would cross session cwd and approval boundaries.
 */
const STATE_KEY = Symbol.for("herdchestra.runner-capture.v1");

function state() {
	const existing = globalThis[STATE_KEY];
	if (existing) return existing;
	const created = {
		installed: false,
		captured: false,
		error: null,
		prototype: null,
		descriptor: null,
		bySession: new WeakMap(),
	};
	Object.defineProperty(globalThis, STATE_KEY, {
		value: created,
		enumerable: false,
		configurable: true,
	});
	return created;
}

function hostMismatch(message) {
	const error = new Error(message);
	error.code = "HOST_API_MISMATCH";
	return error;
}

function runnerFor(context) {
	if (!context || (typeof context !== "object" && typeof context !== "function")) return null;
	const captured = state().bySession;
	const manager = context.sessionManager;
	if (manager) {
		const runner = captured.get(manager);
		if (runner) return runner;
	}
	return captured.get(context) ?? null;
}

function remember(session, runner) {
	if (!runner) return;
	const captured = state();
	captured.captured = true;
	captured.bySession.set(session, runner);
	try {
		const manager = session.sessionManager;
		if (manager) captured.bySession.set(manager, runner);
	} catch {
		// A host getter that throws is not a capture point.
	}
}

export function installRunnerCapture(agentSessionClass) {
	const captured = state();
	if (captured.installed) return controller();
	captured.installed = true;
	if (typeof agentSessionClass !== "function" || !agentSessionClass.prototype) {
		captured.error = "AgentSession is unavailable from the host package root";
		return controller();
	}
	const prototype = agentSessionClass.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "extensionRunner");
	if (!descriptor || typeof descriptor.get !== "function") {
		captured.error = "AgentSession.prototype.extensionRunner getter is unavailable";
		return controller();
	}
	const original = descriptor.get;
	captured.prototype = prototype;
	captured.descriptor = descriptor;
	Object.defineProperty(prototype, "extensionRunner", {
		...descriptor,
		get() {
			const runner = Reflect.apply(original, this, []);
			remember(this, runner);
			return runner;
		},
	});
	captured.error = null;
	return controller();
}

export function runnerCaptureStatus() {
	const captured = state();
	return Object.freeze({
		installed: captured.installed,
		captured: captured.captured,
		error: captured.error,
	});
}

export function restoreRunnerCapture() {
	const captured = state();
	if (captured.prototype && captured.descriptor) {
		Object.defineProperty(captured.prototype, "extensionRunner", captured.descriptor);
	}
	captured.installed = false;
	captured.captured = false;
	captured.error = null;
	captured.prototype = null;
	captured.descriptor = null;
	captured.bySession = new WeakMap();
}

function controller() {
	return Object.freeze({
		available(name, context) {
			const runner = runnerFor(context);
			return (
				!!runner &&
				typeof runner.invokeNativeTool === "function" &&
				typeof runner.hasNativeTool === "function" &&
				runner.hasNativeTool(name)
			);
		},
		invoke(name, params, options, context) {
			const runner = runnerFor(context);
			if (!runner) {
				throw hostMismatch(`no live ExtensionRunner is bound to this session for native tool '${name}'`);
			}
			if (typeof runner.invokeNativeTool !== "function") {
				throw hostMismatch(`the captured ExtensionRunner cannot invoke native tool '${name}'`);
			}
			if (typeof runner.hasNativeTool === "function" && !runner.hasNativeTool(name)) {
				throw hostMismatch(`host native tool '${name}' is unavailable`);
			}
			return runner.invokeNativeTool(name, params, options ?? {});
		},
		getRunner(context) {
			return runnerFor(context);
		},
		status() {
			return runnerCaptureStatus();
		},
		restore() {
			restoreRunnerCapture();
		},
	});
}
