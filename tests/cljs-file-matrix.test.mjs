import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nbb from "nbb";

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
				if (name === "read") {
					return { content: [{ type: "text", text: await readFile(params.path, "utf8") }] };
				}
				await writeFile(params.path, params.content, "utf8");
				return { content: [] };
			},
		}),
	};
	nbb.addClassPath(fileURLToPath(new URL("../src/", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("../src/herd/ufss.cljs", import.meta.url)));
	globalThis.__sandboxSource = await readFile(
		fileURLToPath(new URL("../src/herd/sandbox.cljs", import.meta.url)),
		"utf8",
	);
	const unwrapped = await nbb.loadString("(herd.ufss/unwrap (.-__sandboxSource js/globalThis))");
	const generated = join(root, "generated");
	await mkdir(join(generated, "herd"), { recursive: true });
	await writeFile(join(generated, "herd", "sandbox.cljs"), unwrapped, "utf8");
	nbb.addClassPath(generated);
	await nbb.loadFile(join(generated, "herd", "sandbox.cljs"));
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
});
