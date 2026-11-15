(ns cljs.sandbox-limits-test
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
  (fs/mkdtempSync (path/join (os/tmpdir) "cljs-sandbox-extra-")))

(defn- native-read [params]
  (-> (fsp/readFile (aget params "path") "utf8")
      (.then (fn [text] #js {:content #js [#js {:type "text" :text text}]}))))

(defn- native-write [params]
  (-> (fsp/writeFile (aget params "path") (aget params "content") "utf8")
      (.then (fn [_] #js {:content #js []}))))

(defn- native-runner []
  #js {:getRunner
       (fn []
         #js {:hasNativeTool (fn [name] (or (= name "read") (= name "write")))
              :invokeNativeTool
              (fn [name params]
                (if (= name "read")
                  (native-read params)
                  (native-write params)))})})

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
    (set! (.-__herdNative js/globalThis) (native-runner))
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

(defn- run [pi root name code]
  (p/let [first ((.-execute (tool pi "clj_devops")) nil
                 #js {:name name :code code :agent_state "Converging"}
                 nil nil #js {:cwd root :agent #js {:id "sandbox-extra"}})]
    (if (str/includes? (text-of first) ":state :forked")
      (wait-for-name pi root name)
      first)))

(t/describe "CLJS sandbox limits and wait semantics"
  (fn []
    (t/it "returns exact where spans and all whereAll spans"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                exact (run pi root "exact-where" "(where {:content \"abc\" :needle \"ab\"})")
                all (run pi root "all-where" "(whereAll {:content \"abcabc\" :needle \"ab\"})")]
          (t/to-contain (text-of exact) "[0 2]")
          (t/to-contain (text-of all) "[0 2]")
          (t/to-contain (text-of all) "[3 5]"))))
    (t/it "does not replay completed or failed synchronous calls on wait"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                ok (run pi root "sync-ok" "(+ 10 20)")
                failed (run pi root "sync-err" "(unclosed")
                idle ((.-execute (tool pi "wait")) nil
                      #js {:otherwise_independent_work "none"} nil nil
                      #js {:cwd root})]
          (t/to-contain (text-of ok) ":value 30")
          (t/to-contain (text-of failed) ":state :failed")
          (t/to-contain (text-of idle) ":state :idle")
          (t/to-be (str/includes? (text-of idle) "sync-ok") false)
          (t/to-be (str/includes? (text-of idle) "sync-err") false))))
    (t/it "reports a genuine dangling promise"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                result (run pi root "genuine-dangling"
                            "(require '[promesa.core :as p]) (p/race [(js/Promise.resolve :fast) (call {:argv [\"sh\" \"-c\" \"sleep 0.1\"]})])")
                idle ((.-execute (tool pi "wait")) nil
                      #js {:otherwise_independent_work "none"} nil nil
                      #js {:cwd root})]
          (t/to-contain (text-of result) ":state :failed")
          (t/to-contain (text-of result) ":DANGLING_PROMISE")
          (t/to-contain (text-of idle) ":state :idle"))))
    (t/it "keeps incremental call output and feeds stdin on unpark"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                parked (run pi root "stream-case"
                            "(let [p (call {:argv [\"sh\" \"-c\" \"printf first; read x; printf got:%s $x; printf done\"] :name \"stream-case\"} 0)] (-> (herd.sandbox/await-call-start \"stream-case\") (.then (fn [_] (herd.sandbox/await-call-output \"stream-case\" \"first\"))) (.then (fn [_] (park {:payload 1}))) (.then (fn [_] p))))")
                resumed (run pi root "resume-stream"
                              "(unpark {:name \"stream-case\" :value (str \"hello\" (char 10))})")
                idle ((.-execute (tool pi "wait")) nil
                      #js {:otherwise_independent_work "none"} nil nil
                      #js {:cwd root})]
          (t/to-contain (text-of parked) ":state :parked")
          (t/to-contain (text-of parked) ":call-active true")
          (t/to-contain (text-of parked) "first")
          (t/to-contain (text-of resumed) ":state :completed")
          (t/to-contain (text-of resumed) "got:hello")
          (t/to-contain (text-of resumed) "done")
          (t/to-contain (text-of idle) ":state :idle"))))
    (t/it "rejects oversized cat and over-limit glob"
      (fn []
        (p/let [root (make-root)
                pi (ensure! root)
                _ (fs/mkdirSync (path/join root "tmp") #js {:recursive true})
                _ (fs/writeFileSync (path/join root "tmp/big.txt")
                                    (apply str (repeat (+ (* 2 1024 1024) 1) "x")))
                big (run pi root "big-cat" "(cat {:path \"tmp/big.txt\"})")
                _ (fs/mkdirSync (path/join root "tmp/glob-limit") #js {:recursive true})
                _ (fs/writeFileSync (path/join root "tmp/glob-limit/a.txt") "a")
                _ (fs/writeFileSync (path/join root "tmp/glob-limit/b.txt") "b")
                limited (run pi root "glob-limit"
                             "(glob {:path \"tmp/glob-limit\" :pattern \"*\" :limit 1 :exec (fn [e] e)})")]
          (t/to-contain (text-of big) ":LIMIT_EXCEEDED")
          (t/to-contain (text-of limited) ":LIMIT_EXCEEDED"))))))

