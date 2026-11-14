import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installFakeClock, uninstallFakeClock } from "./fake-clock.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHerdError } from "../src/util/errors.mjs";
import { acquireLock, inspectLock, LOCK_RANKS, releaseLock, withLock } from "../src/util/file-lock.mjs";

const roots = [];
let clock;

const installClock = () => {
	clock = installFakeClock();
	clock.advance(1_700_000_000_000);
};

const resetClock = () => uninstallFakeClock();

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-lock-"));
	roots.push(root);
	return root;
}

function lockMeta(overrides = {}) {
	return {
		lock_id: randomUUID(),
		purpose: "writeW",
		slice_id: "slice-a",
		owner_agent_id: "agent-a",
		owner_term_id: "term-1",
		pid: process.pid,
		startedAt: new Date(clock.now()).toISOString(),
		host: "test-host",
		token: randomUUID(),
		...overrides,
	};
}

function oldMeta(ageMs = 60_000, overrides = {}) {
	return lockMeta({
		startedAt: new Date(clock.now() - ageMs).toISOString(),
		...overrides,
	});
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("acquireLock", async () => {
	beforeEach(installClock);
	afterEach(resetClock);
	it("creates the parent directory and writes the complete owner record", async () => {
		const root = sandbox();
		const lockPath = join(root, "nested", "locks", "writeW.lock");
		const meta = lockMeta();

		const result = await acquireLock(lockPath, meta);

		expect(result.ok).toBe(true);
		expect(result.handle.path).toBe(lockPath);
		expect(result.handle.token).toBe(meta.token);
		expect(result.handle.content.lock_id).toBe(meta.lock_id);
		expect(result.handle.content.purpose).toBe("writeW");
		expect(result.handle.content.owner_agent_id).toBe("agent-a");
		expect(result.handle.content.pid).toBe(process.pid);
		expect(result.handle.content.startedAt).toBe(meta.startedAt);
		expect(result.handle.content.started_at).toBeUndefined();
		expect(statSync(lockPath).mode & 0o777).toBe(0o600);

		const stored = JSON.parse(readFileSync(lockPath, "utf8"));
		expect(stored).toEqual(result.handle.content);
		expect(stored.token).toBe(meta.token);
	});

	it("is available again after its owner releases it", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");

		const first = await acquireLock(lockPath, lockMeta());
		expect(first.ok).toBe(true);
		expect(await releaseLock(first.handle)).toEqual({ released: true });
		expect(existsSync(lockPath)).toBe(false);

		const second = await acquireLock(lockPath, lockMeta({ owner_agent_id: "agent-b" }));
		expect(second.ok).toBe(true);
		expect(second.handle.content.owner_agent_id).toBe("agent-b");
		expect((await releaseLock(second.handle)).released).toBe(true);
	});

	it("does not take a live lock, even when the file is old", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, oldMeta(60_000));
		expect(held.ok).toBe(true);

		const blocked = await acquireLock(lockPath, lockMeta({ owner_agent_id: "agent-b" }));
		expect(blocked.ok).toBe(false);
		expect(blocked.busy).toBe(true);
		expect(blocked.stale).toBe(false);
		expect(blocked.lock.alive).toBe(true);
		expect(blocked.lock.reason).toBe("pid-alive");
		expect(blocked.lock.content.owner_agent_id).toBe("agent-a");
		expect(blocked.error).toBeUndefined();
		expect(existsSync(lockPath)).toBe(true);

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("reports a stale lock with :LOCK_OWNER_DEAD and never removes it", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, oldMeta(60_000, { owner_agent_id: "dead-agent" }));
		expect(held.ok).toBe(true);

		const blocked = await acquireLock(lockPath, {
			...lockMeta({ owner_agent_id: "agent-b" }),
			agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : ":alive"),
		});

		expect(blocked.ok).toBe(false);
		expect(blocked.busy).toBe(false);
		expect(blocked.stale).toBe(true);
		expect(blocked.lock.reason).toBe("owner-dead-stale");
		expect(isHerdError(blocked.error)).toBe(true);
		expect(blocked.error.code).toBe(":LOCK_OWNER_DEAD");
		expect(blocked.error.data.path).toBe(lockPath);
		expect(blocked.error.data.lock).toBe(blocked.lock);
		expect(existsSync(lockPath)).toBe(true);
		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("keeps a recent dead owner's lock busy instead of stale", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, oldMeta(10_000, { owner_agent_id: "dead-agent" }));
		expect(held.ok).toBe(true);

		const blocked = await acquireLock(lockPath, {
			...lockMeta({ owner_agent_id: "agent-b" }),
			agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : ":alive"),
		});

		expect(blocked.ok).toBe(false);
		expect(blocked.busy).toBe(true);
		expect(blocked.stale).toBe(false);
		expect(blocked.lock.reason).toBe("owner-dead-recent");
		expect(blocked.error).toBeUndefined();
		expect(existsSync(lockPath)).toBe(true);

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("treats corrupt and token-less content as an unknown busy owner", async () => {
		const root = sandbox();
		const corruptPath = join(root, "corrupt.lock");
		writeFileSync(corruptPath, "{not-json", "utf8");

		const corrupt = await acquireLock(corruptPath, lockMeta());
		expect(corrupt.ok).toBe(false);
		expect(corrupt.busy).toBe(true);
		expect(corrupt.stale).toBe(false);
		expect(corrupt.error).toBeUndefined();
		expect(existsSync(corruptPath)).toBe(true);

		const noTokenPath = join(root, "no-token.lock");
		writeFileSync(
			noTokenPath,
			JSON.stringify({
				lock_id: randomUUID(),
				owner_agent_id: "agent-a",
				pid: process.pid,
				started_at: new Date(clock.now() - 60_000).toISOString(),
			}),
			"utf8",
		);

		const noToken = await acquireLock(noTokenPath, lockMeta());
		expect(noToken.ok).toBe(false);
		expect(noToken.busy).toBe(true);
		expect(noToken.stale).toBe(false);
		expect(noToken.lock.reason).toBe("missing-token");
		expect(existsSync(noTokenPath)).toBe(true);
	});
});

