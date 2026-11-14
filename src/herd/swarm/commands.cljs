(ns herd.swarm.commands
  (:require
   [clojure.string :as string]
   [herd.swarm.actors :as actors]
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]
   [herd.swarm.tasks :as tasks]))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn- normalize-kind [value]
  (let [kind (cond
               (keyword? value) value
               (string? value) (keyword (string/replace value ":" ""))
               :else nil)]
    (when (contains? model/action-kinds kind) kind)))

(defn- normalize-phase [value]
  (let [phase (cond
                (keyword? value) value
                (string? value) (keyword (string/replace value ":" ""))
                :else nil)]
    (when (contains? model/action-phases phase) phase)))

(defn split-handler [draft context]
  (let [command (:command context)
        parent-id (edn/read-field command :parent-id :parentId)
        remaining-work (edn/read-field command :remaining-work :remainingWork)
        children (:children command)
        parent (get-in draft [:tasks parent-id])
        active (tasks/action-value (tasks/active-action-for-task draft parent-id))]
    (cond
      (nil? parent)
      (failure :INVALID_ARGUMENT "parent task does not exist" {:task-id parent-id})

      (= :done (:state parent))
      (failure :TASK_NOT_READY "cannot split a done task" {:task-id parent-id :current (:state parent)})

      (and active (contains? #{:applying :running :uncertain} (:phase active)))
      (failure :TASK_NOT_READY "cannot split while an action is executing"
               {:task-id parent-id :action-id (:action-id active) :phase (:phase active)})

      (not (edn/text? remaining-work))
      (failure :INVALID_ARGUMENT "split needs a non-empty remaining_work"
               {:task-id parent-id :field :remaining-work})

      (or (not (sequential? children)) (empty? children))
      (failure :INVALID_ARGUMENT "split needs at least one child" {:task-id parent-id})

      :else
      (let [specs (loop [index 0 acc []]
                    (if (>= index (count children))
                      {:ok true :specs acc}
                      (let [normalized (tasks/normalize-task-spec (nth children index)
                                                                  (str "children[" index "]"))]
                        (if-not (:ok normalized)
                          normalized
                          (recur (inc index) (conj acc (:value normalized)))))))]
        (if-not (:ok specs)
          specs
          (let [[draft child-ids]
                (reduce (fn [[board ids] spec]
                          (let [[board task-id] (tasks/append-task board (assoc spec
                                                                                :owner-id nil
                                                                                :ledger-key nil
                                                                                :parent-id parent-id))]
                            [board (conj ids task-id)]))
                        [draft []]
                        (:specs specs))
                raw-wait (edn/read-field command :wait-for :waitFor)
                wait-for (tasks/normalize-wait-entries raw-wait child-ids draft parent-id)]
            (if (nil? wait-for)
              (failure :INVALID_ARGUMENT "wait_for is malformed or empty"
                       {:task-id parent-id :field :wait-for})
              (let [released-claim-id (get-in draft [:tasks parent-id :claim-id])
                    draft (tasks/remove-orphan-actions-for-task draft parent-id)
                    draft (update-in draft [:tasks parent-id]
                                     (fn [task]
                                       (-> task
                                           (assoc :claim-id nil :claim-owner-id nil)
                                           (update :child-ids #(edn/unique-values (vec (concat (or % []) child-ids))))
                                           (update :wait-for #(edn/unique-values (vec (concat (or % []) wait-for))))
                                           (assoc :remaining-work remaining-work)
                                           (assoc :state :waiting)
                                           (assoc :revived-turn-id nil))))
                    wait-list (get-in draft [:tasks parent-id :wait-for])
                    revived? (and (seq wait-list)
                                  (every? #(tasks/is-wait-satisfied? draft %) wait-list))
                    draft (if revived?
                            (-> draft
                                (assoc-in [:tasks parent-id :state] :ready)
                                (assoc-in [:tasks parent-id :wait-for] [])
                                (assoc-in [:tasks parent-id :revived-turn-id] (:turn-id context)))
                            draft)
                    receipt {:outcome :split
                             :parent-id parent-id
                             :child-ids (vec child-ids)
                             :wait-for (get-in draft [:tasks parent-id :wait-for])
                             :revived-parent-ids (if revived? [parent-id] [])
                             :released-claim-id released-claim-id}]
                {:ok true
                 :board draft
                 :receipt receipt
                 :event-type :task-split
                 :event-data receipt
                 :wake-cause :task-split}))))))))

(defn claim-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        atomicity-reason (edn/read-field command :atomicity-reason :atomicityReason)
        task (get-in draft [:tasks task-id])
        active (tasks/action-value (tasks/active-action-for-task draft task-id))]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (not= :ready (:state task))
      (failure :TASK_NOT_READY "task is not ready" {:task-id task-id :current (:state task)})

      (not (edn/text? atomicity-reason))
      (failure :INVALID_ARGUMENT "claim needs a non-empty atomicity_reason"
               {:task-id task-id :field :atomicity-reason})

      (and (:needs-token task) (not (model/is-holder? draft (:actor-id context))))
      (failure :TOKEN_REQUIRED "token task can be claimed by the Holder only"
               {:task-id task-id :holder-id (get-in draft [:token-slot :holder-id])})

      active
      (failure :CLAIM_CONFLICT "task already has an active action"
               {:task-id task-id :action-id (:action-id active) :phase (:phase active)})

      (and (not (:needs-token task))
           (:owner-id task)
           (not= (:owner-id task) (:actor-id context)))
      (failure :CLAIM_CONFLICT "task belongs to another actor"
               {:task-id task-id :owner-id (:owner-id task) :claim-id (:claim-id task)})

      (:claim-id task)
      (failure :CLAIM_CONFLICT "task is already claimed"
               {:task-id task-id :owner-id (:owner-id task) :claim-id (:claim-id task)})

      :else
      (let [[draft claim-id] (model/next-id draft :claim "C")
            draft (update-in draft [:tasks task-id]
                             (fn [task]
                               (cond-> (assoc task :claim-id claim-id
                                                   :claim-owner-id (:actor-id context))
                                 (and (not (:needs-token task)) (nil? (:owner-id task)))
                                 (assoc :owner-id (:actor-id context)))))]
        {:ok true
         :board draft
         :receipt {:outcome :claimed
                   :task-id task-id
                   :claim-id claim-id
                   :owner-id (get-in draft [:tasks task-id :owner-id])
                   :claim-owner-id (:actor-id context)}
         :event-type :task-claimed
         :event-data {:task-id task-id
                      :claim-id claim-id
                      :owner-id (get-in draft [:tasks task-id :owner-id])
                      :claim-owner-id (:actor-id context)}}))))

(defn finish-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        claim-id (edn/read-field command :claim-id :claimId)
        result-summary (edn/read-field command :result-summary :resultSummary)
        dependency-paths (or (edn/read-field command :dependency-paths :dependencyPaths) [])
        task (get-in draft [:tasks task-id])
        active (tasks/action-value (tasks/active-action-for-task draft task-id))]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (= (:revived-turn-id task) (:turn-id context))
      (failure :PARENT_NOT_READY "parent was revived in this turn"
               {:task-id task-id :turn-id (:turn-id context)
                :next "finish the parent in a new turn with integration evidence"})

      (not= :ready (:state task))
      (failure :TASK_NOT_READY "task is not ready" {:task-id task-id :current (:state task)})

      active
      (failure :TASK_NOT_READY "task has an unfinished action"
               {:task-id task-id :action-id (:action-id active) :phase (:phase active)})

      (or (not= (:claim-id task) claim-id)
          (not= (:claim-owner-id task) (:actor-id context)))
      (failure :CLAIM_CHANGED "claim or owner changed"
               {:task-id task-id
                :expected-claim-id claim-id
                :current-claim-id (:claim-id task)
                :expected-claim-owner-id (:actor-id context)
                :current-claim-owner-id (:claim-owner-id task)})

      (not (edn/text? result-summary))
      (failure :INVALID_ARGUMENT "finish needs a non-empty result_summary"
               {:task-id task-id :field :result-summary})

      :else
      (let [paths (model/validate-dependency-paths dependency-paths)]
        (if (nil? paths)
          (failure :INVALID_ARGUMENT "dependency_paths must be workspace-relative paths"
                   {:task-id task-id :field :dependency-paths})
          (let [draft (update-in draft [:tasks task-id]
                                 (fn [task]
                                   (-> task
                                       (assoc :state :done
                                              :claim-id nil
                                              :claim-owner-id nil
                                              :result-summary result-summary
                                              :dependency-paths paths
                                              :revived-turn-id nil))))
                waiting-ids (-> #{}
                                (cond-> (:parent-id task) (conj (:parent-id task)))
                                (into (for [[candidate-id candidate] (:tasks draft)
                                            :when (and (= :waiting (:state candidate))
                                                       (some #(= task-id (tasks/wait-entry-task-id %))
                                                             (:wait-for candidate [])))]
                                        candidate-id)))
                [draft revived]
                (reduce (fn [[board revived] parent-id]
                          (let [candidate (get-in board [:tasks parent-id])]
                            (if (and candidate
                                     (= :waiting (:state candidate))
                                     (seq (:wait-for candidate []))
                                     (every? #(tasks/is-wait-satisfied? board %) (:wait-for candidate)))
                              [(-> board
                                   (assoc-in [:tasks parent-id :state] :ready)
                                   (assoc-in [:tasks parent-id :wait-for] [])
                                   (assoc-in [:tasks parent-id :revived-turn-id] (:turn-id context)))
                               (conj revived parent-id)]
                              [board revived])))
                        [draft []]
                        waiting-ids)]
            {:ok true
             :board draft
             :receipt {:outcome :finished
                       :task-id task-id
                       :revived-parent-ids (vec revived)}
             :event-type :task-finished
             :event-data {:task-id task-id :revived-parent-ids (vec revived)}
             :wake-cause :parent-revived}))))))

(defn cancel-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        reason (:reason command)
        task (get-in draft [:tasks task-id])]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (= :done (:state task))
      (failure :TASK_NOT_READY "cannot cancel a done task" {:task-id task-id :current (:state task)})

      (tasks/has-open-children? draft task)
      (failure :TASK_HAS_CHILDREN "cancel needs a leaf with no unfinished children"
               {:task-id task-id :children (:child-ids task)})

      (not (edn/text? reason))
      (failure :INVALID_ARGUMENT "cancel needs a non-empty reason" {:task-id task-id :field :reason})

      :else
      (let [[draft revived-parent-id] (tasks/detach-child-from-parent draft task nil (:turn-id context))
            draft (tasks/remove-orphan-actions-for-task draft task-id)
            draft (update draft :tasks dissoc task-id)]
        {:ok true
         :board draft
         :receipt {:outcome :cancelled :task-id task-id :revived-parent-id revived-parent-id}
         :event-type :task-cancelled
         :event-data {:task-id task-id :reason reason :revived-parent-id revived-parent-id}
         :wake-cause :task-cancelled}))))

