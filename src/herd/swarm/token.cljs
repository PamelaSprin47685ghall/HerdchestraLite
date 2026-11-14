(ns herd.swarm.token
  (:require
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]))

(def take-or-die-confirmation "i-hereby-confirm-i-die-without-regret")

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn pending-take-attempt [board agent-id]
  (first (for [[_ attempt] (:take-attempts board {})
               :when (and (= agent-id (:agent-id attempt))
                          (not (:resolved attempt)))]
           attempt)))

(defn accept-attempt [draft context]
  (let [command (:command context)
        original-request-id (edn/read-field command :original-request-id :originalRequestId)
        existing (when (edn/text? original-request-id)
                   (get-in draft [:requests original-request-id]))
        confirm (:confirm command)
        handoff (edn/read-field command :handoff-markdown :handoffMarkdown)
        actor (get-in draft [:actors (:actor-id context)])
        token (:token-slot draft)
        pending (pending-take-attempt draft (:actor-id context))]
    (cond
      (and (edn/text? original-request-id) existing)
      (failure :CALL_REPLAY_MISMATCH "request_id was used with a different payload"
               {:request-id original-request-id})

      (not= confirm take-or-die-confirmation)
      (failure :CONFIRMATION_REQUIRED "exact confirmation string is required"
               {:expected take-or-die-confirmation :actual confirm})

      (not (edn/text? handoff))
      (failure :INVALID_ARGUMENT "take_or_die needs non-empty handoff_markdown"
               {:field :handoff-markdown})

      (nil? actor)
      (failure :ACTOR_DEAD "actor is not registered" {:agent-id (:actor-id context)})

      (= (:holder-id token) (:actor-id context))
      (failure :INVALID_ARGUMENT "actor already holds the token"
               {:agent-id (:actor-id context) :term-id (:term-id token)})

      pending
      (failure :INVALID_ARGUMENT "actor already has a pending take attempt"
               {:agent-id (:actor-id context) :request-id (:request-id pending)})

      (some (fn [[_ action]]
              (and (= (:agent-id action) (:actor-id context))
                   (contains? model/active-action-phases (:phase action))))
            (:actions draft))
      (failure :INVALID_ARGUMENT "actor has an in-flight or unresolved action"
               {:agent-id (:actor-id context)})

      :else
      (let [token-tasks (model/open-token-task-ids draft)
            token-held (some? (:holder-id token))]
        (if (and (not token-held) (empty? token-tasks))
          {:ok true
           :skip-commit true
           :board draft
           :receipt {:outcome :no-progressable-work
                     :code :NO_PROGRESSABLE_WORK
                     :agent-id (:actor-id context)
                     :board-version (:board-version draft)
                     :wake-epoch (get-in draft [:wake :epoch])
                     :token-tasks []}
           :event-type :token-attempt-skipped
           :event-data {:agent-id (:actor-id context) :reason :no-token-work}}
          (let [attempt {:request-id (:request-id context)
                         :agent-id (:actor-id context)
                         :term-id (:term-id actor)
                         :observed-version (:board-version draft)
                         :token-state (if token-held :held :free)
                         :token-tasks token-tasks
                         :handoff-markdown handoff
                         :resolved false
                         :outcome nil
                         :resolved-version nil}
                draft (-> draft
                          (assoc-in [:take-attempts (:request-id context)] attempt)
                          (assoc-in [:actors (:actor-id context) :take-attempt-id] (:request-id context)))]
            {:ok true :board draft :attempt attempt}))))))

(defn- mark-attempt-resolved [attempt outcome version reason]
  (cond-> (assoc attempt :resolved true :outcome outcome :resolved-version version)
    (some? reason) (assoc :reason reason)))

(defn- clear-actor-take-attempt [draft agent-id]
  (assoc-in draft [:actors agent-id :take-attempt-id] nil))

