(ns herd.entry
  (:require
   [bridge.native-tools :as native-tools]
   [clojure.string :as str]
   [promesa.core :as p]))

(def ^:private board-tools
  ["board_split" "board_claim" "board_finish" "board_cancel" "board_replace"
   "board_release" "board_reopen" "board_comment" "board_update"
   "board_park_slot" "board_take_or_die"])

(def ^:private role-tools
  {"Plan DevOps" ["clj_devops" "submit_devops_report"]
   "Reviewer" ["review"]
   "Swarm Worker" board-tools
   "Swarm Holder" board-tools
   "Manual Auditor" ["attach_case_audit"]})

(def ^:private role-line #"^\[HERD_ROLE:[^\]]*]\r?\n?")

(defonce latest-ctx (atom nil))
(defonce trace-tail (atom (js/Promise.resolve nil)))
(def ^:private trace-limit (* 1024 1024))
(def ^:private trace-default-path ".herd/perf-trace.jsonl")
(def ^:private newline "\n")

(defn- js-type [value]
  (cond
    (nil? value) "object"
    (boolean? value) "boolean"
    (number? value) "number"
    (string? value) "string"
    (fn? value) "function"
    :else "object"))

(defn- object-like? [value]
  (or (and (some? value) (= "object" (js-type value)))
      (fn? value)))

(defn- nbb-module [] (.-__herdNbb js/globalThis))
(defn- node-require [name] ((.-__herdRequire js/globalThis) name))
(defn- process-env [] (.-env (.-process js/globalThis)))
(defn- performance-now [] (.now (.-performance js/globalThis)))

(defn trace-enabled?
  ([] (trace-enabled? (process-env)))
  ([env] (= "1" (aget env "HERD_TRACE"))))

(defn trace-target
  ([] (trace-target (process-env)))
  ([env] (or (aget env "HERD_TRACE_PATH") trace-default-path)))

(defn boot-trace-record
  ([event] (boot-trace-record event #js {} (js/Date.now)))
  ([event fields] (boot-trace-record event fields (js/Date.now)))
  ([event fields at]
   (let [record #js {:at at :event event}]
     (doseq [key (array-seq (js/Object.keys fields))]
       (aset record key (aget fields key)))
     record)))

(defn ^:async trace-boot-event [event fields]
  (try
    (if-not (trace-enabled?)
      false
      (do
        (await @trace-tail)
        (let [target (trace-target)
              line (str (js/JSON.stringify (boot-trace-record event fields)) newline)
              fs (node-require "node:fs/promises")
              path (node-require "node:path")
              buffer-class (.-Buffer (node-require "node:buffer"))
              bytes (.byteLength buffer-class line "utf8")
              stats (try (await (.stat fs target)) (catch :default _ nil))
              size (if stats (.-size stats) 0)]
          (if (> (+ size bytes) trace-limit)
            false
            (do
              (await (.mkdir fs (.dirname path target) #js {:recursive true}))
              (await (.appendFile fs target line "utf8"))
              true)))))
    (catch :default _ false)))

(defn- trace-on [] (when (trace-enabled?) true))
(defn- ms-since [started] (/ (js/Math.round (* (- (performance-now) started) 1000)) 1000))

(defn- boot-state []
  (let [key (js/Symbol.for "herdchestra.boot.v1")
        existing (aget js/globalThis key)]
    (if (some? existing)
      existing
      (let [state #js {:promise nil
                       :handler nil
                       :activateSession nil
                       :hackContext nil
                       :contextPis (js/WeakSet.)
                       :boots 0
                       :contextRegistrations 0}]
        (js/Object.defineProperty js/globalThis key #js {:value state :enumerable false :configurable true})
        state))))

(defn- option-of [request camel kebab]
  (when (some? request)
    (let [value (aget request camel)]
      (if (some? value) value (aget request kebab)))))

(defn- message-of [value]
  (cond
    (instance? js/Error value) (.-message value)
    (string? value) value
    :else (try (js/JSON.stringify value) (catch :default _ (str value)))))

(defn- request-prompt [request]
  (let [raw (or (option-of request "prompt" "task")
                (option-of request "task" "prompt")
                "")]
    (str/replace (str raw) role-line "")))

(defn- request-model [request]
  (let [explicit (option-of request "model" "model")
        role (aget request "role")
        ctx @latest-ctx]
    (cond
      (some? explicit) explicit
      (contains? #{"Plan DevOps" "Swarm Worker" "Swarm Holder"} role) nil
      :else
      (let [model (when ctx (.-model ctx))]
        (cond
          (and model (string? (.-provider model)) (string? (.-id model)))
          (str (.-provider model) "/" (.-id model))
          (and (string? model) (pos? (count model))) model
          :else nil)))))

(defn- request-tools [request]
  (let [explicit (option-of request "tools" "tools")]
    (if (and (array? explicit) (pos? (.-length explicit)))
      explicit
      (when-let [surface (get role-tools (aget request "role"))]
        (vec surface)))))

(defn ^:async run-subagent [request]
  (try
    (let [role (aget request "role")
          tools (request-tools request)
          task-id (.-__herdTaskId js/globalThis)
          prompt (request-prompt request)
          model (request-model request)
          bindings (or (.-__herdSubagentBindings js/globalThis)
                       (let [created #js {}]
                         (set! (.-__herdSubagentBindings js/globalThis) created)
                         created))
          uuid ((.-randomUUID (node-require "node:crypto")))
          nonce (str/replace uuid "-" "")]
      (cond
        (not (contains? role-tools role))
        #js {:ok false :code ":CAPABILITY_DENIED" :error (str "unsupported Herdchestra subagent role: " role)}

        (nil? tools)
        #js {:ok false :code ":CAPABILITY_DENIED" :error (str "no tool surface for role: " role)}

        (nil? task-id)
        #js {:ok false :code ":HOST_API_MISMATCH" :error "the parent session task id is unavailable"}

        (zero? (count prompt))
        #js {:ok false :code ":INVALID_ARGUMENT" :error "runSubagent requires a non-empty prompt"}

        :else
        (do
          (aset bindings nonce task-id)
          (let [fsp (node-require "node:fs/promises")
                os (node-require "node:os")
                path (node-require "node:path")
                binding-dir (.join path (.tmpdir os) "herd-subagent-bindings")
                binding-file (.join path binding-dir (str nonce ".json"))
                bound-agent-id (or (aget request "agentId") (aget request "agent-id"))
                bound-slot-id (or (aget request "slotId") (aget request "slot-id"))
                binding-json (js/JSON.stringify #js {:taskId task-id
                                                     :role role
                                                     :agentId bound-agent-id
                                                     :slotId bound-slot-id})
                task-prompt (str "[HERD_ROLE: " role " nonce=" nonce """
]

""" prompt)
                params #js {:task task-prompt
                            :name (or (aget request "name") (str "Herdchestra " role))
                            :agent "task"}]
            (when (some? model) (aset params "model" model))
            (try
              (await (.mkdir fsp binding-dir #js {:recursive true}))
              (await (.writeFile fsp binding-file binding-json "utf8"))
              (catch :default _ nil))
            (let [cleanup! (fn []
                             (-> (.rm fsp binding-file #js {:force true})
                                 (.catch (fn [_] nil))))]
              (try
                (let [ctx (or (native-tools/current-context) @latest-ctx)
                      options #js {}
                      signal (or (aget request "signal")
                                 (get request :signal)
                                 (and (some? ctx) (.-signal ctx)))]
                  (when (some? signal)
                    (aset options "signal" signal))
                  (let [task-outcome (await (native-tools/task! params options ctx))
                        task-details (when (object-like? task-outcome) (.-details task-outcome))
                        job-info (when task-details (aget task-details "async"))
                        job-id (when job-info (aget job-info "jobId"))
                        origin (if (and job-id (= "running" (aget job-info "state")))
                                 (or (await (native-tools/wait-for-job! job-id ctx)) task-outcome)
                                 task-outcome)
                        details (when (object-like? origin) (.-details origin))
                        results (when details (.-results details))
                        first-result (when (and results (pos? (.-length results))) (aget results 0))
                        progress (when details (.-progress details))
                        first-progress (when (and progress (pos? (.-length progress))) (aget progress 0))
                        jobs (when (and details (not results)) (.-jobs details))
                        first-job (when (and jobs (pos? (.-length jobs))) (aget jobs 0))
                        text (or (when first-result (.-output first-result))
                                 (let [value (native-tools/text-of origin)] (when (seq value) value))
                                 (string? origin) origin
                                 (and (object-like? origin) (string? (.-result origin))) (.-result origin)
                                 (and (object-like? origin) (string? (.-text origin))) (.-text origin)
                                 (and (object-like? origin) (string? (.-output origin))) (.-output origin)
                                 (js/JSON.stringify (or origin "")))
                        agent-id (or (when first-result (.-id first-result))
                                     (when first-job (.-agentId first-job))
                                     (when (object-like? origin) (.-agentId origin)))
                        session-file (or (when first-progress (.-sessionFile first-progress))
                                         (when first-job (.-sessionFile first-job))
                                         (when details (.-sessionFile details)))
                        artifacts-dir (or (when details (.-artifactsDir details))
                                          (aget request "artifactsDir")
                                          (aget request "artifacts-dir"))
                        err (or (when first-result (.-error first-result))
                                (when (and (object-like? origin) (.-isError origin))
                                  (or (.-error origin) text))
                                (when (and (object-like? task-outcome) (.-isError task-outcome))
                                  (or (.-error task-outcome) text)))]
                    (let [out #js {:ok (nil? err)
                                   :role role
                                   :agentId agent-id
                                   :resultMarkdown text
                                   :artifactsDir artifacts-dir
                                   :sessionFile session-file
                                   :error err
                                   :code nil
                                   :resolvedModel model}]
                      (await (cleanup!))
                      out)))
                (catch :default sub-err
                  (await (cleanup!))
                  (throw sub-err))))))))
    (catch :default error
      (let [stack (when (instance? js/Error error) (.-stack error))]
        (try
          (let [fs (node-require "node:fs")]
            (.appendFileSync fs "/tmp/herd-spawn-error.log"
                             (str (message-of error) "\n" stack """

---

""")))
          (catch :default _ nil))
        #js {:ok false
             :code (or (.-code error) ":AGENT_SPAWN_FAILED")
             :error (message-of error)
             :stack stack}))))

(defn- ^:async boot-body []
  (let [nbb (nbb-module)
        load-string (fn [source] (.loadString nbb source))
        _ (await (load-string "(require 'herd.errors 'herd.host 'bridge.command-host 'bridge.hack-context 'herd.main)"))
        herd-error (await (load-string "herd.errors/herd-error"))
        is-herd-error (await (load-string "herd.errors/is-herd-error"))
        message-of-fn (await (load-string "herd.errors/message-of"))
        error-code (await (load-string "herd.errors/error-code"))
        print-edn (await (load-string "herd.errors/print-edn"))
        render-error (await (load-string "herd.errors/render-error"))
        host-value (await (load-string "herd.host/host"))
        detect-capabilities (await (load-string "herd.host/detect-capabilities"))
        create-command-host (await (load-string "bridge.command-host/create-command-host"))
        handler (await (load-string "herd.main/context-handler"))
        activate-session (await (load-string "herd.main/activate-session!"))
        hack-context (await (load-string "bridge.hack-context/hack-context"))]
    (set! (.-__herdErrors js/globalThis)
          #js {:herdError herd-error
               :isHerdError is-herd-error
               :messageOf message-of-fn
               :errorCode error-code
               :printEdn print-edn
               :renderError render-error})
    (set! (.-__herdHostApi js/globalThis)
          #js {:host host-value
               :detectCapabilities detect-capabilities})
    (set! (.-__herdCreateCommandHost js/globalThis) create-command-host)
    #js {:handler handler
         :activateSession activate-session
         :hackContext hack-context}))

(defn ^:async boot []
  (let [state (boot-state)
        existing (.-promise state)]
    (if (some? existing)
      (await existing)
      (let [started (performance-now)
            promise (-> (boot-body)
                        (.then (fn [value]
                                 (set! (.-handler state) (.-handler value))
                                 (set! (.-activateSession state) (.-activateSession value))
                                 (set! (.-hackContext state) (.-hackContext value))
                                 state))
                        (.catch (fn [error]
                                  (set! (.-promise state) nil)
                                  (trace-boot-event "boot-error" #js {:total (ms-since started)
                                                                      :error (message-of error)})
                                  (throw error))))]
        (set! (.-promise state) promise)
        (await promise)))))

(defn ^:async activate [extension-api]
  (let [trace (trace-on)
        started (if trace (performance-now) 0)
        state (boot-state)
        reused (some? (.-promise state))]
    (set! (.-__pi js/globalThis) extension-api)
    (set! (.-__herdHost js/globalThis)
          #js {:runSubagent (fn [request] (run-subagent request))})
    (when trace
      (trace-boot-event "activate-start" #js {:registered (.has (.-contextPis state) extension-api)
                                              :reusedBoot reused
                                              :boots (.-boots state)}))
    (let [state (await (boot))]
      (when (fn? (.-activateSession state))
        (await ((.-activateSession state) extension-api)))
      (let [pis (.-contextPis state)]
        (when-not (.has pis extension-api)
          (.add pis extension-api)
          (set! (.-contextRegistrations state) (inc (.-contextRegistrations state)))
          ((.-hackContext state) extension-api
           (fn [event ctx]
             (when (some? ctx) (reset! latest-ctx ctx))
             ((.-handler state) event ctx)))))
      (when trace
        (trace-boot-event "activate-end" #js {:ms (ms-since started)
                                              :registered (.has (.-contextPis state) extension-api)
                                              :reusedBoot reused
                                              :boots (.-boots state)
                                              :contextRegistrations (.-contextRegistrations state)})))))