(ns cljs.devops-sandbox-test
  (:require
   ["node:fs" :as fs]
   ["node:fs/promises" :as fsp]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.repl :as repl]
   [herd.sandbox :as sandbox]
   [herd.test :as t]
   [promesa.core :as p]))

(def process (.-process js/globalThis))

(defn- make-root []
  (fs/mkdtempSync (path/join (os/tmpdir) "cljs-devops-sandbox-")))

(defn- native-read [params]
  (-> (fsp/readFile (aget params "path") "utf8")
      (.then (fn [text]
               #js {:content #js [#js {:type "text" :text text}]}))))

(defn- native-write [params]
  (-> (fsp/writeFile (aget params "path") (aget params "content") "utf8")
      (.then (fn [_] #js {:content #js []}))))

(defn- native-tools []
  #js {:available (fn [_name _context] true)
       :invoke (fn [name params _options _context]
                 (if (= name "read")
                   (native-read params)
                   (native-write params)))})

(defn- make-pi []
  (let [tools (js/Map.)
        hooks (js/Map.)
        active (atom ["read" "bash" "board_finish" "clj_devops" "wait"])
        pi #js {}]
    (aset pi "tools" tools)
    (aset pi "hooks" hooks)
    (aset pi "active" active)
    (aset pi "registerTool" (fn [definition]
                                (.set tools (.-name definition) definition)))
    (aset pi "registerCommand" (fn [& _] nil))
    (aset pi "on" (fn [name handler]
                      (when-not (.has hooks name) (.set hooks name handler))))
    (aset pi "getActiveTools" (fn [] (clj->js @active)))
    (aset pi "setActiveTools" (fn [next]
                                  (reset! active (vec (js->clj next)))
                                  (js/Promise.resolve nil)))
    (aset pi "pi" #js {:Text (fn [text] #js {:text text})
                         :Container (fn [] #js {:children #js []})})
    pi))

(defn- reset-runtime! []
  (reset! sandbox/token-state {:paths #{} :path-waiters {} :global false :global-waiters []})
  (reset! sandbox/active-calls {})
  (reset! repl/programs {})
  (reset! repl/running #{})
  (reset! repl/abandoned #{}))

(defn- ensure! [root]
  (let [pi (make-pi)]
    (set! (.-__pi js/globalThis) pi)
    (set! (.-__herdTui js/globalThis)
          #js {:highlightCode (fn [code] (str/split-lines code))})
    (set! (.-__herdNativeTools js/globalThis) (native-tools))
    (set! (.-__herdLockRoot js/globalThis) root)
    (reset-runtime!)
    (p/let [_ ((.-__herdEnsureActivated js/globalThis))]
      pi)))

(defn- tool [pi name] (.get (aget pi "tools") name))
(defn- text-of [receipt]
  (aget (aget (aget receipt "content") 0) "text"))

(defn- wait-for-name [pi root name]
  (p/loop []
    (p/let [waited ((.-execute (tool pi "wait")) nil
                    #js {:otherwise_independent_work "none"} nil nil
                    #js {:cwd root})]
      (let [text (text-of waited)]
        (if (or (str/includes? text (str ":name \"" name "\""))
                (str/includes? text ":state :idle")
                (str/includes? text ":state :parked"))
          waited
          (p/recur))))))

(defn- run
  ([pi root name code]
   (run pi root name code nil))
  ([pi root name code call-id]
   (let [ctx #js {:cwd root :agent #js {:id "sandbox-test"}}]
     (p/let [first ((.-execute (tool pi "clj_devops")) call-id
                    #js {:name name :code code :agent_state "Converging"}
                    nil nil ctx)]
       (if (str/includes? (text-of first) ":state :forked")
         (wait-for-name pi root name)
         first)))))

(defn- execute [pi root params]
  ((.-execute (tool pi "clj_devops")) nil params nil nil
   #js {:cwd root :agent #js {:id "sandbox-test"}}))

(t/describe "CLJS devops sandbox mechanisms"
  (fn []
    (t/it "returns an EDN receipt and emits agent-state comments only on transitions"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                first (run pi root "orient" "(+ 1 2)" "Orienting")
                second (run pi root "converge" "(+ 1 2)" "Converging")
                third (run pi root "converge-again" "(+ 1 2)" "Converging")]
          (t/to-contain (text-of first) ":state :completed")
          (t/to-contain (text-of first) ":value 3")
          (t/to-contain (text-of first) "Karl Popper")
          (t/to-contain (text-of second) "Stop hedging")
          (t/to-be (str/starts-with? (text-of second) ";") true)
          (t/to-be (str/starts-with? (text-of third) ";") false))))
    (t/it "rejects an unknown agent state and replays a call id"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                bad (execute pi root #js {:name "bad-state" :code "1" :agent_state "Confused"})
                first (run pi root "replay" "(js/Date.now)" "call-replay-1")
                second (run pi root "replay" "(js/Date.now)" "call-replay-1")
                mismatch (execute pi root #js {:name "replay" :code "(+ 1 2)" :agent_state "Converging"})]
          (t/to-contain (text-of bad) "INVALID_ARGUMENT")
          (t/to-be (text-of second) (text-of first))
          (t/to-contain (text-of mismatch) "CALL_REPLAY_MISMATCH"))))
    (t/it "passes UFSS fences and exposes cat, promesa, and clojure.string"
      (fn []
        (let [root (.-cwd process)]
          (p/let [pi (ensure! root)
                  fence (run pi root "fence" "(count #\"abc\"#)")
                  cat (run pi root "cat" "(cat {:path \"package.json\"})")
                  promesa (run pi root "promesa"
                                "(require '[promesa.core :as p]) (p/let [s (stat {:path \"package.json\"})] (:size s))")
                  strings (run pi root "strings"
                                 "(require '[clojure.string :as str]) [(str \"a\" \"b\") (str/replace \"abc\" \"b\" \"X\")]")]
            (t/to-contain (text-of fence) ":value 3")
            (t/to-contain (text-of cat) "herdchestra-lite")
            (t/to-contain (text-of promesa) ":state :completed")
            (t/to-contain (text-of strings) "\"ab\"")
            (t/to-contain (text-of strings) "\"aXc\"")))))
    (t/it "parks zero and ambiguous where, then resumes with an explicit span"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                zero (run pi root "zero" "(where {:content \"alpha\\nbeta\" :needle \"gamma\"})")
                ambiguous (run pi root "ambig" "(where {:content \"abcabc\" :needle \"ab\"})")
                resumed (run pi root "resume" "(unpark {:name \"ambig\" :value [3 5]})")
                idle ((.-execute (tool pi "wait")) nil
                      #js {:otherwise_independent_work "none"} nil nil
                      #js {:cwd root})]
          (t/to-contain (text-of zero) ":state :parked")
          (t/to-contain (text-of zero) ":nearest")
          (t/to-contain (text-of ambiguous) ":candidates")
          (t/to-contain (text-of resumed) "[3 5]")
          (t/to-contain (text-of idle) ":state :idle"))))
    (t/it "parks explicit programs and resumes them with wait"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                parked (run pi root "park" "(park {:payload 1})")
                resumed (run pi root "resume" "(unpark {:name \"park\" :value 42})")
                idle ((.-execute (tool pi "wait")) nil
                      #js {:otherwise_independent_work "none"} nil nil
                      #js {:cwd root})]
          (t/to-contain (text-of parked) ":state :parked")
          (t/to-contain (text-of resumed) ":value 42")
          (t/to-contain (text-of idle) ":state :idle"))))
    (t/it "runs call with stdin/eof and strips host preload env"
      (fn []
        (let [root (.-cwd process)
              previous (aget (.-env process) "BUN_OPTIONS")]
          (aset (.-env process) "BUN_OPTIONS" "--preload /tmp/nonexistent.js")
          (p/finally
            (p/let [pi (ensure! root)
                    echo (run pi root "echo" "(call {:argv [\"echo\" \"hello-cljs-call\"]})")
                    eof (run pi root "eof" "(call {:argv [\"sh\" \"-c\" \"cat\"] :eof true})")
                    stdin (run pi root "stdin" "(call {:argv [\"sh\" \"-c\" \"cat\"] :stdin \"hello-stdin\"})")
                    env (run pi root "env" "(call {:argv [\"sh\" \"-c\" \"printenv BUN_OPTIONS || printf unset\"]})")]
              (t/to-contain (text-of echo) ":exit 0")
              (t/to-contain (text-of echo) "hello-cljs-call")
              (t/to-contain (text-of eof) ":exit 0")
              (t/to-contain (text-of stdin) "hello-stdin")
              (t/to-contain (text-of env) "unset"))
            (fn []
              (if (undefined? previous)
                (js-delete (.-env process) "BUN_OPTIONS")
                (aset (.-env process) "BUN_OPTIONS" previous)))))))
    (t/it "glob skips dependency trees and matches zero-depth **/ paths"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                _ (fs/mkdirSync (path/join root "tmp/glob-zero/sub") #js {:recursive true})
                _ (fs/writeFileSync (path/join root "tmp/glob-zero/root.txt") "r")
                _ (fs/writeFileSync (path/join root "tmp/glob-zero/sub/deep.txt") "d")
                _ (fs/mkdirSync (path/join root "tmp/glob-box/node_modules/pkg") #js {:recursive true})
                _ (fs/writeFileSync (path/join root "tmp/glob-box/keep.txt") "x")
                _ (fs/writeFileSync (path/join root "tmp/glob-box/node_modules/pkg/dep.js") "x")
                globbed (run pi root "glob" "(glob {:path \"tmp/glob-box\" :pattern \"*\" :exec (fn [e] e)})")
                zero (run pi root "zero-glob" "(glob {:path \"tmp/glob-zero\" :pattern \"**/*.txt\" :exec (fn [p] p)})")]
          (t/to-contain (text-of globbed) "keep.txt")
          (t/to-be (str/includes? (text-of globbed) "dep.js") false)
          (t/to-contain (text-of zero) "root.txt")
          (t/to-contain (text-of zero) "sub/deep.txt"))))
    (t/it "appends the Brooks worker reminder only for a positive count"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                positive (execute pi root #js {:name "workers-pos" :code "(+ 1 1)"
                                               :agent_state "Converging"
                                               :more_workers_without_hitting_mythical_man_month 2})
                zero (execute pi root #js {:name "workers-zero" :code "(+ 1 1)"
                                           :agent_state "Converging"
                                           :more_workers_without_hitting_mythical_man_month 0})]
          (t/to-contain (text-of positive) "你刚刚在工具参数中说还可以增派 2 个工人")
          (t/to-be (str/includes? (text-of zero) "你刚刚在工具参数中说还可以增派") false))))
    (t/it "runs concurrent p/let programs without false dangling promises"
      (fn []
        (let [root (.-cwd process)]
          (p/let [pi (ensure! root)
                  a (run pi root "concurrent-a"
                         "(require '[promesa.core :as p]) (p/let [a (ls {:path \"src\"}) b (cat {:path \"package.json\"})] {:a (:exists a) :b (pos? (count b))})")
                  b (run pi root "concurrent-b"
                         "(require '[promesa.core :as p]) (p/let [x (cat {:path \"src/herd/sandbox.cljs\"}) y (ls {:path \"src/herd\"})] {:x (pos? (count x)) :y (:exists y)})")]
            (t/to-contain (text-of a) ":state :completed")
            (t/to-contain (text-of b) ":state :completed")))))))

