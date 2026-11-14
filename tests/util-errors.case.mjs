import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	ERROR_CODES,
	errorCode,
	herdError,
	isHerdError,
	messageOf,
	printEdn,
	renderError,
} from "../src/util/errors.mjs";

const CODE_NAMES = [
	"SLUG_TAKEN",
	"STAGE_MISMATCH",
	"CALL_REPLAY_MISMATCH",
	"APPROVAL_REQUIRED",
	"INSUFFICIENT_WORKTREES",
	"RESOURCES_NOT_QUIESCENT",
	"FF_NOT_READY",
	"NO_RESULTS",
	"CASE_SCHEMA_INVALID",
	"CASE_DUPLICATE_ID",
	"CASE_THRESHOLD_INVALID",
	"CASE_REQUIRED_PATH_MISSING",
	"MAPPED_CASE_UNKNOWN",
	"MAPPED_CASE_MISSING",
	"BOARD_CONFLICT",
	"TASK_NOT_READY",
	"CLAIM_CONFLICT",
	"PARENT_NOT_READY",
	"TOKEN_REQUIRED",
	"CONFIRMATION_REQUIRED",
	"TENURE_RETIRED",
	"ACTOR_DEAD",
	"CLAIM_CHANGED",
	"NO_PROGRESSABLE_WORK",
	"TASK_HAS_CHILDREN",
	"NAME_TAKEN",
	"ATTACH_NOT_READY",
	"REVIEW_LEDGER_NOT_EMPTY",
	"ATTACH_STAGE_MISMATCH",
	"ATTACH_ALREADY_PENDING",
	"BOARD_NOT_QUIESCENT",
	"FILE_CONFLICT",
	"STRUCTURE_CONFLICT",
	"PREPARE_REJECTED",
	"LIMIT_EXCEEDED",
	"changed-during-read",
	"PATH_ESCAPE",
	"NOT_UTF8",
	"OUTPUT_TRUNCATED",
	"CAPABILITY_DENIED",
	"PROGRAM_UNKNOWN",
	"STALE_CONTROL",
	"INVALID_ARGUMENT",
	"UFSS_INDENT_VIOLATION",
	"UFSS_UNCLOSED",
	"SCOPE_UNINITIALIZED",
	"SCOPE_BUDGET_SPENT",
	"INTENT_REQUIRED",
	"SCOPE_INVALID",
	"ASK_FORBIDDEN_OUTSIDE_S1",
	"AUDIT_MISSING",
	"AUDIT_UNKNOWN_CASE",
	"AUDIT_DUPLICATE_CASE",
	"AUDIT_INVALID_SCORE",
	"AUDIT_WORKSPACE_MUTATED",
	"AUDIT_TIMEOUT",
	"AUDIT_ABORTED",
	"STALLED",
	"UPSTREAM_ABORTED",
	"AGENT_SPAWN_FAILED",
	"HOST_API_MISMATCH",
	"SETTINGS_UNAVAILABLE",
	"MODEL_FALLBACK",
	"LOCK_OWNER_DEAD",
];

