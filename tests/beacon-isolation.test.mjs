import { describe, expect, it } from "bun:test";
import { createAriadneStore } from "../src/scope/ariadne.mjs";
import { hostSessionKey, sessionIdentity } from "../src/host/session-key.mjs";

describe("beacon session isolation", () => {
	it("seals beacons inside their own session", () => {
		const store = createAriadneStore();
		store.validateAndApplyFork("session-a", { ariadne_budget: 5, ariadne_goal: "first" }, "anchor-one", "call-1", "clj_devops");
		store.validateAndApplyFork("session-a", { ariadne_budget: 5, ariadne_goal: "second" }, "anchor-two", "call-2", "clj_devops");
		const res = store.timeLeap("session-a", { target: "anchor-one", experience: "done", beacon_name: "sealed", beacon_description: "sealed branch" });
		expect(res.beaconName).toBe("sealed");
		const resolved = store.resolvePendingLeap("session-a", [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "clj_devops", arguments: { name: "anchor-one" } }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "clj_devops", arguments: { name: "anchor-two" } }] },
		]);
		expect(resolved.found).toBe(true);
		expect(store.getBeacon("session-a", "sealed")).not.toBeNull();
		expect(store.getBeacon("session-b", "sealed")).toBeNull();
		expect(store.listBeacons("session-b")).toEqual([]);
		expect(store.formatAriadneBlock("session-b")).toBeNull();
	});

	it("retires exactly one session", () => {
		const store = createAriadneStore();
		store.validateAndApplyFork("session-a", { ariadne_budget: 5, ariadne_goal: "first" }, "anchor-one", "call-1", "clj_devops");
		store.validateAndApplyFork("session-a", { ariadne_budget: 5, ariadne_goal: "second" }, "anchor-two", "call-2", "clj_devops");
		store.timeLeap("session-a", { target: "anchor-one", experience: "done", beacon_name: "sealed", beacon_description: "sealed branch" });
		store.resolvePendingLeap("session-a", [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "clj_devops", arguments: { name: "anchor-one" } }] },
		]);
		expect(store.retireSession("session-a")).toBe(true);
		expect(store.retireSession("session-a")).toBe(false);
		expect(store.getBeacon("session-a", "sealed")).toBeNull();
	});
});

describe("hostSessionKey", () => {
	it("prefers the stable session id over the session file", () => {
		const ctx = { sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/tmp/a.jsonl" } };
		expect(sessionIdentity(ctx)).toBe("sess-1");
		expect(hostSessionKey(ctx)).toBe("sess-1");
	});

	it("uses the session file only when no id exists", () => {
		const ctx = { sessionManager: { getSessionFile: () => "/tmp/a.jsonl" } };
		expect(hostSessionKey(ctx)).toBe("/tmp/a.jsonl");
	});

	it("never collapses distinct contexts without a session manager", () => {
		const a = { cwd: "/repo" };
		const b = { cwd: "/repo" };
		expect(hostSessionKey(a)).not.toBe(hostSessionKey(b));
		expect(hostSessionKey(a)).toBe(hostSessionKey(a));
	});
});
