(ns cljs.hack-context-rewrite-test
  (:require
   [bridge.hack-context :as hack]
   [clojure.string :as str]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs/promises"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))

(defn- set-env! [key value]
  (if (nil? value)
    (js-delete (.-env (.-process js/globalThis)) key)
    (aset (.-env (.-process js/globalThis)) key value)))

(defn- host-manager [entries]
  (let [state #js {:header #js {:runtime #js {:version "test"}}
                   :entries (js/Array.from entries)}
        rewrites (atom 0)]
    #js {:state state
         :getRewriteCount (fn [] @rewrites)
         :captureState (fn [] state)
         :restoreState (fn [next]
                         (aset state "header" (aget next "header"))
                         (aset state "entries" (aget next "entries")))
         :rewriteEntries (fn []
                           (swap! rewrites inc)
                           (js/Promise.resolve nil))
         :branch (fn [& _] nil)
         :appendMessage
         (fn [message]
           (let [entries (aget state "entries")
                 parent (when (pos? (.-length entries))
                          (aget entries (dec (.-length entries))))
                 parent-id (when parent (aget parent "id"))
                 id (str "e" (inc (.-length entries)) "-" (or parent-id "root"))]
             (.push entries #js {:type "message" :id id :parentId parent-id :message message})
             id))
         :getLeafEntry
         (fn []
           (let [entries (aget state "entries")]
             (when (pos? (.-length entries))
               (aget entries (dec (.-length entries))))))
         :getEntry
         (fn [id]
           (some (fn [entry] (when (= id (aget entry "id")) entry))
                 (array-seq (aget state "entries"))))
         :getLeafId
         (fn []
           (let [entries (aget state "entries")]
             (when (pos? (.-length entries))
               (aget (aget entries (dec (.-length entries))) "id"))))}))

(defn- register [handler]
  (let [handlers (js/Map.)]
    (hack/hack-context
     #js {:on (fn [name fn] (.set handlers name fn))}
     handler)
    (.get handlers "context")))

(defn- entries-of [messages]
  (mapv (fn [index message]
          #js {:type "message"
               :id (str "s" index)
               :parentId (when (pos? index) (str "s" (dec index)))
               :message message})
        (range (count messages))
        messages))