describe("ERROR_CODES", () => {
	it("registers every SSOT code as a frozen keyword", () => {
		expect(Object.isFrozen(ERROR_CODES)).toBe(true);
		expect(Object.keys(ERROR_CODES).sort()).toEqual([...CODE_NAMES].sort());
		for (const name of CODE_NAMES) {
			expect(ERROR_CODES[name]).toBe(`:${name}`);
		}
	});

	it("covers every code listed in AGENTS.md section 10.3", () => {
		const markdown = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
		const start = markdown.indexOf("### 10.3 错误码与状态词");
		const end = markdown.indexOf("**状态词**", start + 1);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);

		const documented = [];
		for (const rawLine of markdown.slice(start, end).split("\n")) {
			const line = rawLine.trimStart();
			const match = /^\|\s*`(:[^`]+)`\s*\|/.exec(line);
			if (match !== null) documented.push(match[1]);
		}
		expect(documented.length).toBeGreaterThan(0);

		const registered = new Set(Object.values(ERROR_CODES));
		expect(documented.filter((code) => !registered.has(code))).toEqual([]);
	});
});

describe("herdError", () => {
	it("builds a named error with normalized code, copied data, and cause", () => {
		const nested = { keep: true };
		const data = { path: "a.md", nested };
		const cause = new Error("root cause");

		const error = herdError("FILE_CONFLICT", "conflict", data, cause);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("HerdError");
		expect(error.code).toBe(":FILE_CONFLICT");
		expect(error.message).toBe("conflict");
		expect(error.data).toEqual({ path: "a.md", nested });
		expect(error.data).not.toBe(data);
		expect(error.data.nested).toBe(nested);
		expect(error.cause).toBe(cause);
		expect(isHerdError(error)).toBe(true);

		expect(herdError(":changed-during-read", "moved").code).toBe(":changed-during-read");
		expect(herdError("FILE_CONFLICT", "no data").data).toEqual({});
	});

	it("rejects unregistered codes and non-object data", () => {
		expect(() => herdError("NOT_REGISTERED", "x")).toThrow(TypeError);
		expect(() => herdError(":NOT_REGISTERED", "x")).toThrow(TypeError);
		expect(() => herdError(42, "x")).toThrow(TypeError);
		expect(() => herdError("FILE_CONFLICT", "x", [])).toThrow(TypeError);
		expect(() => herdError("FILE_CONFLICT", "x", "data")).toThrow(TypeError);
	});

	it("is not confused with ordinary errors", () => {
		expect(isHerdError(new Error("plain"))).toBe(false);
		expect(isHerdError({ name: "HerdError", code: ":FILE_CONFLICT" })).toBe(false);
		expect(isHerdError(null)).toBe(false);
	});
});

describe("legacy helpers", () => {
	it("keeps messageOf and errorCode behavior", () => {
		expect(messageOf(new Error("boom"))).toBe("boom");
		expect(messageOf("plain")).toBe("plain");

		const system = new Error("disk full");
		system.code = "ENOSPC";
		expect(errorCode(system)).toBe("ENOSPC");
		expect(errorCode({ code: 1 })).toBeUndefined();
		expect(errorCode("plain")).toBeUndefined();
	});
});

describe("renderError", () => {
	it("renders a herd error as aligned EDN with a trailing newline", () => {
		expect(renderError(herdError("FILE_CONFLICT", "conflict", { path: "a.md" }))).toBe(
			'{:code :FILE_CONFLICT\n :message "conflict"\n :data {:path "a.md"}}\n',
		);
	});

	it("uses a raw fence for a single-line message with quotes and backslashes", () => {
		const text = renderError(herdError("INVALID_ARGUMENT", 'bad "x" \\ path'));
		expect(text).toContain(' :message #"bad "x" \\ path"#\n');
		expect(text).not.toContain('\\"');
	});

	it("uses a multiline fence aligned to the message field", () => {
		const pad = " ".repeat(10);
		const text = renderError(herdError("INVALID_ARGUMENT", "first\nsecond line"));
		expect(text).toBe(
			`{:code :INVALID_ARGUMENT\n :message """\n${pad}first\n${pad}second line\n${pad}"""\n :data {}}\n`,
		);
	});

	it("keeps colon-prefixed messages as strings", () => {
		const text = renderError(herdError("INVALID_ARGUMENT", ":not-a-keyword"));
		expect(text).toContain(' :message ":not-a-keyword"\n');
	});

	it("falls back to standard escapes for control characters", () => {
		expect(renderError(new Error("a\rb"))).toBe('{:code nil\n :message "a\\rb"\n :data {:system-code nil}}\n');
	});

	it("normalizes raw exceptions and includes their system code", () => {
		const system = new Error("disk full");
		system.code = "ENOSPC";
		expect(renderError(system)).toBe('{:code nil\n :message "disk full"\n :data {:system-code "ENOSPC"}}\n');
	});

	it("includes a nested cause chain", () => {
		const root = herdError("LOCK_OWNER_DEAD", "owner dead", { agent_id: "a1" });
		const outer = herdError("FILE_CONFLICT", "conflict", {}, root);
		const expected = [
			"{:code :FILE_CONFLICT",
			' :message "conflict"',
			" :data {}",
			" :cause {:code :LOCK_OWNER_DEAD",
			'         :message "owner dead"',
			'         :data {:agent_id "a1"}}}',
		].join("\n");
		expect(renderError(outer)).toBe(`${expected}\n`);
	});

	it("never throws, even for cyclic data or hostile values", () => {
		const cyclic = {};
		cyclic.self = cyclic;
		const text = renderError(herdError("INVALID_ARGUMENT", "cycle", cyclic));
		expect(text.endsWith("\n")).toBe(true);
		expect(text).toContain(":render-error");
		expect(text).toContain(":error-code :INVALID_ARGUMENT");

		expect(() => renderError(undefined)).not.toThrow();
		expect(renderError(undefined)).toBe('{:code nil\n :message "undefined"\n :data {:system-code nil}}\n');

		const hostile = {
			get message() {
				throw new Error("unreadable");
			},
		};
		expect(() => renderError(hostile)).not.toThrow();
	});
});

describe("printEdn scalars", () => {
	it("prints nil, booleans, numbers, bigints, and strings", () => {
		expect(printEdn(null)).toBe("nil");
		expect(printEdn(true)).toBe("true");
		expect(printEdn(false)).toBe("false");
		expect(printEdn(42)).toBe("42");
		expect(printEdn(-7)).toBe("-7");
		expect(printEdn(10n)).toBe("10N");
		expect(printEdn("plain")).toBe('"plain"');
		expect(printEdn(":ready")).toBe(":ready");
		expect(printEdn(":not a keyword")).toBe('":not a keyword"');
		expect(printEdn(":")).toBe('":"');
	});

	it("rejects non-finite numbers with INVALID_ARGUMENT", () => {
		for (const value of [Number.NaN, Infinity, -Infinity]) {
			let caught;
			try {
				printEdn(value);
			} catch (error) {
				caught = error;
			}
			expect(isHerdError(caught)).toBe(true);
			expect(caught.code).toBe(":INVALID_ARGUMENT");
		}
	});
});

describe("printEdn strings", () => {
	it("uses the minimal raw fence for inline quotes and backslashes", () => {
		expect(printEdn('say "hi"')).toBe('#"say "hi""#');
		expect(printEdn("C:\\tmp")).toBe('#"C:\\tmp"#');
		expect(printEdn('a"#b')).toBe('##"a"#b"##');
	});

	it("uses triple-quote blocks for multiline strings", () => {
		expect(printEdn("a\nb")).toBe('"""\na\nb\n"""');
		expect(printEdn("a\nb\n")).toBe('"""\na\nb\n\n"""');
		expect(printEdn("a\\b\nc")).toBe('#"""\na\\b\nc\n"""#');
		expect(printEdn('x """ y\nz')).toBe('#"""\nx """ y\nz\n"""#');
		expect(printEdn('x """# y\nz')).toBe('##"""\nx """# y\nz\n"""##');
	});

	it("aligns multiline blocks to the provided indent", () => {
		expect(printEdn("a\n\nb", { indent: "  " })).toBe('"""\n  a\n\n  b\n  """');
	});

	it("falls back to standard escapes for control characters", () => {
		expect(printEdn("a\rb")).toBe('"a\\rb"');
		expect(printEdn("a\u0001b")).toBe('"a\\u0001b"');
		expect(printEdn("a\tb")).toBe('"a\tb"');
	});
});

describe("printEdn collections", () => {
	it("prints arrays, sets, and maps deterministically", () => {
		expect(printEdn([])).toBe("[]");
		expect(printEdn([1, 2, 3])).toBe("[1 2 3]");
		expect(printEdn(new Set([":a", ":b"]))).toBe("#{:a :b}");
		expect(
			printEdn(
				new Map([
					["k", 1],
					[2, ":v"],
				]),
			),
		).toBe('{"k" 1\n 2 :v}');
		expect(printEdn(new Map([[":k", 1]]))).toBe("{:k 1}");
		expect(printEdn([{ a: 1, b: 2 }])).toBe("[{:a 1\n  :b 2}]");
		expect(
			printEdn([
				{ a: 1, b: 2 },
				{ c: 3, d: 4 },
			]),
		).toBe("[{:a 1\n  :b 2}\n {:c 3\n  :d 4}]");
	});

	it("prints keyword-able object keys as keywords, including colon-prefixed keys", () => {
		expect(printEdn({ path: "a.md", "dry run": true, skipped: undefined })).toBe('{:path "a.md"\n "dry run" true}');
		expect(printEdn({ ":stage": ":s1" })).toBe("{:stage :s1}");
		expect(printEdn({ ":dry run": 1 })).toBe('{":dry run" 1}');
		expect(printEdn({ state: ":ready", colon: ":not a keyword" })).toBe('{:state :ready\n :colon ":not a keyword"}');
	});

	it("aligns nested object continuations", () => {
		expect(printEdn({ a: { b: 1, c: 2 }, d: 3 })).toBe("{:a {:b 1\n     :c 2}\n :d 3}");
	});

	it("rejects circular references but permits shared siblings", () => {
		const cyclic = {};
		cyclic.self = cyclic;
		let caught;
		try {
			printEdn(cyclic);
		} catch (error) {
			caught = error;
		}
		expect(isHerdError(caught)).toBe(true);
		expect(caught.code).toBe(":INVALID_ARGUMENT");
		expect(caught.data.kind).toBe("cycle");

		const shared = { a: 1 };
		expect(printEdn([shared, shared])).toBe("[{:a 1} {:a 1}]");
	});

	it("never appends a trailing newline", () => {
		expect(printEdn("a\nb").endsWith("\n")).toBe(false);
		expect(printEdn({ a: 1 })).toBe("{:a 1}");
	});
});
