import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

let tool;
let waitTool;

beforeAll(async () => {
	globalThis.__pi = {
		tools: new Map(),
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
	};
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/bootstrap.cljs", import.meta.url)));
	await new Promise((resolve) => setTimeout(resolve, 150));
	tool = globalThis.__pi.tools.get("clj_devops");
	waitTool = globalThis.__pi.tools.get("wait");
});

let counter = 0;
function run(code) {
	counter += 1;
	return tool.execute(
		null,
		{ name: `case-${counter}`, code, ariadne_budget: 5, ariadne_goal: "test" },
		null,
	);
}

function runNamed(name, code) {
	return tool.execute(
		null,
		{ name, code, ariadne_budget: 5, ariadne_goal: "test" },
		null,
	);
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

	it("passes UFSS fences through the pre-pass", async () => {
		const result = await run('(count ##"abc"##)');
		expect(result.content[0].text).toContain(":value 3");
	});

	it("exposes the cat capability", async () => {
		const result = await run('(cat {:path "package.json"})');
		expect(result.content[0].text).toContain("herdchestra-lite");
	});

	it("executes through-write, stat, and file lifecycle in cljs", async () => {
		await run('(mkdir {:path "tmp/cljs-box"})');
		await run('(write {:path "tmp/cljs-box/sample.txt" :content "alpha-beta"})');
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
		const result = await run('(call {:argv ["echo" "hello-cljs-call"]})');
		expect(result.content[0].text).toContain(":exit 0");
		expect(result.content[0].text).toContain("hello-cljs-call");
	});

	it("parks ambiguous where and resumes with chosen span", async () => {
		await drain();
		const parked = await runNamed("ambig-case", '(where {:content "abcabc" :needle "ab"})');
		expect(parked.content[0].text).toContain(":state :parked");
		expect(parked.content[0].text).toContain(":candidates");

		const resumed = await runNamed("unpark-ambig", '(unpark {:name "ambig-case" :value [3 5]})');
		expect(resumed.content[0].text).toContain("[3 5]");

		const waited = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		expect(waited.content[0].text).toContain(":name \"ambig-case\"");
		expect(waited.content[0].text).toContain("[3 5]");
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
		expect(waited.content[0].text).toContain(":name \"park-case\"");
		expect(waited.content[0].text).toContain(":value 42");
	});

	it("returns idle when no program is running", async () => {
		const idle = await waitTool.execute(null, { otherwise_independent_work: "none" }, null);
		expect(idle.content[0].text).toContain(":state :idle");
	});
});
