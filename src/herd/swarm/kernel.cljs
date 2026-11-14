(ns herd.swarm.kernel
  (:require
   [herd.swarm.actors :as actors]
   [herd.swarm.commands :as commands]
   [herd.swarm.edn :as edn]
   [herd.swarm.ledger :as ledger]
   [herd.swarm.model :as model]
   [herd.swarm.token :as token]))

(def command-types
  {"split" :split
   "claim" :claim
   "finish" :finish
   "cancel" :cancel
   "replace" :replace
   "release" :release
   "reopen" :reopen
   "comment" :comment
   "update" :update
   "park_slot" :park-slot
   "parkSlot" :park-slot
   "park-slot" :park-slot
   "take_or_die" :take-or-die
   "takeOrDie" :take-or-die
   "take-or-die" :take-or-die
   "accept_take" :accept-take
   "acceptTake" :accept-take
   "accept-take" :accept-take
   "resolve_take" :resolve-take
   "resolveTake" :resolve-take
   "resolve-take" :resolve-take
   "register_actor" :register-actor
   "registerActor" :register-actor
   "register-actor" :register-actor
   "add_tasks" :add-tasks
   "addTasks" :add-tasks
   "add-tasks" :add-tasks
   "start_action" :start-action
   "startAction" :start-action
   "start-action" :start-action
   "set_action_phase" :set-action-phase
   "setActionPhase" :set-action-phase
   "set-action-phase" :set-action-phase
   "resolve_condition" :resolve-condition
   "resolveCondition" :resolve-condition
   "resolve-condition" :resolve-condition
   "record_input" :record-input
   "recordInput" :record-input
   "record-input" :record-input
   "review" :review})

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn command-type [command]
  (let [raw (cond
              (string? command) command
              (keyword? command) (name command)
              (map? command) (edn/read-field command :type :command :name)
              :else nil)]
    (when (or (string? raw) (keyword? raw))
      (get command-types (name raw)))))

(defn normalize-apply-args [raw]
  {:command (edn/normalize-keys (or (:command raw) (when (:type raw) raw) {}))
   :actor (:actor raw)
   :turn-id (edn/first-defined (:turn-id raw) (:turn_id raw))
   :request-id (edn/first-defined (:request-id raw) (:request_id raw))
   :expected-board-version (edn/first-defined (:expected-board-version raw)
                                             (:expected_board_version raw))})

(defn- dispatch [type draft context]
  (case type
    :split (commands/split-handler draft context)
    :claim (commands/claim-handler draft context)
    :finish (commands/finish-handler draft context)
    :cancel (commands/cancel-handler draft context)
    :replace (commands/replace-handler draft context)
    :release (commands/release-handler draft context)
    :reopen (commands/reopen-handler draft context)
    :comment (commands/comment-handler draft context)
    :update (commands/update-handler draft context)
    :park-slot (commands/park-slot-handler draft context)
    :take-or-die (token/take-or-die-handler draft context)
    :accept-take (token/accept-take-handler draft context)
    :resolve-take (token/resolve-take-handler draft context)
    :register-actor (commands/register-actor-handler draft context)
    :record-input (commands/record-input-handler draft context)
    :add-tasks (commands/add-tasks-handler draft context)
    :resolve-condition (commands/resolve-condition-handler draft context)
    :start-action (commands/start-action-handler draft context)
    :set-action-phase (commands/set-action-phase-handler draft context)
    (failure :INVALID_ARGUMENT "unknown board command" {:command (:command context)})))

