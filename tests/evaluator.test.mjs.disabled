import { describe, expect, it } from "bun:test";
import {
	abandonedCapabilities,
	abortProgram,
	abortSession,
	createSandboxSession,
	isSandboxError,
	parkedNames,
	runProgram,
	unpark,
} from "../src/clj-sandbox/evaluator.mjs";
import { EdnKeyword, printUfss, readUfss, renderReceipt } from "../src/clj-sandbox/ufss.mjs";
import { loadCherry } from "../src/host/imports.mjs";

const INTENT = "evaluate this program";

function field(map, name) {
	for (const [key, value] of map) {
		if (key instanceof EdnKeyword && key.name === name) {
			return value;
		}
	}
	return undefined;
}

function stateOf(receipt) {
	return field(receipt, "state")?.name;
}

function keywordOf(value) {
	return value instanceof EdnKeyword ? value.name : value;
}

function codeOf(error) {
	return String(error?.code ?? "").replace(/^:/, "");
}

function makeHarness(options = {}) {
	const files = new Map(Object.entries(options.files ?? { "a.txt": "alpha" }));
	const batches = new Map();
	const calls = [];
	const allowed = options.allowed ?? [
		"cat",
		"stat",
		"ls",
		"write",
		"mkdir",
		"rm",
		"mv",
		"call",
		"where",
		"whereAll",
		"park",
		"unpark",
	];
	const extra = options.capabilities ?? {};

	const session = createSandboxSession({
		agentId: "agent-1",
		role: options.role ?? "worker",
		allowedCapabilities: allowed,
		createCapabilities: ({ programName }) => {
			const batch = { pending: new Map(), commits: 0, discards: 0, readSets: [] };
			batches.set(programName, batch);
			const allCapabilities = {
				cat: ({ path }) => {
					if (!files.has(path)) {
						throw Object.assign(new Error(`missing ${path}`), { code: "INVALID_ARGUMENT" });
					}
					const content = files.get(path);
					return {
						content,
						stamp: { mtimeSec: 1n, mtimeNsec: 2n, size: BigInt(content.length) },
					};
				},
				stat: ({ path }) => ({
					exists: files.has(path),
					size: files.has(path) ? files.get(path).length : 0,
					stamp: { mtimeSec: 1n, mtimeNsec: 2n, size: BigInt(files.get(path)?.length ?? 0) },
				}),
				ls: () => ({ entries: [] }),
				write: ({ path, content }) => {
					batch.pending.set(path, content);
					return null;
				},
				mkdir: ({ path }) => {
					batch.pending.set(path, null);
					return null;
				},
				rm: ({ path }) => {
					batch.pending.set(path, null);
					return null;
				},
				mv: ({ source, target }) => {
					batch.pending.set(source, target);
					return null;
				},
				call: ({ command }) => {
					calls.push(command);
					return { ok: true, stdout: "" };
				},
				...extra,
			};
			const granted = {};
			const allowedSet = new Set(allowed);
			for (const [name, fn] of Object.entries(allCapabilities)) {
				if (allowedSet.has(name)) {
					granted[name] = fn;
				}
			}
			return granted;
		},
		ports: {
			commit: ({ program, readSet }) => {
				const batch = batches.get(program.name);
				batch.commits += 1;
				batch.readSets.push(readSet);
				for (const [path, content] of batch.pending) {
					files.set(path, content);
				}
				batch.pending.clear();
				return { applied: true };
			},
			discard: ({ program }) => {
				const batch = batches.get(program.name);
				batch.discards += 1;
				batch.pending.clear();
			},
			...(options.ports ?? {}),
		},
		limits: {
			now: options.now ?? Date.now,
			deadlineCheckInterval: options.deadlineCheckInterval ?? 1,
		},
	});

	return { session, files, batches, calls };
}

function run(session, name, code, options = {}) {
	return runProgram(session, { name, code, intent: INTENT, ...options });
}

async function captureRejection(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

describe("pure evaluation", () => {
	it("evaluates literals, let bindings, maps, vectors, and sets", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"literals",
			`(defprogram literals []
			   (let [x 2 y 3]
			     {:sum (+ x y)
			      :items [nil true "x" :k]
			      :tags #{1 2 3}
			      :nested {:ok (get {:a 1} :a)}}))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(field(value, "sum")).toBe(5);
		expect(field(value, "items")).toEqual([null, true, "x", field(value, "items")[3]]);
		expect(keywordOf(field(value, "items")[3])).toBe("k");
		expect(field(value, "tags")).toBeInstanceOf(Set);
		expect(field(value, "tags").size).toBe(3);
		expect(field(field(value, "nested"), "ok")).toBe(1);
	});

	it("creates closures and evaluates named recursive functions", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"closures",
			`(defprogram closures []
			   (let [make (fn [x] (fn [y] (+ x y)))
			         add2 (make 2)
			         fact (fn fact [n] (if (<= n 1) 1 (* n (fact (dec n)))))]
			     [(add2 40) (fact 5)]))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([42, 120]);
	});

	it("supports defn and multi-arity fn", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"multi-arity",
			`(defprogram multi-arity []
			   (defn f
			     ([x] (inc x))
			     ([x y] (+ x y)))
			   (defn g [x] (* x 2))
			   [(f 1) (f 2 3) (g 4)])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([2, 5, 8]);
	});

	it("supports try/catch/finally and binds the thrown value", async () => {
		const finalized = [];
		const { session } = makeHarness({
			allowed: ["boom", "record"],
			capabilities: {
				boom: () => {
					throw Object.assign(new Error("boom"), {
						code: "PREPARE_REJECTED",
						data: { reason: "injected" },
					});
				},
				record: () => {
					finalized.push(true);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"try-flow",
			`(defprogram try-flow []
			   [(try (throw {:x 1}) (catch e (get e :x)))
			    (try (boom {}) (catch e (:code e)))
			    (try 7 (finally (record {})))
			    (try (throw "x") (catch :default e e) (finally (record {})))
			    (try (try (throw "inner") (catch e (throw "catch-error")) (finally (record {})))
			      (catch e e))
			    (try (boom {}) (catch e (ex-message e)))
			    (try (throw {:message "custom"}) (catch e (ex-message e)))
			    (try 1)])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(1);
		expect(keywordOf(value[1])).toBe("PREPARE_REJECTED");
		expect(value[2]).toBe(7);
		expect(value[3]).toBe("x");
		expect(value[4]).toBe("catch-error");
		expect(value[5]).toBe("boom");
		expect(value[6]).toBe("custom");
		expect(value[7]).toBe(1);
		expect(finalized).toHaveLength(3);
	});

	it("matches the first catch clause by class or :default", async () => {
		const finalized = [];
		const { session } = makeHarness({
			allowed: ["boom", "record"],
			capabilities: {
				boom: () => {
					throw Object.assign(new Error("boom"), { code: "PREPARE_REJECTED" });
				},
				record: () => {
					finalized.push(true);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"multi-catch",
			`(defprogram multi-catch []
			   [(try (boom {})
			      (catch :PREPARE_REJECTED e [:code (:code e)])
			      (catch :default e [:fallback]))
			    (try (throw {:type :CustomError :x 1})
			      (catch :PREPARE_REJECTED e [:wrong])
			      (catch CustomError e [:custom (:x e)]))
			    (try (throw "plain")
			      (catch :PREPARE_REJECTED e [:wrong])
			      (catch :default e [:default e]))
			    (try (throw "unmatched")
			      (catch CustomError e [:wrong])
			      (finally (record {})))])`,
		);
		expect(stateOf(receipt)).toBe("failed");
		const error = field(receipt, "error");
		expect(keywordOf(field(error, "code"))).toBe("INVALID_ARGUMENT");
		expect(field(error, "data").value).toBe("unmatched");
		expect(finalized).toHaveLength(1);

		const caught = await run(
			session,
			"multi-catch-caught",
			`(defprogram multi-catch-caught []
			   [(try (boom {})
			      (catch :PREPARE_REJECTED e [:code (:code e)])
			      (catch :default e [:fallback]))
			    (try (throw {:type :CustomError :x 1})
			      (catch :PREPARE_REJECTED e [:wrong])
			      (catch CustomError e [:custom (:x e)]))
			    (try (throw "plain")
			      (catch :PREPARE_REJECTED e [:wrong])
			      (catch :default e [:default e]))])`,
		);
		expect(stateOf(caught)).toBe("completed");
		const value = field(caught, "value");
		expect(keywordOf(value[0][0])).toBe("code");
		expect(keywordOf(value[0][1])).toBe("PREPARE_REJECTED");
		expect(keywordOf(value[1][0])).toBe("custom");
		expect(value[1][1]).toBe(1);
		expect(keywordOf(value[2][0])).toBe("default");
		expect(value[2][1]).toBe("plain");
	});

	it("memoizes successful calls by Clojure equality and retries failures", async () => {
		let calls = 0;
		let failures = 0;
		const { session } = makeHarness({
			allowed: ["tick", "fail"],
			capabilities: {
				tick: ({ x }) => {
					calls += 1;
					return x;
				},
				fail: () => {
					failures += 1;
					throw Object.assign(new Error("tick-failure"), { code: "PREPARE_REJECTED" });
				},
			},
		});
		const receipt = await run(
			session,
			"memoized",
			`(defprogram memoized []
			   (let [f (memoize (fn [x] (tick {:x x})))
			         g (memoize (fn [x] (if (= x 1) (fail {}) x)))]
			     [(f 1) (f 1) (f {:k [1 2]}) (f {:k [1 2]}) (f 2)
			      (try (g 1) (catch e [:failed (:code e)]))
			      (try (g 1) (catch e [:failed (:code e)]))
			      (g 2)]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(1);
		expect(value[1]).toBe(1);
		expect(field(value[2], "k")).toEqual([1, 2]);
		expect(field(value[3], "k")).toEqual([1, 2]);
		expect(value[4]).toBe(2);
		expect(keywordOf(value[5][0])).toBe("failed");
		expect(keywordOf(value[5][1])).toBe("PREPARE_REJECTED");
		expect(keywordOf(value[6][0])).toBe("failed");
		expect(value[7]).toBe(2);
		expect(calls).toBe(3);
		expect(failures).toBe(2);
	});

	it("supports doto and returns the first value", async () => {
		const seen = [];
		const { session } = makeHarness({
			allowed: ["record"],
			capabilities: {
				record: (value) => {
					seen.push(value);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"doto-flow",
			`(defprogram doto-flow []
			   (let [f (fn [x] (record {:seen x}))]
			     [(doto 7 (f))
			      (doto [1] (conj 2))
			      (doto {:a 1} (assoc :b 2))
			      (doto 3 (+ 10))]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(7);
		expect(value[1]).toEqual([1]);
		expect(field(value[2], "a")).toBe(1);
		expect(field(value[2], "b")).toBeUndefined();
		expect(value[3]).toBe(3);
		expect(seen).toHaveLength(1);
		expect(seen[0].seen).toBe(7);
	});

	it("supports transducers over eager and lazy collections", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"transducers",
			`(defprogram transducers []
			   [(into [] (map inc) [1 2 3])
			    (transduce (comp (map inc) (filter even?)) + 0 [1 2 3])
			    (transduce (map inc) + 10 [1 2 3])
			    (sequence (map inc) [1 2 3])
			    (vec (eduction (map inc) [1 2 3]))
			    (into [] (comp (map inc) (take 2)) [1 2 3])
			    (into [] cat [[1 2] [3]])
			    (into [] (distinct) [1 1 2])
			    (into [] (partition-all 2) [1 2 3])
			    (into [] (interpose ",") ["a" "b"])
			    (transduce (map inc) (completing +) [1 2 3])
			    (into [] (map inc) (take 3 (iterate inc 0)))
			    (transduce (map inc) + (take 4 (iterate inc 0)))
			    (into [] (map (fn [x] (* x 2))) [1])
			    (transduce (filter (fn [x] (odd? x))) (completing (fn [acc x] (+ acc x))) 0 [1 2 3 4])
			    (into [] (map inc) (eduction (filter even?) [1 2 3 4]))
			    (let [e (eduction (map inc) [1 2 3])]
			      [(vec e) (vec e)])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([2, 3, 4]);
		expect(value[1]).toBe(6);
		expect(value[2]).toBe(19);
		expect(value[3]).toEqual([2, 3, 4]);
		expect(value[4]).toEqual([2, 3, 4]);
		expect(value[5]).toEqual([2, 3]);
		expect(value[6]).toEqual([1, 2, 3]);
		expect(value[7]).toEqual([1, 2]);
		expect(value[8]).toEqual([[1, 2], [3]]);
		expect(value[9]).toEqual(["a", ",", "b"]);
		expect(value[10]).toBe(9);
		expect(value[11]).toEqual([1, 2, 3]);
		expect(value[12]).toBe(10);
		expect(value[13]).toEqual([2]);
		expect(value[14]).toBe(4);
		expect(value[15]).toEqual([2, 4]);
		expect(value[16]).toEqual([
			[2, 3, 4],
			[2, 3, 4],
		]);
	});

	it("drives transducers with async capabilities and keeps sequence lazy", async () => {
		let ticks = 0;
		const { session } = makeHarness({
			allowed: ["tick"],
			capabilities: {
				tick: async ({ x }) => {
					ticks += 1;
					await new Promise((resolve) => setTimeout(resolve, 1));
					return x * 10;
				},
			},
		});
		const lazy = await run(
			session,
			"lazy-sequence",
			`(defprogram lazy-sequence []
			   (let [s (sequence (map (fn [x] (tick {:x x}))) [1 2 3])
			         e (eduction (map (fn [x] (tick {:x x}))) [1 2 3])]
			     0))`,
		);
		expect(stateOf(lazy)).toBe("completed");
		expect(ticks).toBe(0);

		const consumed = await run(
			session,
			"async-transducer",
			`(defprogram async-transducer []
			   [(into [] (map (fn [x] (tick {:x x}))) [1 2 3])
			    (transduce (map (fn [x] (tick {:x x}))) (completing (fn [acc x] (+ acc x))) 0 [1 2])
			    (vec (sequence (filter (fn [x] (odd? x))) [1 2 3]))
			    (vec (sequence (take 3) (iterate inc 0)))
			    (vec (sequence [1 2]))
			    (reduce + (eduction (map inc) [1 2 3]))
			    (transduce (map (fn [x] x))
			      (completing (fn [acc x] (if (> x 2) (reduced acc) (+ acc x))))
			      0 [1 2 3 4])])`,
		);
		expect(stateOf(consumed)).toBe("completed");
		const value = field(consumed, "value");
		expect(value[0]).toEqual([10, 20, 30]);
		expect(value[1]).toBe(30);
		expect(value[2]).toEqual([1, 3]);
		expect(value[3]).toEqual([0, 1, 2]);
		expect(value[4]).toEqual([1, 2]);
		expect(value[5]).toBe(9);
		expect(value[6]).toBe(3);
		expect(ticks).toBe(5);
	});

	it("falls through unmatched inner catches, matches Error, and rejects late finally", async () => {
		const { session } = makeHarness({
			allowed: ["boom"],
			capabilities: {
				boom: () => {
					throw Object.assign(new Error("boom"), { code: "PREPARE_REJECTED" });
				},
			},
		});
		const receipt = await run(
			session,
			"catch-fallthrough",
			`(defprogram catch-fallthrough []
			   [(try (try (throw {:type :X}) (catch Other e :inner))
			      (catch :default e :outer))
			    (try (boom {}) (catch Error e :caught))
			    (try (boom {}) (catch js/Error e :caught-ns))
			    (cljs.core/memoize inc)])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(keywordOf(value[0])).toBe("outer");
		expect(keywordOf(value[1])).toBe("caught");
		expect(keywordOf(value[2])).toBe("caught-ns");

		const lateFinally = await captureRejection(
			run(session, "late-finally", `(defprogram late-finally [] (try 1 (finally 2) (catch e 3)))`),
		);
		expect(codeOf(lateFinally)).toBe("INVALID_ARGUMENT");
		const emptyStep = await captureRejection(run(session, "empty-doto", `(defprogram empty-doto [] (doto 1 ()))`));
		expect(codeOf(emptyStep)).toBe("INVALID_ARGUMENT");
		const missingCatchBinding = await captureRejection(
			run(session, "catch-no-binding", `(defprogram catch-no-binding [] (try 1 (catch Error)))`),
		);
		expect(codeOf(missingCatchBinding)).toBe("INVALID_ARGUMENT");
		const ambiguousCatch = await captureRejection(
			run(session, "catch-ambiguous", `(defprogram catch-ambiguous [] (try 1 (catch Error (get {:x 1} :x))))`),
		);
		expect(codeOf(ambiguousCatch)).toBe("INVALID_ARGUMENT");
	});

	it("carries halt-when final values through async transduce and into", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"halt-when-final",
			`(defprogram halt-when-final []
			   [(into [] (halt-when (fn [x] (= x 2))) [1 2 3])
			    (transduce (halt-when (fn [x] (= x 2))) + 0 [1 2 3])
			    (into [] (halt-when (fn [x] (= x 2)) (fn [acc x] [:halted acc x])) [1 2 3])
			    (vec (sequence (halt-when (fn [x] (= x 2))) [1 2 3]))
			    (transduce (halt-when (fn [x] (= x 2)) (fn [acc x] (+ acc x))) + 0 [1 2 3])
			    (into [] (halt-when even?) [1 2 3])
			    (transduce (halt-when even?) + 0 [1 2 3])
			    (into [] (eduction (halt-when (fn [x] (= x 2))) [1 2 3]))
			    (into [] (eduction (halt-when even?) [1 2 3]))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(2);
		expect(value[1]).toBe(2);
		expect(keywordOf(value[2][0])).toBe("halted");
		expect(value[2][1]).toEqual([1]);
		expect(value[2][2]).toBe(2);
		expect(value[3]).toEqual([1]);
		expect(value[4]).toBe(3);
		expect(value[5]).toBe(2);
		expect(value[6]).toBe(2);
		expect(value[7]).toBe(2);
		expect(value[8]).toBe(2);
	});

	it("evaluates loop/recur without growing the JavaScript stack", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"looping",
			`(defprogram looping []
			   (loop [i 0 acc []]
			     (if (< i 3)
			       (recur (inc i) (conj acc i))
			       acc)))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([0, 1, 2]);
	});

	it("rejects non-tail recur and allows recur in tail positions", async () => {
		const { session } = makeHarness({ allowed: [] });
		const nonTail = await captureRejection(
			run(session, "non-tail", "(defprogram non-tail [] (loop [i 0] (do (recur (inc i)) i)))"),
		);
		expect(codeOf(nonTail)).toBe("INVALID_ARGUMENT");

		const inTest = await captureRejection(
			run(session, "recur-in-test", "(defprogram recur-in-test [] (loop [i 0] (if (recur (inc i)) 1 2)))"),
		);
		expect(codeOf(inTest)).toBe("INVALID_ARGUMENT");

		const valid = await run(
			session,
			"tail-let",
			`(defprogram tail-let []
			   (loop [i 0]
			     (let [x i]
			       (if (< x 3) (recur (inc x)) x))))`,
		);
		expect(stateOf(valid)).toBe("completed");
		expect(field(valid, "value")).toBe(3);

		const ifLet = await run(
			session,
			"tail-if-let",
			`(defprogram tail-if-let []
			   (loop [i 0]
			     (if-let [x (when (< i 3) i)]
			       (recur (inc x))
			       i)))`,
		);
		expect(stateOf(ifLet)).toBe("completed");
		expect(field(ifLet, "value")).toBe(3);
	});

	it("supports threading macros and string/collection builtins", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"builtins",
			`(defprogram builtins []
			   [(-> 1 inc (* 2))
			    (->> [1 2 3] (mapv inc))
			    (str "a" nil 1 :k)
			    (subs "abcdef" 1 4)
			    (count [1 2 3])
			    (get (assoc {:a 1} :b 2) :b)
			    (contains? #{:a} :a)
			    (clojure.string/join "," ["a" "b"])
			    (clojure.set/union #{1} #{2})])`,
		);

		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(4);
		expect(value[1]).toEqual([2, 3, 4]);
		expect(value[2]).toBe("a1:k");
		expect(value[3]).toBe("bcd");
		expect(value[4]).toBe(3);
		expect(value[5]).toBe(2);
		expect(value[6]).toBe(true);
		expect(value[7]).toBe("a,b");
		expect(value[8]).toBeInstanceOf(Set);
		expect(value[8].size).toBe(2);
	});

	it("keeps keyword identity structural across reader and builtins", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"keyword-identity",
			`(defprogram keyword-identity []
			   (let [m {:a 1}
			         by-interning (assoc m (keyword "a") 2)
			         literal (get by-interning :a)]
			     [(= :a (keyword "a"))
			      (= (get m :a) 1)
			      literal
			      (count by-interning)
			      (= [1 2] (list 1 2))
			      (count (set [[1] [1]]))]))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([true, true, 2, 1, true, 1]);
	});

	it("normalizes capability objects into EDN maps with keyword keys", async () => {
		const { session } = makeHarness({
			allowed: ["info"],
			capabilities: {
				info: () => ({ answer: 42, tags: ["x", "y"] }),
			},
		});
		const receipt = await run(
			session,
			"normalized-capability",
			`(defprogram normalized-capability []
			   (let [m (info {})]
			     [(get m :answer) (get m "answer" 0) (= (get m :tags) ["x" "y"])]))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([42, 0, true]);
	});

	it("rejects a missing intent", async () => {
		const { session } = makeHarness({ allowed: [] });
		const error = await captureRejection(
			runProgram(session, { name: "no-intent", code: "(defprogram no-intent [] 1)" }),
		);
		expect(isSandboxError(error)).toBe(true);
		expect(codeOf(error)).toBe("INTENT_REQUIRED");
	});
});

