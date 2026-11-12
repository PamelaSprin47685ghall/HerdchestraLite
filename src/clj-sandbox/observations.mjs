/**
 * Session/actor-scoped observed file facts.
 *
 * A batch read is program-private. `board_finish` can depend on facts read by
 * earlier programs in the same actor term. This ledger keeps the latest
 * observation per path, per `{sessionKey, actorId, termId}`, until the term is
 * retired. It never accepts a dependency path that was not observed.
 *
 * `verifyObservedFacts` is called while the caller already holds the write
 * gate. It checks for unobserved paths first and performs no lstat for them.
 * Only observed dependency paths are re-stamped.
 */

import { lstatSync } from "node:fs";
import { herdError } from "../util/errors.mjs";

const NS_PER_SECOND = 1_000_000_000n;

function invalid(argument, expected, actual) {
	return herdError(":INVALID_ARGUMENT", `observed facts require ${argument} to be ${expected}`, {
		argument,
		expected,
		actual,
	});
}

function requireScope(scope) {
	if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
		throw invalid("scope", "an object", scope);
	}
	for (const key of ["sessionKey", "actorId", "termId"]) {
		if (typeof scope[key] !== "string" || scope[key].length === 0) {
			throw invalid(`scope.${key}`, "a non-empty string", scope[key]);
		}
	}
	return scope;
}

function actorKey(scope) {
	return `${scope.sessionKey}\u0000${scope.actorId}\u0000${scope.termId}`;
}

export function createStampFromStats(stats) {
	const mtimeNs = stats?.mtimeNs;
	const size = stats?.size;
	if (typeof mtimeNs !== "bigint" || typeof size !== "bigint") {
		throw invalid("lstat stamp", "bigint mtimeNs and size", stats);
	}
	const mtimeSec = mtimeNs >= 0n ? mtimeNs / NS_PER_SECOND : (mtimeNs - (NS_PER_SECOND - 1n)) / NS_PER_SECOND;
	return {
		mtimeSec,
		mtimeNsec: mtimeNs - mtimeSec * NS_PER_SECOND,
		size,
	};
}

export function observationKind(stats) {
	if (!stats) return "missing";
	if (stats.isDirectory()) return "dir";
	if (stats.isFile()) return "file";
	if (stats.isSymbolicLink()) return "symlink";
	return "other";
}

function sameStamp(left, right) {
	return (
		left !== null &&
		right !== null &&
		left.mtimeSec === right.mtimeSec &&
		left.mtimeNsec === right.mtimeNsec &&
		left.size === right.size
	);
}

function copyEntry(entry) {
	return {
		path: entry.path,
		exists: entry.exists === true,
		kind: entry.kind,
		stamp: entry.stamp === null || entry.stamp === undefined ? null : { ...entry.stamp },
		size: entry.size ?? entry.stamp?.size ?? null,
	};
}

