(ns herd.host)

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

(defn- coding-agent []
  (.-__herdCodingAgent js/globalThis))

(defn- host-extras []
  (or (.-__herdHostExtras js/globalThis) #js {}))

(defn- host-versions []
  (or (.-__herdHostVersions js/globalThis) #js {}))

(def host
  (let [agent (coding-agent)
        extras (host-extras)
        pi-tui (js/Object.freeze
                #js {:Container (.-Container agent)
                     :Markdown (.-Markdown agent)
                     :Spacer (.-Spacer agent)
                     :Text (.-Text agent)})]
    (js/Object.freeze
     #js {:AgentSession (.-AgentSession agent)
          :Settings (.-Settings agent)
          :runSubprocess (.-runSubprocess agent)
          :runSubagentFollowUpTurn (.-runSubagentFollowUpTurn agent)
          :loadBundledAgents (.-loadBundledAgents extras)
          :piTui pi-tui})))

(defn- settings-instance-available? []
  (try
    (object-like? (.-instance (.-Settings (coding-agent))))
    (catch :default _ false)))

(defn detect-capabilities
  ([pi] (detect-capabilities pi nil #js {}))
  ([pi context] (detect-capabilities pi context #js {}))
  ([pi context observed]
   (let [api (if (object-like? pi) pi #js {})
         ctx (when (object-like? context) context)
         ctx-ui (when ctx (.-ui ctx))
         ctx-session-manager (when ctx (.-sessionManager ctx))
         facts (if (object-like? observed) observed #js {})
         unverified (atom [])
         add-unverified! (fn [name] (swap! unverified conj name))
         fact (fn [name & [mark-missing]]
                (let [value (aget facts name)
                      mark-missing? (boolean mark-missing)]
                  (cond
                    (true? value) true
                    (some? value) (do (add-unverified! name) false)
                    mark-missing? (do (add-unverified! name) false)
                    :else false)))
         observed-ctx-agent (and ctx (some? (.-agent ctx)))
         has-ctx-agent (boolean (or (fact "hasCtxAgent") observed-ctx-agent))
         _ (when (and (nil? (aget facts "hasCtxAgent")) (nil? ctx))
             (add-unverified! "hasCtxAgent"))
         has-set-widget (boolean (and ctx-ui (fn? (.-setWidget ctx-ui))))
         has-on-terminal-input (boolean (and ctx-ui (fn? (.-onTerminalInput ctx-ui))))
         _ (when (nil? ctx)
             (add-unverified! "hasSetWidget")
             (add-unverified! "hasOnTerminalInput"))
         has-artifacts-dir (boolean (and ctx-session-manager (fn? (.-getArtifactsDir ctx-session-manager))))
         has-session-file (boolean (and ctx-session-manager (fn? (.-getSessionFile ctx-session-manager))))
         _ (when (nil? ctx)
             (add-unverified! "hasArtifactsDir")
             (add-unverified! "hasSessionFile"))
         event-bus (aget facts "eventBus")
         has-event-bus (boolean (or (fact "hasEventBus")
                           (and (object-like? event-bus)
                                (fn? (.-emit event-bus))
                                (fn? (.-on event-bus)))))
         _ (when (and (nil? (aget facts "hasEventBus"))
                      (not (object-like? event-bus)))
             (add-unverified! "hasEventBus"))
         versions (host-versions)
         host-version (aget versions "hostVersion")
         cli-version (aget versions "cliVersion")
         runtime-version (aget versions "runtimePackageVersion")
         table #js {:hostPackageVersion (or host-version runtime-version)
                    :cliVersion cli-version
                    :runtimePackageVersion runtime-version
                    :typesPackageVersion runtime-version
                    :hasToolCallInput (fact "hasToolCallInput" true)
                    :hasCtxAgent has-ctx-agent
                    :hasBeforeSubagentSpawn (fact "hasBeforeSubagentSpawn" true)
                    :hasTurnEnd (fact "hasTurnEnd" true)
                    :hasSetWidget has-set-widget
                    :hasHookWidget (boolean (and ctx-ui (fn? (.-setHookWidget ctx-ui))))
                    :hasOnTerminalInput has-on-terminal-input
                    :hasRegisterShortcut (fn? (.-registerShortcut api))
                    :hasSetActiveTools (fn? (.-setActiveTools api))
                    :hasEventBus has-event-bus
                    :hasArtifactsDir has-artifacts-dir
                    :hasModelRegistry (boolean (and ctx (object-like? (.-modelRegistry ctx))))
                    :hasSessionFile has-session-file
                    :hasSettingsInstance (settings-instance-available?)
                    :hasRestrictToolNames (fact "hasRestrictToolNames" true)
                    :hasRunSubagentFollowUpTurn (fn? (.-runSubagentFollowUpTurn (coding-agent)))
                    :unverified (js/Object.freeze (clj->js (vec (distinct @unverified))))}]
     (js/Object.freeze table))))
