# Native Promise Sandbox: LLM Contract

This sandbox has no `await`, no `^:async`, and no user-facing syntax macro. Every capability is an ordinary function that returns a `js/Promise`. Nothing beyond the capability wrappers is preloaded: require namespaces at the top of your code, exactly as in normal ClojureScript. Top-level `require` runs before later forms, so aliases work normally.

```clojure
(require '[promesa.core :as p])
(require '[clojure.string :as str])
```

The runtime keeps the hard limits with guards, not with syntax errors.

## 1. Use `p/let` for serial bindings

`p/let` awaits each binding, whether it is a Promise or a plain value:

```clojure
(p/let [pkg-raw (cat {:path "package.json"})
        pkg (js->clj (js/JSON.parse pkg-raw) :keywordize-keys true)
        entry (or (:main pkg) "index.js")
        st (stat {:path entry})
        src (if (:exists st) (cat {:path entry}) "")]
  {:entry entry :source src})
```

Use `p/do` for ordered side effects, `p/catch`/`p/finally` for errors, and `p/loop`/`p/recur` for serial loops.

## 2. Writes may run concurrently; the write gate serializes them

`write`, `mkdir`, `rm`, and `mv` may be launched concurrently. The path tokens and the cross-process write lock serialize actual disk writes. `p/all` is safe for independent writes, but completion order and side-effect order are not guaranteed; use `p/let` or `p/loop` when the next step depends on the previous result.

```clojure
(p/let [files (:entries (glob {:path "src" :pattern "**/*.cljs"}))]
  (p/loop [xs (seq files) acc []]
    (if xs
      (p/let [f (first xs)
              txt (cat {:path f})
              _ (write {:path (str f ".bak") :content txt})]
        (p/recur (next xs) (conj acc f)))
      acc)))
```

`p/do` also sequences correctly:

```clojure
(p/do
  (write {:path "a.txt" :content "one"})
  (write {:path "b.txt" :content "two"}))
```

`call` is a long-running blackbox; it manages its own global write lock. Concurrent calls queue on that lock. Do not assume a file will contain a call's output until the call's Promise has settled.

## 3. `p/all` is for independent work

`p/all` returns a CLJS vector. Use it for independent reads or writes:

```clojure
(p/let [texts (p/all (mapv (fn [path] (cat {:path path})) paths))]
  (mapv count texts))
```

If order matters, use `p/let` or `p/loop`. `p/all` does not define an order.

## 4. `park` must stay on the main chain

`park` returns a pending Promise. Connect it with `p/let` or `p/->`; do not leave it floating:

```clojure
(p/let [answer (park {:payload {:question "continue?"}})]
  (write {:path "answer.txt" :content (str answer)}))
```

A Promise created but never connected to the main chain is a dangling Promise. When the program settles, the runtime rejects it with `:DANGLING_PROMISE`. Returning a collection that still contains a Promise fails with `:UNRESOLVED_PROMISE`.

## 5. Abandonment is final

If the host abandons the program, later capability calls reject with `:ABANDONED`, and the final state is `:abandoned`. A user `p/catch` cannot turn that into success. Do not try to recover from abandonment inside the same program.

## 6. Error codes

- `:DANGLING_PROMISE` — the program returned while a capability Promise was still pending.
- `:UNRESOLVED_PROMISE` — the returned value contains an unawaited Promise.
- `:ABANDONED` — the program was abandoned by the host.
- `:LIMIT_EXCEEDED`, `:FILE_CONFLICT`, `:STRUCTURE_CONFLICT`, `:CAPABILITY_DENIED`, `:TOKEN_REQUIRED` — ordinary capability failures; handle them with `p/catch` or let them fail the program.

## 7. Anti-patterns

```clojure
;; WRONG: hand-rolled Promise chain; use p/let, p/do, or p/loop
(-> (cat {:path "a.txt"})
    (.then (fn [text] (count text))))

;; WRONG: src is a Promise, not a string
(let [src (cat {:path "a.txt"})]
  (where {:content src :needle "TODO"}))

;; WRONG: mapv returns a vector of Promises
(mapv (fn [path] (stat {:path path})) paths)

;; WRONG: doseq does not await its body
(doseq [path paths]
  (write {:path path :content "x"}))

;; WRONG when you need the new content: the read may see the old file
(do
  (write {:path "a.txt" :content "x"})
  (cat {:path "a.txt"}))

;; WRONG: returning an unawaited Promise inside data
{:size (stat {:path "a.txt"})}
```

## 8. Minimal correct shapes

Single read:

```clojure
(cat {:path "package.json"})
```

Read then transform:

```clojure
(p/let [text (cat {:path "package.json"})]
  (count text))
```

Write then read:

```clojure
(p/let [_ (write {:path "a.txt" :content "x"})
        text (cat {:path "a.txt"})]
  text)
```

Several writes serially:

```clojure
(p/loop [xs [["a.txt" "one"] ["b.txt" "two"]]]
  (when xs
    (p/let [[path content] (first xs)
            _ (write {:path path :content content})]
      (p/recur (next xs)))))
```

Several independent writes:

```clojure
(p/all [(write {:path "a.txt" :content "one"})
        (write {:path "b.txt" :content "two"})])
```

## 9. One-sentence mental model

All capabilities return `js/Promise`; attach every effect to a `p/...` chain, and the write gate handles mutual exclusion when effects run concurrently.
