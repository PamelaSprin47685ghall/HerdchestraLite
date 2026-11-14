(ns herd.swarm.ledger
  (:require
   [herd.swarm.edn :as edn]
   [herd.swarm.model :as model]))

(defn is-attach-ready [board]
  (boolean (:attach-ready board)))

(defn review-ledger [board]
  (let [tasks (vals (:tasks board {}))]
    {:summary (:review-summary board)
     :findings (mapv (fn [task] {:key (:key task) :value (:value task)}) tasks)
     :empty (empty? tasks)
     :attach-ready (is-attach-ready board)}))

(defn- set-plan-parent [board task parent-key]
  (let [previous (:parent-key task)]
    (if (= previous parent-key)
      board
      (-> board
          (cond-> (and previous (contains? (:tasks board) previous))
            (update-in [:tasks previous :child-keys]
                       (fn [children] (vec (remove #(= % (:key task)) (or children []))))))
          (update-in [:tasks (:key task)] assoc :parent-key parent-key)
          (cond-> (and parent-key (contains? (:tasks board) parent-key))
            (update-in [:tasks parent-key :child-keys]
                       (fn [children]
                         (let [children (or children [])]
                           (if (some #(= % (:key task)) children)
                             children
                             (conj (vec children) (:key task)))))))))))

(defn- upsert-plan-task [board key value relation]
  (let [existing (get-in board [:tasks key])
        task (or existing {:key key :value nil :parent-key nil :child-keys [] :wait-for [] :waiting false})
        task (assoc task :key key :value value)
        board (assoc-in board [:tasks key] task)
        board (if (contains? relation :parent-key)
                (set-plan-parent board task (:parent-key relation))
                board)
        board (if (contains? relation :wait-for)
                (assoc-in board [:tasks key :wait-for] (edn/unique-values (:wait-for relation)))
                board)
        board (if (contains? relation :waiting)
                (assoc-in board [:tasks key :waiting] (:waiting relation))
                board)]
    board))

(defn- delete-plan-task [board key]
  (if-not (contains? (:tasks board) key)
    board
    (let [task (get-in board [:tasks key])
          parent-key (:parent-key task)
          board (if (and parent-key (contains? (:tasks board) parent-key))
                  (update-in board [:tasks parent-key :child-keys]
                             (fn [children] (vec (remove #(= % key) (or children [])))))
                  board)
          board (update board :tasks
                        (fn [tasks]
                          (into {}
                                (map (fn [[other-key other]]
                                       [other-key
                                        (if (= other-key key)
                                          other
                                          (-> other
                                              (cond-> (= (:parent-key other) key) (assoc :parent-key nil))
                                              (update :child-keys #(vec (remove (fn [child] (= child key)) (or % []))))
                                              (update :wait-for #(vec (remove (fn [entry] (= entry key)) (or % []))))))])
                                     tasks))))]
      (update board :tasks dissoc key))))

(defn apply-review [board input]
  (if-not (model/board-state? board)
    {:ok false :error {:code :INVALID_ARGUMENT :message "board must be a board value"}}
    (if (not= :plan (:mode board))
      {:ok false :error {:code :INVALID_ARGUMENT
                         :message "review requires a plan board"
                         :mode (:mode board)}}
      (let [findings (:findings input [])
            summary (:summary-markdown input)]
        (cond
          (not (sequential? findings))
          {:ok false :error {:code :INVALID_ARGUMENT
                             :message "findings must be an array"
                             :field :findings}}

          (and (some? summary) (not (string? summary)))
          {:ok false :error {:code :INVALID_ARGUMENT
                             :message "summary_markdown must be a string or nil"
                             :field :summary-markdown}}

          :else
          (let [draft (-> board model/ensure-board-shape
                          (cond-> (contains? input :summary-markdown)
                            (assoc :review-summary summary)))
                result (loop [index 0 draft draft]
                         (if (>= index (count findings))
                           {:ok true :board draft}
                           (let [finding (nth findings index)
                                 key (when (map? finding) (:key finding))
                                 value (when (map? finding) (:value finding))]
                             (cond
                               (not (map? finding))
                               {:ok false :error {:code :INVALID_ARGUMENT
                                                  :message (str "findings[" index "] must be an object")}}

                               (not (edn/text? key))
                               {:ok false :error {:code :INVALID_ARGUMENT
                                                  :message (str "findings[" index "].key must be non-empty")}}

                               (sequential? value)
                               (recur (inc index) draft)

                               (nil? value)
                               (recur (inc index) (delete-plan-task draft key))

                               (not (string? value))
                               {:ok false :error {:code :INVALID_ARGUMENT
                                                  :message (str "findings[" index "].value must be a string or nil")}}

                               :else
                               (let [parent-key (get finding :parent-key)
                                     wait-for (get finding :wait-for)
                                     waiting (get finding :waiting)]
                                 (cond
                                   (and (some? parent-key)
                                        (or (not (edn/text? parent-key))
                                            (= parent-key key)
                                            (not (contains? (:tasks draft) parent-key))))
                                   {:ok false :error {:code :INVALID_ARGUMENT
                                                      :message (str "findings[" index "].parent_key must name another task")
                                                      :parent-key parent-key}}

                                   (and (some? wait-for)
                                        (not (and (sequential? wait-for)
                                                  (every? #(and (edn/text? %) (contains? (:tasks draft) %)) wait-for))))
                                   {:ok false :error {:code :INVALID_ARGUMENT
                                                      :message (str "findings[" index "].wait_for must name existing tasks")}}

                                   (and (some? waiting) (not (boolean? waiting)))
                                   {:ok false :error {:code :INVALID_ARGUMENT
                                                      :message (str "findings[" index "].waiting must be boolean")}}

                                   :else
                                   (recur (inc index)
                                          (upsert-plan-task draft key value
                                                            (cond-> {}
                                                              (some? parent-key) (assoc :parent-key parent-key)
                                                              (some? wait-for) (assoc :wait-for wait-for)
                                                              (some? waiting) (assoc :waiting waiting))))))))))]
            (if-not (:ok result)
              result
              (let [draft (update (:board result) :attach-ready
                                  (fn [_] (empty? (:tasks (:board result)))))
                    unchanged (= (edn/canonical {:tasks (:tasks board)
                                                 :summary (:review-summary board)
                                                 :attach-ready (boolean (:attach-ready board))})
                                 (edn/canonical {:tasks (:tasks draft)
                                                 :summary (:review-summary draft)
                                                 :attach-ready (:attach-ready draft)}))]
                (if unchanged
                  {:ok true :board board :changed false :events []
                   :receipt {:outcome :review-unchanged
                             :board-version (:board-version board)
                             :task-keys (vec (keys (:tasks board)))
                             :attach-ready (is-attach-ready board)}}
                  (let [draft (update draft :board-version inc)
                        version (:board-version draft)
                        event (model/make-event draft :review
                                                {:summary (:review-summary draft)
                                                 :findings (mapv (fn [entry] {:key (:key entry) :value (:value entry)}) findings)
                                                 :attach-ready (:attach-ready draft)}
                                                version
                                                {:request-id nil :actor-id nil :turn-id nil})]
                    {:ok true :board draft :changed true :events [event]
                     :receipt {:outcome :review-recorded
                               :board-version version
                               :task-keys (vec (keys (:tasks draft)))
                               :attach-ready (:attach-ready draft)}}))))))))))