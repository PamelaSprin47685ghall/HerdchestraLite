(ns herd.swarm.tools
  (:require
   [herd.swarm.apply :as apply]
   [herd.swarm.edn :as edn]
   [herd.swarm.store :as store]
   [herd.ufss :as ufss]))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn- param [params key]
  (get params key))

(defn- actor-of [deps ctx]
  (cond
    (fn? (:actor-of deps)) ((:actor-of deps) ctx)
    (map? (:actor deps)) (:actor deps)
    :else nil))

(defn- root-of [deps ctx]
  (cond
    (fn? (:root-of deps)) ((:root-of deps) ctx)
    (string? (:root deps)) (:root deps)
    (and ctx (string? (.-cwd ctx))) (.-cwd ctx)
    :else nil))

(defn- slug-of [deps ctx]
  (cond
    (fn? (:slug-of deps)) ((:slug-of deps) ctx)
    (string? (:slug deps)) (:slug deps)
    :else nil))

(defn- turn-of [deps ctx call-id]
  (or (when (fn? (:turn-of deps)) ((:turn-of deps) ctx))
      (when ctx (.-turnId ctx))
      call-id))

(defn- tool-command [tool params]
  (case tool
    :board_split
    {:type :split
     :parent-id (param params :parent_id)
     :remaining-work (param params :remaining_work)
     :children (param params :children)
     :wait-for (param params :wait_for)
     :expected-board-version (param params :expected_board_version)}

    :board_claim
    {:type :claim
     :task-id (param params :task_id)
     :atomicity-reason (param params :atomicity_reason)}

    :board_finish
    {:type :finish
     :task-id (param params :task_id)
     :claim-id (param params :claim_id)
     :result-summary (param params :result_summary)
     :dependency-paths (or (param params :dependency_paths) [])}

    :board_cancel
    {:type :cancel
     :task-id (param params :task_id)
     :reason (param params :reason)}

    :board_replace
    {:type :replace
     :task-id (param params :task_id)
     :replacement (param params :replacement)
     :reason (param params :reason)}

    :board_release
    {:type :release
     :task-id (param params :task_id)
     :claim-id (param params :claim_id)}

    :board_reopen
    {:type :reopen
     :task-id (param params :task_id)
     :reason (param params :reason)
     :evidence (param params :evidence)}

    :board_comment
    {:type :comment
     :task-id (param params :task_id)
     :text (param params :text)}

    :board_update
    {:type :update
     :task-id (param params :task_id)
     :fields (param params :fields)}

    :board_park_slot
    {:type :park-slot
     :observed-board-version (param params :observed_board_version)}

    :board_take_or_die
    {:type :take-or-die
     :confirm (param params :confirm)
     :handoff-markdown (param params :handoff_markdown)}

    nil))

(defn ^:async execute-command!
  [deps tool params ctx call-id]
  (let [root (root-of deps ctx)
        slug (slug-of deps ctx)
        actor (actor-of deps ctx)
        command (tool-command tool params)]
    (cond
      (nil? command)
      (failure :INVALID_ARGUMENT "unknown board tool" {:tool tool})

      (not (edn/text? root))
      (failure :INVALID_ARGUMENT "workspace root is unavailable" {:field :root})

      (not (edn/text? slug))
      (failure :STAGE_MISMATCH "the session mission focus is not bound"
               {:field :slug :reason :session-slug-missing})

      (nil? actor)
      (failure :ACTOR_DEAD "board tools need a live actor identity" {})

      :else
      (let [handle (or (:handle deps) (store/open-board root slug))
            request-id (or (param params :request_id) call-id)]
        (await (apply/apply-board!
                 {:board handle
                  :command command
                  :actor actor
                  :request-id request-id
                  :turn-id (turn-of deps ctx request-id)}))))))

(defn- receipt-view [result]
  (if (:ok result)
    {:ok true
     :receipt (:receipt result)
     :board-version (get-in result [:receipt :board-version])
     :wake-epoch (get-in result [:receipt :wake-epoch])}
    result))

(defn- tool-result [result]
  {:isError (not (:ok result))
   :content [{:type "text" :text (ufss/canonical (receipt-view result))}]})

(defn ^:async execute-tool!
  [deps tool params ctx call-id]
  (try
    (tool-result (await (execute-command! deps tool params ctx call-id)))
    (catch :default error
      (tool-result (failure :INTERNAL (or (ex-message error) (str error)) {})))))

(defn- string-schema [min-length]
  {:type "string" :minLength min-length})

(defn- array-schema [items]
  {:type "array" :items items})

(defn- task-schema []
  {:type "object"
   :additionalProperties false
   :required ["goal" "remaining_work" "done_when"]
   :properties {:goal (string-schema 1)
                :remaining_work (string-schema 1)
                :done_when (string-schema 1)
                :needs_token {:type "boolean"}}})

