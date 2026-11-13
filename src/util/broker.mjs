import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ACTOR_KEY = Symbol.for("herdchestra.writeActor.v1");

export function normalizeLockPath(value) {
	if (typeof value !== "string" || value.length === 0) return resolve(value ?? "");
	try {
		return realpathSync(value);
	} catch {
		// Fall through to the parent-directory fallback.
	}
	const parent = dirname(value);
	try {
		return resolve(realpathSync(parent), value.slice(parent.length + 1));
	} catch {
		return resolve(value);
	}
}

export function createWriteActor() {
	const holders = new Map();
	const pathQueues = new Map();
	const globalQueue = [];
	let seq = 0;

	function globalHeld() {
		for (const holder of holders.values()) if (holder.kind === "global") return true;
		return false;
	}

	function pathHeld(path) {
		for (const holder of holders.values()) if (holder.kind === "path" && holder.path === path) return true;
		return false;
	}

	function anyPathActivity() {
		for (const holder of holders.values()) if (holder.kind === "path") return true;
		for (const queue of pathQueues.values()) if (queue.length > 0) return true;
		return false;
	}

	function takePath(ownerId, path) {
		return new Promise((grant) => {
			const id = ++seq;
			const take = () => {
				holders.set(id, { ownerId, kind: "path", path });
				grant(id);
			};
			if (!globalHeld() && !pathHeld(path) && (pathQueues.get(path)?.length ?? 0) === 0) {
				take();
				return;
			}
			const queue = pathQueues.get(path) ?? [];
			queue.push({ ownerId, take });
			pathQueues.set(path, queue);
		});
	}

	function takeGlobal(ownerId) {
		return new Promise((grant) => {
			const id = ++seq;
			const take = () => {
				holders.set(id, { ownerId, kind: "global" });
				grant(id);
			};
			if (!globalHeld() && !anyPathActivity()) {
				take();
				return;
			}
			globalQueue.push({ ownerId, take });
		});
	}

	function drain() {
		if (globalHeld()) return;
		for (const [path, queue] of pathQueues) {
			if (queue.length === 0 || pathHeld(path)) continue;
			const next = queue.shift();
			next.take();
			if (queue.length === 0) pathQueues.delete(path);
		}
		if (!globalHeld() && !anyPathActivity() && globalQueue.length > 0) {
			globalQueue.shift().take();
		}
	}

	async function acquire(ownerId, kind, targets) {
		if (kind === "global") {
			const id = await takeGlobal(ownerId);
			return { ownerId, kind: "global", targets: [], ids: [id] };
		}
		const paths = [...new Set((Array.isArray(targets) ? targets : [targets]).map(normalizeLockPath))].sort();
		const ids = [];
		for (const path of paths) ids.push(await takePath(ownerId, path));
		return { ownerId, kind: "path", targets: paths, ids };
	}

	function release(token) {
		if (!token || !Array.isArray(token.ids)) return false;
		let released = false;
		for (const id of token.ids) {
			const holder = holders.get(id);
			if (holder === undefined || holder.ownerId !== token.ownerId) continue;
			holders.delete(id);
			released = true;
		}
		if (released) drain();
		return released;
	}

	function releaseOwner(ownerId) {
		const ids = [];
		for (const [id, holder] of holders) if (holder.ownerId === ownerId) ids.push(id);
		for (const queue of pathQueues.values()) {
			for (let index = queue.length - 1; index >= 0; index -= 1) {
				if (queue[index].ownerId === ownerId) queue.splice(index, 1);
			}
		}
		for (let index = globalQueue.length - 1; index >= 0; index -= 1) {
			if (globalQueue[index].ownerId === ownerId) globalQueue.splice(index, 1);
		}
		for (const id of ids) holders.delete(id);
		if (ids.length > 0) drain();
		return ids.length;
	}

	function snapshot() {
		let kind = "idle";
		for (const holder of holders.values()) {
			kind = holder.kind === "global" ? "global" : "paths";
			break;
		}
		return { kind, holders: [...holders.entries()].map(([id, holder]) => ({ id, ...holder })) };
	}

	function assertInvariant() {
		let globals = 0;
		let paths = 0;
		const seen = new Set();
		for (const holder of holders.values()) {
			if (holder.kind === "global") globals += 1;
			else {
				paths += 1;
				if (seen.has(holder.path)) throw new Error(`write-actor invariant: duplicate holder for ${holder.path}`);
				seen.add(holder.path);
			}
		}
		if (globals > 1) throw new Error("write-actor invariant: multiple global holders");
		if (globals === 1 && paths > 0) throw new Error("write-actor invariant: global and path holders coexist");
		return snapshot();
	}

	return { acquire, release, releaseOwner, snapshot, assertInvariant };
}

export function getWriteActor() {
	let actor = globalThis[ACTOR_KEY];
	if (actor === undefined) {
		actor = createWriteActor();
		globalThis[ACTOR_KEY] = actor;
	}
	return actor;
}