(defn replace-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        reason (:reason command)
        replacement (:replacement command)
        task (get-in draft [:tasks task-id])
        replacement-needs-token (edn/read-field replacement :needs-token :needsToken)
        normalized (tasks/normalize-task-spec replacement "replacement")]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (= :done (:state task))
      (failure :TASK_NOT_READY "cannot replace a done task" {:task-id task-id :current (:state task)})

      (tasks/has-open-children? draft task)
      (failure :TASK_HAS_CHILDREN "replace needs a leaf with no unfinished children"
               {:task-id task-id :children (:child-ids task)})

      (not (edn/text? reason))
      (failure :INVALID_ARGUMENT "replace needs a non-empty reason" {:task-id task-id :field :reason})

      (not (:ok normalized))
      normalized

      :else
      (let [spec (:value normalized)
            spec (if (some? replacement-needs-token)
                   spec
                   (assoc spec :needs-token (:needs-token task)))
            [draft replacement-id] (tasks/append-task draft (assoc spec
                                                                   :owner-id nil
                                                                   :parent-id (:parent-id task)
                                                                   :ledger-key (:ledger-key task)))
            [draft _] (tasks/detach-child-from-parent draft task replacement-id (:turn-id context))
            draft (tasks/remove-orphan-actions-for-task draft task-id)
            draft (update draft :tasks dissoc task-id)]
        {:ok true
         :board draft
         :receipt {:outcome :replaced :task-id task-id :replacement-id replacement-id}
         :event-type :task-replaced
         :event-data {:task-id task-id :replacement-id replacement-id :reason reason}
         :wake-cause :task-replaced}))))

