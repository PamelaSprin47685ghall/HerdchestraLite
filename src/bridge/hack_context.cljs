(ns bridge.hack-context
  (:require
   [promesa.core :as p]))

(def ^:private trace-limit (* 1024 1024))
(defonce ^:private trace-tail (atom (js/Promise.resolve nil)))
(defonce ^:private trace-truncated-target (atom nil))

(defn flush-trace []
  @trace-tail)

(defn- clock-now []
  (let [clock (.-__herdClock js/globalThis)
        perf (.-performance js/globalThis)]
    (cond
      (and clock (fn? (.-performanceNow clock))) (.performanceNow clock)
      (and perf (fn? (.-now perf))) (.now perf)
      :else (.now js/Date))))

(defn- process-env []
  (let [proc (.-process js/globalThis)]
    (when proc (.-env proc))))

(defn- trace-enabled? []
  (let [env (process-env)]
    (and env (= "1" (aget env "HERD_TRACE")))))

(defn- trace-target []
  (let [env (process-env)]
    (or (when env (aget env "HERD_TRACE_PATH")) ".herd/perf-trace.jsonl")))

(defn- node-require [name]
  ((.-__herdRequire js/globalThis) name))

(defn- append-trace [line]
  (let [fs (node-require "node:fs/promises")
        target (trace-target)]
    (swap! trace-tail
           (fn [previous]
             (p/let [_ previous
                     size (-> (.stat fs target)
                              (.then (fn [stats] (.-size stats)))
                              (.catch (fn [_] 0)))]
               (when-not (= target @trace-truncated-target)
                 (let [buffer-module (node-require "node:buffer")
                       buffer-class (.-Buffer buffer-module)
                       bytes (.byteLength buffer-class line "utf8")
                       dir (or (subs target 0 (.lastIndexOf target "/")) ".")]
                   (if (> (+ size bytes) trace-limit)
                     (do
                       (reset! trace-truncated-target target)
                       (p/let [_ (.mkdir fs dir #js {:recursive true})]
                         (.appendFile fs target
                                      (str (js/JSON.stringify #js {:truncated true
                                                                   :limit trace-limit
                                                                   :at (clock-now)})
                                           "
")
                                      "utf8")))
                     (p/let [_ (.mkdir fs dir #js {:recursive true})]
                       (.appendFile fs target line "utf8"))))))))
    nil))

(defn- record-trace [entry]
  (when (trace-enabled?)
    (append-trace (str (js/JSON.stringify entry) "
"))))

(defn- js-type [value]
  (cond
    (nil? value) "object"
    (boolean? value) "boolean"
    (number? value) "number"
    (string? value) "string"
    (fn? value) "function"
    :else "object"))

(defn- plain-object? [value]
  (and (some? value)
       (= "object" (js-type value))
       (let [proto (js/Object.getPrototypeOf value)]
         (or (nil? proto) (= proto (.-prototype js/Object))))))

(defn deep-equal [a b]
  (cond
    (js/Object.is a b) true
    (or (nil? a) (nil? b)) false
    (not= (js-type a) (js-type b)) false
    (not= "object" (js-type a)) false
    (or (array? a) (array? b))
    (and (array? a)
         (array? b)
         (= (.-length a) (.-length b))
         (every? true? (map-indexed (fn [i _] (deep-equal (aget a i) (aget b i)))
                                    (array-seq a))))
    :else
    (let [keys-a (array-seq (js/Object.keys a))
          keys-b (array-seq (js/Object.keys b))]
      (and (= (count keys-a) (count keys-b))
           (every? (fn [key]
                     (and (.call (.-hasOwnProperty (.-prototype js/Object)) b key)
                          (deep-equal (aget a key) (aget b key))))
                   keys-a)))))

(defn- normalize-append-message [message]
  (if (= "number" (js-type (.-timestamp message)))
    message
    #js {:role (.-role message)
         :content (.-content message)
         :timestamp (clock-now)}))

(defn- new-entry-id []
  (let [value (.toString (js/Math.floor (* (js/Math.random) 0xffffffff)) 16)]
    (.padStart value 8 "0")))

(defn- entry-timestamp [message]
  (let [timestamp (when message (.-timestamp message))]
    (cond
      (= "number" (js-type timestamp)) (.toISOString (js/Date. timestamp))
      (= "string" (js-type timestamp)) timestamp
      :else (.toISOString (js/Date.)))))

(defn- compression-boundary? [entry]
  (and entry
       (or (= "compaction" (.-type entry))
           (= "reset_boundary" (.-type entry)))))

(defn- branch-has-compression-boundary? [manager]
  (if-not (fn? (.-getBranch manager))
    false
    (try
      (let [branch (.getBranch manager)]
        (and (array? branch) (some compression-boundary? (array-seq branch))))
      (catch :default _ false))))

(defn has-compression-boundary [manager]
  (if-not manager
    false
    (if-not (fn? (.-getLeafEntry manager))
      (branch-has-compression-boundary? manager)
      (loop [entry (.getLeafEntry manager)
             guard 0]
        (cond
          (nil? entry) false
          (>= guard 256) (branch-has-compression-boundary? manager)
          (compression-boundary? entry) true
          (nil? (.-parentId entry)) false
          (not (fn? (.-getEntry manager))) false
          :else (recur (.getEntry manager (.-parentId entry)) (inc guard)))))))

(defn- last-persisted-message-entry [manager]
  (if-not (fn? (.-getLeafEntry manager))
    nil
    (loop [entry (.getLeafEntry manager)
           guard 0]
      (cond
        (nil? entry) nil
        (>= guard 64) nil
        (compression-boundary? entry) nil
        (and (= "message" (.-type entry)) (some? (.-message entry))) entry
        (or (nil? (.-parentId entry)) (not (fn? (.-getEntry manager)))) nil
        :else (recur (.getEntry manager (.-parentId entry)) (inc guard))))))

(defn append-session-delta [manager after prefix-len]
  (let [started (if (trace-enabled?) (clock-now) 0)]
    (if-not (and manager
                 (fn? (.-branch manager))
                 (fn? (.-appendMessage manager)))
      #js {:persisted false :branched false :appended 0 :reason "no-branch-api"}
      (let [leaf-id (if (fn? (.-getLeafId manager)) (.getLeafId manager) nil)
            branched (if (nil? leaf-id)
                       false
                       (try (.branch manager leaf-id) true
                            (catch :default _ ::missing)))]
        (if (= ::missing branched)
          #js {:persisted false :branched false :appended 0 :reason "leaf-missing"}
          (let [appended (loop [i prefix-len
                                count 0
                                last-id leaf-id]
                           (if (>= i (.-length after))
                             {:count count :last-id last-id}
                             (let [next-id (.appendMessage manager (aget after i))]
                               (recur (inc i) (inc count) next-id))))]
            (when (and (pos? started) (pos? (:count appended)))
              (record-trace #js {:at (clock-now)
                                 :event "context-append"
                                 :appended (:count appended)
                                 :ms (js/Number (.toFixed (- (clock-now) started) 1))}))
            #js {:persisted true
                 :branched (boolean branched)
                 :appended (:count appended)
                 :lastId (:last-id appended)}))))))

(defn apply-history-barrier [manager options]
  (let [options (or options #js {})]
    (if-not (and manager
                 (fn? (.-branch manager))
                 (fn? (.-appendMessage manager)))
      #js {:persisted false :branched false :appended 0}
      (let [parent-id (.-parentId options)]
        (if (nil? parent-id)
          #js {:persisted false :branched false :appended 0 :reason "root-parent"}
          (do
            (.branch manager parent-id)
            (let [briefing (.-briefing options)]
              (when (some? briefing)
                (.appendMessage manager
                                (normalize-append-message
                                 #js {:role "user"
                                      :content #js [#js {:type "text"
                                                         :text (str briefing)}]})))
              #js {:persisted true
                   :branched true
                   :appended (if (some? briefing) 1 0)
                   :via "branch"})))))))

(defonce ^:private rewrite-ledgers (js/WeakMap.))

(defn- current-leaf-id [manager]
  (if-not manager
    nil
    (if (fn? (.-getLeafId manager))
      (try (or (.getLeafId manager) nil) (catch :default _ nil))
      (let [entry (if (fn? (.-getLeafEntry manager)) (.getLeafEntry manager) nil)]
        (when entry (.-id entry))))))

(defn- ledger-for [manager]
  (let [leaf-id (current-leaf-id manager)
        existing (.get rewrite-ledgers manager)]
    (if-not existing
      (let [ledger #js {:leafId leaf-id :rewrites 0 :misses 0}]
        (.set rewrite-ledgers manager ledger)
        ledger)
      (do
        (when (not= (.-leafId existing) leaf-id)
          (set! (.-leafId existing) leaf-id)
          (set! (.-rewrites existing) 0)
          (set! (.-misses existing) 0))
        existing))))

(defn- sync-ledger-leaf [manager]
  (let [ledger (.get rewrite-ledgers manager)]
    (when ledger
      (set! (.-leafId ledger) (current-leaf-id manager)))))

(defn- content-chars [value]
  (cond
    (string? value) (count value)
    (array? value) (reduce (fn [total block]
                             (cond
                               (string? block) (+ total (count block))
                               (and (some? block) (string? (.-text block))) (+ total (count (.-text block)))
                               :else total))
                           0
                           (array-seq value))
    :else -1))

(defn- cheap-same-shape? [a b]
  (cond
    (js/Object.is a b) true
    (or (nil? a) (nil? b)) false
    (not= "object" (js-type a)) false
    (not= "object" (js-type b)) false
    (not= (.-role a) (.-role b)) false
    :else (= (content-chars (.-content a)) (content-chars (.-content b)))))

(defn- timestamp-shape? [a b]
  (and (some? a)
       (some? b)
       (= "object" (js-type a))
       (= "object" (js-type b))
       (= (.-role a) (.-role b))
       (some? (.-timestamp a))
       (some? (.-timestamp b))
       (= (.-timestamp a) (.-timestamp b))
       (= (content-chars (.-content a)) (content-chars (.-content b)))))

(def ^:private prefix-scan-limit 32)
(def ^:private prefix-deep-limit 8)

(defn- persisted-prefix-length [after last]
  (if (nil? last)
    -1
    (let [length (.-length after)
          end (dec length)]
      (if (and (>= end 0) (identical? (aget after end) last))
        length
        (let [floor (max 0 (- length prefix-scan-limit))
              timestamp-hit (loop [i end]
                              (if (< i floor)
                                -1
                                (let [candidate (aget after i)]
                                  (if (or (identical? candidate last)
                                          (timestamp-shape? candidate last))
                                    (inc i)
                                    (recur (dec i))))))]
          (if (>= timestamp-hit 0)
            timestamp-hit
            (let [deep-floor (max 0 (- length prefix-deep-limit))]
              (loop [i end]
                (if (< i deep-floor)
                  -1
                  (let [candidate (aget after i)]
                    (if (and (cheap-same-shape? candidate last)
                             (deep-equal last candidate))
                      (inc i)
                      (recur (dec i)))))))))))))

(defn hack-context [pi handler]
  (when-not (and pi (fn? (.-on pi)))
    (throw (js/TypeError. "hackContext: pi.on is required")))
  (when-not (fn? handler)
    (throw (js/TypeError. "hackContext: handler function is required")))
  (.on pi "context"
       (fn [event ctx]
         (p/let [started (if (trace-enabled?) (clock-now) 0)
                 result (handler event ctx)
                 handler-ms (if (pos? started) (- (clock-now) started) 0)]
           (if-not (and result (array? (.-messages result)))
             result
             (let [after (.-messages result)
                   manager (or (.-sessionManager ctx)
                               (.-__herdSessionManager js/globalThis))
                   prefix-len (atom -1)
                   synced (atom "none")]
               (when (and manager (pos? (.-length after)))
                 (let [entry (last-persisted-message-entry manager)
                       last (when entry (.-message entry))
                       initial-prefix (if (= true (.-fullRewrite result))
                                        -1
                                        (persisted-prefix-length after last))]
                   (reset! prefix-len initial-prefix)
                   (cond
                     (or (= true (.-handoffReplacement result))
                         (= true (.-fullRewrite result)))
                     (do (append-session-delta manager after 0)
                         (reset! synced "append"))

                     (neg? initial-prefix)
                     (let [ledger (ledger-for manager)]
                       (set! (.-misses ledger) (inc (.-misses ledger)))
                       (when (pos? started)
                         (record-trace #js {:at (clock-now)
                                            :event "context-prefix-miss-suppressed"
                                            :messages (.-length after)
                                            :misses (.-misses ledger)}))
                       (reset! synced "suppressed"))

                     (< initial-prefix (.-length after))
                     (do (append-session-delta manager after initial-prefix)
                         (reset! synced "append"))))
                 (sync-ledger-leaf manager))
               (when (pos? started)
                 (let [total (- (clock-now) started)]
                   (when (>= total 20)
                     (record-trace #js {:at (clock-now)
                                        :hook "context"
                                        :handler "hackContext"
                                        :ms (js/Number (.toFixed total 1))
                                        :handlerMs (js/Number (.toFixed handler-ms 1))
                                        :bytes -1
                                        :messages (.-length after)
                                        :prefixLen @prefix-len
                                        :boundary nil
                                        :synced @synced}))))
               #js {:messages after}))))))
