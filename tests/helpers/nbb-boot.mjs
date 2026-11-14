import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";
import { installFakeClock } from "../fake-clock.mjs";

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const HERD_SRC = fileURLToPath(new URL("../../src/herd/", import.meta.url));
const CACHE_ROOT = fileURLToPath(new URL("../../.herd/eval/herd-src/", import.meta.url));

if (!globalThis.__herdTestNbbBoot) {
	globalThis.__herdTestNbbBoot = {
		sharedClock: null,
		initPromise: null,
		loaded: new Set(),
		bootstrapped: false,
		bootstrapPromise: null,
	};
}
const state = globalThis.__herdTestNbbBoot;

async function isFresh(sourcePath, targetPath) {
	try {
		const [srcStat, dstStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
		return srcStat.mtimeMs <= dstStat.mtimeMs;
	} catch {
		return false;
	}
}

async function ensureBase() {
	if (!state.initPromise) {
		state.initPromise = (async () => {
			nbb.addClassPath(SRC_ROOT);
			await mkdir(join(CACHE_ROOT, "herd"), { recursive: true });
			await nbb.loadFile(join(HERD_SRC, "ufss.cljs"));
			nbb.addClassPath(CACHE_ROOT);
		})();
	}
	return state.initPromise;
}

export async function ensureModules(modules) {
	await ensureBase();
	const pending = modules.filter((name) => !state.loaded.has(name));
	if (pending.length === 0) return CACHE_ROOT;
	const targets = await Promise.all(
		pending.map(async (name) => {
			const srcPath = join(HERD_SRC, `${name}.cljs`);
			const dstPath = join(CACHE_ROOT, "herd", `${name}.cljs`);
			if (!(await isFresh(srcPath, dstPath))) {
				const source = await readFile(srcPath, "utf8");
				const unwrapped = await nbb.loadString(`(require '[herd.ufss :as u]) (u/unwrap ${JSON.stringify(source)})`);
				await mkdir(dirname(dstPath), { recursive: true });
				await writeFile(dstPath, unwrapped, "utf8");
			}
			return dstPath;
		}),
	);
	for (let i = 0; i < pending.length; i += 1) {
		if (!state.loaded.has(pending[i])) {
			await nbb.loadFile(targets[i]);
			state.loaded.add(pending[i]);
		}
	}
	return CACHE_ROOT;
}

export async function ensureBootstrap() {
	if (!state.bootstrapPromise) {
		state.bootstrapPromise = (async () => {
			nbb.addClassPath(SRC_ROOT);
			await nbb.loadFile(join(HERD_SRC, "bootstrap.cljs"));
			state.bootstrapped = true;
		})();
	}
	return state.bootstrapPromise;
}

export function isBootstrapped() {
	return state.bootstrapped;
}

export async function ensureActivated() {
	const first = !state.bootstrapped;
	await ensureBootstrap();
	if (!first) {
		await nbb.loadString("(herd.main/activate-session! js/globalThis.__pi)");
	}
}

export function getSharedClock() {
	if (!state.sharedClock) {
		state.sharedClock = installFakeClock();
	}
	return state.sharedClock;
}
