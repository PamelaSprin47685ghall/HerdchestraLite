(ns herd.repl
  (:require
   [clojure.string :as string]
   [herd.clock :as clock]
   [herd.sandbox :as sandbox]
   [herd.ufss :as ufss]
   [nbb.core :as nbb]))

(defonce running (atom #{}))
(defonce programs (atom {}))
(defonce abandoned (atom #{}))

(def ^:private prelude
  (str (string/join
         "\n"
         ["(require '[herd.sandbox :as sandbox])"
          "(require '[herd.repl :as repl])"
          "(def cat (fn [request] (sandbox/guarded :cat (fn [] (sandbox/cat request)))))"
          "(def read (fn [request] (sandbox/guarded :read (fn [] (sandbox/read request)))))"
          "(def stat (fn [request] (sandbox/guarded :stat (fn [] (sandbox/stat request)))))"
          "(def ls (fn [request] (sandbox/guarded :ls (fn [] (sandbox/ls request)))))"
          "(def glob (fn [request] (sandbox/guarded :glob (fn [] (sandbox/glob request)))))"
          "(def where (fn [request] (sandbox/guarded :where (fn [] (sandbox/where-with-name @sandbox/current-name request)))))"
          "(def whereAll (fn [request] (sandbox/guarded :whereAll (fn [] (sandbox/whereAll request)))))"
          "(def write (fn [request] (sandbox/guarded :write (fn [] (sandbox/write-with-name @sandbox/current-name request)))))"
          "(def mkdir (fn [request] (sandbox/guarded :mkdir (fn [] (sandbox/mkdir-with-name @sandbox/current-name request)))))"
          "(def rm (fn [request] (sandbox/guarded :rm (fn [] (sandbox/rm-with-name @sandbox/current-name request)))))"
          "(def mv (fn [request] (sandbox/guarded :mv (fn [] (sandbox/mv-with-name @sandbox/current-name request)))))"
          "(def call (fn"
          "            ([request] (sandbox/guarded :call (fn [] (sandbox/call request))))"
          "            ([request timeout-ms] (sandbox/guarded :call (fn [] (sandbox/call request timeout-ms))))))"
          "(def park (fn [request] (sandbox/guarded :park (fn [] (sandbox/park request)))))"
          "(def unpark (fn [request] (sandbox/guarded :unpark (fn [] (repl/unpark request)))))"
          "(def abandon (fn [request] (sandbox/guarded :abandon (fn [] (repl/abandon request)))))"])
       "\n"))

(defn- timeout-error []
  (ex-info "program timed out" {:code :STALLED}))

(defn- with-deadline [promise ms]
  (js/Promise.
    (fn [resolve reject]
      (let [timer (clock/set-timeout #(reject (timeout-error)) ms)]
        (.then promise
               (fn [value]
                 (clock/clear-timeout timer)
                 (resolve value))
               (fn [error]
                 (clock/clear-timeout timer)
                 (reject error)))))))

(defn- notifier [name]
  (js/Promise.
    (fn [resolve]
      (swap! sandbox/notifiers assoc name resolve))))

(defn- source [_name code]
  (str prelude (ufss/unwrap code) "\n"))

(def ^:private forbidden-source-patterns
  [[#"(?<![\w-])js/process\.stdout(?![\w-])" "js/process.stdout"]
   [#"(?<![\w-])js/process\.stderr(?![\w-])" "js/process.stderr"]
   [#"(?<![\w-])process\.stdout(?![\w-])" "process.stdout"]
   [#"(?<![\w-])process\.stderr(?![\w-])" "process.stderr"]
   [#"\(\s*\.\-stdout[\s,]*js/process\s*\)" "(.-stdout js/process)"]
   [#"\(\s*\.\-stderr[\s,]*js/process\s*\)" "(.-stderr js/process)"]
   [#"(?<![\w./-])println(?![\w./-])" "println"]
   [#"(?<![\w./-])prn(?![\w./-])" "prn"]
   [#"(?<![\w./-])printf(?![\w./-])" "printf"]
   [#"(?<![\w./-])print(?![\w./-])" "print"]
   [#"\*print-err-fn\*" "*print-err-fn*"]
   [#"\*print-fn\*" "*print-fn*"]
   [#"\*out\*" "*out*"]
   [#"\*err\*" "*err*"]
   [#"(?<![\w-])js/console(?![\w-])" "js/console"]
   [#"(?<![\w-])globalThis\.console(?![\w-])" "globalThis.console"]
   [#"(?<![\w-])console(?![\w-])" "console"]])

(def ^:private backslash-char (char 92))
(def ^:private quote-char (char 34))
(def ^:private hash-char (char 35))
(def ^:private semicolon-char (char 59))
(def ^:private pipe-char (char 124))
(def ^:private newline-char (char 10))

(defn- skip-string-literal [text start]
  (let [n (count text)]
    (loop [i (inc start)]
      (if (>= i n)
        n
        (let [ch (subs text i (inc i))]
          (cond
            (= ch backslash-char) (recur (+ i 2))
            (= ch quote-char) (inc i)
            :else (recur (inc i))))))))

(defn- skip-line-comment [text start]
  (let [nl (.indexOf text newline-char start)]
    (if (neg? nl) (count text) (inc nl))))

(defn- strip-literals-and-comments [source]
  (let [text (ufss/unwrap source)
        n (count text)]
    (loop [i 0 out (transient [])]
      (if (>= i n)
        (apply str (persistent! out))
        (let [ch (subs text i (inc i))
              next-ch (when (< (inc i) n) (subs text (inc i) (+ i 2)))]
          (cond
            (= ch semicolon-char)
            (recur (skip-line-comment text i) (conj! out " "))

            (= ch backslash-char)
            (recur (min n (+ i 2)) (conj! out " "))

            (= ch quote-char)
            (recur (skip-string-literal text i) (conj! out " "))

            (and (= ch hash-char) (= next-ch quote-char))
            (recur (skip-string-literal text (inc i)) (conj! out " "))

            (and (= ch hash-char) (= next-ch pipe-char))
            (let [end (.indexOf text (str pipe-char hash-char) (+ i 2))]
              (recur (if (neg? end) n (+ end 2)) (conj! out " ")))

            :else
            (recur (inc i) (conj! out ch))))))))

(def ^:private role-capabilities
  {:devops #{:cat :read :stat :ls :glob :where :whereAll :write :mkdir :rm :mv :call :park :unpark :abandon}
   :plan #{:cat :read :where :whereAll :park :unpark}
   :review #{:cat :read :stat :ls :glob :where :whereAll :unpark}
   :worker #{:cat :read :stat :ls :glob :where :whereAll :write :mkdir :rm :mv :park :unpark :abandon}
   :holder #{:cat :read :stat :ls :glob :where :whereAll :write :mkdir :rm :mv :call :park :unpark :abandon}
   :auditor #{:cat :read :stat :ls :glob :where :whereAll :call :park :unpark :abandon}})

(def ^:private all-capabilities
  [:cat :read :stat :ls :glob :where :whereAll :write :mkdir :rm :mv :call :park :unpark :abandon])

(defn guard-source!
  """
Reject direct console or stdio access and capabilities outside the current
  role before any user code runs. Strings, UFSS fences, character literals,
  and comments are stripped first.
"""
  [code role]
  (let [stripped (strip-literals-and-comments code)
        allowed (get role-capabilities (or role :devops) (:devops role-capabilities))
        forbidden (remove allowed all-capabilities)]
    (when-let [hit (some (fn [[pattern symbol]]
                           (when (re-find pattern stripped)
                             [pattern symbol]))
                         forbidden-source-patterns)]
      (let [symbol (second hit)]
        (throw (ex-info (str symbol " is not available in the sandbox")
                        {:code :CAPABILITY_DENIED
                         :reason :console-or-stdio-forbidden
                         :symbol symbol}))))
    (when-let [cap (some (fn [cap]
                           (let [pattern (re-pattern (str "(?<![A-Za-z0-9_-])" (name cap) "(?![A-Za-z0-9_-])"))]
                             (when (re-find pattern stripped) cap)))
                         forbidden)]
      (throw (ex-info (str (name cap) " is not available for this role")
                      {:code :CAPABILITY_DENIED
                       :reason :role-capability
                       :role role
                       :symbol (name cap)})))))

(defn- evaluate [name code]
  (js/Promise.resolve (nbb/load-string (source name code))))
(defn- parked? [value]
  (and (map? value) (= :parked (:state value))))

(defn- remember! [name entry]
  (swap! programs assoc name entry))

(defn- mark-completed! [name value]
  (remember! name (-> (get @programs name)
                    (assoc :state :completed :value value)
                    (dissoc :promise))))

(defn- error-summary [error]
  (let [data (or (ex-data error) {})]
    (cond-> {:message (or (ex-message error) (.-message error) (str error))
             :code (or (:code data) :INTERNAL)}
      (:reason data) (assoc :reason (:reason data))
      (:symbol data) (assoc :symbol (:symbol data)))))

(defn- mark-failed! [name error]
  (remember! name (-> (get @programs name)
                    (assoc :state :failed :error (error-summary error))
                    (dissoc :promise))))

(defn- mark-parked! [name value]
  (remember! name (merge (get @programs name) value {:state :parked})))

(defn- completed-receipt [name value]
  {:name name :state :completed :value value})

(defn- parked-receipt [name value]
  (merge {:name name} value))

(defn- await-resumed [name entry]
  (if-let [promise (:promise entry)]
    (let [n (notifier name)]
      (-> (js/Promise.race #js [promise n])
          (.then (fn [value]
                   (swap! sandbox/notifiers dissoc name)
                   (if (parked? value)
                     (do (mark-parked! name value)
                         (parked-receipt name value))
                     (do (swap! programs dissoc name)
                         value))))
          (.catch (fn [error]
                    (swap! sandbox/notifiers dissoc name)
                    (swap! programs dissoc name)
                    {:name name :state :failed :error (error-summary error)}))))
    (cond
      (= :completed (:state entry))
      (do (swap! programs dissoc name)
          (:value entry))
      (= :failed (:state entry))
      (do (swap! programs dissoc name)
          {:name name :state :failed :error (:error entry)})
      (= :parked (:state entry))
      {:name name :state :unrecoverable :reason :deadline}
      :else
      {:name name :state :running})))

(defn unpark [request]
  (let [name (:name request)
        entry (get @programs name)]
    (try
      (let [result (sandbox/unpark request)]
        (if entry
          (await-resumed name entry)
          result))
      (catch :default error
        (if (= :PROGRAM_UNKNOWN (:code (ex-data error)))
          (if entry
            (await-resumed name entry)
            (throw error))
          (throw error))))))

(defn abandon [request]
  (let [name (:name request)
        entry (get @programs name)
        _ (when (contains? #{:running :parked} (:state entry))
            (sandbox/abandon-program! name))
        result (sandbox/abandon request)
        runtime-parked? (and entry
                             (= :parked (:state entry))
                             (or (:background entry) (false? (:recoverable entry))))]
    (cond
      (= :abandoned (:state result))
      (do
        (swap! abandoned conj name)
        (swap! programs dissoc name)
        result)

      (and (= :unknown (:state result))
           (contains? #{:completed :failed} (:state entry)))
      (do
        (swap! programs dissoc name)
        {:name name :state :cleared :cleared true})

      (and (= :unknown (:state result)) runtime-parked?)
      (do
        (swap! abandoned conj name)
        (swap! programs dissoc name)
        {:name name :state :cleared :cleared true :reason (:reason entry)})

      :else result)))

(defn- failed-receipt [name error]
  (mark-failed! name error)
  {:name name :state :failed :error (error-summary error)})

(defn- receipt [name value]
  (if (parked? value)
    (do (mark-parked! name value)
        (parked-receipt name value))
    (completed-receipt name value)))

(defn- already-running! [name]
  (when (@running name)
    (throw (ex-info "program name is already running" {:code :NAME_TAKEN :name name}))))

(defn- contains-promise? [value]
  (letfn [(scan [value depth]
            (cond
              (instance? js/Promise value) true
              (>= depth 64) false
              (vector? value) (boolean (some (fn [item] (scan item (inc depth))) value))
              (set? value) (boolean (some (fn [item] (scan item (inc depth))) value))
              (map? value) (boolean (or (some (fn [item] (scan item (inc depth))) (keys value))
                                        (some (fn [item] (scan item (inc depth))) (vals value))))
              (seq? value) (boolean (some (fn [item] (scan item (inc depth))) value))
              (array? value) (boolean (some (fn [item] (scan item (inc depth))) (array-seq value)))
              :else false))]
    (scan value 0)))

(defn- validate-program-result! [name value]
  (let [state (sandbox/program-state name)
        in-flight (get state :in-flight 0)]
    (cond
      (or (contains? @abandoned name) (:abandoned? state))
      (throw (ex-info "program was abandoned" {:code :ABANDONED}))

      (pos? in-flight)
      (throw (ex-info "program finished with capabilities still in flight"
                      {:code :DANGLING_PROMISE :in-flight in-flight}))

      (contains-promise? value)
      (throw (ex-info "program returned unresolved Promise(s)"
                      {:code :UNRESOLVED_PROMISE}))

      :else value)))

(defn- track! [name promise]
  (let [tracked
        (-> promise
            (.then
              (fn [value]
                (swap! sandbox/notifiers dissoc name)
                (if (contains? @abandoned name)
                  (do
                    (sandbox/end-program! name)
                    (swap! running disj name)
                    (js/Promise.reject (ex-info "program was abandoned" {:code :ABANDONED})))
                  (try
                    (let [checked (validate-program-result! name value)]
                      (mark-completed! name checked)
                      (sandbox/end-program! name)
                      (swap! running disj name)
                      checked)
                    (catch :default error
                      (mark-failed! name error)
                      (sandbox/end-program! name)
                      (swap! running disj name)
                      (js/Promise.reject error)))))
              (fn [error]
                (swap! sandbox/notifiers dissoc name)
                (when-not (contains? @abandoned name)
                  (mark-failed! name error))
                (sandbox/end-program! name)
                (swap! running disj name)
                (js/Promise.reject error))))]
    (remember! name {:state :running :promise tracked})
    tracked))

(defonce fork-token #js {})

(defn- after [ms value]
  (js/Promise.
    (fn [resolve]
      (clock/set-timeout #(resolve value) ms))))

(defn- run-role [name code _deadline-ms role]
  (when-not (and (string? name) (pos? (count (string/trim name))))
    (throw (ex-info "name must be a non-empty string"
                    {:code :INVALID_ARGUMENT :field :name})))
  (when-not (string? code)
    (throw (ex-info "code must be a string"
                    {:code :INVALID_ARGUMENT :field :code})))
  (already-running! name)
  (swap! abandoned disj name)
  (sandbox/reset-budget! name)
  (sandbox/begin-program! name)
  (swap! running conj name)
  (reset! sandbox/current-name name)
  (let [n (notifier name)
        p (try
            (guard-source! code role)
            (evaluate name code)
            (catch :default error
              (js/Promise.reject error)))
        tracked (track! name p)]
    (-> (js/Promise.race #js [tracked n (after 2000 fork-token)])
        (.then (fn [value]
                 (if (identical? value fork-token)
                   {:name name :state :forked}
                   (receipt name value))))
        (.catch (fn [error]
                  (if (or (contains? @abandoned name)
                          (= :ABANDONED (:code (ex-data error))))
                    {:name name :state :abandoned}
                    (failed-receipt name error)))))))

(defn run
  ([name code deadline] (run-role name code deadline :devops))
  ([name code deadline role] (run-role name code deadline role)))

(defn- finished? [entry]
  (or (= :completed (:state entry))
      (= :failed (:state entry))))

(defn- finished-entries []
  (->> @programs
       (filter (fn [[_ entry]] (finished? entry)))
       (sort-by first)))

(defn- take-finished! []
  (let [entries (finished-entries)]
    (when (seq entries)
      (swap! programs #(apply dissoc % (map first entries)))
      entries)))

(defn- running-promises []
  (->> @programs
       (keep (fn [[_ entry]] (when (= :running (:state entry)) (:promise entry))))
       vec))

(defn- idle-receipt []
  {:state :idle
   :in-flight (count (running-promises))
   :backlog 0
   :message "No sandbox tasks are running or queued."})

(defn- receipt-of [[name entry]]
  (if (= :failed (:state entry))
    {:name name :state :failed :error (:error entry)}
    (completed-receipt name (:value entry))))

(defn- results-receipt [entries]
  (if (= 1 (count entries))
    (receipt-of (first entries))
    {:state :joined :results (mapv receipt-of entries)}))

(defn- collect-or-wait []
  (if-let [entries (take-finished!)]
    (results-receipt entries)
    (if-let [promises (seq (running-promises))]
      (-> (js/Promise.race (clj->js promises))
          (.then (fn [_] (collect-or-wait)))
          (.catch (fn [_] (collect-or-wait))))
      (idle-receipt))))

(defn- running-names []
  (->> @programs
       (keep (fn [[name entry]] (when (= :running (:state entry)) name)))
       vec))

(defn parked-names []
  (->> @programs
       (keep (fn [[name entry]] (when (= :parked (:state entry)) name)))
       vec))

(defn- park-all! []
  (let [names (running-names)]
    (doseq [name names]
      (let [entry (get @programs name)
            snapshot (or (sandbox/call-snapshot name) {})]
        (remember! name (merge entry
                               {:state :parked
                                :reason :deadline
                                :recoverable false
                                :background true
                                :payload (merge {:reason :deadline} snapshot)}))))
    (mapv (fn [name]
            (let [entry (get @programs name)]
              {:name name
               :state :parked
               :reason :deadline
               :recoverable false
               :background true
               :payload (:payload entry)}))
          names)))

(defn wait-for-result
  ([] (wait-for-result 30000))
  ([deadline-ms]
   (-> (with-deadline (js/Promise.resolve (collect-or-wait)) (or deadline-ms 30000))
       (.catch (fn [error]
                 (if (= :STALLED (:code (ex-data error)))
                   (let [parked (park-all!)]
                     (if (seq parked)
                       {:state :parked :reason :deadline :programs parked}
                       (throw error)))
                   (throw error))))))) 1713