(defn release-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        claim-id (edn/read-field command :claim-id :claimId)
        task (get-in draft [:tasks task-id])
        active (tasks/action-value (tasks/active-action-for-task draft task-id))]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (not= :ready (:state task))
      (failure :TASK_NOT_READY "task is not ready" {:task-id task-id :current (:state task)})

      (and active (not (contains? #{:claimed :preparing :waiting-gate} (:phase active))))
      (failure :CLAIM_CHANGED "cannot release after applying"
               {:task-id task-id :action-id (:action-id active) :phase (:phase active)})

      (or (not= (:claim-id task) claim-id)
          (not= (:claim-owner-id task) (:actor-id context)))
      (failure :CLAIM_CHANGED "claim or owner changed"
               {:task-id task-id
                :expected-claim-id claim-id
                :current-claim-id (:claim-id task)
                :expected-claim-owner-id (:actor-id context)
                :current-claim-owner-id (:claim-owner-id task)})

      :else
      (let [draft (tasks/remove-orphan-actions-for-task draft task-id)
            draft (update-in draft [:tasks task-id]
                             (fn [task]
                               (cond-> (assoc task :claim-id nil :claim-owner-id nil)
                                 (not (:needs-token task)) (assoc :owner-id nil))))]
        {:ok true
         :board draft
         :receipt {:outcome :released :task-id task-id}
         :event-type :task-released
         :event-data {:task-id task-id}
         :wake-cause :task-released}))))

