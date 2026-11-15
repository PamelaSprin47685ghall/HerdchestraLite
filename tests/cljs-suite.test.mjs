import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { installRunnerCapture, restoreRunnerCapture, runnerCaptureStatus } from "../src/host/runner-capture.js";

globalThis.__bunTest = { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn };
globalThis.__herdNbb = nbb;
globalThis.__herdRequire = createRequire(import.meta.url);
globalThis.__herdEntryPath = fileURLToPath(new URL("../src/clj-main.mjs", import.meta.url));
nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
await nbb.loadFile(fileURLToPath(new URL("cljs/harness.cljs", import.meta.url)));

class FakeAgentSession {
	constructor(runner) {
		this.sessionManager = { id: `session-${FakeAgentSession.next++}` };
		this.runner = runner;
	}

	get extensionRunner() {
		return this.runner;
	}
}
FakeAgentSession.next = 1;

function makeRunner() {
	const calls = [];
	return {
		calls,
		hasNativeTool(name) {
			return name === "read" || name === "write";
		},
		invokeNativeTool(name, params, options) {
			calls.push({ name, params, options });
			return Promise.resolve({ content: [{ type: "text", text: `${name}:${params.path}` }] });
		},
	};
}

describe("host runner capture", () => {
	afterEach(() => restoreRunnerCapture());

	it("captures the real runner through the AgentSession getter", () => {
		const runner = makeRunner();
		const session = new FakeAgentSession(runner);
		const tools = installRunnerCapture(FakeAgentSession);
		expect(tools.status().installed).toBe(true);
		expect(session.extensionRunner).toBe(runner);
		expect(runnerCaptureStatus().captured).toBe(true);
		const context = { sessionManager: session.sessionManager };
		expect(tools.available("read", context)).toBe(true);
		return tools.invoke("read", { path: "a" }, {}, context).then((result) => {
			expect(result.content[0].text).toBe("read:a");
			expect(runner.calls.at(-1).name).toBe("read");
		});
	});

	it("selects the runner by SessionManager rather than the last capture", () => {
		const a = makeRunner();
		const b = makeRunner();
		const sa = new FakeAgentSession(a);
		const sb = new FakeAgentSession(b);
		const tools = installRunnerCapture(FakeAgentSession);
		expect(sa.extensionRunner).toBe(a);
		expect(sb.extensionRunner).toBe(b);
		return Promise.all([
			tools.invoke("read", { path: "a" }, {}, { sessionManager: sa.sessionManager }),
			tools.invoke("read", { path: "b" }, {}, { sessionManager: sb.sessionManager }),
		]).then(([ra, rb]) => {
			expect(a.calls.at(-1).params.path).toBe("a");
			expect(b.calls.at(-1).params.path).toBe("b");
			expect(ra.content[0].text).toBe("read:a");
			expect(rb.content[0].text).toBe("read:b");
		});
	});

	it("rejects a context with no captured session", () => {
		const tools = installRunnerCapture(FakeAgentSession);
		expect(tools.available("read", {})).toBe(false);
		expect(() => tools.invoke("read", {}, {}, {})).toThrow();
	});

	it("fails closed when the host class is unavailable", () => {
		const tools = installRunnerCapture(null);
		expect(tools.status().installed).toBe(true);
		expect(tools.status().error).toContain("AgentSession");
		expect(() => tools.invoke("read", {}, {}, {})).toThrow();
	});

	it("restores the original getter", () => {
		const original = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, "extensionRunner").get;
		const tools = installRunnerCapture(FakeAgentSession);
		expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, "extensionRunner").get).not.toBe(original);
		tools.restore();
		expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, "extensionRunner").get).toBe(original);
	});
});