(defn apply-command [board raw-args]
  (if-not (model/board-state? board)
    (failure :INVALID_ARGUMENT "board must be a board value" {})
    (let [args (normalize-apply-args raw-args)
          command (:command args)
          type (command-type command)
          reject (fn [result] (assoc result :board board :events []))]
      (if-not type
        (reject (failure :INVALID_ARGUMENT "unknown board command" {:command command}))
        (if (= :review type)
          (let [reviewed (ledger/apply-review board command)]
            (if-not (:ok reviewed)
              (assoc reviewed :board board :events [])
              (assoc reviewed :replayed false)))
          (if (and (not (edn/text? (:request-id args)))
                   (not= :record-input type))
            (reject (failure :INVALID_ARGUMENT "request_id is required" {:field :request-id}))
            (let [expected (edn/first-defined
                             (:expected-board-version args)
                             (edn/read-field command :expected-board-version :expectedBoardVersion)
                             (edn/read-field command :observed-board-version :observedBoardVersion))
                  digest (edn/digest-of {:type type
                                         :command command
                                         :actor (actors/actor-id-of (:actor args))
                                         :expected-board-version expected})
                  existing (get-in board [:requests (:request-id args)])]
              (cond
                existing
                (if (not= (:digest existing) digest)
                  (reject (failure :CALL_REPLAY_MISMATCH
                                   "request_id was used with a different payload"
                                   {:request-id (:request-id args)}))
                  {:ok true
                   :board board
                   :replayed true
                   :changed false
                   :receipt (:receipt existing)
                   :events []})

                (and (contains? #{:split :park-slot} type) (not (integer? expected)))
                (reject (failure :INVALID_ARGUMENT "expected board version is required"
                                 {:field (if (= :park-slot type)
                                           :observed-board-version
                                           :expected-board-version)
                                  :board-version (:board-version board)}))

                (and (some? expected) (not (integer? expected)))
                (reject (failure :INVALID_ARGUMENT "expected board version must be an integer"
                                 {:field :expected-board-version
                                  :current (:board-version board)}))

                (and (some? expected) (not= expected (:board-version board)))
                (reject (failure :BOARD_CONFLICT "board version changed"
                                 {:expected expected
                                  :current (:board-version board)
                                  :summary (model/progressable-summary board)}))

                :else
                (let [resolved (if (contains? #{:register-actor :record-input} type)
                                 {:ok true :agent-id nil}
                                 (actors/resolve-actor board (:actor args)
                                                       {:allow (when (= :resolve-take type) :allow-dead)}))]
                  (if-not (:ok resolved)
                    (reject resolved)
                    (let [agent-id (:agent-id resolved)
                          pending (when (and agent-id (not= :resolve-take type))
                                    (token/pending-take-attempt board agent-id))]
                      (if pending
                        (reject (failure :INVALID_ARGUMENT "actor has a pending take attempt"
                                         {:agent-id agent-id
                                          :request-id (:request-id pending)
                                          :next "resolve the accepted attempt before other board work"}))
                        (let [draft (model/ensure-board-shape board)
                              context {:command command
                                       :actor-id agent-id
                                       :turn-id (or (:turn-id args) "tool")
                                       :request-id (:request-id args)}
                              handler-result (dispatch type draft context)]
                          (if-not (:ok handler-result)
                            {:ok false :board board :events [] :error (:error handler-result)}
                            (let [next-board (:board handler-result)]
                              (if (:skip-commit handler-result)
                                {:ok true
                                 :board board
                                 :changed false
                                 :replayed false
                                 :receipt (assoc (:receipt handler-result)
                                                 :request-id (:request-id context)
                                                 :board-version (:board-version draft))
                                 :events []}
                                (let [had-sleepers? (seq (:sleepers board))
                                      version (inc (:board-version draft))
                                      board-with-version (-> next-board
                                                             (assoc :board-version version)
                                                             (model/ensure-board-shape))
                                      events [(model/make-event board-with-version
                                                                (:event-type handler-result)
                                                                (or (:event-data handler-result) {})
                                                                version
                                                                context)]
                                      [settled-board retirement] (token/settle-holder board-with-version)
                                      events (cond-> events
                                               retirement
                                               (conj (model/make-event settled-board :holder-retired
                                                                       retirement version context)))
                                      should-wake (or (:force-wake handler-result)
                                                      (and had-sleepers?
                                                           (seq (model/progressable-set settled-board))))
                                      settled-board (if should-wake
                                                      (model/bump-wake settled-board)
                                                      settled-board)
                                      events (if should-wake
                                               (conj events
                                                     (model/make-event settled-board :wake-all
                                                                       {:cause (or (:wake-cause handler-result)
                                                                                   (:event-type handler-result))
                                                                        :epoch (get-in settled-board [:wake :epoch])}
                                                                       version context))
                                               events)
                                      receipt (cond-> (merge (:receipt handler-result)
                                                             {:request-id (:request-id context)
                                                              :board-version version
                                                              :wake-epoch (get-in settled-board [:wake :epoch])})
                                                retirement (assoc :holder-retired retirement))
                                      settled-board (assoc-in settled-board
                                                              [:requests (:request-id context)]
                                                              {:digest digest
                                                               :receipt receipt
                                                               :board-version version})]
                                  {:ok true
                                   :board settled-board
                                   :changed true
                                   :replayed false
                                   :receipt receipt
                                   :events events})))))))))))))))))