(defn reopen-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        reason (:reason command)
        evidence (:evidence command)
        task (get-in draft [:tasks task-id])
        evidence? (or (edn/text? evidence)
                      (and (sequential? evidence)
                           (not (empty? evidence))
                           (every? edn/text? evidence)))]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (not= :done (:state task))
      (failure :TASK_NOT_READY "only a done task can be reopened"
               {:task-id task-id :current (:state task)})

      (not (edn/text? reason))
      (failure :INVALID_ARGUMENT "reopen needs a non-empty reason" {:task-id task-id :field :reason})

      (not evidence?)
      (failure :INVALID_ARGUMENT "reopen needs evidence" {:task-id task-id :field :evidence})

      :else
      (let [draft (update-in draft [:tasks task-id]
                             (fn [task]
                               (let [owner (get-in draft [:actors (:owner-id task)])]
                                 (cond-> (-> task
                                             (assoc :state :ready
                                                    :claim-id nil
                                                    :claim-owner-id nil
                                                    :revived-turn-id nil))
                                   (not= :alive (:life-state owner)) (assoc :owner-id nil)))))]
        {:ok true
         :board draft
         :receipt {:outcome :reopened :task-id task-id}
         :event-type :task-reopened
         :event-data {:task-id task-id :reason reason :evidence evidence}
         :force-wake true
         :wake-cause :task-reopened}))))

(defn comment-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        text (:text command)
        task (get-in draft [:tasks task-id])]
    (if (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})
      (if-not (edn/text? text)
        (failure :INVALID_ARGUMENT "comment needs non-empty text" {:task-id task-id :field :text})
        (let [comment {:agent-id (:actor-id context)
                       :turn-id (:turn-id context)
                       :board-version (inc (:board-version draft))
                       :text text}
              draft (update-in draft [:tasks task-id :comments]
                               #(conj (vec (or % [])) comment))]
          {:ok true
           :board draft
           :receipt {:outcome :commented :task-id task-id}
           :event-type :task-commented
           :event-data {:task-id task-id :text text}})))))