describe("inspectLock", async () => {
	beforeEach(installClock);
	afterEach(resetClock);
	it("reports a missing file without throwing", async () => {
		const root = sandbox();
		const path = join(root, "absent.lock");

		expect(await inspectLock(path)).toEqual({
			exists: false,
			content: null,
			alive: false,
			stale: false,
			reason: "missing",
		});
	});

	it("checks agent state before a live shared PID", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, oldMeta(60_000, { owner_agent_id: "dead-agent" }));
		expect(held.ok).toBe(true);

		const seen = await inspectLock(lockPath, {
			agentState: (agentId) => (agentId === "dead-agent" ? ":terminated" : ":alive"),
		});
		expect(seen.exists).toBe(true);
		expect(seen.alive).toBe(false);
		expect(seen.stale).toBe(true);
		expect(seen.reason).toBe("owner-dead-stale");

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("does not turn a live agent into a dead owner because the PID is shared", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, lockMeta({ owner_agent_id: "agent-a" }));
		expect(held.ok).toBe(true);

		const seen = await inspectLock(lockPath, {
			agentState: (agentId) => (agentId === "agent-a" ? ":alive" : undefined),
		});
		expect(seen.alive).toBe(true);
		expect(seen.stale).toBe(false);
		expect(seen.reason).toBe("owner-alive");

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("keeps a dead owner's recent lock out of the stale state", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, oldMeta(29_000, { owner_agent_id: "dead-agent" }));
		expect(held.ok).toBe(true);

		const seen = await inspectLock(lockPath, {
			agentState: (agentId) => (agentId === "dead-agent" ? ":terminated" : undefined),
		});
		expect(seen.alive).toBe(false);
		expect(seen.stale).toBe(false);
		expect(seen.reason).toBe("owner-dead-recent");

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("reads the legacy started_at field for locks written before the cutover", async () => {
		const root = sandbox();
		const lockPath = join(root, "alias.lock");
		writeFileSync(
			lockPath,
			JSON.stringify({
				lock_id: randomUUID(),
				owner_agent_id: "dead-agent",
				pid: process.pid,
				token: randomUUID(),
				started_at: new Date(clock.now() - 60_000).toISOString(),
			}),
			"utf8",
		);

		const seen = await inspectLock(lockPath, {
			agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : undefined),
		});
		expect(seen.alive).toBe(false);
		expect(seen.stale).toBe(true);
		expect(seen.reason).toBe("owner-dead-stale");
	});

	it("uses the PID only when agent state is unknown", async () => {
		const root = sandbox();
		const lockPath = join(root, "pid.lock");
		writeFileSync(
			lockPath,
			JSON.stringify({
				lock_id: randomUUID(),
				pid: process.pid,
				token: randomUUID(),
				startedAt: new Date(clock.now() - 60_000).toISOString(),
			}),
			"utf8",
		);

		const seen = await inspectLock(lockPath);
		expect(seen.alive).toBe(true);
		expect(seen.stale).toBe(false);
		expect(seen.reason).toBe("pid-alive");
	});

	it("never marks corrupt or token-less locks stale", async () => {
		const root = sandbox();
		const corruptPath = join(root, "corrupt.lock");
		writeFileSync(corruptPath, "", "utf8");

		const corrupt = await inspectLock(corruptPath);
		expect(corrupt.alive).toBe(false);
		expect(corrupt.stale).toBe(false);
		expect(corrupt.reason).toBe("corrupt");

		const noTokenPath = join(root, "no-token.lock");
		writeFileSync(
			noTokenPath,
			JSON.stringify({
				owner_agent_id: "dead-agent",
				pid: process.pid,
				started_at: new Date(clock.now() - 60_000).toISOString(),
			}),
			"utf8",
		);
		const noToken = await inspectLock(noTokenPath, {
			agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : undefined),
		});
		expect(noToken.alive).toBe(false);
		expect(noToken.stale).toBe(false);
		expect(noToken.reason).toBe("missing-token");
	});
});

