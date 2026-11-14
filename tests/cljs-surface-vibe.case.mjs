import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { ensureActivated } from "./helpers/nbb-boot.mjs";

const here = (path) => fileURLToPath(new URL("../" + path, import.meta.url));

const makePi = (active) => {
	const calls = [];
	const pi = {
		calls,
		active: [...active],
		tools: new Map(),
		registerTool(definition) {
			pi.tools.set(definition.name, definition);
		},
		registerCommand() {},
		on() {},
		getActiveTools() {
			return [...pi.active];
		},
		setActiveTools(next) {
			calls.push([...next]);
			pi.active = [...next];
			return Promise.resolve(null);
		},
	};
	return pi;
};

const ctxFor = (id) => ({ agent: { id }, hasUI: false });

let applySurface;

beforeAll(async () => {
	globalThis.__herdLockRoot = here("tmp/herd-surface-vibe-lock");
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
	const boot = makePi([]);
	boot.pi = { Text: FakeText, Container: FakeContainer };
	globalThis.__pi = boot;
	globalThis.__herdTui = { highlightCode: (code) => code };
	await ensureActivated();
	applySurface = await nbb.loadString("(var-get (resolve (quote herd.main/apply-tool-surface!)))");
});

describe("vibe tool surface", () => {
	it("drops host edit/shell tools and keeps the devops tools", async () => {
		const pi = makePi(["bash", "read", "write", "debug"]);
		globalThis.__pi = pi;
		await applySurface(ctxFor("vibe-append"));
		expect(pi.calls.length).toBe(1);
		expect(new Set(pi.active)).toEqual(new Set(["debug", "clj_devops", "wait", "handoff"]));
		expect(pi.active).not.toContain("bash");
		expect(pi.active).not.toContain("read");
		expect(pi.active).not.toContain("write");
	});

	it("drops host edit/shell tools even when herd tools are missing", async () => {
		const pi = makePi(["bash", "read"]);
		globalThis.__pi = pi;
		await applySurface(ctxFor("vibe-idempotent"));
		expect(pi.calls.length).toBe(1);
		expect(new Set(pi.active)).toEqual(new Set(["clj_devops", "wait", "handoff"]));
	});

	it("never touches the /vibe main agent surface", async () => {
		const pi = makePi(["bash", "read", "write", "debug", "vibe_spawn"]);
		globalThis.__pi = pi;
		await applySurface({ agent: { id: "vibe-main" }, hasUI: true, mode: "vibe" });
		expect(pi.calls.length).toBe(1);
		expect(new Set(pi.active)).toEqual(new Set(["debug", "vibe_spawn", "clj_devops", "wait", "handoff"]));
		expect(pi.active).not.toContain("bash");
	});
	it("lets the mission surface take over without appending", async () => {
		const pi = makePi(["bash", "read", "write", "debug", "clj_devops", "wait"]);
		globalThis.__pi = pi;
		const id = "vibe-mission";
		await nbb.loadString(
			"(swap! (var-get (resolve (quote herd.system/state))) update-in [:sessions " +
				JSON.stringify(id) +
				"] assoc :slug " +
				JSON.stringify("surface-probe") +
				" :stage :s1)",
		);
		await applySurface(ctxFor(id));
		expect(pi.calls.length).toBeGreaterThan(0);
		expect(pi.active).toEqual(["clj_plan", "review", "attach_brainstorm", "ask_user", "devops"]);
		expect(pi.active).not.toContain("bash");
		expect(pi.active).not.toContain("clj_devops");
	});

	it("swallows read and write failures", async () => {
		const readPi = makePi(["bash"]);
		readPi.getActiveTools = () => {
			throw new Error("getActiveTools unavailable");
		};
		globalThis.__pi = readPi;
		expect(() => applySurface(ctxFor("vibe-fail-read"))).not.toThrow();
		const writePi = makePi(["bash"]);
		writePi.setActiveTools = () => {
			throw new Error("setActiveTools unavailable");
		};
		globalThis.__pi = writePi;
		expect(() => applySurface(ctxFor("vibe-fail-write"))).not.toThrow();
	});

	it("appends herd tools for a plain subagent without removing host tools", async () => {
		const pi = makePi(["bash", "read", "write", "debug"]);
		globalThis.__pi = pi;
		await applySurface({ agent: { id: "vibe-sub", kind: "sub" }, hasUI: false });
		expect(pi.calls.length).toBe(1);
		expect(new Set(pi.active)).toEqual(new Set(["debug", "clj_devops", "wait", "handoff"]));
		expect(pi.active).not.toContain("bash");
		expect(pi.active).not.toContain("read");
	});
});