(defn update-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        fields (:fields command)
        task (get-in draft [:tasks task-id])]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (= :done (:state task))
      (failure :TASK_NOT_READY "cannot update a done task" {:task-id task-id :current (:state task)})

      (or (not (map? fields)) (sequential? fields))
      (failure :INVALID_ARGUMENT "update needs a fields object" {:task-id task-id})

      :else
      (let [result (reduce
                     (fn [acc [key value]]
                       (if (:error acc)
                         acc
                         (case key
                           (:goal "goal")
                           (if (edn/text? value)
                             (update acc :changes assoc :goal value)
                             {:error (failure :INVALID_ARGUMENT "goal must be non-empty" {:task-id task-id})})

                           (:remaining-work "remainingWork" "remaining_work")
                           (if (edn/text? value)
                             (update acc :changes assoc :remaining-work value)
                             {:error (failure :INVALID_ARGUMENT "remaining_work must be non-empty" {:task-id task-id})})

                           (:done-when "doneWhen" "done_when")
                           (if (edn/text? value)
                             (update acc :changes assoc :done-when value)
                             {:error (failure :INVALID_ARGUMENT "done_when must be non-empty" {:task-id task-id})})

                           (:needs-token "needsToken" "needs_token")
                           (cond
                             (not (boolean? value))
                             {:error (failure :INVALID_ARGUMENT "needs_token must be boolean" {:task-id task-id})}

                             (and (not= value (:needs-token task)) (:claim-id task))
                             {:error (failure :CLAIM_CONFLICT "cannot change needs_token while claimed"
                                              {:task-id task-id :claim-id (:claim-id task)})}

                             :else
                             (update acc :changes assoc :needs-token value))

                           {:error (failure :INVALID_ARGUMENT "update field is not allowed"
                                            {:task-id task-id :field key})})))
                     {:changes {}}
                     fields)]
        (if-let [error (:error result)]
          error
          (if (empty? (:changes result))
            (failure :INVALID_ARGUMENT "update needs at least one field" {:task-id task-id})
            (let [draft (update-in draft [:tasks task-id] #(merge % (:changes result)))]
              {:ok true
               :board draft
               :receipt {:outcome :updated :task-id task-id :fields (:changes result)}
               :event-type :task-updated
               :event-data {:task-id task-id :fields (:changes result)}
               :wake-cause :task-updated})))))))

(defn park-slot-handler [draft context]
  (let [command (:command context)
        observed (edn/first-defined
                   (edn/read-field command :observed-board-version :observedBoardVersion)
                   (edn/read-field command :expected-board-version :expectedBoardVersion))]
    (cond
      (not (integer? observed))
      (failure :INVALID_ARGUMENT "park needs observed_board_version"
               {:field :observed-board-version})

      (not= observed (:board-version draft))
      (failure :BOARD_CONFLICT "board version changed"
               {:expected observed :current (:board-version draft)
                :summary (model/progressable-summary draft)})

      (seq (model/progressable-set draft))
      (failure :BOARD_CONFLICT "board still has progressable work"
               {:current (:board-version draft) :summary (model/progressable-summary draft)})

      :else
      (let [draft (assoc-in draft [:sleepers (:actor-id context)]
                            {:agent-id (:actor-id context)
                             :slot-id (get-in draft [:actors (:actor-id context) :slot-id])
                             :since-version (:board-version draft)
                             :wake-epoch (get-in draft [:wake :epoch])})]
        {:ok true
         :board draft
         :receipt {:outcome :parked
                   :agent-id (:actor-id context)
                   :wake-epoch (get-in draft [:wake :epoch])}
         :event-type :slot-parked
         :event-data {:agent-id (:actor-id context)}}))))

(defn register-actor-handler [draft context]
  (let [command (:command context)
        raw (or (:agent command)
                (edn/read-field command :actor)
                {:agent-id (edn/read-field command :agent-id :agentId)
                 :slot-id (edn/read-field command :slot-id :slotId)
                 :role (:role command)})
        normalized (actors/normalize-actor-spec raw)]
    (if-not (:ok normalized)
      normalized
      (let [actor (:value normalized)]
        (if (contains? (:actors draft) (:agent-id actor))
          (failure :NAME_TAKEN "agent_id already exists" {:agent-id (:agent-id actor)})
          (let [draft (assoc-in draft [:actors (:agent-id actor)] actor)]
            {:ok true
             :board draft
             :receipt {:outcome :actor-registered
                       :agent-id (:agent-id actor)
                       :slot-id (:slot-id actor)}
             :event-type :actor-registered
             :event-data {:agent-id (:agent-id actor)
                          :slot-id (:slot-id actor)
                          :role (:role actor)}
             :wake-cause :actor-registered}))))))

