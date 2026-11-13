/**
 * In-process adapter with the Worker message surface, used by dogfood tests.
 * It runs the real sandbox runtime without starting a worker thread.
 */
import { createSandboxRuntime } from "./sandbox-worker.mjs";

export function createInlineSandboxWorker() {
	const listeners = new Set();
	let runtime = null;
	const post = (message) => {
		for (const listener of listeners) queueMicrotask(() => listener(message));
	};
	runtime = createSandboxRuntime(post);
	return {
		postMessage(message) {
			queueMicrotask(() => void runtime(message));
		},
		on(event, listener) {
			if (event === "message" && typeof listener === "function") listeners.add(listener);
			return this;
		},
		unref() {},
		terminate() {
			listeners.clear();
			return Promise.resolve();
		},
	};
}