(t/describe "context trace"
  (fn []
    (t/it "records suppressed misses with the miss count"
      (fn []
        (p/let [dir (.mkdtemp fs (.join path (.tmpdir os) "herd-hack-suppressed-"))
                trace-path (.join path dir "perf-trace.jsonl")]
          (set-env! "HERD_TRACE" "1")
          (set-env! "HERD_TRACE_PATH" trace-path)
          (let [manager (host-manager (entries-of [#js {:role "user" :content "old"}]))
                round (atom 0)
                context (register (fn []
                                    (swap! round inc)
                                    #js {:messages #js [#js {:role "user"
                                                             :content (str "x-" @round)}]}))
                ctx #js {:sessionManager manager}]
            (p/let [_ (context #js {:messages #js []} ctx)
                    _ (context #js {:messages #js []} ctx)
                    _ (hack/flush-trace)
                    text (p/let [value (.readFile fs trace-path "utf8")] value)]
              (let [lines (mapv js/JSON.parse (remove str/blank? (str/split-lines text)))
                    suppressed (some (fn [item]
                                       (when (= "context-prefix-miss-suppressed"
                                                (aget item "event"))
                                         item))
                                     lines)]
                (t/to-be (some? suppressed) true)
                (t/to-be (aget suppressed "misses") 1)
                (t/to-be (aget suppressed "messages") 1)))
            (.rm fs dir #js {:recursive true :force true}))))))
    (t/it "writes no trace when HERD_TRACE is off"
      (fn []
        (p/let [dir (.mkdtemp fs (.join path (.tmpdir os) "herd-hack-off-"))
                trace-path (.join path dir "perf-trace.jsonl")]
          (set-env! "HERD_TRACE" nil)
          (set-env! "HERD_TRACE_PATH" trace-path)
          (let [manager (host-manager (entries-of [#js {:role "user" :content "old"}]))
                context (register (fn [] #js {:messages #js [#js {:role "user" :content "new"}]}))]
            (p/let [_ (context #js {:messages #js []} #js {:sessionManager manager})
                    _ (hack/flush-trace)
                    text (-> (.readFile fs trace-path "utf8")
                             (.catch (fn [_] nil)))]
              (t/to-be text nil)))
          (.rm fs dir #js {:recursive true :force true})))))

(t/describe "hackContext append-only"
  (fn []
    (t/it "appends the new tail without rewriting"
      (fn []
        (let [old #js {:role "user" :content "old"}
              tail #js {:role "assistant" :content #js [#js {:type "text" :text "after"}]}
              manager (host-manager (entries-of [old]))
              context (register (fn [_] #js {:messages #js [old tail]}))]
          (p/let [_ (context #js {:messages #js [old]} #js {:sessionManager manager})]
            (t/to-be (.getRewriteCount manager) 0)
            (let [entries (aget (aget manager "state") "entries")
                  last-entry (aget entries (dec (.-length entries)))]
              (t/to-be (.-length entries) 2)
              (t/to-be (identical? tail (aget last-entry "message")) true))))))
    (t/it "stays append-only when the leaf is a custom entry"
      (fn []
        (let [seed #js {:role "user" :content "seed"}
              manager (host-manager
                       (into (entries-of [seed])
                             [#js {:type "custom" :id "c1" :parentId "s0" :data #js {}}]))
              tail #js {:role "user" :content #js [#js {:type "text" :text "tail"}]}
              context (register (fn [_] #js {:messages #js [seed tail]}))]
          (p/let [_ (context #js {:messages #js [seed]} #js {:sessionManager manager})]
            (t/to-be (.getRewriteCount manager) 0)
            (let [entries (aget (aget manager "state") "entries")
                  last-entry (aget entries (dec (.-length entries)))]
              (t/to-be (.-length entries) 3)
              (t/to-be (identical? tail (aget last-entry "message")) true))))))
    (t/it "does not persist a replacement without rewriting"
      (fn []
        (let [old #js {:role "user" :content "old"}
              manager (host-manager (entries-of [old]))
              context (register (fn [_] #js {:messages #js [#js {:role "user" :content "replacement"}]}))]
          (p/let [_ (context #js {:messages #js [old]} #js {:sessionManager manager})]
            (t/to-be (.getRewriteCount manager) 0)
            (let [entries (aget (aget manager "state") "entries")]
              (t/to-be (.-length entries) 1)
              (t/to-be (aget (aget entries 0) "message") old))))))
    (t/it "appends a handoff replacement after a compression boundary"
      (fn []
        (let [old #js {:role "user" :content "old"}
              manager (host-manager
                       (into (entries-of [old])
                             [#js {:type "compaction" :id "c1" :parentId "s0"}]))
              doc #js {:role "user" :content #js [#js {:type "text" :text "handoff"}]}
              context (register (fn [_] #js {:messages #js [doc] :handoffReplacement true}))]
          (p/let [_ (context #js {:messages #js [old]} #js {:sessionManager manager})]
            (t/to-be (.getRewriteCount manager) 0)
            (let [entries (aget (aget manager "state") "entries")
                  last-entry (aget entries (dec (.-length entries)))]
              (t/to-be (.-length entries) 3)
              (t/to-be (aget last-entry "parentId") "c1")
              (t/to-be (identical? doc (aget last-entry "message")) true))))))
    (t/it "appends ordinary tail after a compression boundary"
      (fn []
        (let [old #js {:role "user" :content "old"}
              kept #js {:role "user" :content "kept"}
              manager (host-manager
                       (into (entries-of [old])
                             [#js {:type "compaction" :id "c1" :parentId "s0"}
                              #js {:type "message" :id "e2" :parentId "c1" :message kept}]))
              tail #js {:role "user" :content "tail"}
              context (register (fn [_] #js {:messages #js [kept tail]}))]
          (p/let [_ (context #js {:messages #js [kept]} #js {:sessionManager manager})]
            (t/to-be (.getRewriteCount manager) 0)
            (let [entries (aget (aget manager "state") "entries")
                  last-entry (aget entries (dec (.-length entries)))]
              (t/to-be (.-length entries) 4)
              (t/to-be (aget last-entry "parentId") "e2"))))))
    (t/it "returns transformed messages without a manager"
      (fn []
        (let [context (register (fn [_] #js {:messages #js [#js {:role "user" :content "after"}]}))]
          (p/let [result (context #js {:messages #js [#js {:role "user" :content "before"}]} #js {})]
            (t/to-be (aget (aget (aget result "messages") 0) "content") "after")))))
    (t/it "applyHistoryBarrier branches and appends the briefing"
      (fn []
        (let [seed #js {:role "user" :content "seed"}
              manager (host-manager (entries-of [seed]))
              result (hack/apply-history-barrier manager #js {:parentId "s0" :briefing "S2"})]
          (t/to-be (aget result "persisted") true)
          (t/to-be (aget result "branched") true)
          (t/to-be (aget result "appended") 1)
          (let [entries (aget (aget manager "state") "entries")
                last-entry (aget entries (dec (.-length entries)))]
            (t/to-equal (aget (aget (aget last-entry "message") "content") 0)
                       #js {:type "text" :text "S2"})))))
    (t/it "applyHistoryBarrier rejects a null parent and missing APIs"
      (fn []
        (let [manager (host-manager [])
              root (hack/apply-history-barrier manager #js {:parentId nil :briefing "x"})
              missing (hack/apply-history-barrier nil #js {:briefing "x"})]
          (t/to-be (aget root "persisted") false)
          (t/to-be (aget root "reason") "root-parent")
          (t/to-be (aget missing "persisted") false))))))
