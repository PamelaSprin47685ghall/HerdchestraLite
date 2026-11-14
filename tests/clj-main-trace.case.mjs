import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@oh-my-pi/pi-coding-agent", () => ({
	AgentSession: class {},
	Container: class {},
	Markdown: class {},
	Settings: { instance: undefined },
	Spacer: class {},
	Text: class {},
	VERSION: "0.0.0-test",
	runSubprocess: async () => undefined,
	runSubagentFollowUpTurn: async () => undefined,
}));

const { TRACE_LIMIT, bootTraceRecord, traceBootEvent, traceEnabled, traceTarget } = await import("../src/clj-main.mjs");

const NEWLINE = String.fromCharCode(10);
let root;
let target;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "herd-boot-trace-"));
	target = join(root, "perf-trace.jsonl");
	delete process.env.HERD_TRACE;
	delete process.env.HERD_TRACE_PATH;
});

afterEach(async () => {
	delete process.env.HERD_TRACE;
	delete process.env.HERD_TRACE_PATH;
	await rm(root, { recursive: true, force: true });
});

afterAll(() => {
	mock.restore();
});

describe("boot trace", () => {
	it("stays silent unless HERD_TRACE is 1", async () => {
		expect(traceEnabled()).toBe(false);
		expect(traceTarget()).toBe(".herd/perf-trace.jsonl");
		expect(await traceBootEvent("boot-start", { pid: process.pid })).toBe(false);
		let size = null;
		try {
			size = (await stat(target)).size;
		} catch {
			size = null;
		}
		expect(size).toBe(null);
	});

	it("appends one parseable JSON line when enabled", async () => {
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = target;
		expect(traceEnabled()).toBe(true);
		expect(traceTarget()).toBe(target);
		const wrote = await traceBootEvent("boot-start", { pid: 4321, cwd: "/tmp/x", pluginSrc: "/tmp/x/src" });
		expect(wrote).toBe(true);
		const text = await readFile(target, "utf8");
		expect(text.endsWith(NEWLINE)).toBe(true);
		const lines = text.split(NEWLINE).filter((line) => line.length > 0);
		expect(lines.length).toBe(1);
		const entry = JSON.parse(lines[0]);
		expect(entry.event).toBe("boot-start");
		expect(entry.pid).toBe(4321);
		expect(entry.cwd).toBe("/tmp/x");
		expect(entry.pluginSrc).toBe("/tmp/x/src");
		expect(typeof entry.at).toBe("number");
	});

	it("never grows the file past the 1 MiB cap", async () => {
		process.env.HERD_TRACE = "1";
		process.env.HERD_TRACE_PATH = target;
		await writeFile(target, "x".repeat(TRACE_LIMIT), "utf8");
		expect(await traceBootEvent("boot-end", { total: 1 })).toBe(false);
		expect((await stat(target)).size).toBe(TRACE_LIMIT);
	});

	it("builds records without reading the clock when an at value is given", () => {
		const record = bootTraceRecord("boot-phase", { phase: "nbb-import", ms: 1.5 }, 1234);
		expect(record).toEqual({ at: 1234, event: "boot-phase", phase: "nbb-import", ms: 1.5 });
	});
});
