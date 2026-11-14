import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { loadLanguageDetector } from "../src/host/language-detect.mjs";
import { ensureActivated, getSharedClock } from "./helpers/nbb-boot.mjs";

const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const evalClj = (source) => nbb.loadString(`(require '[herd.main :as m]) ${source}`);

let messageEnd;
let clock;
let messageStart;
let messageUpdate;
let sessionStart;

const resetUsage = () =>
	evalClj(`
		(reset! m/usage-totals {})
		(reset! m/last-usage {})
		(reset! m/last-usage-line {})
		(reset! m/last-prefix {})
		(reset! m/active-usage-key nil)
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

const mainCtx = ({ ui, hasUI = true, sessionManager } = {}) => ({
	hasUI,
	ui,
	agent: { id: "main-session" },
	...(sessionManager ? { sessionManager } : {}),
});

const subCtx = (id, ui) => ({ hasUI: true, ui, agent: { id, kind: "sub" } });

const lastLine = (lines) => lines[lines.length - 1];

beforeAll(async () => {
	clock = getSharedClock();
	clock.reset();
	globalThis.__herdLockRoot = here("tmp/herd-usage-lock");
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
	await ensureActivated();
	messageEnd = globalThis.__pi.hooks.get("message_end");
	messageStart = globalThis.__pi.hooks.get("message_start");
	messageUpdate = globalThis.__pi.hooks.get("message_update");
	sessionStart = globalThis.__pi.hooks.get("session_start");
});

beforeEach(async () => {
	clock.reset();
	clock.reset();
	await resetUsage();
});

describe("working usage across subagents", () => {
	it("shows the main session's latest request when no subagent has reported", async () => {
		const { ui, lines } = makeUi();
		const ctx = mainCtx({ ui });
		await messageEnd(usageEvent(100, 10), ctx);
		await messageEnd(usageEvent(300, 30), ctx);
		expect(lastLine(lines)).toContain("Δ: 0.3k");
		expect(lastLine(lines)).toContain("; Σ: 0.4k");
	});

	it("keeps the latest subagent delta after a later main-session request", async () => {
		const { ui, lines } = makeUi();
		await messageEnd(usageEvent(100, 10), mainCtx({ ui }));
		await messageEnd(usageEvent(200, 20), subCtx("sub-a", ui));
		await messageEnd(usageEvent(300, 30), mainCtx({ ui }));
		expect(lastLine(lines)).toContain("Δ: 0.2k");
		expect(lastLine(lines)).toContain("; Σ: 0.6k");
		expect(await evalClj("@m/active-usage-key")).toBe("sub-a");
	});

	it("coalesces streaming usage ticks into one throttle window", async () => {
		const { ui, lines } = makeUi();
		const ctx = mainCtx({ ui });
		await messageEnd(usageEvent(100, 10), ctx);
		const beforeLines = lines.length;
		const beforeTimers = clock.pending();
		for (let i = 0; i < 20; i += 1) messageUpdate({}, ctx);
		expect(lines.length).toBe(beforeLines);
		expect(clock.pending()).toBe(beforeTimers + 1);
		clock.advance(99);
		expect(clock.pending()).toBe(beforeTimers + 1);
		clock.advance(1);
		expect(clock.pending()).toBe(beforeTimers);
	});

	it("switches the delta to a second subagent and sums all four requests", async () => {
		const { ui, lines } = makeUi();
		await messageEnd(usageEvent(100, 10), mainCtx({ ui }));
		await messageEnd(usageEvent(200, 20), subCtx("sub-a", ui));
		await messageEnd(usageEvent(300, 30), mainCtx({ ui }));
		const beforeSubB = lines.length;
		await messageEnd(usageEvent(400, 40), subCtx("sub-b", ui));
		expect(lines.length).toBe(beforeSubB);
		await messageStart({}, mainCtx({ ui }));
		expect(lastLine(lines)).toContain("Δ: 0.4k");
		expect(lastLine(lines)).toContain("; Σ: 1.0k");
		expect(await evalClj("@m/active-usage-key")).toBe("sub-b");
	});

	it("resets only the starting session and keeps subagent totals and delta", async () => {
		const { ui, lines } = makeUi();
		await messageEnd(usageEvent(500, 50), mainCtx({ ui }));
		await messageEnd(usageEvent(200, 20), subCtx("sub-a", ui));
		await sessionStart({}, mainCtx({ ui }));
		await messageEnd(usageEvent(100, 10), mainCtx({ ui }));
		expect(lastLine(lines)).toContain("Δ: 0.2k");
		expect(lastLine(lines)).toContain("; Σ: 0.3k");
		const totals = await evalClj("(clj->js @m/usage-totals)");
		expect(totals["sub-a"].input).toBe(200);
		expect(totals["main-session"].input).toBe(100);
	});

	it("updates totals without UI and tolerates a missing setWorkingMessage", async () => {
		expect(() => messageEnd(usageEvent(100, 10), mainCtx({ hasUI: false }))).not.toThrow();
		const partial = { hasUI: true, ui: { setStatus: () => {} }, agent: { id: "main-session" } };
		expect(() => messageEnd(usageEvent(50, 5), partial)).not.toThrow();
		const totals = await evalClj("(clj->js @m/usage-totals)");
		expect(totals["main-session"].input).toBe(150);
		expect(totals["main-session"].output).toBe(15);
		expect(await evalClj("@m/active-usage-key")).toBeFalsy();
	});

	it("records a cache probe only when enabled", async () => {
		const handler = globalThis.__pi.hooks.get("before_provider_request");
		expect(handler).toBeDefined();
		const payload = { system: "s", tools: [], messages: [{ role: "user", content: "x" }] };
		const ctx = mainCtx({});
		delete process.env.HERD_CACHE_PROBE;
		const before = clock.now();
		expect(handler({ payload }, ctx)).toBe(payload);
		expect(clock.now()).toBe(before);
		const probePath = here("tmp/herd-usage-probe.jsonl");
		await rm(probePath, { force: true });
		process.env.HERD_CACHE_PROBE = "1";
		process.env.HERD_CACHE_PROBE_PATH = probePath;
		try {
			handler({ payload }, ctx);
			await evalClj("(deref m/probe-tail)");
			const line = (await readFile(probePath, "utf8")).trim();
			expect(line).toContain("messages");
			expect(line).toContain("count");
		} finally {
			delete process.env.HERD_CACHE_PROBE;
			delete process.env.HERD_CACHE_PROBE_PATH;
			await rm(probePath, { force: true });
		}
	});

	it("replays branch usage into the starting session's totals", async () => {
		const { ui, lines } = makeUi();
		const sessionManager = {
			getBranchView: () => [{ type: "model_usage", usage: { input: 70, output: 7, cacheRead: 3, cacheWrite: 0 } }],
		};
		await sessionStart({}, mainCtx({ ui, sessionManager }));
		expect(lastLine(lines)).toContain("Δ: 0.0k");
		expect(lastLine(lines)).toContain("; Σ: 0.1k");
		const totals = await evalClj("(clj->js @m/usage-totals)");
		expect(totals["main-session"].input).toBe(70);
		expect(totals["main-session"]["cache-read"]).toBe(3);
	});

	it("registers usage hooks through activate-session! and renders the delta", async () => {
		const activate = await nbb.loadString("herd.main/activate-session!");
		const hooks = new Map();
		const lines = [];
		const pi = {
			tools: new Map(),
			active: [],
			registerTool() {},
			registerCommand() {},
			on(name, handler) {
				hooks.set(name, handler);
			},
			getActiveTools() {
				return [];
			},
			setActiveTools() {},
		};
		globalThis.__pi = pi;
		await activate(pi);
		expect(hooks.has("message_end")).toBe(true);
		expect(hooks.has("session_start")).toBe(true);
		expect(hooks.has("tool_execution_start")).toBe(true);
		const ui = {
			setWorkingMessage: (text) => lines.push(text),
			setStatus: () => {},
		};
		await hooks.get("message_end")(usageEvent(1200, 300), mainCtx({ ui, hasUI: true }));
		expect(lines.length).toBeGreaterThan(0);
		expect(lastLine(lines)).toContain("Δ:");
		expect(lastLine(lines)).toContain("Σ:");
	});
});

afterAll(() => {
	clock?.restore?.();
});