function defaultLstat(path) {
	try {
		return lstatSync(path, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
		throw error;
	}
}

/**
 * Create one ledger. `lstat` is injectable for tests; production omits it.
 */
export function createObservationLedger({ lstat = defaultLstat } = {}) {
	if (typeof lstat !== "function") throw invalid("lstat", "a function", lstat);
	const actors = new Map();
	const retired = new Set();
	const sessionActors = new Map();
	let epochCounter = 0;

	function actorFor(scope, create) {
		const key = actorKey(scope);
		if (retired.has(key)) return null;
		let actor = actors.get(key);
		if (actor === undefined && create) {
			actor = { epoch: ++epochCounter, entries: new Map() };
			actors.set(key, actor);
			let keys = sessionActors.get(scope.sessionKey);
			if (keys === undefined) {
				keys = new Set();
				sessionActors.set(scope.sessionKey, keys);
			}
			keys.add(key);
		}
		return actor ?? null;
	}

	function observe(scope, entry) {
		const normalized = requireScope(scope);
		if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0) {
			throw invalid("entry.path", "a non-empty string", entry?.path);
		}
		const actor = actorFor(normalized, true);
		if (actor === null) {
			throw herdError(":STALE_CONTROL", "observed fact belongs to a retired term", {
				...normalized,
				path: entry.path,
				next: "register a new term or re-read the dependency",
			});
		}
		actor.entries.set(entry.path, copyEntry(entry));
		return { ok: true };
	}

	function observeReadSet(scope, entries) {
		const normalized = requireScope(scope);
		const list = Array.from(entries ?? []);
		for (const entry of list) observe(normalized, entry);
		return { ok: true, observed: list.length };
	}

	function readSetForActor(scope) {
		const normalized = requireScope(scope);
		const actor = actorFor(normalized, false);
		if (actor === null) {
			return {
				ok: false,
				code: ":STALE_CONTROL",
				reason: "actor-term-unknown-or-retired",
				...normalized,
			};
		}
		return {
			ok: true,
			credential: {
				...normalized,
				epoch: actor.epoch,
				entries: [...actor.entries.values()].map(copyEntry),
			},
		};
	}

	function verifyObservedFacts(credential, paths) {
		if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
			throw invalid("credential", "a credential object", credential);
		}
		const scope = requireScope(credential);
		if (!Array.isArray(credential.entries) || !Number.isSafeInteger(credential.epoch)) {
			throw invalid("credential.entries/epoch", "an entries array and integer epoch", credential);
		}
		if (!Array.isArray(paths)) throw invalid("paths", "an array of paths", paths);
		const actor = actorFor(scope, false);
		if (actor === null || actor.epoch !== credential.epoch) {
			return {
				ok: false,
				code: ":STALE_CONTROL",
				reason: "credential-stale",
				missing: [],
				checked: [],
			};
		}
		const observed = actor.entries;
		const unique = [...new Set(paths)];
		for (const path of unique) {
			if (typeof path !== "string" || path.length === 0) throw invalid("paths[]", "a non-empty string", path);
		}
		const missing = unique.filter((path) => !observed.has(path));
		if (missing.length > 0) {
			return {
				ok: false,
				code: ":STALE_CONTROL",
				reason: "unobserved-dependency",
				missing,
				checked: [],
			};
		}
		const conflicts = [];
		const checked = [];
		for (const path of unique) {
			const expected = observed.get(path);
			const stats = lstat(path);
			const current = stats
				? { exists: true, kind: observationKind(stats), stamp: createStampFromStats(stats) }
				: { exists: false, kind: "missing", stamp: null };
			checked.push(path);
			if (expected.exists !== current.exists) {
				conflicts.push({
					code: ":STRUCTURE_CONFLICT",
					path,
					reason: expected.exists ? "path-missing" : "path-appeared",
					expected,
					current,
				});
				continue;
			}
			if (!expected.exists) continue;
			if (expected.kind !== current.kind) {
				conflicts.push({
					code: ":STRUCTURE_CONFLICT",
					path,
					reason: "type-changed",
					expected,
					current,
				});
				continue;
			}
			if (!sameStamp(expected.stamp, current.stamp)) {
				conflicts.push({
					code: ":FILE_CONFLICT",
					path,
					reason: "stamp-mismatch",
					expected,
					current,
				});
			}
		}
		if (conflicts.length > 0) {
			return {
				ok: false,
				code: conflicts[0].code,
				reason: "observed-fact-conflict",
				missing: [],
				checked,
				conflicts,
			};
		}
		return { ok: true, checked, missing: [] };
	}

	function retireActor(scope) {
		const normalized = requireScope(scope);
		const key = actorKey(normalized);
		const existed = actors.delete(key);
		retired.add(key);
		const keys = sessionActors.get(normalized.sessionKey);
		keys?.delete(key);
		if (keys?.size === 0) sessionActors.delete(normalized.sessionKey);
		return { ok: true, retired: existed };
	}

	function retireSession(sessionKey) {
		if (typeof sessionKey !== "string" || sessionKey.length === 0) {
			throw invalid("sessionKey", "a non-empty string", sessionKey);
		}
		const keys = sessionActors.get(sessionKey);
		let retiredCount = 0;
		if (keys !== undefined) {
			for (const key of keys) {
				if (actors.delete(key)) retiredCount += 1;
				retired.add(key);
			}
			sessionActors.delete(sessionKey);
		}
		return { ok: true, retired: retiredCount };
	}

	return {
		observe,
		observeReadSet,
		readSetForActor,
		verifyObservedFacts,
		retireActor,
		retireSession,
	};
}
