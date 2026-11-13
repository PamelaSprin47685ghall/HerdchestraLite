import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEdnAtomic, writeFileAtomic } from "../src/util/atomic-write.mjs";
import { isHerdError } from "../src/util/errors.mjs";
import { acquireLock, inspectLock, releaseLock, withLock } from "../src/util/file-lock.mjs";

const roots = [];

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "herd-atomic-lock-"));
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
		startedAt: new Date().toISOString(),
		host: "test-host",
		token: randomUUID(),
		...overrides,
	};
}

function staleMeta(overrides = {}) {
	return lockMeta({
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		...overrides,
	});
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop(), { recursive: true, force: true });
	}
});

describe("atomic write under the write gate", async () => {
	it("publishes the complete new state and releases the lock", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const statePath = join(root, "board.edn");

		const result = await withLock(lockPath, lockMeta(), async () => {
			const written = await writeEdnAtomic(statePath, {
				":board-version": 2,
				":tasks": [":ready", ":waiting"],
			});
			return written.existed;
		});

		expect(result.ok).toBe(true);
		expect(result.value).toBe(false);
		expect(result.released).toBe(true);
		expect(existsSync(lockPath)).toBe(false);
		const state = readFileSync(statePath, "utf8");
		expect(state).toContain(":board-version 2");
		expect(state).toContain(":tasks [:ready :waiting]");
		expect(state.endsWith("\n")).toBe(true);
	});

	it("keeps the previous target when the writer throws", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const statePath = join(root, "board.edn");
		writeFileSync(statePath, "old-state\n", "utf8");

		let caught;
		try {
			await withLock(lockPath, lockMeta(), () => {
				throw new Error("writer failed before rename");
			});
		} catch (error) {
			caught = error;
		}

		expect(caught?.message).toBe("writer failed before rename");
		expect(existsSync(lockPath)).toBe(false);
		expect(readFileSync(statePath, "utf8")).toBe("old-state\n");
	});

	it("leaves no temporary file after a successful replacement", async () => {
		const root = sandbox();
		const target = join(root, "mission.edn");
		writeFileSync(target, "old\n", "utf8");

		const result = await writeFileAtomic(root, "mission.edn", "new\n");

		expect(result).toEqual({ path: target, existed: true });
		expect(readFileSync(target, "utf8")).toBe("new\n");
		expect(readdirSync(root).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
	});
});

describe("single writer lock", async () => {
	it("lets only one of two OS processes acquire the same lock", async () => {
		const root = sandbox();
		const lockPath = join(root, "cross-process.lock");
		const moduleUrl = new URL("../src/util/file-lock.mjs", import.meta.url).href;
		const script = `
			import { readdirSync, writeFileSync } from "node:fs";
			import { acquireLock, releaseLock } from ${JSON.stringify(moduleUrl)};
			const root = ${JSON.stringify(root)};
			const lockPath = ${JSON.stringify(lockPath)};
			writeFileSync(root + "/attempt-" + process.pid, "");
			const barrier = Date.now() + 3000;
			while (Date.now() < barrier) {
				if (readdirSync(root).filter((name) => name.startsWith("attempt-")).length >= 2) break;
				await Bun.sleep(5);
			}
			const result = await acquireLock(lockPath, {
				lock_id: crypto.randomUUID(),
				purpose: "writeW",
				slice_id: "slice-a",
				owner_agent_id: crypto.randomUUID(),
				owner_term_id: "term-child",
				pid: process.pid,
				startedAt: new Date().toISOString(),
				host: "child",
				token: crypto.randomUUID(),
			});
			if (!result.ok) {
				console.log("busy");
				process.exit(0);
			}
			console.log("ok");
			await Bun.sleep(50);
			await releaseLock(result.handle);
		`;
		const spawn = () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		const children = [spawn(), spawn()];
		const outputs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
		await Promise.all(children.map((child) => child.exited));

		expect(outputs.map((output) => output.trim()).sort()).toEqual(["busy", "ok"]);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("lets exactly one contender hold the same lock path", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");

		const first = await acquireLock(lockPath, lockMeta());
		expect(first.ok).toBe(true);

		const second = await acquireLock(lockPath, lockMeta({ owner_agent_id: "agent-b" }));
		expect(second.ok).toBe(false);
		expect(second.busy).toBe(true);
		expect(second.stale).toBe(false);
		expect(second.lock.alive).toBe(true);
		expect(second.lock.content.owner_agent_id).toBe("agent-a");

		expect(await releaseLock(first.handle)).toEqual({ released: true });
		expect(existsSync(lockPath)).toBe(false);
	});

	it("trusts agent state over a live shared PID", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, staleMeta({ owner_agent_id: "dead-agent" }));
		expect(held.ok).toBe(true);

		const recent = await inspectLock(lockPath, {
			agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : ":alive"),
		});
		expect(recent.alive).toBe(false);
		expect(recent.stale).toBe(true);

		const blocked = await acquireLock(lockPath, {
			...lockMeta({ owner_agent_id: "agent-b" }),
			agentState: (agentId) => (agentId === "dead-agent" ? ":dead" : ":alive"),
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.stale).toBe(true);
		expect(isHerdError(blocked.error)).toBe(true);
		expect(blocked.error.code).toBe(":LOCK_OWNER_DEAD");
		expect(existsSync(lockPath)).toBe(true);

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("does not mark a dead owner stale inside thirty seconds", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, lockMeta({ owner_agent_id: "dead-agent" }));
		expect(held.ok).toBe(true);

		const seen = await inspectLock(lockPath, {
			agentState: (agentId) => (agentId === "dead-agent" ? ":terminated" : ":alive"),
		});
		expect(seen.alive).toBe(false);
		expect(seen.stale).toBe(false);
		expect(seen.reason).toBe("owner-dead-recent");

		expect((await releaseLock(held.handle)).released).toBe(true);
	});

	it("never deletes a lock whose token does not match", async () => {
		const root = sandbox();
		const lockPath = join(root, "locks", "writeW.lock");
		const held = await acquireLock(lockPath, lockMeta());
		expect(held.ok).toBe(true);

		const forged = { ...held.handle, token: randomUUID() };
		expect(await releaseLock(forged)).toEqual({ released: false, reason: "token-mismatch" });
		expect(existsSync(lockPath)).toBe(true);

		expect(await releaseLock(held.handle)).toEqual({ released: true });
	});

	it("treats corrupt lock content as an unknown live owner", async () => {
		const root = sandbox();
		const lockPath = join(root, "corrupt.lock");
		writeFileSync(lockPath, "{not-json", "utf8");

		const seen = await inspectLock(lockPath);
		expect(seen.exists).toBe(true);
		expect(seen.alive).toBe(false);
		expect(seen.stale).toBe(false);
		expect(seen.reason).toBe("corrupt");

		const blocked = await acquireLock(lockPath, lockMeta());
		expect(blocked.ok).toBe(false);
		expect(blocked.busy).toBe(true);
		expect(existsSync(lockPath)).toBe(true);
	});
});