describe("releaseLock", async () => {
	beforeEach(installClock);
	afterEach(resetClock);
	it("is idempotent on a missing lock", async () => {
		const root = sandbox();
		const path = join(root, "absent.lock");

		expect(await releaseLock({ path, token: randomUUID() })).toEqual({
			released: false,
			reason: "missing",
		});
	});

	it("does not delete a lock when the token does not match", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, lockMeta());
		expect(held.ok).toBe(true);

		expect(await releaseLock({ ...held.handle, token: randomUUID() })).toEqual({
			released: false,
			reason: "token-mismatch",
		});
		expect(existsSync(lockPath)).toBe(true);

		expect(await releaseLock(held.handle)).toEqual({ released: true });
	});

	it("does not delete corrupt content", async () => {
		const root = sandbox();
		const lockPath = join(root, "corrupt.lock");
		writeFileSync(lockPath, "{not-json", "utf8");

		expect(await releaseLock({ path: lockPath, token: randomUUID() })).toEqual({
			released: false,
			reason: "corrupt",
		});
		expect(existsSync(lockPath)).toBe(true);

		const noTokenPath = join(root, "no-token.lock");
		writeFileSync(noTokenPath, JSON.stringify({ owner_agent_id: "agent-a" }), "utf8");
		expect(await releaseLock({ path: noTokenPath, token: randomUUID() })).toEqual({
			released: false,
			reason: "missing-token",
		});
		expect(existsSync(noTokenPath)).toBe(true);
	});
});

describe("withLock", async () => {
	beforeEach(installClock);
	afterEach(resetClock);
	it("runs a synchronous writer and releases the lock", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "board.lock");

		const result = await withLock(lockPath, lockMeta(), () => 42);

		expect(result).toEqual({
			ok: true,
			value: 42,
			released: true,
			release: { released: true },
		});
		expect(existsSync(lockPath)).toBe(false);
	});

	it("runs an asynchronous writer and releases the lock", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "board.lock");

		const result = await withLock(lockPath, lockMeta(), async (handle) => {
			await Promise.resolve();
			return handle.content.owner_agent_id;
		});

		expect(result.ok).toBe(true);
		expect(result.value).toBe("agent-a");
		expect(result.released).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("returns a busy acquisition unchanged and does not call the writer", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "board.lock");
		const held = await acquireLock(lockPath, lockMeta());
		let called = false;

		const result = await withLock(lockPath, lockMeta({ owner_agent_id: "agent-b" }), () => {
			called = true;
		});

		expect(result.ok).toBe(false);
		expect(result.busy).toBe(true);
		expect(result.stale).toBe(false);
		expect(result.error).toBeUndefined();
		expect(called).toBe(false);
		expect(existsSync(lockPath)).toBe(true);

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("returns a stale acquisition with :LOCK_OWNER_DEAD and does not call the writer", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "board.lock");
		const held = await acquireLock(lockPath, oldMeta(60_000, { owner_agent_id: "dead-agent" }));
		let called = false;

		const result = await withLock(
			lockPath,
			{
				...lockMeta({ owner_agent_id: "agent-b" }),
				agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : undefined),
			},
			() => {
				called = true;
			},
		);

		expect(result.ok).toBe(false);
		expect(result.busy).toBe(false);
		expect(result.stale).toBe(true);
		expect(isHerdError(result.error)).toBe(true);
		expect(result.error.code).toBe(":LOCK_OWNER_DEAD");
		expect(called).toBe(false);
		expect(existsSync(lockPath)).toBe(true);

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("releases after a writer error and rethrows the original error", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "board.lock");
		const original = new Error("writer failed");

		let caught;
		try {
			await withLock(lockPath, lockMeta(), () => {
				throw original;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(original);
		expect(caught.release).toEqual({ released: true });
		expect(existsSync(lockPath)).toBe(false);
	});

	it("keeps the writer error when release also fails", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "board.lock");
		const original = new Error("writer failed");

		let caught;
		try {
			await withLock(lockPath, lockMeta(), (handle) => {
				handle.token = randomUUID();
				throw original;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(original);
		expect(caught.release).toEqual({ released: false, reason: "token-mismatch" });
		expect(existsSync(lockPath)).toBe(true);
	});
});

describe("LOCK_RANKS", async () => {
	beforeEach(installClock);
	afterEach(resetClock);
	it("is frozen and maps the documented ranks", async () => {
		expect(Object.isFrozen(LOCK_RANKS)).toBe(true);
		expect(LOCK_RANKS).toEqual({ integration: 0, writeW: 1, board: 2 });
	});
});