(defn record-input-handler [draft context]
  (let [command (:command context)
        text (edn/read-field command :text :input)]
    (if-not (edn/text? text)
      (failure :INVALID_ARGUMENT "record_input needs the original text" {:field :text})
      (let [[draft input-id] (model/next-id draft :input "I")
            draft (update draft :inputs conj {:input-id input-id
                                              :text text
                                              :board-version (inc (:board-version draft))
                                              :turn-id (:turn-id context)})]
        {:ok true
         :board draft
         :receipt {:outcome :input-recorded :input-id input-id :text text}
         :event-type :user-input
         :event-data {:input-id input-id :text text}
         :force-wake true
         :wake-cause :user-input}))))

(defn add-tasks-handler [draft context]
  (let [specs (:tasks (:command context))]
    (if (or (not (sequential? specs)) (empty? specs))
      (failure :INVALID_ARGUMENT "add_tasks needs at least one task" {})
      (let [result (loop [index 0 board draft ids []]
                     (if (>= index (count specs))
                       {:ok true :board board :task-ids ids}
                       (let [normalized (tasks/normalize-task-spec (nth specs index)
                                                                   (str "tasks[" index "]"))]
                         (if-not (:ok normalized)
                           normalized
                           (let [[board task-id] (tasks/append-task board (:value normalized))]
                             (recur (inc index) board (conj ids task-id)))))))]
        (if-not (:ok result)
          result
          {:ok true
           :board (:board result)
           :receipt {:outcome :tasks-added :task-ids (vec (:task-ids result))}
           :event-type :tasks-added
           :event-data {:task-ids (vec (:task-ids result))}
           :wake-cause :tasks-added})))))

