import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

let tool;

beforeAll(async () => {
	globalThis.__pi = {
		tools: new Map(),
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
	};
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/main.cljs", import.meta.url)));
	tool = globalThis.__pi.tools.get("clj_devops");
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

	it("returns one exact where span", async () => {
		const result = await run('(where {:content "abcabc" :needle "ab"})');
		expect(result.content[0].text).toContain("[0 2]");
	});

	it("reports a failed program as an EDN error receipt", async () => {
		const result = await run("(unclosed");
		expect(result.content[0].text).toContain(":state :failed");
	});
});