(defn- lose-token-attempt [draft agent-id handoff]
  (let [[draft handed-off]
        (reduce (fn [[board handed-off] [task-id task]]
                  (let [owned (= (:owner-id task) agent-id)
                        claimed (= (:claim-owner-id task) agent-id)]
                    (if (or owned claimed)
                      (let [board (update-in board [:tasks task-id]
                                             (fn [task]
                                               (-> task
                                                   (cond-> (and owned (not (:needs-token task)))
                                                     (assoc :owner-id nil))
                                                   (cond-> claimed
                                                     (assoc :claim-id nil :claim-owner-id nil))
                                                   (assoc :handoff-note handoff))))]
                        [board (conj handed-off task-id)])
                      [board handed-off])))
                [draft []]
                (:tasks draft))
        draft (update draft :actions
                      (fn [actions]
                        (into {}
                              (remove (fn [[_ action]]
                                        (and (= (:agent-id action) agent-id)
                                             (contains? #{:claimed :preparing :waiting-gate} (:phase action))))
                                      actions))))
        draft (-> draft
                  (assoc-in [:actors agent-id :life-state] :dead)
                  (assoc-in [:actors agent-id :active-action-id] nil)
                  (update :sleepers dissoc agent-id))]
    {:board draft
     :receipt {:outcome :attempt-lost :agent-id agent-id :handed-off-task-ids handed-off}
     :event-data {:agent-id agent-id :handedOffTaskIds handed-off :handoff handoff}}))

(defn- resolve-other-pending-attempts-as-lost [draft keep-attempt-id reason]
  (reduce
    (fn [[board lost] [_ attempt]]
      (if (or (= (:request-id attempt) keep-attempt-id) (:resolved attempt))
        [board lost]
        (let [agent-id (:agent-id attempt)
              actor (get-in board [:actors agent-id])]
          (if (nil? actor)
            [(assoc-in board [:take-attempts (:request-id attempt)]
                       (mark-attempt-resolved attempt :attempt-lost (:board-version board) reason))
             lost]
            (let [outcome (lose-token-attempt board agent-id (:handoff-markdown attempt))
                  board (-> (:board outcome)
                            (assoc-in [:take-attempts (:request-id attempt)]
                                      (mark-attempt-resolved attempt :attempt-lost
                                                             (:board-version board) reason))
                            (clear-actor-take-attempt agent-id))]
              [board (conj lost {:attempt-id (:request-id attempt)
                                 :agent-id agent-id
                                 :handed-off-task-ids (get-in outcome [:receipt :handed-off-task-ids])})])))))
    [draft []]
    (:take-attempts draft)))

(defn resolve-attempt [draft attempt context]
  (let [token (:token-slot draft)
        actor (get-in draft [:actors (:agent-id attempt)])
        holder-id (:holder-id token)
        handoff (:handoff-markdown attempt)]
    (if (:resolved attempt)
      {:ok true
       :skip-commit true
       :board draft
       :receipt {:outcome (or (:outcome attempt) :attempt-resolved)
                 :attempt-id (:request-id attempt)
                 :agent-id (:agent-id attempt)
                 :reason (:reason attempt)
                 :board-version (:board-version draft)
                 :wake-epoch (get-in draft [:wake :epoch])}
       :event-type :token-attempt-replayed
       :event-data {:attempt-id (:request-id attempt)}}
      (cond
        (nil? actor)
        (let [draft (assoc-in draft [:take-attempts (:request-id attempt)]
                              (mark-attempt-resolved attempt :attempt-lost
                                                     (:board-version draft) :actor-dead))]
          {:ok true
           :board draft
           :receipt {:outcome :attempt-lost
                     :agent-id (:agent-id attempt)
                     :handed-off-task-ids []
                     :attempt-id (:request-id attempt)
                     :reason :actor-dead
                     :lost-attempts []}
           :event-type :token-lost
           :event-data {:agent-id (:agent-id attempt)
                        :attempt-id (:request-id attempt)
                        :reason :actor-dead
                        :lostAttempts []}
           :wake-cause :token-lost})

        (not= :alive (:life-state actor))
        (let [outcome (lose-token-attempt draft (:agent-id attempt) handoff)
              draft (-> (:board outcome)
                        (assoc-in [:take-attempts (:request-id attempt)]
                                  (mark-attempt-resolved attempt :attempt-lost
                                                         (:board-version draft) :actor-dead))
                        (clear-actor-take-attempt (:agent-id attempt)))
              [draft lost-attempts] (if (some? holder-id)
                                      (resolve-other-pending-attempts-as-lost
                                        draft (:request-id attempt) :token-held)
                                      [draft []])]
          {:ok true
           :board draft
           :receipt (merge (:receipt outcome)
                           {:attempt-id (:request-id attempt)
                            :reason :actor-dead
                            :lost-attempts lost-attempts})
           :event-type :token-lost
           :event-data (merge (:event-data outcome)
                              {:attempt-id (:request-id attempt)
                               :reason :actor-dead
                               :lostAttempts lost-attempts})
           :wake-cause :token-lost})

        (and (some? holder-id) (not= holder-id (:agent-id attempt)))
        (let [outcome (lose-token-attempt draft (:agent-id attempt) handoff)
              draft (-> (:board outcome)
                        (assoc-in [:take-attempts (:request-id attempt)]
                                  (mark-attempt-resolved attempt :attempt-lost
                                                         (:board-version draft) :token-held))
                        (clear-actor-take-attempt (:agent-id attempt)))
              [draft lost-attempts] (resolve-other-pending-attempts-as-lost
                                      draft (:request-id attempt) :token-held)]
          {:ok true
           :board draft
           :receipt (merge (:receipt outcome)
                           {:attempt-id (:request-id attempt)
                            :lost-attempts lost-attempts})
           :event-type :token-lost
           :event-data (merge (:event-data outcome)
                              {:attempt-id (:request-id attempt)
                               :lostAttempts lost-attempts})
           :wake-cause :token-lost})

        :else
        (let [[draft term-id]
              (if (nil? (get-in draft [:token-slot :holder-id]))
                (let [[draft term-id] (model/next-id draft :term "TERM")]
                  [(-> draft
                       (assoc-in [:token-slot :holder-id] (:agent-id attempt))
                       (assoc-in [:token-slot :term-id] term-id)
                       (assoc-in [:token-slot :state] :held)
                       (assoc-in [:actors (:agent-id attempt) :role] :holder)
                       (assoc-in [:actors (:agent-id attempt) :term-id] term-id)
                       (assoc-in [:actors (:agent-id attempt) :life-state] :alive))
                   term-id])
                [draft (get-in draft [:token-slot :term-id])])
              draft (-> draft
                        (assoc-in [:take-attempts (:request-id attempt)]
                                  (mark-attempt-resolved attempt :attempt-won
                                                         (:board-version draft) nil))
                        (clear-actor-take-attempt (:agent-id attempt)))
              [draft lost-attempts] (resolve-other-pending-attempts-as-lost
                                      draft (:request-id attempt) :token-won-by-other)
              token-tasks (model/open-token-task-ids draft)]
          {:ok true
           :board draft
           :receipt {:outcome :attempt-won
                     :agent-id (:agent-id attempt)
                     :term-id term-id
                     :token-tasks token-tasks
                     :lost-attempts lost-attempts}
           :event-type :token-won
           :event-data {:agent-id (:agent-id attempt)
                        :term-id term-id
                        :attempt-id (:request-id attempt)
                        :tokenTasks token-tasks
                        :lostAttempts lost-attempts}
           :wake-cause :token-won})))))

(defn retire-holder [board holder-id reason]
  (let [token (:token-slot board)
        term-id (:term-id token)
        board (-> board
                  (update-in [:token-slot :retired-terms]
                             #(if (and term-id (not (some (fn [term] (= term term-id)) %)))
                                (conj (vec %) term-id)
                                (vec %)))
                  (assoc-in [:token-slot :holder-id] nil)
                  (assoc-in [:token-slot :term-id] nil)
                  (assoc-in [:token-slot :state] :free)
                  (update :sleepers dissoc holder-id))]
    [(cond-> board
       (get-in board [:actors holder-id])
       (-> (assoc-in [:actors holder-id :life-state] :dead)
           (assoc-in [:actors holder-id :active-action-id] nil)))
     {:agent-id holder-id :term-id term-id :reason reason}]))

(defn settle-holder [board]
  (let [holder-id (get-in board [:token-slot :holder-id])]
    (if-not holder-id
      [board nil]
      (let [actor (get-in board [:actors holder-id])]
        (cond
          (not= :alive (:life-state actor))
          (retire-holder board holder-id :holder-missing)

          (seq (model/responsibility-set board holder-id))
          [board nil]

          :else
          (retire-holder board holder-id :no-responsibility))))))

(defn take-or-die-handler [draft context]
  (let [accepted (accept-attempt draft context)]
    (if-not (:ok accepted)
      accepted
      (if (:skip-commit accepted)
        accepted
        (let [resolved (resolve-attempt (:board accepted) (:attempt accepted) context)]
          (if-not (:ok resolved)
            resolved
            (-> resolved
                (assoc-in [:receipt :accepted-version] (get-in accepted [:attempt :observed-version]))
                (assoc-in [:receipt :token-tasks]
                          (or (get-in resolved [:receipt :token-tasks])
                              (get-in accepted [:attempt :token-tasks])))
                (assoc-in [:event-data :accepted-version] (get-in accepted [:attempt :observed-version]))
                (assoc-in [:event-data :tokenTasks]
                          (or (get-in resolved [:event-data :tokenTasks])
                              (get-in accepted [:attempt :token-tasks]))))))))))

(defn accept-take-handler [draft context]
  (let [accepted (accept-attempt draft context)]
    (if-not (:ok accepted)
      accepted
      (if (:skip-commit accepted)
        accepted
        (let [attempt (:attempt accepted)]
          {:ok true
           :board (:board accepted)
           :receipt {:outcome :attempt-accepted
                     :attempt-id (:request-id attempt)
                     :agent-id (:agent-id attempt)
                     :token-state (:token-state attempt)
                     :token-tasks (:token-tasks attempt)}
           :event-type :token-attempt-accepted
           :event-data {:attempt-id (:request-id attempt)
                        :agent-id (:agent-id attempt)
                        :token-state (:token-state attempt)
                        :token-tasks (:token-tasks attempt)}
           :wake-cause :token-attempt-accepted})))))

(defn resolve-take-handler [draft context]
  (let [command (:command context)
        attempt-id (or (edn/read-field command :attempt-id :attemptId)
                       (edn/read-field command :accept-request-id :acceptRequestId))
        attempt (when (edn/text? attempt-id)
                  (get-in draft [:take-attempts attempt-id]))]
    (cond
      (not (edn/text? attempt-id))
      (failure :INVALID_ARGUMENT "resolve_take needs attempt_id" {:field :attempt-id})

      (nil? attempt)
      (failure :INVALID_ARGUMENT "accepted take attempt does not exist" {:attempt-id attempt-id})

      (not= (:agent-id attempt) (:actor-id context))
      (failure :ACTOR_DEAD "accepted attempt belongs to another actor"
               {:attempt-id attempt-id
                :agent-id (:actor-id context)
                :owner-id (:agent-id attempt)})

      :else
      (resolve-attempt draft attempt context))))