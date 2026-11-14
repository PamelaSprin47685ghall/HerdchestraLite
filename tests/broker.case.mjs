import { describe, expect, it } from "bun:test";
import { createWriteActor, normalizeLockPath } from "../src/util/broker.mjs";

describe("write actor tokens", async () => {
	it("serializes the same path and runs distinct paths concurrently", async () => {
		const actor = createWriteActor();
		const first = await actor.acquire("a", "path", ["/tmp/x"]);
		let second = false;
		const waiting = actor.acquire("b", "path", ["/tmp/x"]).then(() => {
			second = true;
		});
		await Promise.resolve();
		expect(second).toBe(false);
		actor.release(first);
		await waiting;
		expect(second).toBe(true);

		const c = await actor.acquire("c", "path", ["/tmp/y"]);
		const d = await actor.acquire("d", "path", ["/tmp/z"]);
		expect(c.ids.length).toBe(1);
		expect(d.ids.length).toBe(1);
		actor.release(c);
		actor.release(d);
	});

	it("makes global exclude every path token", async () => {
		const actor = createWriteActor();
		const pathToken = await actor.acquire("a", "path", ["/tmp/x"]);
		let globalReady = false;
		const globalWait = actor.acquire("b", "global").then(() => {
			globalReady = true;
		});
		await Promise.resolve();
		expect(globalReady).toBe(false);
		actor.release(pathToken);
		await globalWait;
		expect(globalReady).toBe(true);

		let pathReady = false;
		const pathWait = actor.acquire("c", "path", ["/tmp/y"]).then(() => {
			pathReady = true;
		});
		await Promise.resolve();
		expect(pathReady).toBe(false);
		actor.releaseOwner("b");
		await pathWait;
		expect(pathReady).toBe(true);
		actor.releaseOwner("c");
	});

	it("releases every token held by an owner", async () => {
		const actor = createWriteActor();
		await actor.acquire("a", "path", ["/tmp/x"]);
		await actor.acquire("a", "path", ["/tmp/y"]);
		expect(actor.releaseOwner("a")).toBe(2);
		expect(actor.snapshot().kind).toBe("idle");
	});

	it("normalizes dot segments", async () => {
		expect(await normalizeLockPath("/tmp/a/../b")).toBe("/tmp/b");
	});
});
