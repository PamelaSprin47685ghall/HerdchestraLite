(ns cljs.console-guard-test
  (:require
   [clojure.string :as str]
   [herd.system :as system]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))
(def process (.-process js/globalThis))

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
    (aset pi "setActiveTools" (fn [next] (reset! active (vec (js->clj next)))))
    (aset pi "pi" #js {:Text (fn [text] #js {:text text})
                         :Container (fn [] #js {:children #js []})})
    pi))

(def pi (make-pi))
(def counter (atom 0))

(defn- ensure! []
  (set! (.-__pi js/globalThis) pi)
  (set! (.-__herdTui js/globalThis) #js {:highlightCode (fn [code] (str/split-lines code))})
  (set! (.-__herdNative js/globalThis)
        #js {:getRunner (fn []
                          #js {:hasNativeTool (fn [name] (or (= name "read") (= name "write")))
                               :invokeNativeTool
                               (fn [name params]
                                 (if (= name "read")
                                   (js/Promise.resolve
                                    #js {:content #js [#js {:type "text"
                                                            :text (.readFileSync fs (aget params "path") "utf8")}]})
                                   (do (.writeFileSync fs (aget params "path") (aget params "content") "utf8")
                                       (js/Promise.resolve #js {:content #js []}))))})})
  ((.-__herdEnsureActivated js/globalThis)))

(defn- tool [name] (.get (aget pi "tools") name))

(defn- text-of [receipt]
  (aget (aget (aget receipt "content") 0) "text"))

(defn- wait-for-name [name]
  (p/loop []
    (p/let [waited ((.-execute (tool "wait")) nil
                    #js {:otherwise_independent_work (apply str (repeat 1000 "x"))}
                    nil)]
      (let [text (text-of waited)]
        (if (or (str/includes? text (str ":name \"" name "\""))
                (str/includes? text ":state :idle")
                (str/includes? text ":state :parked"))
          waited
          (p/recur))))))

(defn- run [code]
  (let [counter-value (swap! counter inc)
        name (str "guard-case-" counter-value)]
    (p/let [first ((.-execute (tool "clj_devops")) nil
                   #js {:name name :code code :agent_state "Converging"}
                   nil)]
      (if (str/includes? (text-of first) ":state :forked")
        (wait-for-name name)
        first))))

(defn- drain []
  (p/loop []
    (p/let [waited ((.-execute (tool "wait")) nil
                    #js {:otherwise_independent_work "none"} nil)]
      (if (str/includes? (text-of waited) ":state :idle")
        nil
        (p/recur)))))

(defn- spy-on [object key]
  ((aget js/__bunTest "spyOn") object key))

(defn- capture-host-writes []
  (let [writes (atom [])
        out (spy-on (.-stdout process) "write")
        err (spy-on (.-stderr process) "write")]
    (.mockImplementation out (fn [chunk] (swap! writes conj (str chunk)) true))
    (.mockImplementation err (fn [chunk] (swap! writes conj (str chunk)) true))
    {:writes writes
     :restore (fn []
                (.mockRestore out)
                (.mockRestore err))}))

(t/describe "CLJS console and stdio guard"
  (fn []
    (t/it "denies direct console and stdio access before running any code"
      (fn []
        (p/let [_ (ensure!)
                dir (.mkdtemp fs (.join path (.tmpdir os) "herd-console-guard-"))]
          (let [previous (.cwd process)
                capture (capture-host-writes)
                symbols [["(js/console.log \"x\")" "js/console"]
                         ["(globalThis.console.log \"x\")" "globalThis.console"]
                         ["(console.log \"x\")" "console"]
                         ["(js/process.stdout.write \"x\")" "js/process.stdout"]
                         ["(js/process.stderr.write \"x\")" "js/process.stderr"]
                         ["(process.stdout.write \"x\")" "process.stdout"]
                         ["(process.stderr.write \"x\")" "process.stderr"]
                         ["(.-stdout js/process)" "(.-stdout js/process)"]
                         ["(.-stderr js/process)" "(.-stderr js/process)"]
                         ["(println \"x\")" "println"]
                         ["(prn \"x\")" "prn"]
                         ["(print \"x\")" "print"]
                         ["(printf \"x\")" "printf"]
                         ["(binding [*print-fn* (fn [_])] nil)" "*print-fn*"]
                         ["(binding [*print-err-fn* (fn [_])] nil)" "*print-err-fn*"]
                         ["(binding [*out* *out*] *out*)" "*out*"]
                         ["(binding [*err* *err*] *err*)" "*err*"]]]
            (.chdir process dir)
            (try
              (p/let [receipts (p/loop [remaining symbols acc []]
                                 (if (empty? remaining)
                                   acc
                                   (let [[code symbol] (first remaining)]
                                     (p/let [receipt (run code)]
                                       (p/recur (rest remaining)
                                                (conj acc [symbol (text-of receipt)]))))))]
                (doseq [[symbol text] receipts]
                  (t/to-contain text ":state :failed")
                  (t/to-contain text "CAPABILITY_DENIED")
                  (t/to-contain text ":reason :console-or-stdio-forbidden")
                  (t/to-contain text (str ":symbol \"" symbol "\"")))
                (t/to-equal @(:writes capture) [])
                (t/to-equal (vec (.readdirSync fs dir)) []))
              (finally
                ((:restore capture))
                (.chdir process previous)
                (.rmSync fs dir #js {:recursive true :force true})))))))
    (t/it "does not reject console text inside strings, comments, or fences"
      (fn []
        (p/let [_ (ensure!)
                literal (run "(str \"println console\" \"-safe\")")
                comment (run "; console.log(\"x\")\n; (println \"x\") prn print printf *print-fn* *out* *err*\n(+ 1 2)")
                fence (run "(count #\"println console\"#)")]
          (t/to-contain (text-of literal) ":state :completed")
          (t/to-contain (text-of literal) "println console-safe")
          (t/to-contain (text-of comment) ":state :completed")
          (t/to-contain (text-of comment) ":value 3")
          (t/to-contain (text-of fence) ":state :completed")
          (t/to-contain (text-of fence) ":value 15"))))
    (t/it "captures call output without writing to the host streams"
      (fn []
        (p/let [_ (ensure!) _ (drain)]
          (let [capture (capture-host-writes)]
            (p/let [result (run "(call {:argv [\"sh\" \"-c\" \"printf out; printf err >&2\"]})")]
              ((:restore capture))
              (let [text (text-of result)]
                (t/to-contain text ":exit 0")
                (t/to-contain text ":stdout \"out\"")
                (t/to-contain text ":stderr \"err\"")
                (t/to-contain text ":output-truncated false")
                (t/to-be (str/includes? text ":log") false)
                (t/to-equal @(:writes capture) []))))))
    (t/it "keeps normal write and cat programs working"
      (fn []
        (p/let [_ (ensure!)
                mkdir (run "(mkdir {:path \"tmp/cljs-console-guard\"})")
                write (run "(write {:path \"tmp/cljs-console-guard/ok.txt\" :content \"guard-ok\"})")
                cat (run "(cat {:path \"tmp/cljs-console-guard/ok.txt\"})")
                removed (run "(rm {:path \"tmp/cljs-console-guard\"})")]
          (t/to-contain (text-of mkdir) ":state :completed")
          (t/to-contain (text-of write) ":state :completed")
          (t/to-contain (text-of cat) "guard-ok")
          (t/to-contain (text-of removed) ":state :completed"))))
    (t/it "writes record-health! to the internal file without host output"
      (fn []
        (p/let [_ (ensure!)
                dir (.mkdtemp fs (.join path (.tmpdir os) "herd-health-"))]
          (swap! system/state assoc-in [:options :root] dir)
          (let [capture (capture-host-writes)
                record (system/record-health! {:entry "test.health" :status "degraded"})]
            ((:restore capture))
            @system/health-tail
            (t/to-equal @(:writes capture) [])
            (t/to-be (aget record "entry") "test.health")
            (t/to-be (aget record "status") "degraded")
            (let [text (.readFileSync fs (.join path dir ".herd/health.jsonl") "utf8")]
              (t/to-contain text "\"entry\":\"test.health\"")
              (t/to-contain text "\"status\":\"degraded\""))
            (.rmSync fs dir #js {:recursive true :force true}))))))
)
)
