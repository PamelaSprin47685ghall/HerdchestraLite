(ns herd.swarm.tasks
  (:require
   [clojure.string :as string]
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]))

(defn normalize-task-spec [spec label]
  (if-not (map? spec)
    {:ok false :error {:code :INVALID_ARGUMENT :message (str label " must be an object")}}
    (let [goal (edn/read-field spec :goal)
          remaining-work (edn/read-field spec :remaining-work :remainingWork)
          done-when (edn/read-field spec :done-when :doneWhen)
          needs-token (edn/read-field spec :needs-token :needsToken)]
      (cond
        (not (edn/text? goal))
        {:ok false :error {:code :INVALID_ARGUMENT
                           :message (str label ".goal must be non-empty")}}

        (not (edn/text? remaining-work))
        {:ok false :error {:code :INVALID_ARGUMENT
                           :message (str label ".remaining_work must be non-empty")}}

        (not (edn/text? done-when))
        {:ok false :error {:code :INVALID_ARGUMENT
                           :message (str label ".done_when must be non-empty")}}

        (and (some? needs-token) (not (boolean? needs-token)))
        {:ok false :error {:code :INVALID_ARGUMENT
                           :message (str label ".needs_token must be boolean")}}

        :else
        {:ok true
         :value {:goal goal
                 :remaining-work remaining-work
                 :done-when done-when
                 :needs-token (boolean needs-token)
                 :owner-id (edn/read-field spec :owner-id :ownerId)
                 :ledger-key (edn/read-field spec :ledger-key :ledgerKey)
                 :parent-id (edn/read-field spec :parent-id :parentId)}}))))

(defn append-task [board spec]
  (let [[board task-id] (model/next-id board :task "T")]
    [(assoc-in board [:tasks task-id]
               {:task-id task-id
                :ledger-key (:ledger-key spec)
                :goal (:goal spec)
                :remaining-work (:remaining-work spec)
                :done-when (:done-when spec)
                :state :ready
                :wait-for []
                :needs-token (:needs-token spec)
                :owner-id (:owner-id spec)
                :claim-id nil
                :claim-owner-id nil
                :parent-id (:parent-id spec)
                :child-ids []
                :result-refs []
                :result-summary nil
                :dependency-paths []
                :handoff-note nil
                :comments []
                :revived-turn-id nil})
     task-id]))

(defn wait-entry-task-id [entry]
  (when (and (string? entry) (not (string/starts-with? entry model/condition-wait-prefix)))
    entry))

(defn condition-wait-key [entry]
  (when (and (string? entry) (string/starts-with? entry model/condition-wait-prefix))
    (let [key (subs entry (count model/condition-wait-prefix))]
      (when (edn/text? key) key))))

(defn is-wait-satisfied? [board entry]
  (if-not (string? entry)
    false
    (if (string/starts-with? entry model/condition-wait-prefix)
      (let [key (condition-wait-key entry)]
        (and key (= true (get-in board [:conditions key]))))
      (let [task (get-in board [:tasks entry])]
        (or (nil? task) (= :done (:state task)))))))

(defn normalize-wait-entries [raw child-ids board parent-id]
  (if (nil? raw)
    (vec child-ids)
    (if (or (not (sequential? raw)) (empty? raw))
      nil
      (let [allowed (set (get-in board [:tasks parent-id :child-ids] []))
            result (reduce (fn [acc entry]
                             (cond
                               (not (edn/text? entry)) (reduced nil)
                               (string/starts-with? entry model/condition-wait-prefix)
                               (if (condition-wait-key entry)
                                 (conj acc entry)
                                 (reduced nil))
                               (and (contains? allowed entry) (contains? (:tasks board) entry))
                               (conj acc entry)
                               :else (reduced nil)))
                           []
                           raw)]
        (when result (edn/unique-values result))))))

(defn has-open-children? [board task]
  (some (fn [child-id]
          (let [child (get-in board [:tasks child-id])]
            (and child (not= :done (:state child)))))
        (:child-ids task [])))

(defn detach-child-from-parent [board task replacement-id turn-id]
  (let [parent-id (:parent-id task)]
    (if-not (and parent-id (contains? (:tasks board) parent-id))
      [board nil]
      (let [parent (get-in board [:tasks parent-id])
            child-id (:task-id task)
            child-ids (vec (remove #(= % child-id) (:child-ids parent [])))
            child-ids (if replacement-id (edn/unique-values (conj child-ids replacement-id)) child-ids)
            wait-for (vec (mapcat (fn [entry]
                                    (if (= (wait-entry-task-id entry) child-id)
                                      (if replacement-id [replacement-id] [])
                                      [entry]))
                                  (:wait-for parent [])))
            board (-> board
                      (assoc-in [:tasks parent-id :child-ids] child-ids)
                      (assoc-in [:tasks parent-id :wait-for] wait-for))
            revived? (and (= :waiting (:state parent))
                          (seq wait-for)
                          (every? #(is-wait-satisfied? board %) wait-for))]
        (if revived?
          [(-> board
               (assoc-in [:tasks parent-id :state] :ready)
               (assoc-in [:tasks parent-id :wait-for] [])
               (assoc-in [:tasks parent-id :revived-turn-id] turn-id))
           parent-id]
          [board nil])))))

(defn active-action-for-actor [board agent-id]
  (first (filter (fn [[_ action]]
                   (and (= agent-id (:agent-id action))
                        (not= :finished (:phase action))))
                 (:actions board {}))))

(defn active-action-for-task [board task-id]
  (first (filter (fn [[_ action]]
                   (and (= task-id (:task-id action))
                        (not= :finished (:phase action))))
                 (:actions board {}))))

(defn action-value [entry]
  (when entry (second entry)))

(defn remove-orphan-actions-for-task [board task-id]
  (let [orphans (for [[action-id action] (:actions board)
                      :when (and (= task-id (:task-id action))
                                 (contains? #{:claimed :preparing :waiting-gate} (:phase action)))]
                  [action-id (:agent-id action)])]
    (reduce (fn [board [action-id agent-id]]
              (let [board (update board :actions dissoc action-id)
                    actor (get-in board [:actors agent-id])]
                (if (= action-id (:active-action-id actor))
                  (assoc-in board [:actors agent-id :active-action-id] nil)
                  board)))
            board
            orphans)))