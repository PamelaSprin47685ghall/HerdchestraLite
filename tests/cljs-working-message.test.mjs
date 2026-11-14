import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { loadLanguageDetector } from "../src/host/language-detect.mjs";
import { installFakeClock } from "./fake-clock.mjs";

const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const evalClj = (source) => nbb.loadString(`(require '[herd.main :as m]) ${source}`);

let clock;
let messageEnd;
let messageUpdate;
let toolExecutionUpdate;

const resetState = () =>
	evalClj(`
		(reset! m/usage-totals {})
		(reset! m/last-usage {})
		(reset! m/last-usage-line {})
		(reset! m/last-prefix {})
		(reset! m/active-usage-key nil)
		(reset! m/ui-render {:usage-last nil :last-working {}})
		(reset! m/last-host-working-text nil)
		(reset! m/usage-timers {})
		(reset! m/usage-last-emit {})
	`);

const usageEvent = (input, output) => ({
	message: {
		role: "assistant",
		usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	},
});

const makeUi = () => {
	const lines = [];
	return {
		lines,
		ui: {
			setWorkingMessage: (text) => lines.push(text),
			setStatus: () => {},
		},
	};
};

const mainCtx = ({ ui, hasUI = true } = {}) => ({
	hasUI,
	ui,
	agent: { id: "main-session" },
});

const subCtx = (id, ui) => ({ hasUI: true, ui, agent: { id, kind: "sub" } });

const lastLine = (lines) => lines[lines.length - 1];

beforeAll(async () => {
	clock = installFakeClock();
	globalThis.__herdLockRoot = here("tmp/herd-working-message-lock");
	globalThis.__herdNative = {
		getRunner: () => ({
			hasNativeTool: () => false,
			invokeNativeTool: async () => ({ content: [] }),
		}),
	};
	class FakeText {
		constructor(text) {
			this.text = text;
		}
	}
	class FakeContainer {
		constructor() {
			this.children = [];
		}
		addChild(child) {
			this.children.push(child);
		}
	}
	globalThis.__pi = {
		tools: new Map(),
		hooks: new Map(),
		active: [],
		pi: { Text: FakeText, Container: FakeContainer },
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
		registerCommand() {},
		on(name, handler) {
			this.hooks.set(name, handler);
		},
		getActiveTools() {
			return [...this.active];
		},
		setActiveTools(next) {
			this.active = [...next];
		},
	};
	globalThis.__herdTui = { highlightCode: (code) => code.split("\n") };
	globalThis.__herdDetectLanguage = loadLanguageDetector(createRequire(import.meta.url));
	nbb.addClassPath(here("src/"));
	await nbb.loadFile(here("src/herd/bootstrap.cljs"));
	messageEnd = globalThis.__pi.hooks.get("message_end");
	messageUpdate = globalThis.__pi.hooks.get("message_update");
	toolExecutionUpdate = globalThis.__pi.hooks.get("tool_execution_update");
});

beforeEach(async () => {
	await resetState();
});

describe("working message host-overwrite recovery", () => {
	it("registers the update hooks used to detect a host overwrite", () => {
		expect(typeof messageUpdate).toBe("function");
		expect(typeof toolExecutionUpdate).toBe("function");
	});

	it("restores our text after the host writes its own working line", async () => {
		const { ui, lines } = makeUi();
		const ctx = mainCtx({ ui });
		await messageEnd(usageEvent(100, 10), ctx);
		const target = lastLine(lines);
		expect(target).toContain("Δ:");
		expect(target).toContain("Σ:");

		// omp's built-in working line is written through the same host UI.
		// The guard records that write without changing the displayed text.
		ui.setWorkingMessage("原版工作条");
		expect(lastLine(lines)).toBe("原版工作条");

		const before = lines.length;
		await messageUpdate({}, ctx);
		clock.advance(100);
		expect(lines.length).toBe(before + 1);
		expect(lastLine(lines)).toBe(target);

		// The host did not overwrite again: the same event must not rewrite.
		const settled = lines.length;
		await messageUpdate({}, ctx);
		clock.advance(100);
		expect(lines.length).toBe(settled);
		expect(lastLine(lines)).toBe(target);
	});

	it("restores our text on a message_end after an official overwrite", async () => {
		const { ui, lines } = makeUi();
		const ctx = mainCtx({ ui });
		await messageEnd(usageEvent(100, 10), ctx);
		const target = lastLine(lines);
		ui.setWorkingMessage("原版工作条");
		const before = lines.length;
		await messageEnd({}, ctx);
		expect(lines.length).toBe(before + 1);
		expect(lastLine(lines)).toBe(target);
	});

	it("never writes the main UI from a subagent context", async () => {
		const { ui, lines } = makeUi();
		await messageEnd(usageEvent(100, 10), mainCtx({ ui }));
		const baseline = lines.length;
		const sub = subCtx("sub-a", ui);
		await messageUpdate({}, sub);
		await toolExecutionUpdate({}, sub);
		await messageEnd(usageEvent(200, 20), sub);
		await messageUpdate({}, sub);
		expect(lines.length).toBe(baseline);
	});

	it("prefers getWorkingMessage when the host exposes it", async () => {
		let current = null;
		const lines = [];
		const ui = {
			getWorkingMessage: () => current,
			setWorkingMessage: (text) => {
				current = text;
				lines.push(text);
			},
			setStatus: () => {},
		};
		const ctx = mainCtx({ ui });
		await messageEnd(usageEvent(100, 10), ctx);
		const target = lastLine(lines);
		current = "原版工作条";
		const before = lines.length;
		await messageUpdate({}, ctx);
		clock.advance(100);
		expect(lines.length).toBe(before + 1);
		expect(lastLine(lines)).toBe(target);
		const settled = lines.length;
		await messageUpdate({}, ctx);
		clock.advance(100);
		expect(lines.length).toBe(settled);
	});

	it("does not resend an identical usage line on consecutive message_end events", async () => {
		const { ui, lines } = makeUi();
		const ctx = mainCtx({ ui });
		await messageEnd({}, ctx);
		const first = lines.length;
		expect(first).toBeGreaterThan(0);
		await messageEnd({}, ctx);
		expect(lines.length).toBe(first);
	});

	it("uses events, never a polling timer, on the working-message path", async () => {
		const source = readFileSync(here("src/herd/main.cljs"), "utf8");
		const start = source.indexOf("(defonce ui-render");
		const end = source.indexOf("(defonce registered-clj-pis");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const workingCode = source.slice(start, end);
		expect(workingCode).not.toContain("setInterval");
		expect(workingCode).not.toContain("setTimeout");

		const { ui } = makeUi();
		const ctx = mainCtx({ ui });
		await messageEnd(usageEvent(100, 10), ctx);
		const realSetInterval = globalThis.setInterval;
		const realSetTimeout = globalThis.setTimeout;
		let timerCalls = 0;
		globalThis.setInterval = (...args) => {
			timerCalls += 1;
			return realSetInterval(...args);
		};
		globalThis.setTimeout = (...args) => {
			timerCalls += 1;
			return realSetTimeout(...args);
		};
		try {
			messageUpdate({}, ctx);
			messageUpdate({}, ctx);
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.setTimeout = realSetTimeout;
		}
		expect(timerCalls).toBe(0);
	});
});