import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { loadLanguageDetector } from "../src/host/language-detect.mjs";
import { lockEndpointFor, shutdownIpcDaemon } from "../src/host/lock-daemon.mjs";
import { installFakeClock } from "./fake-clock.mjs";

let tool;
let waitTool;
let clock;

beforeAll(async () => {
	clock = installFakeClock();
	globalThis.__herdLockRoot = fileURLToPath(new URL("../tmp/herd-sandbox-lock", import.meta.url));
	globalThis.__herdNative = {
		getRunner: () => ({
			hasNativeTool: (name) => name === "read" || name === "write",
			invokeNativeTool: async (name, params) => {
				if (name === "read") return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
				await writeFile(params.path, params.content, "utf8");
				return { content: [] };
			},
		}),
	};
	class FakeText {
		constructor(text, x, y) {
			this.text = text;
			this.x = x;
			this.y = y;
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
		active: ["read", "bash", "board_finish", "clj_devops", "wait"],
		pi: { Text: FakeText, Container: FakeContainer },
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
		on(name, handler) {
			if (!this.hooks.has(name)) this.hooks.set(name, handler);
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
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/bootstrap.cljs", import.meta.url)));
	const start = globalThis.__pi.hooks.get("session_start");
	if (start) start({}, {});
	tool = globalThis.__pi.tools.get("clj_devops");
	waitTool = globalThis.__pi.tools.get("wait");
});

beforeEach(() => {
	clock.reset();
});

afterAll(async () => {
	await shutdownIpcDaemon(lockEndpointFor(fileURLToPath(new URL("../tmp/herd-sandbox-lock", import.meta.url))));
});

describe("CLJS host wiring", () => {
	it("injects repo-aware rules once", async () => {
		const handler = globalThis.__pi.hooks.get("before_agent_start");
		expect(handler).toBeDefined();
		const first = await handler({ systemPrompt: "base" }, {});
		expect(first.systemPrompt).toContain("# Repo-aware Rules");
		const second = await handler({ systemPrompt: first.systemPrompt }, {});
		expect(second.systemPrompt).toBe(first.systemPrompt);
	});

	it("appends the outbound language and parked reminder", async () => {
		const handler = await nbb.loadString("herd.main/context-handler");
		const result = handler({ messages: [{ role: "user", content: "x" }] }, {});
		expect(result.messages).toHaveLength(2);
		const text = result.messages[1].content[0].text;
		expect(text).toContain("强制以简体中文");
		expect(text).toContain("<system-reminder>");
		await nbb.loadString('(require \'[herd.repl :as r]) (swap! r/programs assoc "probe-parked" {:state :parked})');
		const parked = handler({ messages: [{ role: "user", content: "x" }] }, {});
		expect(parked.messages[1].content[0].text).toContain("停靠程序");
		await nbb.loadString('(require \'[herd.repl :as r]) (swap! r/programs dissoc "probe-parked")');
	});

	it("injects one managed prompt block into array prompts", async () => {
		const handler = globalThis.__pi.hooks.get("before_agent_start");
		const first = await handler({ systemPrompt: ["base"] }, {});
		expect(Array.isArray(first.systemPrompt)).toBe(true);
		expect(first.systemPrompt.every((part) => typeof part === "string")).toBe(true);
		const text = first.systemPrompt.join("\n");
		expect(text).toContain("<!-- herdchestra:system-prompt v1 -->");
		const second = await handler({ systemPrompt: first.systemPrompt }, {});
		expect(second.systemPrompt).toEqual(first.systemPrompt);
	});

	it("replaces an existing managed prompt region", async () => {
		const handler = globalThis.__pi.hooks.get("before_agent_start");
		const start = "<!-- herdchestra:system-prompt v1 -->";
		const end = "<!-- /herdchestra:system-prompt -->";
		const prompt = start + "\nold rules\n" + end + "\n\nbase";
		const out = await handler({ systemPrompt: prompt }, {});
		expect(out.systemPrompt.split(start)).toHaveLength(2);
		expect(out.systemPrompt).not.toContain("old rules");
		expect(out.systemPrompt).toContain("base");
	});

	it("drops host edit/shell tools in the devops surface", async () => {
		const start = globalThis.__pi.hooks.get("session_start");
		await start({}, { cwd: process.cwd(), hasUI: false, agent: { id: "main-session" } });
		expect(globalThis.__pi.active).toContain("board_finish");
		expect(globalThis.__pi.active).toContain("clj_devops");
		expect(globalThis.__pi.active).toContain("wait");
		expect(globalThis.__pi.active).toContain("handoff");
		expect(globalThis.__pi.active).not.toContain("read");
		expect(globalThis.__pi.active).not.toContain("bash");
	});

	it("requires a self-reported control-flow state and no scope", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		expect(definition.parameters.required).toContain("agent_state");
		expect(definition.parameters.required).not.toContain("scope");
		expect(definition.parameters.properties.scope).toBeUndefined();
		expect(definition.parameters.properties.agent_state.enum).toEqual([
			"Orienting",
			"Converging",
			"Consolidating",
			"Stagnant",
			"Drifting",
			"Densifying",
			"Reorienting",
			"Settled",
		]);
	});

	it("does not force tool output expansion at session start", () => {
		const calls = [];
		const start = globalThis.__pi.hooks.get("session_start");
		start(
			{},
			{
				hasUI: true,
				ui: {
					setToolsExpanded: (value) => calls.push(value),
					setStatus: () => {},
					setWorkingMessage: () => {},
				},
			},
		);
		expect(calls).toEqual([]);
	});

	it("renders clj_devops call with humanized title", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "read-ufss-state",
				agent_state: "Converging",
				code: "(let [x 1](+ x 1))",
			},
			{ expanded: true },
			{ fg: (role, text) => (role.startsWith("syntax") || role === "accent" ? text : `${role}:${text}`) },
		);
		expect(call.children).toHaveLength(3);
		expect(call.children[0].text).toBe("Read Ufss State dim:--- [稳定收敛]");
		expect(call.children[1].render(10)).toEqual(["dim:" + "─".repeat(10)]);
		expect(call.children[2].text).toBe("(let [x 1] (+ x 1))");
	});

	it("renders Chinese labels for every agent state", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const expected = {
			Orienting: "探索定向",
			Converging: "稳定收敛",
			Consolidating: "固结沉淀",
			Stagnant: "局部停滞",
			Drifting: "目标漂移",
			Densifying: "细节致密",
			Reorienting: "回溯重整",
			Settled: "完全收敛",
		};
		for (const [state, label] of Object.entries(expected)) {
			const call = definition.renderCall(
				{ name: "state-case", agent_state: state, code: "1" },
				{ expanded: true },
				{ fg: (role, text) => (role === "accent" ? text : `${role}:${text}`) },
			);
			expect(call.children[0].text).toBe(`State Case dim:--- [${label}]`);
		}
	});

	it("collapses UFSS strings to dim $$$ in call previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "collapsed-call",
				agent_state: "Converging",
				code: '(println "secret-value-that-is-longer-than-forty-characters")',
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children).toHaveLength(3);
		expect(call.children[1].render(10)).toEqual(["dim:" + "─".repeat(10)]);
		expect(call.children[2].text).toContain("dim:$$$");
		expect(call.children[2].text).not.toContain("secret-value-that-is-longer-than-forty-characters");
	});

	it("collapses short multiline strings to dim $$$ in previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "multiline-short",
				agent_state: "Converging",
				code: `(println "a
b")`,
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children[2].text).toContain("dim:$$$");
	});

	it("collapses short multiline strings in result previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const result = definition.renderResult(
			{
				content: [
					{
						type: "text",
						text: `{:value "a
b"}`,
					},
				],
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(result.children[1].text).toContain("dim:$$$");
	});

	it("collapses UFSS fence bodies to dim $$$ in previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "collapsed-fence",
				agent_state: "Converging",
				code: '(println ##"secret-value-that-is-longer-than-forty-characters"##)',
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children).toHaveLength(3);
		expect(call.children[1].render(10)).toEqual(["dim:" + "─".repeat(10)]);
		expect(call.children[2].text).toContain("dim:$$$");
		expect(call.children[2].text).not.toContain("secret-value-that-is-longer-than-forty-characters");
	});

	it("keeps text after $$$ when the collapsed call wraps", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "wrapped-after",
				agent_state: "Converging",
				code: '(let [x "secret-value-that-is-longer-than-forty-characters"]\n  (println x :after))',
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children).toHaveLength(3);
		expect(call.children[2].text).toContain("dim:$$$");
		expect(call.children[2].text).toContain(":after");
		expect(call.children[2].text).toContain("\n");
	});

	it("keeps text after $$$ when the collapsed result wraps", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const result = definition.renderResult(
			{
				content: [
					{
						type: "text",
						text: '{:name "secret-value-that-is-longer-than-forty-characters"\n :state :failed\n :ok true}',
					},
				],
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(result.children).toHaveLength(2);
		expect(result.children[1].text).toContain("dim:$$$");
		expect(result.children[1].text).toContain(":state");
		expect(result.children[1].text).toContain("\n");
	});

	it("keeps short single-line strings visible in collapsed previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "short-collapsed-call",
				agent_state: "Converging",
				code: '(println "short-value")',
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children[2].text).toContain("short-value");
		expect(call.children[2].text).not.toContain("$$");
	});

	it("keeps 40-character strings and collapses 41-character strings", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const theme = { fg: (role, text) => `${role}:${text}` };
		const forty = "x".repeat(40);
		const fortyOne = "x".repeat(41);
		const shortCall = definition.renderCall(
			{ name: "forty", agent_state: "Converging", code: `(println "${forty}")` },
			{ expanded: false },
			theme,
		);
		expect(shortCall.children[2].text).toContain(forty);
		expect(shortCall.children[2].text).not.toContain("$$");
		const longCall = definition.renderCall(
			{ name: "forty-one", agent_state: "Converging", code: `(println "${fortyOne}")` },
			{ expanded: false },
			theme,
		);
		expect(longCall.children[2].text).toContain("dim:$$");
		expect(longCall.children[2].text).not.toContain(fortyOne);
	});

	it("keeps short single-line fence strings visible", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "short-fence",
				agent_state: "Converging",
				code: '(println ##"short-raw-value"##)',
			},
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children[2].text).toContain("short-raw-value");
		expect(call.children[2].text).not.toContain("$$");
	});
	it("keeps UFSS strings visible in expanded call previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const call = definition.renderCall(
			{
				name: "expanded-call",
				agent_state: "Converging",
				code: '(println "secret-value-that-is-longer-than-forty-characters")',
			},
			{ expanded: true },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(call.children[2].text).toContain("secret-value-that-is-longer-than-forty-characters");
	});

	it("collapses UFSS strings to dim $$$ in result previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const result = definition.renderResult(
			{ content: [{ type: "text", text: '{:value "secret-value-that-is-longer-than-forty-characters"}' }] },
			{ expanded: false },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(result.children).toHaveLength(2);
		expect(result.children[0].render(10)).toEqual(["dim:" + "─".repeat(10)]);
		expect(result.children[1].text).toContain("dim:$$$");
		expect(result.children[1].text).not.toContain("secret-value-that-is-longer-than-forty-characters");
	});

	it("keeps UFSS strings visible in expanded result previews", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const result = definition.renderResult(
			{ content: [{ type: "text", text: '{:value "secret-value-that-is-longer-than-forty-characters"}' }] },
			{ expanded: true },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(result.children[1].text).toContain("secret-value-that-is-longer-than-forty-characters");
	});

	it("highlights Clojure with keywords and rainbow delimiters", async () => {
		const out = await nbb.loadString(`
			(require '[herd.ufss :as u] '[herd.highlight :as h])
			(let [hl (h/make-highlighter #js {:fg (fn [role text] (str role ":" text))})]
			  (u/canonical "(a [b])" hl))`);
		expect(out).toContain("syntaxKeyword:(");
		expect(out).toContain("syntaxFunction:[");
	});

	it("re-fences UFSS strings with dim fences and body highlighting", async () => {
		const out = await nbb.loadString(`
			(require '[herd.ufss :as u] '[herd.highlight :as h])
			(let [hl (h/make-highlighter #js {:fg (fn [role text] (str role ":" text))})]
			  (u/canonical "(println ##\\"a\\"b\\"##)" hl))`);
		expect(out).toContain('dim:#"');
		expect(out).toContain('dim:"#');
		expect(out).toContain('a"b');
	});

	it("auto-highlights standard-string bodies", async () => {
		const out = await nbb.loadString(`
			(require '[herd.ufss :as u] '[herd.highlight])
			(let [detect (ns-resolve 'herd.highlight 'detect-language)
			      esc (fn [code text] (str (char 27) "[" code "m" text (char 27) "[0m"))
			      hl (fn [text lang]
			           (cond
			             (= lang :dim) (esc "2" text)
			             (nil? lang) (if (= "clojure" ((deref detect) text))
			                           (esc "35" text)
			                           text)
			             :else (esc "36" text)))]
			  (u/wrap (str "(println " (pr-str "(+ 1 2)") ")") hl))`);
		const esc = String.fromCharCode(27);
		expect(out).toContain(`${esc}[35m 1 2`);
	});

	it("auto-detects javascript bodies", async () => {
		const out = await nbb.loadString(`
			(require '[herd.highlight])
			(let [detect (ns-resolve 'herd.highlight 'detect-language)]
			  (detect (str "import x from " (pr-str "y") "; " "const z = 1;")))`);
		expect(out).toBe("javascript");
	});

	it("auto-highlights javascript result bodies", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const previous = globalThis.__herdTui.highlightCode;
		const seen = [];
		globalThis.__herdTui.highlightCode = (text, lang) => {
			seen.push(lang);
			return [`\u001b[36m${text}\u001b[0m`];
		};
		try {
			const result = definition.renderResult(
				{ content: [{ type: "text", text: ' {:value "import x from \\"y\\"; const z = 1;"}' }] },
				{ expanded: true },
				{ fg: (_role, text) => text },
			);
			expect(seen).toContain("javascript");
			expect(result.children[1].text).toContain("\u001b[36m");
		} finally {
			globalThis.__herdTui.highlightCode = previous;
		}
	});

	it("secondary rainbow inherits outer depth", async () => {
		const out = await nbb.loadString(`
			(require '[herd.ufss :as u])
			(let [esc (fn [code text] (str (char 27) "[" code "m" text (char 27) "[0m"))
			      hl (fn [text lang]
			           (cond
			             (= lang :dim) (esc "2" text)
			             (vector? lang) (let [depth (second lang)] (esc (str (+ 30 depth)) text))
			             :else (esc "36" text)))]
			  (u/wrap (str "(println " (pr-str "(+ 1 2)") ")") hl))`);
		const esc = String.fromCharCode(27);
		expect(out).toContain(`${esc}[31m(`);
	});

	it("highlights list verbs with accent", async () => {
		const out = await nbb.loadString(`
			(require '[herd.ufss :as u])
			(let [esc (fn [code text] (str (char 27) "[" code "m" text (char 27) "[0m"))
			      hl (fn [text lang]
			           (cond
			             (= lang :accent) (esc "33" text)
			             (= lang :dim) (esc "2" text)
			             (vector? lang) (esc "36" text)
			             :else text))]
			  (u/wrap "(let [x 1] (+ x 1))" hl))`);
		const esc = String.fromCharCode(27);
		expect(out).toContain(`${esc}[33mlet`);
		expect(out).toContain(`${esc}[33m+`);
	});

	it("highlights result output with the same highlighter", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const previous = globalThis.__herdTui.highlightCode;
		globalThis.__herdTui.highlightCode = (text) => [`\u001b[36m${text}\u001b[0m`];
		try {
			const result = definition.renderResult(
				{ content: [{ type: "text", text: ' {:path "x"}' }] },
				{ expanded: true },
				{ fg: (role, text) => `${role}:${text}` },
			);
			expect(result.children[1].text).toContain("\u001b[36m");
		} finally {
			globalThis.__herdTui.highlightCode = previous;
		}
	});

	it("skips syntax highlighting for large collapsed tool results", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		let calls = 0;
		const original = globalThis.__herdTui.highlightCode;
		globalThis.__herdTui.highlightCode = (code) => {
			calls += 1;
			return code.split("\n");
		};
		try {
			const text = "x".repeat(9000);
			const result = definition.renderResult(
				{ content: [{ type: "text", text }] },
				{ expanded: false },
				{ fg: (_role, value) => value },
			);
			expect(result.children).toHaveLength(2);
			expect(calls).toBe(0);
		} finally {
			globalThis.__herdTui.highlightCode = original;
		}
	});

	it("renders a horizontal rule before clj_devops output", () => {
		const definition = globalThis.__pi.tools.get("clj_devops");
		const result = definition.renderResult(
			{ content: [{ type: "text", text: "output" }] },
			{ expanded: true },
			{ fg: (role, text) => `${role}:${text}` },
		);
		expect(result.children).toHaveLength(2);
		expect(result.children[0].render(10)).toEqual(["dim:" + "─".repeat(10)]);
		expect(result.children[1].text).toBe("output");
	});
});