(defn- split-parameters []
  {:type "object"
   :additionalProperties false
   :required ["parent_id" "expected_board_version" "children" "remaining_work"]
   :properties {:parent_id (string-schema 1)
                :expected_board_version {:type "integer" :minimum 0}
                :children (array-schema (task-schema))
                :remaining_work (string-schema 1)
                :wait_for (array-schema (string-schema 1))}})

(defn- claim-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "atomicity_reason"]
   :properties {:task_id (string-schema 1)
                :atomicity_reason (string-schema 1)}})

(defn- finish-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "claim_id" "result_summary"]
   :properties {:task_id (string-schema 1)
                :claim_id (string-schema 1)
                :result_summary (string-schema 1)
                :dependency_paths (array-schema (string-schema 1))}})

(defn- cancel-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "reason"]
   :properties {:task_id (string-schema 1) :reason (string-schema 1)}})

(defn- replace-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "replacement" "reason"]
   :properties {:task_id (string-schema 1)
                :replacement (task-schema)
                :reason (string-schema 1)}})

(defn- release-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "claim_id"]
   :properties {:task_id (string-schema 1) :claim_id (string-schema 1)}})

(defn- reopen-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "reason" "evidence"]
   :properties {:task_id (string-schema 1)
                :reason (string-schema 1)
                :evidence {:anyOf [(string-schema 1)
                                   (array-schema (string-schema 1))]}}})

(defn- comment-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "text"]
   :properties {:task_id (string-schema 1) :text (string-schema 1)}})

(defn- update-parameters []
  {:type "object"
   :additionalProperties false
   :required ["task_id" "fields"]
   :properties {:task_id (string-schema 1)
                :fields {:type "object"}}})

(defn- park-parameters []
  {:type "object"
   :additionalProperties false
   :required ["observed_board_version"]
   :properties {:observed_board_version {:type "integer" :minimum 0}}})

(defn- take-parameters []
  {:type "object"
   :additionalProperties false
   :required ["request_id" "confirm" "handoff_markdown"]
   :properties {:request_id (string-schema 1)
                :confirm (string-schema 1)
                :handoff_markdown (string-schema 1)}})

(defn- definition [deps tool label description parameters]
  {:name (name tool)
   :label label
   :description description
   :load-mode "essential"
   :parameters parameters
   :execute (fn [call-id params _signal _on-update ctx]
              (execute-tool! deps tool (js->clj (or params #js {}) :keywordize-keys true)
                             ctx call-id))})

(defn tool-definitions [deps]
  [(definition deps :board_split "Split Task"
               "Split a task into children and keep the parent waiting on its declared wait set."
               (split-parameters))
   (definition deps :board_claim "Claim Task"
               "Claim one ready task with an atomicity reason."
               (claim-parameters))
   (definition deps :board_finish "Finish Task"
               "Finish a claimed task and revive any satisfied waiting parent to ready."
               (finish-parameters))
   (definition deps :board_cancel "Cancel Task"
               "Cancel a leaf task and update its parent wait set."
               (cancel-parameters))
   (definition deps :board_replace "Replace Task"
               "Replace a leaf task with a new task and rewire the parent."
               (replace-parameters))
   (definition deps :board_release "Release Task"
               "Release a claim before applying; refused after applying."
               (release-parameters))
   (definition deps :board_reopen "Reopen Task"
               "Reopen a done task with a reason and evidence."
               (reopen-parameters))
   (definition deps :board_comment "Comment Task"
               "Append an observation without changing task state."
               (comment-parameters))
   (definition deps :board_update "Update Task"
               "Update goal, remaining_work, done_when, or needs_token."
               (update-parameters))
   (definition deps :board_park_slot "Park Slot"
               "Park only when the whole board has no progressable work."
               (park-parameters))
   (definition deps :board_take_or_die "Take Or Die"
               "Enter the irreversible token race with a handoff note."
               (take-parameters))])

(defn register-all! [register deps]
  (doseq [definition (tool-definitions deps)]
    (register definition)))

(defn- bridge-execute [execute]
  (fn [call-id params signal on-update ctx]
    (try
      (-> (js/Promise.resolve (execute call-id params signal on-update ctx))
          (.then (fn [value] (clj->js value))))
      (catch :default error
        (clj->js (tool-result (failure :INTERNAL (or (ex-message error) (str error)) {})))))))

(defn register! [pi deps]
  (when-not (and pi (instance? js/Function (.-registerTool pi)))
    (throw (ex-info "host extension API lacks registerTool" {:code :HOST_API_MISMATCH})))
  (register-all!
    (fn [definition]
      (.registerTool pi #js {:name (:name definition)
                             :label (:label definition)
                             :description (:description definition)
                             :loadMode (:load-mode definition)
                             :parameters (clj->js (:parameters definition))
                             :execute (bridge-execute (:execute definition))}))
    deps))