(defn resolve-condition-handler [draft context]
  (let [command (:command context)
        key (edn/read-field command :key :condition)
        value (if (contains? command :value) (:value command) true)]
    (cond
      (not (edn/text? key))
      (failure :INVALID_ARGUMENT "resolve_condition needs a condition key" {:field :key})

      (not (boolean? value))
      (failure :INVALID_ARGUMENT "condition value must be boolean" {:field :value})

      :else
      (let [draft (assoc-in draft [:conditions key] value)
            [draft revived]
            (if value
              (reduce (fn [[board revived] [task-id task]]
                        (if (and (= :waiting (:state task))
                                 (seq (:wait-for task []))
                                 (some #(= key (tasks/condition-wait-key %)) (:wait-for task))
                                 (every? #(tasks/is-wait-satisfied? board %) (:wait-for task)))
                          [(-> board
                               (assoc-in [:tasks task-id :state] :ready)
                               (assoc-in [:tasks task-id :wait-for] [])
                               (assoc-in [:tasks task-id :revived-turn-id] (:turn-id context)))
                           (conj revived task-id)]
                          [board revived]))
                      [draft []]
                      (:tasks draft))
              [draft []])]
        {:ok true
         :board draft
         :receipt {:outcome :condition-resolved :key key :value value :revived-task-ids (vec revived)}
         :event-type :condition-resolved
         :event-data {:key key :value value :revived-task-ids (vec revived)}
         :wake-cause :condition-resolved}))))

(defn start-action-handler [draft context]
  (let [command (:command context)
        task-id (edn/read-field command :task-id :taskId)
        claim-id (edn/read-field command :claim-id :claimId)
        raw-kind (edn/read-field command :kind)
        raw-phase (edn/read-field command :phase)
        kind (if (nil? raw-kind) :edit (normalize-kind raw-kind))
        phase (if (nil? raw-phase) :preparing (normalize-phase raw-phase))
        action-id-arg (edn/read-field command :action-id :actionId)
        task (get-in draft [:tasks task-id])
        actor-active (tasks/active-action-for-actor draft (:actor-id context))
        task-active (tasks/active-action-for-task draft task-id)]
    (cond
      (nil? task)
      (failure :INVALID_ARGUMENT "task does not exist" {:task-id task-id})

      (not= :ready (:state task))
      (failure :TASK_NOT_READY "task is not ready" {:task-id task-id :current (:state task)})

      (or (not= (:claim-id task) claim-id)
          (not= (:claim-owner-id task) (:actor-id context)))
      (failure :CLAIM_CHANGED "claim or owner changed"
               {:task-id task-id
                :expected-claim-id claim-id
                :current-claim-id (:claim-id task)
                :expected-claim-owner-id (:actor-id context)
                :current-claim-owner-id (:claim-owner-id task)})

      (nil? kind)
      (failure :INVALID_ARGUMENT "unknown action kind" {:kind raw-kind})

      (nil? phase)
      (failure :INVALID_ARGUMENT "unknown action phase" {:phase raw-phase})

      (= :finished phase)
      (failure :INVALID_ARGUMENT "an action cannot start finished" {:phase phase})

      (and (= :shell kind) (not (model/is-holder? draft (:actor-id context))))
      (failure :TOKEN_REQUIRED "shell action needs the Holder"
               {:task-id task-id :holder-id (get-in draft [:token-slot :holder-id])})

      actor-active
      (failure :INVALID_ARGUMENT "actor already has an active action"
               {:agent-id (:actor-id context)
                :action-id (:action-id (tasks/action-value actor-active))
                :phase (:phase (tasks/action-value actor-active))})

      task-active
      (failure :INVALID_ARGUMENT "task already has an active action"
               {:task-id task-id
                :action-id (:action-id (tasks/action-value task-active))
                :phase (:phase (tasks/action-value task-active))})

      :else
      (let [[draft action-id] (if (edn/text? action-id-arg)
                                [draft action-id-arg]
                                (model/next-id draft :action "A"))]
        (if (contains? (:actions draft) action-id)
          (failure :NAME_TAKEN "action_id already exists" {:action-id action-id})
          (let [action {:action-id action-id
                        :task-id task-id
                        :agent-id (:actor-id context)
                        :claim-id claim-id
                        :kind kind
                        :phase phase
                        :request-id (:request-id context)
                        :result-ref nil}
                draft (-> draft
                          (assoc-in [:actions action-id] action)
                          (assoc-in [:actors (:actor-id context) :active-action-id]
                                    (when-not (contains? #{:finished :uncertain} phase) action-id)))]
            {:ok true
             :board draft
             :receipt {:outcome :action-started :action-id action-id :task-id task-id :phase phase}
             :event-type :action-started
             :event-data {:action-id action-id :task-id task-id :phase phase :kind kind}
             :wake-cause :action-started}))))))

(defn set-action-phase-handler [draft context]
  (let [command (:command context)
        action-id (edn/read-field command :action-id :actionId)
        raw-phase (:phase command)
        phase (normalize-phase raw-phase)
        result-ref (or (edn/read-field command :result-ref :resultRef) nil)
        claim-id (edn/read-field command :claim-id :claimId)
        action (get-in draft [:actions action-id])]
    (cond
      (nil? action)
      (failure :INVALID_ARGUMENT "action does not exist" {:action-id action-id})

      (not= (:agent-id action) (:actor-id context))
      (failure :ACTOR_DEAD "action belongs to another actor"
               {:action-id action-id :agent-id (:actor-id context) :current (:agent-id action)})

      (and (some? claim-id) (not= claim-id (:claim-id action)))
      (failure :CLAIM_CHANGED "action claim changed"
               {:action-id action-id :expected-claim-id claim-id :current-claim-id (:claim-id action)})

      (nil? phase)
      (failure :INVALID_ARGUMENT "unknown action phase" {:phase raw-phase})

      (not (contains? (get model/action-transitions (:phase action) #{}) phase))
      (failure :INVALID_ARGUMENT "action phase transition is not allowed"
               {:action-id action-id :from (:phase action) :to phase})

      (and (= :shell (:kind action))
           (not (contains? #{:finished :uncertain} phase))
           (not (model/is-holder? draft (:actor-id context))))
      (failure :TOKEN_REQUIRED "shell action needs the Holder"
               {:action-id action-id :holder-id (get-in draft [:token-slot :holder-id])})

      :else
      (let [draft (-> draft
                      (assoc-in [:actions action-id :phase] phase)
                      (cond-> (some? result-ref)
                        (assoc-in [:actions action-id :result-ref] result-ref))
                      (assoc-in [:actors (:actor-id context) :active-action-id]
                                (when-not (contains? #{:finished :uncertain} phase) action-id)))]
        {:ok true
         :board draft
         :receipt {:outcome :action-phase :action-id action-id :phase phase}
         :event-type :action-phase
         :event-data {:action-id action-id :phase phase :result-ref result-ref}
         :wake-cause :action-phase}))))