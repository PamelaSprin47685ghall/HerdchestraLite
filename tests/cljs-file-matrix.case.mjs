import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nbb from "nbb";
import { ensureModules } from "./helpers/nbb-boot.mjs";

let root;
let evalClj;

async function statJson(file) {
	return evalClj(
		`(-> (herd.sandbox/stat {:path ${JSON.stringify(file)}})
		     (.then (fn [s] (js/JSON.stringify (clj->js s)))))`,
	);
}

function stampLiteral(stamp) {
	return ` :expected-stamp {:mtime-sec ${stamp["mtime-sec"]} :mtime-nsec ${stamp["mtime-nsec"]} :size ${stamp.size}}`;
}

function writeClj(file, content, stamp = null) {
	return evalClj(
		`(-> (herd.sandbox/write {:path ${JSON.stringify(file)} :content ${JSON.stringify(content)}${stamp === null ? "" : stampLiteral(stamp)}})
		     (.then (fn [_] "ok"))
		     (.catch (fn [e] (str (or (:code (ex-data e)) (.-code e) (.-message e) e)))))`,
	);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "herd-file-matrix-"));
	globalThis.__herdLockRoot = root;
	globalThis.__herdNative = {
		getRunner: () => ({
			hasNativeTool: (name) => name === "read" || name === "write",
			invokeNativeTool: async (name, params) => {
				if (name === "read") return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
				await writeFile(params.path, params.content, "utf8");
				return { content: [] };
			},
		}),
	};
	await ensureModules(["sandbox"]);
	evalClj = (code) => nbb.loadString(code);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("file matrix: stat/stamp contract", () => {
	it("F01: rejects a stale expected-stamp and keeps the external content", async () => {
		const file = join(root, "f01.txt");
		await writeFile(file, "v1");
		const first = JSON.parse(await statJson(file));
		expect(first.exists).toBe(true);
		expect(typeof first["mtime-sec"]).toBe("number");
		expect(typeof first["mtime-nsec"]).toBe("number");
		expect(typeof first.size).toBe("number");
		expect(typeof first["is-dir"]).toBe("boolean");

		await writeFile(file, "v2");
		const conflict = await writeClj(file, "v3", first);
		expect(conflict).toContain("FILE_CONFLICT");
		expect(await readFile(file, "utf8")).toBe("v2");

		const second = JSON.parse(await statJson(file));
		const ok = await writeClj(file, "v3", second);
		expect(ok).toBe("ok");
		expect(await readFile(file, "utf8")).toBe("v3");
	});

	it("F03: keeps earlier writes when a later target is structurally invalid", async () => {
		const one = join(root, "f03-one.txt");
		const two = join(root, "f03-two.txt");
		const blocked = join(root, "f03-blocked");
		await mkdir(blocked, { recursive: true });

		const result = await evalClj(
			`(-> (herd.sandbox/write {:path ${JSON.stringify(one)} :content "one"})
			     (.then (fn [_] (herd.sandbox/write {:path ${JSON.stringify(two)} :content "two"})))
			     (.then (fn [_] (herd.sandbox/write {:path ${JSON.stringify(blocked)} :content "three"})))
			     (.then (fn [_] "unexpected"))
			     (.catch (fn [e] (str (or (:code (ex-data e)) (.-code e) (.-message e) e)))))`,
		);
		expect(result).not.toBe("unexpected");
		expect(result).toContain("EISDIR");
		expect(await readFile(one, "utf8")).toBe("one");
		expect(await readFile(two, "utf8")).toBe("two");
	});

	it("F09: accepts an old stamp when only atime changed", async () => {
		const file = join(root, "f09.txt");
		await writeFile(file, "stable");
		const base = new Date(1000000000000);
		await utimes(file, base, base);
		const stamp = JSON.parse(await statJson(file));
		expect(stamp["mtime-sec"]).toBe(1000000000);
		expect(stamp["mtime-nsec"]).toBe(0);

		await utimes(file, new Date(1000000000000 + 60000), base);
		const ok = await writeClj(file, "updated", stamp);
		expect(ok).toBe("ok");
		expect(await readFile(file, "utf8")).toBe("updated");
	});

	it("F04: moves to a new path and then writes it", async () => {
		const source = join(root, "f04-old.txt");
		const target = join(root, "f04-new.txt");
		await writeFile(source, "moved");
		const moved = await evalClj(
			`(-> (herd.sandbox/mv {:source ${JSON.stringify(source)} :target ${JSON.stringify(target)}})
			     (.then (fn [_] "ok"))
			     (.catch (fn [e] (str (or (:code (ex-data e)) (.-code e) (.-message e) e)))))`,
		);
		expect(moved).toBe("ok");
		const written = await writeClj(target, "after-move");
		expect(written).toBe("ok");
		expect(await readFile(target, "utf8")).toBe("after-move");

		const removedDir = join(root, "f04-dir");
		await mkdir(removedDir, { recursive: true });
		await writeFile(join(removedDir, "keep.txt"), "keep");
		const removed = await evalClj(
			`(-> (herd.sandbox/rm {:path ${JSON.stringify(removedDir)}})
			     (.then (fn [_] "ok"))
			     (.catch (fn [e] (str (or (:code (ex-data e)) (.-code e) (.-message e) e)))))`,
		);
		expect(removed).toBe("ok");
		expect(JSON.parse(await statJson(removedDir)).exists).toBe(false);

		const blocked = await writeClj(join(removedDir, "new.txt"), "nope");
		expect(blocked).not.toBe("ok");
		expect(blocked).toMatch(/ENOENT|EISDIR|ENOTDIR/);
		expect(await readFile(join(removedDir, "keep.txt"), "utf8").catch(() => "gone")).toBe("gone");
	});

	it("F07: allows cat and stat reads without waiting while call holds the write lock W", async () => {
		const target = join(root, "f07.txt");
		await writeFile(target, "before-call");
		const out = JSON.parse(
			await evalClj(
				`(-> (let [p (herd.sandbox/call {:argv ["sh" "-c" "sleep 0.25; printf done"] :name "f07-call"} 5000)]
				       (-> (herd.sandbox/await-call-start "f07-call")
				           (.then (fn [_]
				                    (js/Promise.all
				                      #js [(herd.sandbox/cat {:path ${JSON.stringify(target)}})
				                           (herd.sandbox/stat {:path ${JSON.stringify(target)}})
				                           (js/Promise.resolve (some? (@herd.sandbox/active-calls "f07-call")))])))
				           (.then (fn [arr]
				                    (let [during-cat (aget arr 0)
				                          during-stat (aget arr 1)
				                          call-still-active (aget arr 2)]
				                      (-> p
				                          (.then (fn [res]
				                                   (js/JSON.stringify
				                                     (clj->js {:cat during-cat
				                                               :exists (:exists during-stat)
				                                               :size (:size during-stat)
				                                               :call-active call-still-active
				                                               :exit (:exit res)}))))))))))
				 )`,
			),
		);
		expect(out.cat).toBe("before-call");
		expect(out.exists).toBe(true);
		expect(out.size).toBe(11);
		expect(out["call-active"]).toBe(true);
		expect(out.exit).toBe(0);
	});

	it("F02: rejects when a read-only dependency stamp changes even if target stamp is unchanged", async () => {
		const api = join(root, "f02-api.txt");
		const client = join(root, "f02-client.txt");
		await writeFile(api, "v1");
		await writeFile(client, "c1");
		const apiStamp = JSON.parse(await statJson(api));
		const clientStamp = JSON.parse(await statJson(client));

		await writeFile(api, "v2-breaking");
		const res = await evalClj(
			`(-> (herd.sandbox/stat {:path ${JSON.stringify(api)}})
			     (.then (fn [cur]
			              (if (or (not= (:mtime-sec cur) ${apiStamp["mtime-sec"]})
			                      (not= (:mtime-nsec cur) ${apiStamp["mtime-nsec"]})
			                      (not= (:size cur) ${apiStamp.size}))
			                (js/Promise.reject (ex-info "FILE_CONFLICT: dependency changed" {:code :FILE_CONFLICT}))
			                (herd.sandbox/write {:path ${JSON.stringify(client)} :content "c2"${stampLiteral(clientStamp)}}))))
			     (.then (fn [_] "ok"))
			     (.catch (fn [e] (str (or (:code (ex-data e)) (.-message e) e)))))`,
		);
		expect(res).toContain("FILE_CONFLICT");
		expect(await readFile(client, "utf8")).toBe("c1");
	});

	it("F05: keeps current write on cancellation and skips subsequent steps", async () => {
		const f1 = join(root, "f05-1.txt");
		const f2 = join(root, "f05-2.txt");
		const f3 = join(root, "f05-3.txt");
		const res = await evalClj(
			`(-> (herd.sandbox/write {:path ${JSON.stringify(f1)} :content "step1"})
			     (.then (fn [_] (herd.sandbox/write {:path ${JSON.stringify(f2)} :content "step2"})))
			     (.then (fn [_] (js/Promise.reject (ex-info "AUDIT_ABORTED: cancelled mid-sequence" {:code :AUDIT_ABORTED}))))
			     (.then (fn [_] (herd.sandbox/write {:path ${JSON.stringify(f3)} :content "step3"})))
			     (.then (fn [_] "ok"))
			     (.catch (fn [e] (str (or (:code (ex-data e)) (.-message e) e)))))`,
		);
		expect(res).toContain("AUDIT_ABORTED");
		expect(await readFile(f1, "utf8")).toBe("step1");
		expect(await readFile(f2, "utf8")).toBe("step2");
		expect(await readFile(f3, "utf8").catch(() => "missing")).toBe("missing");
	});

	it("F08: accepts write when external edit preserves exact mtime and size (A02-15 boundary)", async () => {
		const file = join(root, "f08.txt");
		await writeFile(file, "aaaa");
		const base = new Date(1700000000000);
		await utimes(file, base, base);
		const stamp = JSON.parse(await statJson(file));

		await writeFile(file, "bbbb");
		await utimes(file, base, base);
		const ok = await writeClj(file, "cccc", stamp);
		expect(ok).toBe("ok");
		expect(await readFile(file, "utf8")).toBe("cccc");
	});

	it("F10: allows stale observation summary without blocking, requiring successor re-read", async () => {
		const file = join(root, "f10.txt");
		await writeFile(file, "compat-present");
		const observed = await evalClj(`(herd.sandbox/cat {:path ${JSON.stringify(file)}})`);
		expect(observed).toBe("compat-present");

		await writeFile(file, "compat-removed");
		const latest = await evalClj(`(herd.sandbox/cat {:path ${JSON.stringify(file)}})`);
		expect(latest).toBe("compat-removed");
	});

	it("F11: queues write behind call holding W without stealing W and completes after call releases", async () => {
		const file = join(root, "f11.txt");
		await writeFile(file, "init");
		const out = JSON.parse(
			await evalClj(
				`(-> (let [order (atom [])
				           p (herd.sandbox/call {:argv ["sh" "-c" "sleep 0.15; printf done"] :name "f11-call"} 5000)]
				       (-> (herd.sandbox/await-call-start "f11-call")
				           (.then (fn [_]
				                    (let [w (-> (herd.sandbox/write {:path ${JSON.stringify(file)} :content "after-call"})
				                                (.then (fn [_] (swap! order conj :write))))
				                          c (-> p
				                                (.then (fn [res] (swap! order conj :call) res)))]
				                      (js/Promise.all #js [c w]))))
				           (.then (fn [arr]
				                    (let [call-res (aget arr 0)]
				                      (js/JSON.stringify
				                        (clj->js {:order @order
				                                  :exit (:exit call-res)}))))))))`,
			),
		);
		expect(out.order).toEqual(["call", "write"]);
		expect(out.exit).toBe(0);
		expect(await readFile(file, "utf8")).toBe("after-call");
	});

	it("F12: tracks active call while running and releases W once outermost command exits", async () => {
		const out = JSON.parse(
			await evalClj(
				`(-> (let [p (herd.sandbox/call {:argv ["sh" "-c" "sleep 0.15; printf ok"] :name "f12-call"} 5000)]
				       (-> (herd.sandbox/await-call-start "f12-call")
				           (.then (fn [_]
				                    (let [active-mid (some? (@herd.sandbox/active-calls "f12-call"))]
				                      (-> p
				                          (.then (fn [res]
				                                   (js/JSON.stringify
				                                     (clj->js {:active-mid active-mid
				                                               :active-end (some? (@herd.sandbox/active-calls "f12-call"))
				                                               :exit (:exit res)})))))))))))`,
			),
		);
		expect(out["active-mid"]).toBe(true);
		expect(out["active-end"]).toBe(false);
		expect(out.exit).toBe(0);
	});

	it("F13: keeps first write and leaves third unwritten on mid-sequence native write failure", async () => {
		const f1 = join(root, "f13-1.txt");
		const f2 = join(root, "f13-2.txt");
		const f3 = join(root, "f13-3.txt");
		const origNative = globalThis.__herdNative;
		globalThis.__herdNative = {
			getRunner: () => ({
				hasNativeTool: (name) => name === "read" || name === "write",
				invokeNativeTool: async (name, params) => {
					if (name === "write" && params.path === f2) {
						throw new Error("simulated crash on second write");
					}
					if (name === "read") return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
					await writeFile(params.path, params.content, "utf8");
					return { content: [] };
				},
			}),
		};
		try {
			const res = await evalClj(
				`(-> (herd.sandbox/write {:path ${JSON.stringify(f1)} :content "first"})
				     (.then (fn [_] (herd.sandbox/write {:path ${JSON.stringify(f2)} :content "second"})))
				     (.then (fn [_] (herd.sandbox/write {:path ${JSON.stringify(f3)} :content "third"})))
				     (.then (fn [_] "ok"))
				     (.catch (fn [e] (str (.-message e)))))`,
			);
			expect(res).toContain("simulated crash on second write");
			expect(await readFile(f1, "utf8")).toBe("first");
			expect(await readFile(f2, "utf8").catch(() => "missing")).toBe("missing");
			expect(await readFile(f3, "utf8").catch(() => "missing")).toBe("missing");
		} finally {
			globalThis.__herdNative = origNative;
		}
	});

	it("F14: documents best-effort boundary when external writer mutates file outside protocol", async () => {
		const file = join(root, "f14.txt");
		await writeFile(file, "initial");
		const s1 = JSON.parse(await statJson(file));
		expect(await writeClj(file, "protocol-write", s1)).toBe("ok");
		await writeFile(file, "external-bypass");
		expect(await readFile(file, "utf8")).toBe("external-bypass");
	});
});
