(ns herd.entry
  (:require
   [clojure.string :as str]
   [herd.native-runner :as native-runner]
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

(def ^:private role-system-prompts
  {"Plan DevOps" "You are the Plan DevOps subagent for Herdchestra Lite. Inspect the real workspace read-only with clj_devops and finish exactly once through submit_devops_report."
   "Reviewer" "You are the Herdchestra Lite S5 Reviewer. Inspect the frozen contract documents and the real single workspace, then finish with exactly one review call."
   "Swarm Worker" "You are a Herdchestra Lite Swarm Worker. Coordinate only through the shared board tools and the write gate; never wait for a human."
   "Swarm Holder" "You are a Herdchestra Lite Swarm Holder. Coordinate only through the shared board tools and the write gate; never wait for a human."
   "Manual Auditor" "You are a Herdchestra Lite Manual Auditor. Audit exactly one CASE in the isolated copy and finish exactly once through attach_case_audit."})

(def ^:private role-line #"^\[HERD_ROLE:[^\]]*]\r?\n?")

(defonce latest-ctx (atom nil))
(defonce trace-tail (atom (js/Promise.resolve nil)))
(def ^:private trace-limit (* 1024 1024))
(def ^:private trace-default-path ".herd/perf-trace.jsonl")
(def ^:private newline "
")

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
(defn- process-cwd [] (.cwd (.-process js/globalThis)))
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

(defn- ^:async traced [trace phase f]
  (if (nil? trace)
    (await (f))
    (let [started (performance-now)]
      (try
        (let [value (await (f))]
          (trace-boot-event "boot-phase" #js {:phase phase :ms (ms-since started)})
          value)
        (catch :default error
          (trace-boot-event "boot-phase" #js {:phase phase :ms (ms-since started)})
          (throw error))))))

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

(defn- request-system-prompt [request]
  (let [explicit (option-of request "systemPrompt" "system-prompt")]
    (if (and (string? explicit) (pos? (count (str/trim explicit))))
      explicit
      (get role-system-prompts (aget request "role")))))

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

(defn- request-artifacts-dir [request]
  (let [value (option-of request "artifactsDir" "artifacts-dir")]
    (when (and (string? value) (pos? (count value))) value)))

(defn- request-session-file [request]
  (let [value (option-of request "sessionFile" "session-file")]
    (when (and (string? value) (pos? (count value))) value)))

(defn- outcome-payload [outcome role]
  (let [result (when (object-like? outcome) (.-result outcome))
        result-markdown (cond
                          (string? result) result
                          (and result (string? (.-result result))) (.-result result)
                          (and result (string? (.-text result))) (.-text result)
                          (and result (string? (.-message result))) (.-message result)
                          (and result (string? (.-output result))) (.-output result)
                          :else "")
        ok (true? (when outcome (.-ok outcome)))
        error (when-not ok (message-of (or (.-error outcome) "subagent failed")))]
    #js {:ok ok
         :role role
         :agentId (when outcome (.-agentId outcome))
         :resultMarkdown result-markdown
         :artifactsDir (when (and outcome (.-artifacts outcome)) (.-dir (.-artifacts outcome)))
         :sessionFile (when (and outcome (.-artifacts outcome)) (.-sessionFile (.-artifacts outcome)))
         :error error
         :code (when-not ok (or (when (and outcome (.-error outcome)) (.-code (.-error outcome))) ":AGENT_SPAWN_FAILED"))
         :resolvedModel (when outcome (.-resolvedModel outcome))}))

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
          nonce (str/replace uuid "-" "")
          runner (when-let [native (.-__herdNative js/globalThis)]
                   ((.-getRunner native)))]
      (cond
        (not (contains? role-tools role))
        #js {:ok false :code ":CAPABILITY_DENIED" :error (str "unsupported Herdchestra subagent role: " role)}

        (nil? tools)
        #js {:ok false :code ":CAPABILITY_DENIED" :error (str "no tool surface for role: " role)}

        (nil? task-id)
        #js {:ok false :code ":HOST_API_MISMATCH" :error "the parent session task id is unavailable"}

        (nil? runner)
        #js {:ok false :code ":HOST_API_MISMATCH" :error "the native task runner is unavailable"}

        (zero? (count prompt))
        #js {:ok false :code ":INVALID_ARGUMENT" :error "runSubagent requires a non-empty prompt"}

        :else
        (do
          (aset bindings nonce task-id)
          (let [task-prompt (str "[HERD_ROLE: " role " nonce=" nonce "]\n" prompt)
                params #js {:prompt task-prompt
                            :description (str "Herdchestra " role)
                            :agent "task"}]
            (when (some? model) (aset params "model" model))
            (let [outcome (await (.invokeNativeTool runner "task" params #js {}))
                  text (cond
                         (string? outcome) outcome
                         (and (object-like? outcome) (string? (.-result outcome))) (.-result outcome)
                         (and (object-like? outcome) (string? (.-text outcome))) (.-text outcome)
                         (and (object-like? outcome) (string? (.-output outcome))) (.-output outcome)
                         :else (js/JSON.stringify (or outcome "")))]
              #js {:ok true
                   :role role
                   :agentId (when (object-like? outcome) (.-agentId outcome))
                   :resultMarkdown text
                   :artifactsDir nil
                   :sessionFile nil
                   :error nil
                   :code nil
                   :resolvedModel model})))))
    (catch :default error
      #js {:ok false
           :code (or (.-code error) ":AGENT_SPAWN_FAILED")
           :error (message-of error)})))

(defn- ^:async boot-body []
  (let [nbb (nbb-module)
        load-string (fn [source] (.loadString nbb source))
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
    (set! (.-__herdHost js/globalThis) #js {:runSubagent run-subagent})
    (when-not (.-__herdRunnerCaptureInstalled js/globalThis)
      (set! (.-__herdRunnerCaptureInstalled js/globalThis) true)
      (try
        (await (native-runner/install-capture!))
        (set! (.-__herdNative js/globalThis) #js {:getRunner native-runner/get-native-runner})
        (catch :default _ (set! (.-__herdNative js/globalThis) nil))))
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