describe("pure control macros and comprehensions", () => {
	it("expands pure control macros into existing forms", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"pure-macros",
			`(defprogram pure-macros []
			   [(when-not false 1 2)
			    (when-not true 1)
			    (if-not false "yes" "no")
			    (if-not true "yes")
			    (when-some [x 5] (+ x 1))
			    (when-some [x nil] 1)
			    (if-some [x false] "some" "nil")
			    (if-some [x nil] "some" "nil")
			    (cond-> 1 true (+ 2) false (* 100) true (* 3))
			    (some-> 5 inc inc)
			    (some-> {:a 1} :b inc)
			    (as-> 1 x (+ x 2) (* x 3))
			    (when-first [x [7 8]] x)
			    (when-first [x []] x)
			    (when-first [x (iterate (fn [x] (inc x)) 0)] x)
			    (case 2 1 "a" 2 "b" "c")
			    (case 3 (1 2) "low" (3 4) "mid" "high")
			    (case 9 1 "a" 2 "b" "c")
			    (case (quote b) a "A" b "B" "C")
			    (condp = 2 1 "a" 2 "b" "c")
			    (condp > 2 1 "small" 3 "big" "mid")
			    (condp + 2 1 :>> (fn [v] v) 3 "b" "c")])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			2,
			null,
			"yes",
			null,
			6,
			null,
			"some",
			"nil",
			9,
			7,
			null,
			9,
			7,
			null,
			0,
			"b",
			"mid",
			"c",
			"B",
			"b",
			"big",
			3,
		]);

		for (const [name, code] of [
			["case-miss", '(defprogram case-miss [] (case 9 1 "a"))'],
			["condp-miss", '(defprogram condp-miss [] (condp = 9 1 "a"))'],
		]) {
			const missed = await run(session, name, code);
			expect(stateOf(missed)).toBe("failed");
			expect(keywordOf(field(field(missed, "error"), "code"))).toBe("INVALID_ARGUMENT");
		}
	});

	it("supports recursive letfn definitions with async bodies", async () => {
		const { session } = makeHarness({
			allowed: ["bump"],
			capabilities: {
				bump: async ({ x }) => {
					await new Promise((resolve) => setTimeout(resolve, 1));
					return x + 1;
				},
			},
		});
		const receipt = await run(
			session,
			"letfn-recursive",
			`(defprogram letfn-recursive []
			   (let [base 10]
			     (letfn [(ev? [n] (if (= n 0) true (od? (- n 1))))
			             (od? [n] (if (= n 0) false (ev? (- n 1))))
			             (add ([x] (bump {:x (+ x base)})) ([x y] (+ x y base)))]
			       [(ev? 10) (od? 7) (add 1) (add 1 2)])))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([true, true, 12, 13]);

		const capture = await run(
			session,
			"letfn-capture",
			"(defprogram letfn-capture [] (let [base 10] (letfn [(f [x] (+ x base))] (f 5))))",
		);
		expect(field(capture, "value")).toBe(15);
	});

	it("evaluates for comprehensions lazily with bindings and modifiers", async () => {
		const { session } = makeHarness({
			allowed: ["keepx"],
			capabilities: {
				keepx: async ({ x }) => {
					await new Promise((resolve) => setTimeout(resolve, 1));
					return x > 1;
				},
			},
		});
		const receipt = await run(
			session,
			"for-comprehensions",
			`(defprogram for-comprehensions []
			   [(vec (for [x [1 2 3]] (* x 2)))
			    (vec (for [x [1 2] y [10 20]] [x y]))
			    (vec (for [x [1 2 3] :let [y (* x 10)] :when (odd? x)] [x y]))
			    (vec (for [x [1 2 3 4] :while (< x 3)] x))
			    (vec (for [x [1 2] y [1 2 3] :while (< y 3)] [x y]))
			    (vec (for [[a b] [[1 2] [3 4]]] (+ a b)))
			    (vec (take 5 (for [x (range)] (* x x))))
			    (vec (take 3 (for [x (iterate (fn [x] (inc x)) 0) :when (keepx {:x x})] x)))
			    (vec (take 3 (for [x (range) y (range)] [x y])))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[2, 4, 6],
			[
				[1, 10],
				[1, 20],
				[2, 10],
				[2, 20],
			],
			[
				[1, 10],
				[3, 30],
			],
			[1, 2],
			[
				[1, 1],
				[1, 2],
				[2, 1],
				[2, 2],
			],
			[3, 7],
			[0, 1, 4, 9, 16],
			[2, 3, 4],
			[
				[0, 0],
				[0, 1],
				[0, 2],
			],
		]);

		const error = await captureRejection(run(session, "bad-for", "(defprogram bad-for [] (for [x [1 2]]))"));
		expect(codeOf(error)).toBe("INVALID_ARGUMENT");
	});

	it("preserves for comprehension state across park", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		const parked = await run(
			session,
			"for-park",
			"(defprogram for-park [] (take 2 (for [x (range)] (if (= x 0) (park {:payload {}}) x))))",
		);
		expect(stateOf(parked)).toBe("parked");
		const resumed = await unpark(session, { name: "for-park", value: 5, intent: "resume" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([5, 1]);
	});

	it("supports map destructuring defaults and defn metadata", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"destructure-meta",
			`(defprogram destructure-meta []
			   (defn tagged "doc" {:tag :x} [y] y)
			   (defn- hidden [x] x)
			   (defn multi ([x] x) ([x y] (+ x y)) {:added "1"})
			   (let [d 7
			         {:keys [a b] :or {b d}} {:a 1}
			         {c :c :or {c 9}} {}
			         {:strs [s] :or {s "d"}} {}]
			     [[a b c s]
			      (tagged 3)
			      (hidden 4)
			      (get (meta tagged) :doc)
			      (get (meta tagged) :tag)
			      (get (meta hidden) :private)
			      ((fn [{:keys [z] :or {z 1}}] z) {})
			      (multi 1)
			      (multi 1 2)
			      (get (meta multi) :added)]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([1, 7, 9, "d"]);
		expect(value[1]).toBe(3);
		expect(value[2]).toBe(4);
		expect(value[3]).toBe("doc");
		expect(keywordOf(value[4])).toBe("x");
		expect(value[5]).toBe(true);
		expect(value[6]).toBe(1);
		expect(value[7]).toBe(1);
		expect(value[8]).toBe(3);
		expect(value[9]).toBe("1");

		const expressionDefault = await run(
			session,
			"expression-default",
			"(defprogram expression-default [] (let [{:keys [a] :or {a (+ 1 2)}} {}] a))",
		);
		expect(stateOf(expressionDefault)).toBe("completed");
		expect(field(expressionDefault, "value")).toBe(3);
	});

	it("evaluates map destructuring defaults lazily through the CEK", async () => {
		const calls = [];
		const { session } = makeHarness({
			allowed: ["probe"],
			capabilities: {
				probe: async ({ tag }) => {
					calls.push(tag.name);
					await new Promise((resolve) => setTimeout(resolve, 1));
					return 9;
				},
			},
		});
		const receipt = await run(
			session,
			"destructure-defaults",
			`(defprogram destructure-defaults []
			   [(let [{:keys [a b] :or {a 1 b (+ a 1)}} {}
			          {x :x :or {x (probe {:tag :missing})}} {}
			          {:keys [present]} {:present 5}]
			      [a b x present])
			    (let [{:keys [m] :or {m (probe {:tag :present})}} {:m 4}] m)
			    (let [{:keys [n] :or {n (probe {:tag :nil-present})}} {:n nil}] n)
			    ((fn [{:keys [z] :or {z (probe {:tag :fn})}}] z) {})
			    (when-let [{:keys [q] :or {q (probe {:tag :when-let})}} {}] q)
			    (loop [{:keys [r] :or {r (probe {:tag :loop})}} {}] r)
			    (doseq [{:keys [w] :or {w (probe {:tag :doseq})}} [{}]] w)
			    (vec (for [{:keys [z] :or {z (probe {:tag :for})}} [{}]] z))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([[1, 2, 9, 5], 4, null, 9, 9, 9, null, [9]]);
		expect(calls).toEqual(["missing", "fn", "when-let", "loop", "doseq", "for"]);

		const failure = await run(
			session,
			"default-error",
			"(defprogram default-error [] (let [{:keys [a] :or {a (throw {:boom 1})}} {}] a))",
		);
		expect(stateOf(failure)).toBe("failed");
		expect(keywordOf(field(field(failure, "error"), "code"))).toBe("INVALID_ARGUMENT");
	});

	it("resumes map destructuring defaults across park", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		const parked = await run(
			session,
			"default-park",
			"(defprogram default-park [] (let [{:keys [a] :or {a (park {:payload {}})}} {}] a))",
		);
		expect(stateOf(parked)).toBe("parked");
		const resumed = await unpark(session, { name: "default-park", value: 7, intent: "resume" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toBe(7);

		const parkedFor = await run(
			session,
			"default-for-park",
			"(defprogram default-for-park [] (take 1 (for [{:keys [a] :or {a (park {:payload {}})}} [{}]] a)))",
		);
		expect(stateOf(parkedFor)).toBe("parked");
		const resumedFor = await unpark(session, { name: "default-for-park", value: 5, intent: "resume" });
		expect(stateOf(resumedFor)).toBe("completed");
		expect(field(resumedFor, "value")).toEqual([5]);
	});
});

describe("higher-order sequence functions", () => {
	it("evaluates mapv, filter, keep, reduce, some, every?, and apply", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"hofs",
			`(defprogram hofs []
			   (let [xs [1 2 3 4]]
			     [(mapv inc xs)
			      (filter even? xs)
			      (keep (fn [x] (when (> x 2) (* x 10))) xs)
			      (reduce + 0 xs)
			      (some (fn [x] (when (> x 3) x)) xs)
			      (every? pos? xs)
			      (apply + xs)]))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([[2, 3, 4, 5], [2, 4], [30, 40], 10, 4, true, 10]);
	});

	it("awaits async capabilities strictly one at a time in doseq and mapv", async () => {
		const order = [];
		let busy = false;
		const { session } = makeHarness({
			allowed: ["step"],
			capabilities: {
				step: async ({ x }) => {
					if (busy) {
						throw Object.assign(new Error("concurrent capability call"), { code: "INVALID_ARGUMENT" });
					}
					busy = true;
					order.push(`start:${x}`);
					await new Promise((resolve) => setTimeout(resolve, 1));
					order.push(`end:${x}`);
					busy = false;
					return x * 10;
				},
			},
		});

		const doseq = await run(
			session,
			"ordered-doseq",
			"(defprogram ordered-doseq [] (doseq [x [1 2 3]] (step {:x x})) nil)",
		);
		expect(stateOf(doseq)).toBe("completed");
		expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);

		order.length = 0;
		const mapped = await run(
			session,
			"ordered-map",
			"(defprogram ordered-map [] (mapv (fn [x] (step {:x x})) [1 2 3]))",
		);
		expect(stateOf(mapped)).toBe("completed");
		expect(field(mapped, "value")).toEqual([10, 20, 30]);
		expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);

		order.length = 0;
		const paired = await run(
			session,
			"ordered-paired-map",
			"(defprogram ordered-paired-map [] (map (fn [a b] (step {:x (+ a b)})) [1 2] [10 20]))",
		);
		expect(stateOf(paired)).toBe("completed");
		expect(field(paired, "value")).toEqual([110, 220]);
		expect(order).toEqual(["start:11", "end:11", "start:22", "end:22"]);

		const composed = await run(
			session,
			"async-comp",
			"(defprogram async-comp [] ((comp (fn [x] (step {:x x})) inc) 1))",
		);
		expect(field(composed, "value")).toBe(20);

		const juxtaposed = await run(
			session,
			"async-juxt",
			"(defprogram async-juxt [] ((juxt (fn [x] (step {:x x})) inc) 1))",
		);
		expect(field(juxtaposed, "value")).toEqual([10, 2]);
	});

	it("supports update, indexed, group-by, and while sequence functions", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"more-hofs",
			`(defprogram more-hofs []
			   (let [grouped (group-by (fn [x] (if (even? x) :even :odd)) [1 2 3 4])]
			     [(get (update {:a 1} :a inc) :a)
			      (update {:a 1} :a + 2 3)
			      (map-indexed (fn [i x] (+ i x)) [10 20])
			      (keep-indexed (fn [i x] (when (even? i) x)) [:a :b :c])
			      (get grouped :even)
			      (get grouped :odd)
			      (take-while (fn [x] (< x 3)) [1 2 3 4])
			      (drop-while (fn [x] (< x 3)) [1 2 3 4])]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(2);
		expect(field(value[1], "a")).toBe(6);
		expect(value[2]).toEqual([10, 21]);
		expect(value[4]).toEqual([2, 4]);
		expect(value[5]).toEqual([1, 3]);
		expect(keywordOf(value[3][0])).toBe("a");
		expect(keywordOf(value[3][1])).toBe("c");
		expect(value[6]).toEqual([1, 2]);
		expect(value[7]).toEqual([3, 4]);
		const negatives = await run(
			session,
			"negative-predicates",
			`(defprogram negative-predicates []
			   [(not-any? even? [1 3])
			    (not-any? even? [1 2])
			    (not-every? even? [1 2])
			    (not-every? even? [2 4])])`,
		);
		expect(field(negatives, "value")).toEqual([true, false, true, false]);
	});

	it("supports default sort and key-driven sort-by", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"sorting",
			`(defprogram sorting []
			   [(sort [3 1 2])
			    (sort-by (fn [x] (- x)) [1 3 2])
			    (sort-by count ["aaa" "a" "aa"])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([1, 2, 3]);
		expect(value[1]).toEqual([3, 2, 1]);
		expect(value[2]).toEqual(["a", "aa", "aaa"]);
	});

	it("supports multi-collection map and mapcat, plus filterv", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"multi-map",
			`(defprogram multi-map []
			   [(map (fn [a b] (+ a b)) [1 2 3] [10 20])
			    (mapv (fn [a b] [a b]) [1 2] [:a :b])
			    (mapcat (fn [x] [x x]) [1 2])
			    (filterv even? [1 2 3 4])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([11, 22]);
		expect(value[1][0][0]).toBe(1);
		expect(keywordOf(value[1][0][1])).toBe("a");
		expect(value[1][1][0]).toBe(2);
		expect(keywordOf(value[1][1][1])).toBe("b");
		expect(value[2]).toEqual([1, 1, 2, 2]);
		expect(value[3]).toEqual([2, 4]);
	});

	it("supports reduce-kv, reductions, partition-by, split-with, tree-seq, and run!", async () => {
		const seen = [];
		const { session } = makeHarness({
			allowed: ["record"],
			capabilities: {
				record: ({ x }) => {
					seen.push(x);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"more-seq-fns",
			`(defprogram more-seq-fns []
			   [(reduce-kv (fn [acc k v] (+ acc v)) 0 {:a 1 :b 2})
			    (reductions + 0 [1 2 3])
			    (reductions + [1 2 3])
			    (partition-by odd? [1 3 2 4 5])
			    (split-with (fn [x] (< x 3)) [1 2 3 4])
			    (count (tree-seq map? vals {:a {:b 1}}))
			    (run! (fn [x] (record {:x x})) [1 2 3])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(3);
		expect(value[1]).toEqual([0, 1, 3, 6]);
		expect(value[2]).toEqual([1, 3, 6]);
		expect(value[3]).toEqual([[1, 3], [2, 4], [5]]);
		expect(value[4]).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(value[5]).toBe(3);
		expect(value[6]).toBeNull();
		expect(seen).toEqual([1, 2, 3]);
	});

	it("supports nested doseq bindings", async () => {
		const seen = [];
		const { session } = makeHarness({
			allowed: ["record"],
			capabilities: {
				record: ({ x, y }) => {
					seen.push(`${x}${String(y)}`);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"nested-doseq",
			`(defprogram nested-doseq []
			   (doseq [x [1 2] y [:a :b]]
			     (record {:x x :y y}))
			   nil)`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(seen).toEqual(["1:a", "1:b", "2:a", "2:b"]);
	});
});

describe("cherry runtime and standard libraries", () => {
	it("uses Cherry persistent collections and keywords at runtime", async () => {
		const captured = [];
		const { session } = makeHarness({
			allowed: ["inspect"],
			capabilities: {
				inspect: ({ value }) => {
					captured.push(value);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"cherry-runtime",
			`(defprogram cherry-runtime []
			   (do
			     (inspect {:value [1 2]})
			     (inspect {:value {:a 1}})
			     (inspect {:value #{1 2}})
			     (inspect {:value (list 1 2)})
			     (inspect {:value :a})
			     nil))`,
		);
		expect(stateOf(receipt)).toBe("completed");

		const loaded = await loadCherry();
		expect(loaded.ok).toBe(true);
		const core = loaded.cherry.core;
		expect(captured[0]).toBeInstanceOf(core.PersistentVector);
		expect(captured[1]).toBeInstanceOf(core.PersistentHashMap);
		expect(captured[2]).toBeInstanceOf(core.PersistentHashSet);
		expect(captured[3]).toBeInstanceOf(core.List);
		expect(core.keyword_QMARK_(captured[4])).toBe(true);
	});

	it("keeps structural keyword and vector equality inside programs", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"persistent-semantics",
			`(defprogram persistent-semantics []
			   (let [v [1 2]
			         m {:a 1}
			         s #{1 2}
			         l (list 1 2)
			         k :a]
			     [(vector? v) (map? m) (set? s) (list? l) (keyword? k)
			      (= :a (keyword "a"))
			      (get m (keyword "a"))
			      (get {[1 2] :ok} [1 2])
			      (count (conj v 3))
			      (count (assoc m :b 2))
			      (count (disj s 1))
			      (= l v)]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value.slice(0, 7)).toEqual([true, true, true, true, true, true, 1]);
		expect(keywordOf(value[7])).toBe("ok");
		expect(value.slice(8)).toEqual([3, 2, 1, true]);
		expect(value).toHaveLength(12);
	});

	it("runs clojure.walk/postwalk and prewalk with async capabilities and park", async () => {
		const { session } = makeHarness({
			allowed: ["bump", "park", "unpark"],
			capabilities: {
				bump: async ({ x }) => x + 10,
			},
		});

		const walked = await run(
			session,
			"postwalk-async",
			`(defprogram postwalk-async []
			   (clojure.walk/postwalk
			     (fn [x] (if (number? x) (bump {:x x}) x))
			     [1 2]))`,
		);
		expect(stateOf(walked)).toBe("completed");
		expect(field(walked, "value")).toEqual([11, 12]);

		const prewalked = await run(
			session,
			"prewalk",
			`(defprogram prewalk []
			   (clojure.walk/prewalk
			     (fn [x] (if (vector? x) (conj x 9) x))
			     [[1] [2]]))`,
		);
		expect(stateOf(prewalked)).toBe("completed");
		expect(field(prewalked, "value")).toEqual([[1, 9], [2, 9], 9]);

		const walkedLevel = await run(
			session,
			"walk-level",
			`(defprogram walk-level []
			   (clojure.walk/walk
			     (fn [x] (if (number? x) (bump {:x x}) x))
			     identity
			     [1 2]))`,
		);
		expect(stateOf(walkedLevel)).toBe("completed");
		expect(field(walkedLevel, "value")).toEqual([11, 12]);

		const walkedMap = await run(
			session,
			"postwalk-map",
			`(defprogram postwalk-map []
			   (clojure.walk/postwalk
			     (fn [x] (if (map? x) (assoc x :seen true) x))
			     {:a 1 :b [2]}))`,
		);
		expect(stateOf(walkedMap)).toBe("completed");
		expect(field(field(walkedMap, "value"), "seen")).toBe(true);
		expect(field(field(walkedMap, "value"), "a")).toBe(1);

		const parked = await run(
			session,
			"postwalk-park",
			`(defprogram postwalk-park []
			   (clojure.walk/postwalk
			     (fn [x] (if (= x 2) (park {:payload {:x x}}) x))
			     [1 2 3]))`,
		);
		expect(stateOf(parked)).toBe("parked");
		const resumed = await unpark(session, { name: "postwalk-park", value: 20, intent: "resume" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([1, 20, 3]);
	});

	it("supports clojure.walk key conversion and replace walks", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"walk-values",
			`(defprogram walk-values []
			   [(get (clojure.walk/keywordize-keys {"a" 1 "b" {"c" 2}}) :a)
			    (get (get (clojure.walk/keywordize-keys {"b" {"c" 2}}) :b) :c)
			    (clojure.walk/postwalk-replace {1 :one} [1 2])
			    (clojure.walk/prewalk-replace {[1] :one} [[1] 2])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")[0]).toBe(1);
		expect(field(receipt, "value")[1]).toBe(2);
		expect(keywordOf(field(receipt, "value")[2][0])).toBe("one");
		expect(field(receipt, "value")[2][1]).toBe(2);
		expect(keywordOf(field(receipt, "value")[3][0])).toBe("one");
		expect(field(receipt, "value")[3][1]).toBe(2);
	});

	it("supports re-pattern, re-find, re-matches, re-seq, and regex replace", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"regex",
			`(defprogram regex []
			   [(re-find (re-pattern "a+") "caat")
			    (re-matches (re-pattern "(a+)(b+)") "aaabbb")
			    (count (re-seq (re-pattern "a") "aaa"))
			    (clojure.string/replace "a1b2" (re-pattern "[0-9]") "#")])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe("aa");
		expect(value[1]).toEqual(["aaabbb", "aaa", "bbb"]);
		expect(value[2]).toBe(3);
		expect(value[3]).toBe("a#b#");
	});

	it("runs regex operations through the terminable worker", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"regex-worker-values",
			`(defprogram regex-worker-values []
			   [(re-find (re-pattern "(a+)(b*)") "caab")
			    (re-matches (re-pattern "a+") "caa")
			    (vec (re-seq (re-pattern "([ab])") "ab"))
			    (re-find (re-pattern "z") "abc")
			    (clojure.string/replace "a1b2" (re-pattern "([0-9])") "<$1>")
			    (clojure.string/replace "abc" (re-pattern "b") "[$&]")
			    (clojure.string/replace "abc" (re-pattern "b") "[$$]")
			    (clojure.string/replace "abc" "b" "[$&]")
			    (clojure.string/replace-first "a1b2" (re-pattern "([0-9])") "<$1>")
			    (clojure.string/replace "abc" (re-pattern "(?<x>b)") "<$<x>>")
			    (vec (re-seq (re-pattern "a|") "ab"))
			    (count (re-seq (re-pattern "^a") "aaa"))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual(["aab", "aa", "b"]);
		expect(value[1]).toBeNull();
		expect(value[2]).toEqual([
			["a", "a"],
			["b", "b"],
		]);
		expect(value[3]).toBeNull();
		expect(value[4]).toBe("a<1>b<2>");
		expect(value[5]).toBe("a[b]c");
		expect(value[6]).toBe("a[$]c");
		expect(value[7]).toBe("a[b]c");
		expect(value[8]).toBe("a<1>b2");
		expect(value[9]).toBe("a<b>c");
		expect(value[10]).toEqual(["a", "", ""]);
		expect(value[11]).toBe(3);
	});

	it("parks a catastrophic regex at the deadline and never fakes a match", async () => {
		const { session } = makeHarness({ allowed: [] });
		const text = `${"a".repeat(40)}b`;
		const parked = await run(
			session,
			"regex-hang",
			`(defprogram regex-hang [] (re-find (re-pattern "(a+)+$") "${text}"))`,
			{ intent: "x" },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("deadline");
		const resumed = await unpark(session, { name: "regex-hang", value: "ignored", intent: "x" });
		expect(stateOf(resumed)).toBe("parked");
		expect(keywordOf(field(resumed, "reason"))).toBe("deadline");

		const replaced = await run(
			session,
			"replace-hang",
			`(defprogram replace-hang [] (clojure.string/replace "${text}" (re-pattern "(a+)+$") "#"))`,
			{ intent: "x" },
		);
		expect(stateOf(replaced)).toBe("parked");
		expect(keywordOf(field(replaced, "reason"))).toBe("deadline");
	});

	it("pulls re-seq matches lazily and parks at the deadline", async () => {
		const { session } = makeHarness({ allowed: [] });
		const longText = "a".repeat(500);
		const first = await run(
			session,
			"seq-first",
			`(defprogram seq-first [] (first (re-seq (re-pattern "a") "${longText}")))`,
			{ intent: "x".repeat(10) },
		);
		expect(stateOf(first)).toBe("completed");
		expect(field(first, "value")).toBe("a");

		const taken = await run(
			session,
			"seq-take",
			`(defprogram seq-take [] (vec (take 2 (re-seq (re-pattern "a") "${longText}"))))`,
			{ intent: "x".repeat(10) },
		);
		expect(stateOf(taken)).toBe("completed");
		expect(field(taken, "value")).toEqual(["a", "a"]);

		const empty = await run(
			session,
			"seq-empty",
			`(defprogram seq-empty [] (first (re-seq (re-pattern "z") "${longText}")))`,
			{ intent: "x".repeat(10) },
		);
		expect(stateOf(empty)).toBe("completed");
		expect(field(empty, "value")).toBeNull();

		const counted = await run(
			session,
			"seq-count",
			`(defprogram seq-count [] (count (re-seq (re-pattern "a") "${longText}")))`,
			{ intent: "x".repeat(10) },
		);
		expect(stateOf(counted)).toBe("parked");
		expect(keywordOf(field(counted, "reason"))).toBe("deadline");

		const root = await run(session, "seq-root", `(defprogram seq-root [] (re-seq (re-pattern "a") "${longText}"))`, {
			intent: "x".repeat(10),
		});
		expect(stateOf(root)).toBe("parked");
		expect(keywordOf(field(root, "reason"))).toBe("deadline");
		const resumed = await unpark(session, { name: "seq-root", value: 1, intent: "x".repeat(10) });
		expect(stateOf(resumed)).toBe("parked");
		expect(keywordOf(field(resumed, "reason"))).toBe("deadline");
	});

	it("does not run replacement callbacks when the regex times out", async () => {
		const tagged = [];
		const { session } = makeHarness({
			allowed: ["tag"],
			capabilities: {
				tag: ({ m }) => {
					tagged.push(m);
					return "";
				},
			},
		});
		const text = `${"a".repeat(40)}b`;
		const parked = await run(
			session,
			"replace-callback-hang",
			`(defprogram replace-callback-hang [] (clojure.string/replace "${text}" (re-pattern "(a+)+$") (fn [m] (tag {:m m}))))`,
			{ intent: "x" },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(tagged).toEqual([]);
		const resumed = await unpark(session, { name: "replace-callback-hang", value: "ignored", intent: "x" });
		expect(stateOf(resumed)).toBe("parked");
		expect(tagged).toEqual([]);
	});

	it("aborts a catastrophic regex without waiting for its deadline", async () => {
		const { session } = makeHarness({ allowed: [] });
		const text = `${"a".repeat(40)}b`;
		const running = run(
			session,
			"regex-abort",
			`(defprogram regex-abort [] (re-find (re-pattern "(a+)+$") "${text}"))`,
			{ intent: "x".repeat(200) },
		);
		const seqRunning = run(
			session,
			"seq-abort",
			`(defprogram seq-abort [] (first (re-seq (re-pattern "(a+)+$") "${text}")))`,
			{ intent: "x".repeat(200) },
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(abortProgram(session, "regex-abort", "operator").ok).toBe(true);
		expect(abortProgram(session, "seq-abort", "operator").ok).toBe(true);
		const receipt = await running;
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(receipt, "reason"))).toBe("aborted");
		const seqReceipt = await seqRunning;
		expect(stateOf(seqReceipt)).toBe("failed");
		expect(keywordOf(field(seqReceipt, "reason"))).toBe("aborted");
	});

	it("supports clojure.set map-invert and clojure.string helpers", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"libraries",
			`(defprogram libraries []
			   [(get (clojure.set/map-invert {:a 1}) 1)
			    (clojure.set/select even? #{1 2 3 4})
			    (clojure.string/index-of "abcdef" "cd")
			    (clojure.string/split-lines "a\\nb\\nc")
			    (clojure.string/upper-case "abc")])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(keywordOf(value[0])).toBe("a");
		expect(value[1]).toEqual(new Set([2, 4]));
		expect(value[2]).toBe(2);
		expect(value[3]).toEqual(["a", "b", "c"]);
		expect(value[4]).toBe("ABC");
	});

	it("supports function replacements in clojure.string/replace", async () => {
		const { session } = makeHarness({
			allowed: ["tag"],
			capabilities: {
				tag: async ({ m }) => `<${m}>`,
			},
		});
		const receipt = await run(
			session,
			"replace-fn",
			`(defprogram replace-fn []
			   [(clojure.string/replace "a1b2" (re-pattern "[0-9]") (fn [m] (str "<" m ">")))
			    (clojure.string/replace-first "a1b2" (re-pattern "[0-9]") (fn [m] "#"))
			    (clojure.string/replace "a-b" "-" (fn [m] "+"))
			    (clojure.string/replace "a1b2" (re-pattern "([0-9])") (fn [m] (str (get m 1) "!")))
			    (clojure.string/replace "a1b2" (re-pattern "[0-9]") (fn [m] (tag {:m m})))
			    (clojure.string/replace "abc" "" (fn [m] "-"))
			    (clojure.string/replace-first "abc" "" (fn [m] "-"))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe("a<1>b<2>");
		expect(value[1]).toBe("a#b2");
		expect(value[2]).toBe("a+b");
		expect(value[3]).toBe("a1!b2!");
		expect(value[4]).toBe("a<1>b<2>");
		expect(value[5]).toBe("-a-b-c-");
		expect(value[6]).toBe("-abc");
	});

	it("supports common core collection helpers", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"core-collections",
			`(defprogram core-collections []
			   [(get-in {:a {:b 1}} [:a :b])
			    (get-in {} [:missing] :none)
			    (get-in (assoc-in {} [:a :b] 2) [:a :b])
			    (into [] [1 2])
			    (cons 1 [2 3])
			    (concat [1] [2 3])
			    (distinct [1 1 2])
			    (flatten [1 [2 [3]]])
			    (partition 2 [1 2 3 4])
			    (not-empty [])
			    (butlast [1 2 3])
			    (interpose 0 [1 2])
			    (interleave [1 2] [:a :b])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(1);
		expect(keywordOf(value[1])).toBe("none");
		expect(value[2]).toBe(2);
		expect(value[3]).toEqual([1, 2]);
		expect(value[4]).toEqual([1, 2, 3]);
		expect(value[5]).toEqual([1, 2, 3]);
		expect(value[6]).toEqual([1, 2]);
		expect(value[7]).toEqual([1, 2, 3]);
		expect(value[8]).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(value[9]).toBeNull();
		expect(value[10]).toEqual([1, 2]);
		expect(value[11]).toEqual([1, 0, 2]);
		expect(value[12][0]).toBe(1);
		expect(keywordOf(value[12][1])).toBe("a");
	});

	it("binds additional pure cljs.core functions", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"core-functions",
			`(defprogram core-functions []
			   [(peek [1 2])
			    (pop [1 2])
			    (subvec [0 1 2 3] 1 3)
			    (find {:a 1} :a)
			    (empty [1])
			    (not-empty [])
			    (integer? 1)
			    (float? 1.5)
			    (vec (list 1 2))
			    (count (hash-set 1 2 2))
			    (count (sorted-set 3 1))
			    (take-last 2 [1 2 3])
			    (split-at 1 [1 2 3])
			    (compare 1 2)
			    ({:a 1} :a)
			    (#{1 2} 1)
			    (ifn? :a)
			    (ifn? 1)])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(2);
		expect(value[1]).toEqual([1]);
		expect(value[2]).toEqual([1, 2]);
		expect(keywordOf(value[3][0])).toBe("a");
		expect(value[3][1]).toBe(1);
		expect(value[4]).toEqual([]);
		expect(value[5]).toBeNull();
		expect(value[6]).toBe(true);
		expect(value[7]).toBe(true);
		expect(value[8]).toEqual([1, 2]);
		expect(value[9]).toBe(2);
		expect(value[10]).toBe(2);
		expect(value[11]).toEqual([2, 3]);
		expect(value[12][0]).toEqual([1]);
		expect(value[12][1]).toEqual([2, 3]);
		expect(value[13]).toBe(-1);
		expect(value[14]).toBe(1);
		expect(value[15]).toBe(1);
		expect(value[16]).toBe(true);
		expect(value[17]).toBe(false);
	});

	it("supports partial, comp, juxt, complement, and fnil", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"combinators",
			`(defprogram combinators []
			   [((partial + 1 2) 3)
			    ((comp inc (fn [x] (* x 2))) 2)
			    ((comp) 5)
			    ((juxt inc dec) 2)
			    ((complement even?) 2)
			    ((complement even?) 3)
			    ((fnil + 10) nil 2)
			    ((every-pred even? pos?) 2 4)
			    ((every-pred even? pos?) 2 -4)
			    ((some-fn even? neg?) 1 -2)
			    ((some-fn even? neg?) 1 3)])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toBe(6);
		expect(value[1]).toBe(5);
		expect(value[2]).toBe(5);
		expect(value[3]).toEqual([3, 1]);
		expect(value[4]).toBe(false);
		expect(value[5]).toBe(true);
		expect(value[6]).toBe(12);
		expect(value[7]).toBe(true);
		expect(value[8]).toBe(false);
		expect(value[9]).toBe(true);
		expect(value[10]).toBe(false);
	});

	it("keeps iterate and repeatedly lazy for synchronous producers", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"lazy-producers",
			`(defprogram lazy-producers []
			   [(take 5 (iterate inc 0))
			    (take 3 (repeatedly (constantly 7)))
			    (repeatedly 3 (constantly 9))
			    (take 2 (iterate (comp inc inc) 0))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([0, 1, 2, 3, 4]);
		expect(value[1]).toEqual([7, 7, 7]);
		expect(value[2]).toEqual([9, 9, 9]);
		expect(value[3]).toEqual([0, 2]);

		const userFn = await run(
			session,
			"lazy-user-fn",
			"(defprogram lazy-user-fn [] (take 2 (iterate (fn [x] (* x 2)) 1)))",
		);
		expect(stateOf(userFn)).toBe("completed");
		expect(field(userFn, "value")).toEqual([1, 2]);

		const replayable = await run(
			session,
			"lazy-replay",
			`(defprogram lazy-replay []
			   (let [s (iterate (fn [x] (inc x)) 0)]
			     [(vec (take 2 s)) (vec (take 3 s))]))`,
		);
		expect(stateOf(replayable)).toBe("completed");
		expect(field(replayable, "value")).toEqual([
			[0, 1],
			[0, 1, 2],
		]);

		let calls = 0;
		const asyncSession = makeHarness({
			allowed: ["step"],
			capabilities: {
				step: async ({ x }) => {
					calls += 1;
					return x * 10;
				},
			},
		}).session;
		const asyncProducer = await run(
			asyncSession,
			"lazy-async-user-fn",
			"(defprogram lazy-async-user-fn [] (take 2 (iterate (fn [x] (step {:x x})) 1)))",
		);
		expect(stateOf(asyncProducer)).toBe("completed");
		expect(field(asyncProducer, "value")).toEqual([1, 10]);
		expect(calls).toBe(1);

		const asyncReductions = await run(
			asyncSession,
			"lazy-async-reductions",
			`(defprogram lazy-async-reductions []
			   (vec (reductions (fn [a x] (step {:x (+ a x)})) [1 2 3])))`,
		);
		expect(stateOf(asyncReductions)).toBe("completed");
		expect(field(asyncReductions, "value")).toEqual([1, 30, 330]);
		expect(calls).toBe(3);
	});

	it("runs interpreter user functions lazily in reductions, partition-by, split-with, and tree-seq", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"lazy-user-hofs",
			`(defprogram lazy-user-hofs []
			   [(vec (reductions (fn [a x] (+ a x)) [1 2 3]))
			    (vec (partition-by (fn [x] (odd? x)) [1 3 2 4 5]))
			    (let [[a b] (split-with (fn [x] (< x 3)) [1 2 3 4])]
			      [(vec (take 2 a)) (vec (take 2 b))])
			    (count (tree-seq (fn [x] (map? x)) (fn [x] (vals x)) {:a {:b 1}}))
			    (reduce + 0 (reductions (fn [a x] (+ a x)) [1 2 3]))
			    (apply + (reductions (fn [a x] (+ a x)) [1 2 3]))
			    (some even? (reductions (fn [a x] (+ a x)) [1 2 3]))
			    (every? pos? (reductions (fn [a x] (+ a x)) [1 2 3]))
			    {:x (reductions (fn [a x] (+ a x)) [1 2])}
			    #{(reductions (fn [a x] (+ a x)) [1 2])}])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([1, 3, 6]);
		expect(value[1]).toEqual([[1, 3], [2, 4], [5]]);
		expect(value[2]).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(value[3]).toBe(3);
		expect(value[4]).toBe(10);
		expect(value[5]).toBe(10);
		expect(value[6]).toBe(true);
		expect(value[7]).toBe(true);
		expect(field(value[8], "x")).toEqual([1, 3]);
		expect(value[9]).toBeInstanceOf(Set);
		expect([...value[9]][0]).toEqual([1, 3]);
	});

	it("preserves a lazy producer continuation across park", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		const parked = await run(
			session,
			"lazy-park",
			`(defprogram lazy-park []
			   (take 2 (iterate (fn [x] (if (= x 0) (park {:payload {:at x}}) (inc x))) 0)))`,
		);
		expect(stateOf(parked)).toBe("parked");
		const resumed = await unpark(session, { name: "lazy-park", value: 5, intent: "resume" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([0, 5]);
	});

	it("composes map/filter/seq/rest/next over lazy streams", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"lazy-compose",
			`(defprogram lazy-compose []
			   (let [s (iterate (fn [x] (inc x)) 0)]
			     [(vec (take 3 (map (fn [x] (* x 2)) s)))
			      (vec (take 2 (filter odd? (iterate (fn [x] (inc x)) 0))))
			      (vec (take 3 (rest s)))
			      (vec (take 2 (next s)))
			      (vec (take 2 (seq s)))]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[0, 2, 4],
			[1, 3],
			[1, 2, 3],
			[1, 2],
			[0, 1],
		]);
	});

	it("accepts lazy streams as reductions/partition-by/split-with input", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"lazy-inputs",
			`(defprogram lazy-inputs []
			   (let [src (map inc (iterate (fn [x] (inc x)) 0))]
			     [(vec (take 4 (reductions + 0 src)))
			      (vec (take 2 (partition-by odd? (map inc (iterate (fn [x] (inc x)) 0)))))
			      (let [[a b] (split-with (fn [x] (< x 3)) (map inc (iterate (fn [x] (inc x)) 0)))]
			        [(vec (take 2 a)) (vec (take 2 b))])
			      (count (tree-seq (fn [x] (= x 0))
			                       (fn [x] (reductions (fn [a b] (+ a b)) [1 2]))
			                       0))]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[0, 1, 3, 6],
			[[1], [2]],
			[
				[1, 2],
				[3, 4],
			],
			3,
		]);
	});

	it("supports trampoline with thunk-returning functions", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"trampoline",
			`(defprogram trampoline []
			   (trampoline (fn f [n] (if (< n 3) (fn [] (f (inc n))) n)) 0))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toBe(3);
	});

	it("short-circuits some/every?/not-any?/not-every? over infinite lazy streams", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"lazy-short-circuit",
			`(defprogram lazy-short-circuit []
			   [(some (fn [x] (when (= x 2) x)) (iterate (fn [x] (inc x)) 0))
			    (every? (fn [x] (< x 3)) (iterate (fn [x] (inc x)) 0))
			    (some even? (map (fn [x] (* 2 x)) (iterate (fn [x] (inc x)) 0)))
			    (every? even? (take 5 (map (fn [x] (* 2 x)) (iterate (fn [x] (inc x)) 0))))
			    (not-any? (fn [x] (= x 2)) (iterate (fn [x] (inc x)) 0))
			    (not-every? (fn [x] (< x 3)) (iterate (fn [x] (inc x)) 0))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([2, false, true, true, false, true]);
	});

	it("materializes lazy streams nested at any depth inside vectors, maps, and sets", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"deep-lazy-nesting",
			`(defprogram deep-lazy-nesting []
			   [(reductions (fn [a x] (+ a x)) [1 2 3])
			    {:a {:b (reductions (fn [a x] (+ a x)) [1 2])}}
			    {:a [(reductions (fn [a x] (+ a x)) [1 2])]}
			    #{[(reductions (fn [a x] (+ a x)) [1 2])]}
			    #{{:k (reductions (fn [a x] (+ a x)) [1 2])}}
			    {:v (map (fn [x] {:k (reductions (fn [a b] (+ a b)) [x])}) [1 2])}])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect(value[0]).toEqual([1, 3, 6]);
		expect(field(field(value[1], "a"), "b")).toEqual([1, 3]);
		expect(field(value[2], "a")).toEqual([[1, 3]]);
		expect(value[3]).toBeInstanceOf(Set);
		expect([...value[3]][0]).toEqual([[1, 3]]);
		const setMap = [...value[4]][0];
		expect(field(setMap, "k")).toEqual([1, 3]);
		const nestedMaps = field(value[5], "v");
		expect(nestedMaps.length).toBe(2);
		expect(field(nestedMaps[0], "k")).toEqual([1]);
		expect(field(nestedMaps[1], "k")).toEqual([2]);
	});

	it("streams run! over a lazy stream and keeps seq/rest/next composable", async () => {
		const seen = [];
		const { session } = makeHarness({
			allowed: ["record"],
			capabilities: {
				record: ({ x }) => {
					seen.push(x);
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"lazy-run-seq",
			`(defprogram lazy-run-seq []
			   (let [s (iterate (fn [x] (inc x)) 0)]
			     [(run! (fn [x] (record {:x x})) (reductions (fn [a x] (+ a x)) [1 2 3]))
			      (vec (take 3 (seq s)))
			      (vec (take 2 (rest s)))
			      (vec (take 2 (next s)))]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([null, [0, 1, 2], [1, 2], [1, 2]]);
		expect(seen).toEqual([1, 3, 6]);
	});

	it("short-circuits predicates over an unbounded Cherry range", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"range-short-circuit",
			`(defprogram range-short-circuit []
			   [(some (fn [x] (= x 3)) (range))
			    (every? (fn [x] (< x 3)) (range))
			    (not-any? (fn [x] (= x 3)) (range))
			    (not-every? (fn [x] (< x 3)) (range))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([true, false, false, true]);
	});

	it("materializes lazy streams inside lists and Cherry lazy sequences", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"deep-list-seq",
			`(defprogram deep-list-seq []
			   [(list (reductions (fn [a x] (+ a x)) [1 2]))
			    {:a (list (reductions (fn [a x] (+ a x)) [1 2]))}
			    {:b (take 2 (iterate (fn [x] (reductions (fn [a b] (+ a b)) [x])) 0))}
			    (reductions (fn [a x] (list (reductions (fn [b y] (+ b y)) [x]))) [1 2])])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect([...value[0]]).toEqual([[1, 3]]);
		expect([...field(value[1], "a")]).toEqual([[1, 3]]);
		expect(field(value[2], "b")).toEqual([0, [0]]);
		expect(value[3][0]).toBe(1);
		expect([...value[3][1]]).toEqual([[2]]);
	});

	it("resumes mixed-source map and tree-seq pulls through rest views", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"mixed-source-pull",
			`(defprogram mixed-source-pull []
			   [(vec (take 2 (rest (map + (iterate (fn [x] (inc x)) 0) [10 20 30]))))
			    (vec (take 2 (rest (tree-seq (fn [x] (< x 3)) (fn [x] [(inc x)]) 0))))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[21, 32],
			[1, 2],
		]);
	});

	it("compares, prints, and hashes lazy streams structurally like Cherry sequences", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"stream-structural",
			`(defprogram stream-structural []
			   (let [s (reductions (fn [a x] (+ a x)) [1 2 3])
			         t (reductions (fn [a x] (+ a x)) [1 2 3])
			         u (reductions (fn [a x] (+ a x)) [1 2 4])
			         c (take 3 (reductions (fn [a x] (+ a x)) [1 2 3]))]
			     [(= s t)
			      (= s c)
			      (= s [1 3 6])
			      (= s u)
			      (not= s u)
			      (= (hash s) (hash c))
			      (= (str s) (str c))
			      (= (pr-str s) (pr-str c))
			      (= (print-str s) (print-str c))
			      (= (prn-str s) (prn-str c))
			      (= (println-str s) (println-str c))
			      (= (str {:a s}) (str {:a c}))
			      (str s)
			      (pr-str s)]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const value = field(receipt, "value");
		expect([...value].slice(0, 5)).toEqual([true, true, true, false, true]);
		expect([...value].slice(5, 12)).toEqual(new Array(7).fill(true));
		expect(value[12]).toBe("[1 3 6]");
		expect(value[13]).toBe("[1 3 6]");
	});

	it("fails at the materialization limit for structural consumers of infinite streams", async () => {
		const { session } = makeHarness({ allowed: [], now: () => 0, deadlineCheckInterval: 1024 });
		for (const [name, expression] of [
			["stream-eq-infinite", "(= (iterate (fn [x] (inc x)) 0) (iterate (fn [x] (inc x)) 0))"],
			["stream-str-infinite", "(str (iterate (fn [x] (inc x)) 0))"],
			["stream-hash-infinite", "(hash (iterate (fn [x] (inc x)) 0))"],
			["stream-sort-infinite", "(sort (iterate (fn [x] (inc x)) 0))"],
			["stream-join-infinite", '(clojure.string/join "," (iterate (fn [x] (inc x)) 0))'],
		]) {
			const receipt = await run(session, name, `(defprogram ${name} [] ${expression})`);
			expect(stateOf(receipt)).toBe("failed");
			expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("LIMIT_EXCEEDED");
		}
	});

	it("parks structural consumers of infinite streams on the intent deadline", async () => {
		let clock = 0;
		const { session } = makeHarness({ allowed: [], now: () => (clock += 10) });
		const receipt = await run(
			session,
			"stream-str-deadline",
			"(defprogram stream-str-deadline [] (str (iterate (fn [x] (inc x)) 0)))",
			{ intent: "x".repeat(200) },
		);
		expect(stateOf(receipt)).toBe("parked");
		expect(keywordOf(field(receipt, "reason"))).toBe("deadline");
	});

	it("sorts and joins finite lazy streams", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"sort-join-lazy",
			`(defprogram sort-join-lazy []
			   (let [s (reductions (fn [a x] (+ a x)) [1 2 3])
			         m (map (fn [x] (- x)) (reductions (fn [a x] (+ a x)) [1 2 3]))]
			     [(sort m)
			      (clojure.string/join "," s)
			      (clojure.string/join s)
			      (clojure.string/join "-" (map (fn [x] (str x)) s))]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([[-6, -3, -1], "1,3,6", "136", "1-3-6"]);
	});

	it("sorts with sync, async, boolean, and stable custom comparators", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"sort-compare",
			`(defprogram sort-compare []
			   [(sort < [3 1 2])
			    (sort (fn [a b] (< a b)) [3 1 2])
			    (sort (fn [a b] (> a b)) [3 1 2])
			    (sort (fn [a b] 0) [3 1 2])
			    (sort (fn [a b] (< a b)) (reductions (fn [a x] (+ a x)) [1 2 3]))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[1, 2, 3],
			[1, 2, 3],
			[3, 2, 1],
			[3, 1, 2],
			[1, 3, 6],
		]);

		const invalid = await run(session, "sort-bad-cmp", "(defprogram sort-bad-cmp [] (sort 42 [3 1 2]))");
		expect(stateOf(invalid)).toBe("failed");
		expect(keywordOf(field(field(invalid, "error"), "code"))).toBe("INVALID_ARGUMENT");
	});

	it("supports three-arity sort-by with sync and async comparators", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"sort-by-compare",
			`(defprogram sort-by-compare []
			   [(sort-by (fn [x] (- x)) < [1 3 2])
			    (sort-by (fn [x] (- x)) (fn [a b] (< a b)) [1 3 2])
			    (sort-by (fn [x] (if (even? x) 0 1)) (fn [a b] (< a b)) [2 4 1 3])
			    (sort-by (fn [x] (- x)) (fn [a b] (< a b)) (reductions (fn [a x] (+ a x)) [1 2 3]))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[3, 2, 1],
			[3, 2, 1],
			[2, 4, 1, 3],
			[6, 3, 1],
		]);
	});

	it("calls a side-effecting sort-by key function during each comparison", async () => {
		const events = [];
		const { session } = makeHarness({
			allowed: ["kprobe", "cprobe"],
			capabilities: {
				kprobe: ({ x }) => {
					events.push(["key", x]);
					return x;
				},
				cprobe: ({ a, b }) => {
					events.push(["cmp", a, b]);
					return a - b;
				},
			},
		});
		const receipt = await run(
			session,
			"sort-by-comparisons",
			`(defprogram sort-by-comparisons []
			   (sort-by (fn [x] (kprobe {:x x})) (fn [a b] (cprobe {:a a :b b})) [3 1 2]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([1, 2, 3]);
		expect(events.length).toBe(9);
		for (let index = 0; index < events.length; index += 3) {
			const [leftTag, left] = events[index];
			const [rightTag, right] = events[index + 1];
			expect(leftTag).toBe("key");
			expect(rightTag).toBe("key");
			expect(events[index + 2]).toEqual(["cmp", left, right]);
		}

		const defaultEvents = [];
		const { session: defaultSession } = makeHarness({
			allowed: ["kprobe"],
			capabilities: {
				kprobe: ({ x }) => {
					defaultEvents.push(x);
					return x;
				},
			},
		});
		const defaultReceipt = await run(
			defaultSession,
			"sort-by-default-keys",
			"(defprogram sort-by-default-keys [] (sort-by (fn [x] (kprobe {:x x})) [3 1 2]))",
		);
		expect(field(defaultReceipt, "value")).toEqual([1, 2, 3]);
		expect(defaultEvents).toEqual([3, 1, 1, 2, 3, 2]);
	});

	it("re-runs sort-by keys for the reverse half of boolean comparisons", async () => {
		const events = [];
		const { session } = makeHarness({
			allowed: ["kprobe", "cprobe"],
			capabilities: {
				kprobe: ({ x }) => {
					events.push(["key", x]);
					return x;
				},
				cprobe: ({ a, b }) => {
					events.push(["cmp", a, b]);
					return false;
				},
			},
		});
		const receipt = await run(
			session,
			"sort-by-reverse",
			`(defprogram sort-by-reverse []
			   (sort-by (fn [x] (kprobe {:x x})) (fn [a b] (cprobe {:a a :b b})) [3 1 2]))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([3, 1, 2]);
		expect(events.length).toBe(18);
		for (let index = 0; index < events.length; index += 6) {
			const [leftTag, left] = events[index];
			const [rightTag, right] = events[index + 1];
			expect(leftTag).toBe("key");
			expect(rightTag).toBe("key");
			expect(events[index + 2]).toEqual(["cmp", left, right]);
			expect(events[index + 3]).toEqual(["key", right]);
			expect(events[index + 4]).toEqual(["key", left]);
			expect(events[index + 5]).toEqual(["cmp", right, left]);
		}
	});

	it("resumes a custom sort comparator across park", async () => {
		let probes = 0;
		const { session } = makeHarness({
			allowed: ["probe", "park"],
			capabilities: {
				probe: () => {
					probes += 1;
					return probes === 1;
				},
			},
		});
		const parked = await run(
			session,
			"sort-park",
			`(defprogram sort-park []
			   (sort (fn [a b] (if (probe {}) (park {:payload {:pair [a b]}}) (< a b))) [3 1 2]))`,
		);
		expect(stateOf(parked)).toBe("parked");
		const resumed = await unpark(session, { name: "sort-park", value: true, intent: "resume" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([2, 3, 1]);
	});

	it("awaits custom sort comparators strictly one at a time", async () => {
		let busy = false;
		let overlaps = 0;
		const { session } = makeHarness({
			allowed: ["pair"],
			capabilities: {
				pair: async ({ a, b }) => {
					if (busy) {
						overlaps += 1;
					}
					busy = true;
					await new Promise((resolve) => setTimeout(resolve, 1));
					busy = false;
					return a < b;
				},
			},
		});
		const receipt = await run(
			session,
			"sort-async-cmp",
			"(defprogram sort-async-cmp [] (sort (fn [a b] (pair {:a a :b b})) [3 1 2]))",
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([1, 2, 3]);
		expect(overlaps).toBe(0);
	});

	it("short-circuits equality on differing infinite lazy prefixes", async () => {
		const { session } = makeHarness({ allowed: [] });
		const receipt = await run(
			session,
			"lazy-equality-prefix",
			`(defprogram lazy-equality-prefix []
			   [(= (iterate (fn [x] (inc x)) 0) (iterate (fn [x] (inc x)) 5))
			    (= (iterate (fn [x] (inc x)) 0) [0 1 2])
			    (not= (iterate (fn [x] (inc x)) 0) (iterate (fn [x] (inc x)) 5))
			    (= (iterate (fn [x] (inc x)) 0) (take 3 (iterate (fn [x] (inc x)) 0)))
			    (= (iterate (fn [x] (inc x)) 0))
			    (not= (iterate (fn [x] (inc x)) 0))])`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([false, false, true, false, true, false]);
	});

	it("parks equality of equal infinite lazy streams on the intent deadline", async () => {
		let clock = 0;
		const { session } = makeHarness({ allowed: [], now: () => (clock += 10) });
		const receipt = await run(
			session,
			"lazy-equality-infinite",
			"(defprogram lazy-equality-infinite [] (= (iterate (fn [x] (inc x)) 0) (iterate (fn [x] (inc x)) 0)))",
			{ intent: "x".repeat(100) },
		);
		expect(stateOf(receipt)).toBe("parked");
		expect(keywordOf(field(receipt, "reason"))).toBe("deadline");
	});

	it("streams run! over an unbounded Cherry range until the deadline", async () => {
		let clock = 0;
		const seen = [];
		const { session } = makeHarness({
			allowed: ["record"],
			now: () => clock,
			capabilities: {
				record: ({ x }) => {
					seen.push(x);
					clock += 20;
					return null;
				},
			},
		});
		const receipt = await run(
			session,
			"run-range",
			"(defprogram run-range [] (run! (fn [x] (record {:x x})) (range)))",
			{ intent: "x" },
		);
		expect(stateOf(receipt)).toBe("parked");
		expect(keywordOf(field(receipt, "reason"))).toBe("deadline");
		expect(seen).toEqual([0, 1, 2]);
	});

	it("keeps range lazy for take and fails explicitly instead of faking an infinite result", async () => {
		const { session } = makeHarness({ allowed: [] });
		const finite = await run(
			session,
			"ranges",
			`(defprogram ranges []
			   [(take 5 (range))
			    (range 3)
			    (range 1 4)
			    (range 0 10 3)])`,
		);
		expect(stateOf(finite)).toBe("completed");
		const value = field(finite, "value");
		expect(value[0]).toEqual([0, 1, 2, 3, 4]);
		expect(value[1]).toEqual([0, 1, 2]);
		expect(value[2]).toEqual([1, 2, 3]);
		expect(value[3]).toEqual([0, 3, 6, 9]);

		const infinite = await run(session, "infinite-range", "(defprogram infinite-range [] (range))");
		expect(stateOf(infinite)).toBe("failed");
		expect(keywordOf(field(field(infinite, "error"), "code"))).toBe("LIMIT_EXCEEDED");

		const counted = await run(session, "infinite-count", "(defprogram infinite-count [] (count (range)))");
		expect(stateOf(counted)).toBe("failed");
		expect(keywordOf(field(field(counted, "error"), "code"))).toBe("LIMIT_EXCEEDED");

		const lasted = await run(session, "infinite-last", "(defprogram infinite-last [] (last (range)))");
		expect(stateOf(lasted)).toBe("failed");
		expect(keywordOf(field(field(lasted, "error"), "code"))).toBe("LIMIT_EXCEEDED");

		const mapped = await run(session, "infinite-map", "(defprogram infinite-map [] (last (map inc (range))))");
		expect(stateOf(mapped)).toBe("failed");
		expect(keywordOf(field(field(mapped, "error"), "code"))).toBe("LIMIT_EXCEEDED");

		const equal = await run(session, "infinite-equal", "(defprogram infinite-equal [] (= (range) (range)))");
		expect(stateOf(equal)).toBe("failed");
		expect(keywordOf(field(field(equal, "error"), "code"))).toBe("LIMIT_EXCEEDED");

		const nested = await run(session, "nested-lazy-print", "(defprogram nested-lazy-print [] (str {:a (range)}))");
		expect(stateOf(nested)).toBe("failed");
		expect(keywordOf(field(field(nested, "error"), "code"))).toBe("LIMIT_EXCEEDED");
	});
});

describe("where and park/unpark", () => {
	it("returns a unique UTF-16 span usable by subs", async () => {
		const { session } = makeHarness({ allowed: ["where"] });
		const receipt = await run(
			session,
			"unique",
			`(defprogram unique []
			   (let [src "hello world"
			         [b e] (where {:content src :needle "world"})]
			     (subs src b e)))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toBe("world");
	});

	it("returns every whereAll span", async () => {
		const { session } = makeHarness({ allowed: ["whereAll"] });
		const receipt = await run(session, "all", `(defprogram all [] (whereAll {:content "aaaa" :needle "aa"}))`);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([
			[0, 2],
			[1, 3],
			[2, 4],
		]);

		const empty = await run(session, "none", `(defprogram none [] (whereAll {:content "abc" :needle "z"}))`);
		expect(stateOf(empty)).toBe("completed");
		expect(field(empty, "value")).toEqual([]);
	});

	it("parks on ambiguous where, preserves locals and pending VFS, then resumes", async () => {
		const { session, files, batches } = makeHarness({ files: { "a.txt": "abcabc" } });
		const receipt = await run(
			session,
			"patch",
			`(defprogram patch []
			   (let [src (cat {:path "a.txt"})
			         [b e] (where {:content src :needle "abc"})]
			     (write {:path "a.txt"
			             :content (str (subs src 0 b) "XYZ" (subs src e))})))`,
		);

		expect(stateOf(receipt)).toBe("parked");
		expect(keywordOf(field(receipt, "reason"))).toBe("where-ambiguous");
		expect(keywordOf(field(field(receipt, "payload"), "kind"))).toBe("ambiguous");
		expect(field(field(receipt, "payload"), "candidates")).toHaveLength(2);
		expect(field(receipt, "source")).toContain("   1 | (defprogram patch []");
		expect(typeof field(receipt, "remaining-wait-ms")).toBe("number");
		expect(batches.get("patch").commits).toBe(0);
		expect(files.get("a.txt")).toBe("abcabc");
		expect(parkedNames(session)).toEqual(["patch"]);

		const done = await unpark(session, {
			name: "patch",
			value: [0, 3],
			intent: "apply the fix",
		});
		expect(stateOf(done)).toBe("completed");
		expect(files.get("a.txt")).toBe("XYZabc");
		expect(batches.get("patch").commits).toBe(1);
		expect(batches.get("patch").readSets[0]).toHaveLength(1);
		expect(batches.get("patch").readSets[0][0].path).toBe("a.txt");
		expect(parkedNames(session)).toEqual([]);
	});

	it("parks explicitly and injects the unpark value as the park result", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		const parked = await run(
			session,
			"pause",
			`(defprogram pause []
			   (let [a 1]
			     (+ a (park {:payload {:why "need input"}}))))`,
		);

		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("explicit");
		expect(field(field(parked, "payload"), "why")).toBe("need input");
		expect(field(parked, "source")).toContain("   1 | (defprogram pause []");

		const done = await unpark(session, { name: "pause", value: 41, intent: "resume" });
		expect(stateOf(done)).toBe("completed");
		expect(field(done, "value")).toBe(42);
	});

	it("parks on zero where matches and round-trips the receipt through the EDN printer", async () => {
		const { session } = makeHarness({ allowed: ["where"] });
		const parked = await run(session, "missing", `(defprogram missing [] (where {:content "abc" :needle "zzz"}))`);

		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("where-ambiguous");
		expect(keywordOf(field(field(parked, "payload"), "kind"))).toBe("none");

		const rendered = renderReceipt(parked);
		expect(printUfss(readUfss(rendered))).toBe(printUfss(parked));

		const done = await unpark(session, { name: "missing", value: [0, 1], intent: "resume" });
		expect(stateOf(done)).toBe("completed");
		expect(field(done, "value")).toEqual([0, 1]);
	});

	it("resumes another parked program from inside a program", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		await run(session, "target", `(defprogram target [] (park {:payload {:at 1}}))`);

		const resume = await run(session, "resume", `(defprogram resume [] (unpark {:name "target" :value 9}))`);
		expect(stateOf(resume)).toBe("completed");
		const targetReceipt = field(resume, "value");
		expect(keywordOf(field(targetReceipt, "state"))).toBe("completed");
		expect(field(targetReceipt, "value")).toBe(9);
		expect(parkedNames(session)).toEqual([]);
	});

	it("keeps a park inside a higher-order callback inside the continuation", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		const parked = await run(
			session,
			"nested-park",
			`(defprogram nested-park []
			   (mapv (fn [x]
			           (if (= x 2)
			             (park {:payload {:at x}})
			             (* x 10)))
			         [1 2 3]))`,
		);

		expect(stateOf(parked)).toBe("parked");
		expect(field(field(parked, "payload"), "at")).toBe(2);

		const done = await unpark(session, { name: "nested-park", value: 20, intent: "resume" });
		expect(stateOf(done)).toBe("completed");
		expect(field(done, "value")).toEqual([10, 20, 30]);
	});

	it("rejects unknown, stale, self, and capability-lost resumes", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark", "where"] });

		const unknown = await captureRejection(unpark(session, { name: "missing", value: 1, intent: "resume" }));
		expect(codeOf(unknown)).toBe("PROGRAM_UNKNOWN");

		const invalid = await captureRejection(unpark(session, { name: "", value: 1, intent: "resume" }));
		expect(codeOf(invalid)).toBe("INVALID_ARGUMENT");

		const self = await run(session, "self", `(defprogram self [] (unpark {:name "self" :value 1}))`);
		expect(stateOf(self)).toBe("failed");
		expect(keywordOf(field(field(self, "error"), "code"))).toBe("INVALID_ARGUMENT");

		await run(session, "twice", `(defprogram twice [] (park {:payload {}}))`);
		const first = await unpark(session, { name: "twice", value: 1, intent: "resume" });
		expect(stateOf(first)).toBe("completed");
		const stale = await captureRejection(unpark(session, { name: "twice", value: 2, intent: "resume" }));
		expect(codeOf(stale)).toBe("STALE_CONTROL");

		await run(session, "narrowed", `(defprogram narrowed [] (park {:payload {}}))`);
		session.allowedCapabilities.delete("where");
		const denied = await captureRejection(unpark(session, { name: "narrowed", value: 1, intent: "resume" }));
		expect(codeOf(denied)).toBe("CAPABILITY_DENIED");
	});

	it("rejects a same-name program while active and allows reuse after completion", async () => {
		const { session } = makeHarness({ allowed: ["park", "unpark"] });
		await run(session, "reuse", "(defprogram reuse [] (park {:payload {}}))");

		const taken = await captureRejection(run(session, "reuse", "(defprogram reuse [] (park {:payload {}}))"));
		expect(codeOf(taken)).toBe("NAME_TAKEN");

		await unpark(session, { name: "reuse", value: 1, intent: "resume" });
		const reused = await run(session, "reuse", "(defprogram reuse [] 7)");
		expect(stateOf(reused)).toBe("completed");
		expect(field(reused, "value")).toBe(7);
	});
});

describe("deadline, replay, and abort", () => {
	it("parks on the intent deadline and resumes the loop continuation without replay", async () => {
		let clock = 0;
		const ticks = [];
		const { session } = makeHarness({
			allowed: ["tick"],
			now: () => clock,
			deadlineCheckInterval: 1,
			capabilities: {
				tick: async ({ i }) => {
					ticks.push(i);
					clock += 30;
					return i;
				},
			},
		});

		const parked = await run(
			session,
			"deadline",
			`(defprogram deadline []
			   (loop [i 0]
			     (if (< i 100)
			       (recur (inc (tick {:i i})))
			       i)))`,
			{ intent: "x" },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("deadline");
		expect(field(parked, "remaining-wait-ms")).toBe(0);
		const parkedCalls = ticks.length;

		const done = await unpark(session, { name: "deadline", value: 41, intent: "x".repeat(200) });
		expect(stateOf(done)).toBe("completed");
		expect(field(done, "value")).toBe(100);
		expect(ticks.length).toBe(100);
		expect(ticks.slice(0, parkedCalls)).toEqual(Array.from({ length: parkedCalls }, (_, index) => index));
		expect(ticks.slice(parkedCalls)).toEqual(
			Array.from({ length: 100 - parkedCalls }, (_, index) => parkedCalls + index),
		);
	});

	it("replays the same call-id and payload without running the program twice", async () => {
		let counter = 0;
		const { session } = makeHarness({
			allowed: ["tick"],
			capabilities: {
				tick: () => {
					counter += 1;
					return counter;
				},
			},
		});
		const request = {
			name: "replay",
			code: "(defprogram replay [] (tick {}))",
			intent: INTENT,
			callId: "call-1",
		};

		const first = await runProgram(session, request);
		const second = await runProgram(session, request);
		expect(field(first, "value")).toBe(1);
		expect(field(second, "value")).toBe(1);
		expect(counter).toBe(1);

		const mismatch = await captureRejection(
			runProgram(session, { ...request, code: "(defprogram replay [] (tick nil)) (comment)" }),
		);
		expect(codeOf(mismatch)).toBe("CALL_REPLAY_MISMATCH");
	});

	it("fails a running program when the session is aborted", async () => {
		const { session } = makeHarness({
			allowed: ["slow"],
			capabilities: {
				slow: async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return 1;
				},
			},
		});

		const promise = run(session, "aborted", "(defprogram aborted [] (slow {}))");
		abortSession(session, "operator");

		const receipt = await promise;
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(receipt, "reason"))).toBe("aborted");

		const next = await run(session, "after-abort", "(defprogram after-abort [] 7)");
		expect(stateOf(next)).toBe("completed");
		expect(field(next, "value")).toBe(7);
	});

	it("aborts only the named program and keeps the session usable", async () => {
		const { session } = makeHarness({
			allowed: ["slow"],
			capabilities: {
				slow: async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return 1;
				},
			},
		});
		const promise = run(session, "first-call", "(defprogram first-call [] (slow {}))");
		const abort = abortProgram(session, "first-call", "tool-cancel");
		expect(abort.ok).toBe(true);
		expect(stateOf(await promise)).toBe("failed");

		const next = await run(session, "second-call", "(defprogram second-call [] 9)");
		expect(stateOf(next)).toBe("completed");
		expect(field(next, "value")).toBe(9);
	});

	it("preserves a pending capability across deadline and does not fabricate its result", async () => {
		let calls = 0;
		const { session } = makeHarness({
			allowed: ["delayed", "hang"],
			capabilities: {
				delayed: () => {
					calls += 1;
					return new Promise((resolve) => setTimeout(() => resolve("actual"), 200));
				},
				hang: () => new Promise(() => {}),
			},
		});

		const deadline = await run(session, "delayed-deadline", "(defprogram delayed-deadline [] (delayed {}))", {
			intent: "x",
		});
		expect(stateOf(deadline)).toBe("parked");
		expect(keywordOf(field(deadline, "reason"))).toBe("deadline");
		expect(parkedNames(session)).toContain("delayed-deadline");
		expect(calls).toBe(1);

		const stillPending = await unpark(session, { name: "delayed-deadline", value: "fake", intent: "x" });
		expect(stateOf(stillPending)).toBe("parked");
		expect(keywordOf(field(stillPending, "reason"))).toBe("deadline");
		expect(calls).toBe(1);

		await new Promise((resolve) => setTimeout(resolve, 220));
		const resumed = await unpark(session, { name: "delayed-deadline", value: "fake", intent: "x" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toBe("actual");
		expect(calls).toBe(1);

		const pending = run(session, "hang-abort", "(defprogram hang-abort [] (hang {}))");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const abort = abortProgram(session, "hang-abort", "test");
		expect(abort.ok).toBe(true);
		const aborted = await pending;
		expect(stateOf(aborted)).toBe("failed");
		expect(keywordOf(field(aborted, "reason"))).toBe("aborted");
	});

	it("marks an aborted pending capability outcome-unknown and keeps its late settlement", async () => {
		let calls = 0;
		let startedResolve;
		const started = new Promise((resolve) => {
			startedResolve = resolve;
		});
		const effects = [];
		const { session } = makeHarness({
			allowed: ["slow"],
			capabilities: {
				slow: () => {
					calls += 1;
					startedResolve();
					return new Promise((resolve) => {
						setTimeout(() => {
							effects.push("late");
							resolve("late-result");
						}, 400);
					});
				},
			},
		});
		const running = run(session, "cap-abort", `(defprogram cap-abort [] (slow {:path "x"}))`, {
			intent: "x".repeat(200),
		});
		await started;
		expect(abortProgram(session, "cap-abort", "operator").ok).toBe(true);
		const receipt = await running;
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(receipt, "reason"))).toBe("aborted");
		const interrupted = [...field(receipt, "interrupted-capabilities")];
		expect(interrupted.length).toBe(1);
		const entry = interrupted[0];
		expect(field(entry, "capability")).toBe("slow");
		expect(field(field(entry, "argument"), "path")).toBe("x");
		expect(keywordOf(field(entry, "status"))).toBe("outcome-unknown");
		expect(field(entry, "settled")).toBe(false);
		expect(calls).toBe(1);
		const rendered = renderReceipt(receipt);
		expect(rendered).toContain(":interrupted-capabilities");
		expect(rendered).toContain(":outcome-unknown");

		const pendingSnapshot = [...abandonedCapabilities(session, "cap-abort")];
		expect(field(pendingSnapshot[0], "settled")).toBe(false);
		const reused = await run(session, "cap-abort", "(defprogram cap-abort [] 7)");
		expect(stateOf(reused)).toBe("completed");
		expect(field(reused, "value")).toBe(7);
		const afterReuse = [...abandonedCapabilities(session, "cap-abort")];
		expect(afterReuse.length).toBe(1);
		expect(field(afterReuse[0], "settled")).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 450));
		const settledSnapshot = [...abandonedCapabilities(session, "cap-abort")];
		expect(field(settledSnapshot[0], "settled")).toBe(true);
		expect(field(settledSnapshot[0], "result")).toBe("late-result");
		expect(keywordOf(field(settledSnapshot[0], "outcome"))).toBe("completed");
		expect(effects).toEqual(["late"]);
		expect(stateOf(receipt)).toBe("failed");
		expect(calls).toBe(1);
	});

	it("injects the unpark value for an explicit park in a root lazy producer", async () => {
		const { session } = makeHarness({ allowed: ["park"] });
		const parked = await run(
			session,
			"explicit-root-park",
			"(defprogram explicit-root-park [] (reductions (fn [a x] (if (= x 2) (park {:payload {}}) (+ a x))) [1 2 3]))",
			{ intent: "x".repeat(10) },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("explicit");
		const resumed = await unpark(session, { name: "explicit-root-park", value: 5, intent: "x" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([1, 5, 8]);
	});

	it("resumes a deadline-parked pending capability in a root lazy producer with its real result", async () => {
		const { session } = makeHarness({
			allowed: ["slow"],
			capabilities: {
				slow: async () => {
					await new Promise((resolve) => setTimeout(resolve, 150));
					return 42;
				},
			},
		});
		const parked = await run(
			session,
			"cap-root-park",
			"(defprogram cap-root-park [] (map (fn [x] (slow {:x x})) (reductions (fn [a x] (+ a x)) [1])))",
			{ intent: "x" },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("deadline");
		const resumed = await unpark(session, { name: "cap-root-park", value: "WRONG", intent: "x".repeat(10) });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([42]);
	});

	it("resumes a deadline-parked pure producer continuation and ignores the unpark value", async () => {
		const { session } = makeHarness({ allowed: [] });
		const parked = await run(
			session,
			"fn-root-park",
			"(defprogram fn-root-park [] (map (fn [x] (loop [i 0] (if (< i 200000) (recur (inc i)) i))) (reductions (fn [a x] a) [1])))",
			{ intent: "x" },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("deadline");
		const resumed = await unpark(session, { name: "fn-root-park", value: null, intent: "x".repeat(200) });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toEqual([200000]);
		const program = session.programs.get("fn-root-park");
		expect(program.parkCheckpoint).toBeNull();
	});
});

describe("protected writes and failure isolation", () => {
	it("records cat/stat read stamps and commits them with the write", async () => {
		const { session, files, batches } = makeHarness({ files: { "a.txt": "alpha" } });
		const receipt = await run(
			session,
			"write-through",
			`(defprogram write-through []
			   (let [src (cat {:path "a.txt"})]
			     (stat {:path "a.txt"})
			     (write {:path "a.txt" :content (str src "!")})))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(files.get("a.txt")).toBe("alpha!");
		expect(batches.get("write-through").commits).toBe(1);
		const readSet = batches.get("write-through").readSets[0];
		expect(readSet.map((entry) => entry.path)).toEqual(["a.txt", "a.txt"]);
		expect(readSet[0].stamp).toBeInstanceOf(Map);
		expect(field(readSet[0].stamp, "mtime-sec")).toBe(1n);
		expect(field(readSet[0].stamp, "mtime-nsec")).toBe(2n);
		expect(field(readSet[1].stamp, "mtime-sec")).toBe(1n);
		expect(field(readSet[1].stamp, "size")).toBe(5n);
	});

	it("commits a read-only program so file facts are rechecked", async () => {
		let payload;
		const { session } = makeHarness({
			allowed: ["cat"],
			ports: {
				commit: (request) => {
					payload = request;
					return { status: ":applied", written: [] };
				},
			},
		});
		const receipt = await run(session, "read-only-facts", `(defprogram read-only-facts [] (cat {:path "a.txt"}))`);
		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toBe("alpha");
		expect(payload.writeSetEmpty).toBe(true);
		expect(payload.readSet).toHaveLength(1);
		expect(payload.readSet[0].path).toBe("a.txt");
	});

	it("maps C3 camelCase stat/list fields to the EDN contract", async () => {
		const { session } = makeHarness({
			allowed: ["stat", "ls"],
			capabilities: {
				stat: () => ({
					exists: true,
					size: 5n,
					mtimeSec: 1n,
					mtimeNsec: 2n,
					isDir: false,
				}),
				ls: () => ({
					exists: true,
					entries: [{ name: "a.txt", isDir: false, isFile: true }],
				}),
			},
		});
		const receipt = await run(
			session,
			"stat-shape",
			`(defprogram stat-shape []
			   (let [s (stat {:path "a.txt"})
			         e (first (:entries (ls {:path "."})))]
			     [(get s :mtime-sec) (get s :mtime-nsec) (get s :is-dir)
			      (get e :is-file) (get e :is-dir)]))`,
		);

		expect(stateOf(receipt)).toBe("completed");
		expect(field(receipt, "value")).toEqual([1n, 2n, false, true, false]);
	});

	it("accepts JS Map capability results with colon-prefixed stamp keys", async () => {
		const { session, batches } = makeHarness({
			allowed: ["cat", "write"],
			capabilities: {
				cat: () =>
					new Map([
						["content", "abc"],
						[
							":stamp",
							new Map([
								[":mtime-sec", 7n],
								[":mtime-nsec", 8n],
								[":size", 3n],
							]),
						],
						[":virtual", false],
					]),
			},
		});
		const receipt = await run(
			session,
			"js-map-capability",
			`(defprogram js-map-capability []
			   (let [src (cat {:path "x"})]
			     (write {:path "y" :content src})))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		const readSet = batches.get("js-map-capability").readSets[0];
		expect(readSet).toHaveLength(1);
		expect(field(readSet[0].stamp, "mtime-sec")).toBe(7n);
		expect(field(readSet[0].stamp, "mtime-nsec")).toBe(8n);
	});

	it("does not put ls probes into the read-set", async () => {
		const { session, batches } = makeHarness();
		const receipt = await run(
			session,
			"probe",
			`(defprogram probe []
			   (ls {:path "."})
			   (write {:path "new.txt" :content "x"}))`,
		);
		expect(stateOf(receipt)).toBe("completed");
		expect(batches.get("probe").readSets[0]).toEqual([]);
	});

	it("discards staged writes and never commits on an exception", async () => {
		const { session, files, batches } = makeHarness({
			allowed: ["write", "boom"],
			capabilities: {
				boom: () => {
					throw Object.assign(new Error("exploded"), { code: "PREPARE_REJECTED" });
				},
			},
		});
		const receipt = await run(
			session,
			"failing",
			`(defprogram failing []
			   (write {:path "x.txt" :content "bad"})
			   (boom {}))`,
		);

		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("PREPARE_REJECTED");
		expect(files.has("x.txt")).toBe(false);
		expect(batches.get("failing").commits).toBe(0);
		expect(batches.get("failing").discards).toBe(1);
		expect(batches.get("failing").pending.size).toBe(0);
	});

	it("treats a VFS-style rejected commit as a failed program", async () => {
		const { session, files } = makeHarness({
			files: { "a.txt": "alpha" },
			ports: {
				commit: () => ({
					status: ":rejected",
					code: ":FILE_CONFLICT",
					message: "stamp changed",
					conflicts: [{ path: "a.txt", reason: "stamp-mismatch" }],
					written: [],
				}),
			},
		});
		const receipt = await run(
			session,
			"conflicted",
			`(defprogram conflicted []
			   (write {:path "a.txt" :content "overwrite"}))`,
		);

		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("FILE_CONFLICT");
		expect(files.get("a.txt")).toBe("alpha");
	});

	it("parks a pending commit at the deadline and resumes it without replaying", async () => {
		let commitCalls = 0;
		let resolveCommit;
		const { session } = makeHarness({
			allowed: ["write"],
			ports: {
				commit: () => {
					commitCalls += 1;
					return new Promise((resolve) => {
						resolveCommit = resolve;
					});
				},
			},
		});
		const parked = await run(
			session,
			"commit-wait",
			`(defprogram commit-wait [] (write {:path "a.txt" :content "x"}) 42)`,
			{ intent: "x" },
		);
		expect(stateOf(parked)).toBe("parked");
		expect(keywordOf(field(parked, "reason"))).toBe("deadline");
		expect(keywordOf(field(field(parked, "commit"), "status"))).toBe("pending");
		expect(commitCalls).toBe(1);

		resolveCommit({ status: ":applied", written: ["a.txt"], pending: [], uncertain: [] });
		const resumed = await unpark(session, { name: "commit-wait", value: "ignored", intent: "resume" });
		expect(stateOf(resumed)).toBe("completed");
		expect(field(resumed, "value")).toBe(42);
		expect(field(field(resumed, "commit"), "status")).toBe(":applied");
		expect(commitCalls).toBe(1);
	});

	it("marks an aborted pending commit uncertain and keeps responsibility", async () => {
		let commitCalls = 0;
		let discardCalls = 0;
		let startedResolve;
		const started = new Promise((resolve) => {
			startedResolve = resolve;
		});
		const { session } = makeHarness({
			allowed: ["write"],
			ports: {
				commit: () => {
					commitCalls += 1;
					startedResolve();
					return new Promise(() => {});
				},
				discard: () => {
					discardCalls += 1;
					return null;
				},
			},
		});
		const running = run(
			session,
			"commit-abort",
			`(defprogram commit-abort [] (write {:path "a.txt" :content "x"}) 42)`,
			{ intent: "x".repeat(100) },
		);
		await started;
		expect(commitCalls).toBe(1);
		expect(abortProgram(session, "commit-abort", "operator").ok).toBe(true);
		const receipt = await running;
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(receipt, "reason"))).toBe("aborted");
		expect(keywordOf(field(field(receipt, "commit"), "status"))).toBe("uncertain");
		expect(field(field(receipt, "commit"), "pending")).toBe(true);
		expect(discardCalls).toBe(0);
		const program = session.programs.get("commit-abort");
		expect(program.pendingCommit).not.toBeNull();
		expect(program.dirty).toBe(true);
	});

	it("bounds a hanging discard and reports cleanup uncertainty", async () => {
		let discardCalls = 0;
		const { session } = makeHarness({
			allowed: ["write", "boom"],
			capabilities: {
				boom: () => {
					throw Object.assign(new Error("boom"), { code: "INVALID_ARGUMENT" });
				},
			},
			ports: {
				discard: () => {
					discardCalls += 1;
					return new Promise(() => {});
				},
			},
		});
		const receipt = await run(
			session,
			"discard-hang",
			`(defprogram discard-hang [] (write {:path "a.txt" :content "x"}) (boom {}))`,
			{ intent: "x" },
		);
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
		expect(discardCalls).toBe(1);
		expect(keywordOf(field(field(receipt, "discard"), "status"))).toBe("uncertain");
		expect(field(field(receipt, "discard"), "pending")).toBe(true);
		const program = session.programs.get("discard-hang");
		expect(program.pendingDiscard).not.toBeNull();
		expect(program.dirty).toBe(true);
	});

	it("reports a rejected discard as settled but uncertain cleanup", async () => {
		const { session } = makeHarness({
			allowed: ["write", "boom"],
			capabilities: {
				boom: () => {
					throw Object.assign(new Error("boom"), { code: "INVALID_ARGUMENT" });
				},
			},
			ports: {
				discard: () => Promise.reject(Object.assign(new Error("discard failed"), { code: "FILE_CONFLICT" })),
			},
		});
		const receipt = await run(
			session,
			"discard-reject",
			`(defprogram discard-reject [] (write {:path "a.txt" :content "x"}) (boom {}))`,
		);
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("INVALID_ARGUMENT");
		expect(keywordOf(field(field(receipt, "discard"), "status"))).toBe("uncertain");
		expect(field(field(receipt, "discard"), "pending")).toBe(false);
		const program = session.programs.get("discard-reject");
		expect(program.pendingDiscard).toBeNull();
		expect(program.discardUncertain).toBe(true);
		expect(program.dirty).toBe(true);
	});

	it("propagates a rejected commit without marking it pending", async () => {
		const { session } = makeHarness({
			allowed: ["write"],
			ports: {
				commit: () => Promise.reject(Object.assign(new Error("commit failed"), { code: "FILE_CONFLICT" })),
			},
		});
		const receipt = await run(
			session,
			"commit-reject",
			`(defprogram commit-reject [] (write {:path "a.txt" :content "x"}))`,
		);
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("FILE_CONFLICT");
		expect(field(receipt, "commit")).toBeUndefined();
		const program = session.programs.get("commit-reject");
		expect(program.pendingCommit).toBeNull();
		expect(program.dirty).toBe(true);
	});

	it("reports a missing capability as :CAPABILITY_DENIED without touching disk", async () => {
		const session = createSandboxSession({ allowedCapabilities: ["write"] });
		const receipt = await run(session, "no-port", '(defprogram no-port [] (write {:path "x" :content "y"}))');
		expect(stateOf(receipt)).toBe("failed");
		expect(keywordOf(field(field(receipt, "error"), "code"))).toBe("CAPABILITY_DENIED");
	});
});

describe("security whitelist", () => {
	const escapes = [
		"(defprogram p [] (js/console.log 1))",
		"(defprogram p [] (globalThis))",
		"(defprogram p [] (process))",
		"(defprogram p [] (Bun))",
		'(defprogram p [] (require "x"))',
		'(defprogram p [] (import "x"))',
		"(defprogram p [] (eval 1))",
		'(defprogram p [] (read-string "1"))',
		'(defprogram p [] (load-string "1"))',
		"(defprogram p [] (resolve 1))",
		"(defprogram p [] (set! x 1))",
		"(defprogram p [] (aget [] 0))",
		"(defprogram p [] (aset [] 0 1))",
		"(defprogram p [] (goog.object/get 1))",
		"(defprogram p [] (unknown-symbol 1))",
		"(defprogram p [] (.foo 1))",
		"(defprogram p [] (new Date))",
		"(defprogram p [] (ns foo))",
	];

	it("denies every host escape at analysis time", async () => {
		const { session } = makeHarness({ allowed: [] });
		for (const code of escapes) {
			const error = await captureRejection(run(session, "p", code));
			expect(isSandboxError(error)).toBe(true);
			expect(codeOf(error)).toBe("CAPABILITY_DENIED");
		}
	});

	it("never uses eval or the Function constructor", async () => {
		const source = await Bun.file(new URL("../src/clj-sandbox/evaluator.mjs", import.meta.url)).text();
		expect(source).not.toMatch(/\beval\s*\(/);
		expect(source).not.toMatch(/\bFunction\s*\(/);
		expect(source).not.toMatch(/new\s+Function/);
	});
});