let counter = 0;
async function waitForName(name) {
	for (;;) {
		const waited = await waitTool.execute(null, { otherwise_independent_work: "x".repeat(1000) }, null);
		const text = waited.content[0].text;
		if (text.includes(`:name "${name}"`) || text.includes(":state :idle") || text.includes(":state :parked")) {
			return waited;
		}
	}
}

async function run(code) {
	counter += 1;
	const name = `case-${counter}`;
	const first = await tool.execute(null, { name, code, agent_state: "Converging" }, null);
	if (!first.content[0].text.includes(":state :forked")) return first;
	return waitForName(name);
}

function runNamed(name, code) {
	return tool.execute(null, { name, code, agent_state: "Converging" }, null);
}

async function drain() {
	for (;;) {
		const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		if (waited.content[0].text.includes(":state :idle")) return;
	}
}

describe("CLJS nbb sandbox", () => {
	it("returns an EDN receipt with the completed value", async () => {
		const result = await run("(+ 1 2)");
		const text = result.content[0].text;
		expect(text).toContain(":state :completed");
		expect(text).toContain(":value 3");
	});

	it("prepends the Orienting comment with all three masters", async () => {
		const result = await tool.execute(
			null,
			{
				name: "orienting-comment",
				code: "(+ 1 2)",
				agent_state: "Orienting",
			},
			null,
		);
		const text = result.content[0].text;
		expect(text.startsWith("; Karl Popper's piecemeal engineering and falsification")).toBe(true);
		expect(text).toContain("Herbert Simon's bounded rationality and satisficing");
		expect(text).toContain("Friedrich Hayek's respect for local, dispersed knowledge");
		expect(text).toContain("Let reality correct you before you re-orient.");
		expect(text).toContain(":value 3");
	});

	it("uses the finalized comment for every non-Orienting state", async () => {
		const handoffStates = new Set(["Stagnant", "Drifting", "Densifying"]);
		const expected = {
			Converging: "; Stop hedging: Søren Aabye Kierkegaard's commitment",
			Consolidating: "; Do not treat a gain as a victory lap: Imre Lakatos's progressive research programme",
			Stagnant: "; Do not hibernate in a loop: Mary Parker Follett's integrative authority",
			Drifting: "; Do not confuse effort with relevance: Charles Sanders Peirce's pragmatic maxim",
			Densifying: "; Offload, do not hoard: Daniel Kahneman's attention budget",
			Reorienting: "; Keep the lesson and drop the scoreboard: Gaston Bachelard's epistemological obstacle",
			Settled: "; Do not endure for endurance's sake: Aristotle's telos",
		};
		for (const [state, prefix] of Object.entries(expected)) {
			const result = await tool.execute(null, { name: `comment-${state}`, code: "(+ 1 2)", agent_state: state }, null);
			const text = result.content[0].text;
			expect(text.startsWith(prefix)).toBe(true);
			expect(text).not.toContain("; TODO:");
			if (handoffStates.has(state)) {
				expect(text).toContain("Use the handoff tool. I mean it.");
			} else {
				expect(text).not.toContain("Use the handoff tool.");
			}
		}
	});

	it("emits the comment only on state transitions", async () => {
		const ctx = { agent: { id: "state-transition-test" } };
		const first = await tool.execute(
			null,
			{ name: "transition-first", code: "(+ 1 2)", agent_state: "Orienting" },
			null,
			null,
			ctx,
		);
		const second = await tool.execute(
			null,
			{ name: "transition-second", code: "(+ 1 2)", agent_state: "Orienting" },
			null,
			null,
			ctx,
		);
		const third = await tool.execute(
			null,
			{ name: "transition-third", code: "(+ 1 2)", agent_state: "Converging" },
			null,
			null,
			ctx,
		);
		expect(first.content[0].text.startsWith("; Karl Popper's")).toBe(true);
		expect(second.content[0].text.startsWith("; ")).toBe(false);
		expect(third.content[0].text.startsWith("; Stop hedging:")).toBe(true);
	});

	it("rejects an unknown agent state", async () => {
		const result = await tool.execute(
			null,
			{
				name: "bad-agent-state",
				code: "1",
				agent_state: "Confused",
			},
			null,
		);
		expect(result.content[0].text).toContain("INVALID_ARGUMENT");
	});

	it("replays the same call id and rejects a changed payload", async () => {
		const params = {
			name: "replay-case",
			code: "(js/Date.now)",
			agent_state: "Converging",
		};
		const first = await tool.execute("call-replay-1", params, null);
		const second = await tool.execute("call-replay-1", params, null);
		expect(second.content[0].text).toBe(first.content[0].text);
		const mismatch = await tool.execute("call-replay-1", { ...params, code: "(+ 1 2)" }, null);
		expect(mismatch.content[0].text).toContain("CALL_REPLAY_MISMATCH");
	});

	it("passes UFSS fences through the pre-pass", async () => {
		const result = await run('(count ##"abc"##)');
		expect(result.content[0].text).toContain(":value 3");
	});

	it("exposes the cat capability", async () => {
		const result = await run('(cat {:path "package.json"})');
		expect(result.content[0].text).toContain("herdchestra-lite");
	});

	it("loads promesa from top-level user code", async () => {
		const result = await run(
			`(require '[promesa.core :as p])
       (p/let [s (stat {:path "package.json"})] (:size s))`,
		);
		const text = result.content[0].text;
		expect(text).toContain(":state :completed");
		expect(text).toContain(":value");
	});

	it("loads clojure.string from top-level user code", async () => {
		const result = await run(
			`(require '[clojure.string :as str])
       [(str "a" "b") (str/replace "abc" "b" "X")]`,
		);
		const text = result.content[0].text;
		expect(text).toContain('"ab"');
		expect(text).toContain('"aXc"');
	});

	it("keeps the host alive when a capability rejection is ignored", async () => {
		const result = await run('(do (where {:content 42 :needle "x"}) 42)');
		expect(result.content[0].text).toContain(":state");
	});

	it("runs serial writes through p/loop", async () => {
		const result = await run(
			`(require '[promesa.core :as p])
       (p/loop [xs [1 2] acc []] (if (seq xs) (p/let [_ (write {:path (str "tmp/p-loop-" (first xs) ".txt") :content "x"})] (p/recur (next xs) (conj acc (first xs)))) acc))`,
		);
		const text = result.content[0].text;
		expect(text).toContain(":state :completed");
		expect(text).toContain("[1 2]");
	});

	it("allows concurrent writes through the write gate", async () => {
		// The fake clock cannot drive the real lock retry loop; use real timers for this case.
		const fake = globalThis.__herdClock;
		delete globalThis.__herdClock;
		try {
			const result = await run(
				`(require '[promesa.core :as p])
         (p/all [(write {:path "tmp/concurrent-a.txt" :content "a"}) (write {:path "tmp/concurrent-b.txt" :content "b"})])`,
			);
			const text = result.content[0].text;
			expect(text).toContain(":state :completed");
			expect(text).toContain(":value");
		} finally {
			globalThis.__herdClock = fake;
		}
	});

	it("rejects a cat above the 2 MiB limit", async () => {
		await run('(mkdir {:path "tmp/cljs-box"})');
		await writeFile(
			fileURLToPath(new URL("../tmp/cljs-box/big.txt", import.meta.url)),
			"x".repeat(2 * 1024 * 1024 + 1),
		);
		const before = clock.now();
		const result = await run('(cat {:path "tmp/cljs-box/big.txt"})');
		expect(clock.now()).toBe(before);
		expect(result.content[0].text).toContain(":LIMIT_EXCEEDED");
	});

	it("skips dependency trees and rejects an over-limit glob", async () => {
		await run('(mkdir {:path "tmp/glob-box/node_modules/pkg"})');
		await run('(write {:path "tmp/glob-box/keep.txt" :content "x"})');
		await run('(write {:path "tmp/glob-box/other.txt" :content "x"})');
		await run('(write {:path "tmp/glob-box/node_modules/pkg/dep.js" :content "x"})');
		const before = clock.now();
		const skipped = await run('(glob {:path "tmp/glob-box" :pattern "*" :exec (fn [entry] entry)})');
		expect(skipped.content[0].text).toContain("keep.txt");
		expect(skipped.content[0].text).not.toContain("dep.js");
		const limited = await run('(glob {:path "tmp/glob-box" :pattern "*" :limit 1 :exec (fn [entry] entry)})');
		expect(clock.now()).toBe(before);
		expect(limited.content[0].text).toContain(":LIMIT_EXCEEDED");
	});

	it("parks a zero-match where with the nearest line", async () => {
		const before = clock.now();
		const result = await runNamed("zero-match", '(where {:content "alpha\\nbeta" :needle "gamma"})');
		expect(clock.now()).toBe(before);
		expect(result.content[0].text).toContain(":state :parked");
		expect(result.content[0].text).toContain(":nearest");
	});

	it("executes through-write, stat, and file lifecycle in cljs", async () => {
		const m = await run('(mkdir {:path "tmp/cljs-box"})');
		expect(m.content[0].text).toContain(":state :completed");
		const w = await run('(write {:path "tmp/cljs-box/sample.txt" :content "alpha-beta"})');
		expect(w.content[0].text).toContain(":state :completed");
		const c = await run('(cat {:path "tmp/cljs-box/sample.txt"})');
		expect(c.content[0].text).toContain("alpha-beta");
		const s = await run('(stat {:path "tmp/cljs-box/sample.txt"})');
		expect(s.content[0].text).toContain(":exists true");
		expect(s.content[0].text).toContain(":size 10");
		await run('(mv {:source "tmp/cljs-box/sample.txt" :target "tmp/cljs-box/renamed.txt"})');
		const l = await run('(ls {:path "tmp/cljs-box"})');
		expect(l.content[0].text).toContain("renamed.txt");
		await run('(rm {:path "tmp/cljs-box"})');
		const sAfter = await run('(stat {:path "tmp/cljs-box/renamed.txt"})');
		expect(sAfter.content[0].text).toContain(":exists false");
	});

	it("returns one exact where span", async () => {
		const result = await run('(where {:content "abc" :needle "ab"})');
		expect(result.content[0].text).toContain("[0 2]");
	});

	it("executes blackbox call through child process", async () => {
		await drain();
		const result = await run('(call {:argv ["echo" "hello-cljs-call"]})');
		let text = result.content[0].text;
		if (text.includes(":forked")) {
			const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
			text = waited.content[0].text;
		}
		expect(text).toContain(":exit 0");
		expect(text).toContain("hello-cljs-call");
	});

	it("parks ambiguous where and resumes with chosen span", async () => {
		await drain();
		const parked = await runNamed("ambig-case", '(where {:content "abcabc" :needle "ab"})');
		expect(parked.content[0].text).toContain(":state :parked");
		expect(parked.content[0].text).toContain(":candidates");

		const resumed = await runNamed("unpark-ambig", '(unpark {:name "ambig-case" :value [3 5]})');
		expect(resumed.content[0].text).toContain("[3 5]");

		const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		expect(waited.content[0].text).toContain(":state :idle");
	});

	it("reports a failed program as an EDN error receipt", async () => {
		const result = await run("(unclosed");
		expect(result.content[0].text).toContain(":state :failed");
	});

	it("parks, resumes, and collects the result with wait", async () => {
		await drain();
		const parked = await runNamed("park-case", "(park {:payload 1})");
		expect(parked.content[0].text).toContain(":state :parked");

		const resumed = await runNamed("resume-case", '(unpark {:name "park-case" :value 42})');
		expect(resumed.content[0].text).toContain(":value 42");

		const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		expect(waited.content[0].text).toContain(":state :idle");
	});

	it("parks with incremental call output and unpark feeds stdin", async () => {
		await drain();
		const pending = runNamed(
			"stream-case",
			`(let [p (call {:argv ["sh" "-c" "printf first; read x; printf got:%s $x; printf done"] :name "stream-case"} 0)]
  (-> (herd.sandbox/await-call-start "stream-case")
      (.then (fn [_] (herd.sandbox/await-call-output "stream-case" "first")))
      (.then (fn [_] (park {:payload 1})))
      (.then (fn [_] p))))`,
		);
		const parked = await pending;
		expect(parked.content[0].text).toContain(":state :parked");
		expect(parked.content[0].text).toContain(":call-active true");
		expect(parked.content[0].text).toContain("first");

		const resumed = await runNamed("resume-stream", `(unpark {:name "stream-case" :value (str "hello" (char 10))})`);
		expect(resumed.content[0].text).toContain(":state :completed");
		expect(resumed.content[0].text).toContain("got:hello");
		expect(resumed.content[0].text).toContain("done");
		await drain();
	});

	it("returns idle when no program is running", async () => {
		const idle = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		expect(idle.content[0].text).toContain(":state :idle");
	});

	it("isolates concurrent p/let programs without false DANGLING_PROMISE", async () => {
		await drain();
		const codeA = `(require '[promesa.core :as p])
(p/let [a (ls {:path "src"})
        b (cat {:path "package.json"})
        c (ls {:path "tests"})]
  {:a (:exists a) :b (pos? (count b)) :c (:exists c)})`;
		const codeB = `(require '[promesa.core :as p])
(p/let [x (cat {:path "src/herd/sandbox.cljs"})
        y (ls {:path "src/herd"})]
  {:x (pos? (count x)) :y (:exists y)})`;
		for (let i = 0; i < 10; i++) {
			const [resA, resB] = await Promise.all([
				runNamed(`concurrent-a-${i}`, codeA),
				runNamed(`concurrent-b-${i}`, codeB),
			]);
			expect(resA.content[0].text).toContain(":state :completed");
			expect(resB.content[0].text).toContain(":state :completed");
		}
		await drain();
	});

	it("still catches genuine dangling promises within a single program", async () => {
		await drain();
		const result = await runNamed(
			"genuine-dangling",
			`(require '[promesa.core :as p])
       (p/race [(js/Promise.resolve :fast) (call {:argv ["sh" "-c" "sleep 0.1"]})])`,
		);
		expect(result.content[0].text).toContain(":state :failed");
		expect(result.content[0].text).toContain(":DANGLING_PROMISE");
		await drain();
	});

	it("strips BUN_OPTIONS and host preload env vars from call subprocesses", async () => {
		await drain();
		const prev = process.env.BUN_OPTIONS;
		process.env.BUN_OPTIONS = "--preload /tmp/nonexistent-preload.js";
		try {
			const result = await run('(call {:argv ["sh" "-c" "printenv BUN_OPTIONS || printf unset"]})');
			let text = result.content[0].text;
			if (text.includes(":forked")) {
				const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
				text = waited.content[0].text;
			}
			expect(text).toContain(":exit 0");
			expect(text).toContain("unset");
			expect(text).not.toContain("nonexistent-preload");
		} finally {
			if (prev === undefined) delete process.env.BUN_OPTIONS;
			else process.env.BUN_OPTIONS = prev;
		}
	});

	it("appends the Brooks worker reminder when more_workers is positive and omits it at zero", async () => {
		await drain();
		expect(tool.parameters.properties.more_workers_without_hitting_mythical_man_month.description).toContain("Brooks");
		expect(waitTool.parameters.properties.more_workers_without_hitting_mythical_man_month.description).toContain(
			"Brooks",
		);

		const positive = await tool.execute(
			null,
			{
				name: "workers-pos",
				code: "(+ 1 1)",
				agent_state: "Converging",
				more_workers_without_hitting_mythical_man_month: 2,
			},
			null,
		);
		expect(positive.content[0].text).toContain("你刚刚在工具参数中说还可以增派 2 个工人，现在请你立刻兑现。");

		const zero = await tool.execute(
			null,
			{
				name: "workers-zero",
				code: "(+ 1 1)",
				agent_state: "Converging",
				more_workers_without_hitting_mythical_man_month: 0,
			},
			null,
		);
		expect(zero.content[0].text).not.toContain("你刚刚在工具参数中说还可以增派");

		const waited = await waitTool.execute(
			null,
			{
				otherwise_independent_work: "none",
				more_workers_without_hitting_mythical_man_month: 3,
			},
			null,
		);
		expect(waited.content[0].text).toContain("你刚刚在工具参数中说还可以增派 3 个工人，现在请你立刻兑现。");
	});

	it("does not replay previously completed or failed synchronous calls on a later wait", async () => {
		await drain();
		const syncOk = await runNamed("sync-ok-first", "(+ 10 20)");
		expect(syncOk.content[0].text).toContain(":value 30");
		const syncErr = await runNamed("sync-err-second", "(unclosed");
		expect(syncErr.content[0].text).toContain(":state :failed");

		const idleBeforeFork = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		expect(idleBeforeFork.content[0].text).toContain(":state :idle");

		const pendingFork = runNamed("slow-forked-call", '(call {:argv ["sh" "-c" "sleep 0.15; printf forked-done"]})');
		await nbb.loadString('(herd.sandbox/await-call-start "slow-forked-call")');
		clock.advance(2000);
		const forked = await pendingFork;
		expect(forked.content[0].text).toContain(":state :forked");

		const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		const text = waited.content[0].text;
		expect(text).toContain(':name "slow-forked-call"');
		expect(text).toContain("forked-done");
		expect(text).not.toContain("sync-ok-first");
		expect(text).not.toContain("sync-err-second");
	});
	it("matches zero-depth directories with **/ in glob", async () => {
		await run('(mkdir {:path "tmp/glob-zero/sub"})');
		await run('(write {:path "tmp/glob-zero/root.txt" :content "r"})');
		await run('(write {:path "tmp/glob-zero/sub/deep.txt" :content "d"})');
		try {
			const res = await run('(glob {:path "tmp/glob-zero" :pattern "**/*.txt" :exec (fn [p] p)})');
			const text = res.content[0].text;
			expect(text).toContain("root.txt");
			expect(text).toContain("sub/deep.txt");
		} finally {
			await run('(rm {:path "tmp/glob-zero"})');
		}
	});

	it("supports :eof and :stdin on call without hanging stdin-reading commands", async () => {
		await drain();
		const eofRes = await run('(call {:argv ["sh" "-c" "cat"] :eof true})');
		expect(eofRes.content[0].text).toContain(":exit 0");
		expect(eofRes.content[0].text).toContain(':stdout ""');

		const stdinRes = await run('(call {:argv ["sh" "-c" "cat"] :stdin "hello-stdin"})');
		expect(stdinRes.content[0].text).toContain(":exit 0");
		expect(stdinRes.content[0].text).toContain("hello-stdin");

		const parked = await runNamed(
			"stdin-open-check",
			`(let [p (call {:argv ["sh" "-c" "sleep 0.2"] :name "stdin-open-check"} 0)]
  (-> (herd.sandbox/await-call-start "stdin-open-check")
      (.then (fn [_] (park {:payload 1})))
      (.then (fn [_] p))))`,
		);
		expect(parked.content[0].text).toContain(":stdin-open true");
		await runNamed("stdin-open-abandon", '(abandon {:name "stdin-open-check"})');
		await drain();
	});
});
