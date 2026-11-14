(ns herd.swarm.model
  (:require
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.swarm.edn :as edn]))

(def condition-wait-prefix "condition:")

(def task-states #{:ready :waiting :done})
(def life-states #{:alive :dead :terminated})
(def action-kinds #{:board :edit :shell})
(def action-phases #{:claimed :preparing :waiting-gate :applying :running :finished :uncertain})
(def active-action-phases #{:applying :running :uncertain})

(def action-transitions
  {:claimed #{:preparing :applying :running :waiting-gate :finished :uncertain}
   :preparing #{:applying :running :waiting-gate :finished :uncertain}
   :waiting-gate #{:applying :running :finished :uncertain}
   :applying #{:finished :uncertain}
   :running #{:finished :uncertain}
   :uncertain #{:finished}
   :finished #{}})

(defn initial-board
  ([]
   (initial-board {}))
  ([options]
   (let [version (if (integer? (:board-version options)) (:board-version options) 0)
         mode (if (= :plan (:mode options)) :plan :swarm)]
     {:board-version version
      :mode mode
      :tasks {}
      :attach-ready (= mode :plan)
      :review-summary nil
      :actions {}
      :actors {}
      :token-slot {:holder-id nil :term-id nil :state :free :retired-terms []}
      :tenure {:term 0 :phase (if (= mode :plan) :plan :swarm)}
      :next-ids {:task 1 :claim 1 :term 1 :action 1 :event 1 :input 1}
      :requests {}
      :take-attempts {}
      :sleepers {}
      :wake {:epoch 0}
      :conditions {}
      :inputs []})))

(defn board-state? [value]
  (and (map? value)
       (contains? value :board-version)
       (map? (:tasks value))
       (map? (:actors value))))

(defn valid-board? [value]
  (and (board-state? value)
       (integer? (:board-version value))
       (if (= :plan (:mode value))
         (every? (fn [[key task]]
                   (and (map? task)
                        (or (nil? (:key task)) (= key (:key task)))
                        (or (nil? (:value task)) (string? (:value task)))
                        (every? string? (:wait-for task []))
                        (every? #(contains? (:tasks value) %) (:wait-for task []))))
                 (:tasks value))
         (and (map? (:actions value))
              (map? (:next-ids value))
              (contains? #{:free :held} (get-in value [:token-slot :state]))
              (every? (fn [[_ task]]
                        (and (map? task)
                             (string? (:task-id task))
                             (contains? task-states (:state task))
                             (vector? (:wait-for task))
                             (every? (fn [entry]
                                       (and (string? entry)
                                            (if (string/starts-with? entry condition-wait-prefix)
                                              (edn/text? (subs entry (count condition-wait-prefix)))
                                              (contains? (:tasks value) entry))))
                                     (:wait-for task))))
                      (:tasks value))
              (every? (fn [[_ actor]]
                        (and (map? actor)
                             (string? (:agent-id actor))
                             (contains? life-states (:life-state actor))))
                      (:actors value))
              (every? (fn [[_ action]]
                        (and (map? action)
                             (string? (:action-id action))
                             (contains? action-phases (:phase action))))
                      (:actions value))
              (every? (fn [[_ attempt]]
                        (and (map? attempt)
                             (string? (:request-id attempt))
                             (string? (:agent-id attempt))
                             (boolean? (:resolved attempt))
                             (contains? #{:free :held} (:token-state attempt))
                             (contains? #{nil :attempt-won :attempt-lost} (:outcome attempt))))
                      (:take-attempts value {}))))))

(defn- ensure-plan-tasks [board]
  (update board :tasks
          (fn [tasks]
            (into {}
                  (map (fn [[key task]]
                         (if (map? task)
                           [key (-> task
                                    (update :key #(or % key))
                                    (update :value #(if (contains? task :value) % nil))
                                    (update :parent-key #(if (contains? task :parent-key) % nil))
                                    (update :child-keys #(or % []))
                                    (update :wait-for #(or % []))
                                    (update :waiting #(boolean %)))]
                           [key task]))
                       tasks)))))

(defn ensure-board-shape [board]
  (let [board (-> board
                  (update :board-version #(if (integer? %) % 0))
                  (update :mode #(if (= :plan %) :plan :swarm))
                  (update :attach-ready boolean)
                  (update :review-summary #(when (some? %) %))
                  (update :tasks #(or % {}))
                  (update :actions #(or % {}))
                  (update :actors #(or % {})))]
    (-> board
        (cond-> (= :plan (:mode board)) ensure-plan-tasks)
        (update :token-slot #(merge {:holder-id nil :term-id nil :state :free :retired-terms []} %))
        (update :tenure #(merge {:term 0 :phase (if (= :plan (:mode board)) :plan :swarm)} %))
        (update :next-ids #(merge {:task 1 :claim 1 :term 1 :action 1 :event 1 :input 1} %))
        (update :requests #(or % {}))
        (update :take-attempts #(or % {}))
        (update :sleepers #(or % {}))
        (update :wake #(merge {:epoch 0} %))
        (update :conditions #(or % {}))
        (update :inputs #(or % [])))))

(defn next-id [board kind prefix]
  (let [current (get-in board [:next-ids kind] 1)]
    [(assoc-in board [:next-ids kind] (inc current))
     (str prefix "-" current)]))

(defn make-event [board type data version context]
  {:event-id (str "E-" version "-"
                  (subs (edn/digest-of [type data (:request-id context) (:actor-id context)]) 0 8))
   :event-type type
   :board-version version
   :request-id (:request-id context)
   :actor-id (:actor-id context)
   :turn-id (:turn-id context)
   :data data})

(defn task-tree [board]
  (mapv (fn [[_ task]]
          {:task-id (:task-id task)
           :parent-id (:parent-id task)
           :state (:state task)
           :owner-id (:owner-id task)
           :claim-id (:claim-id task)
           :claim-owner-id (:claim-owner-id task)
           :needs-token (:needs-token task)
           :wait-for (vec (:wait-for task []))
           :goal (:goal task)})
        (:tasks board)))

(defn responsibility-set [board agent-id]
  (let [holder-id (get-in board [:token-slot :holder-id])]
    (-> []
        (into (for [[_ task] (:tasks board)
                    :when (and (contains? #{:ready :waiting} (:state task))
                               (or (and (not (:needs-token task)) (= agent-id (:owner-id task)))
                                   (and (:needs-token task) (= holder-id agent-id))))]
                {:kind (if (:needs-token task) :token-task :task)
                 :id (:task-id task)
                 :task task}))
        (into (for [[_ action] (:actions board)
                    :when (and (= agent-id (:agent-id action))
                               (contains? active-action-phases (:phase action)))]
                {:kind :action :id (:action-id action) :action action})))))

(defn progressable-set [board]
  (let [active-by-task (into {}
                             (for [[_ action] (:actions board)
                                   :when (not= :finished (:phase action))]
                               [(:task-id action) action]))]
    (-> []
        (into (for [[_ task] (:tasks board)
                    :when (and (= :ready (:state task))
                               (not (contains? active-by-task (:task-id task))))]
                {:kind :task :id (:task-id task) :task task}))
        (into (for [[_ action] (:actions board)
                    :when (contains? #{:claimed :preparing :uncertain} (:phase action))]
                {:kind :action :id (:action-id action) :action action})))))

(defn workspace-relative-path? [value]
  (and (edn/text? value)
       (not (string/includes? value (str (char 0))))
       (not (path/isAbsolute value))
       (let [normalized (path/posix.normalize value)]
         (and (not= normalized "..")
              (not (string/starts-with? normalized "../"))))))

(defn validate-dependency-paths [paths]
  (when (and (sequential? paths) (every? workspace-relative-path? paths))
    (edn/unique-values (vec paths))))

(defn is-holder? [board agent-id]
  (let [token (:token-slot board)]
    (boolean (and (= :held (:state token))
                  (= agent-id (:holder-id token))))))

(defn open-token-task-ids [board]
  (vec (for [[_ task] (:tasks board)
             :when (and (:needs-token task)
                        (contains? #{:ready :waiting} (:state task)))]
         (:task-id task))))

(defn bump-wake [board]
  (-> board
      (update-in [:wake :epoch] inc)
      (assoc :sleepers {})))

(defn wake-all [board reason]
  (let [board (-> board ensure-board-shape (update :board-version inc) (bump-wake))
        epoch (get-in board [:wake :epoch])]
    {:board board
     :event (make-event board :wake-all {:cause reason :epoch epoch}
                        (:board-version board)
                        {:request-id nil :actor-id nil :turn-id nil})
     :epoch epoch}))

(defn progressable-summary [board]
  {:board-version (:board-version board)
   :holder-id (get-in board [:token-slot :holder-id])
   :progressable (mapv (fn [item]
                         {:kind (:kind item)
                          :id (:id item)
                          :task-id (or (get-in item [:action :task-id])
                                       (get-in item [:task :task-id]))
                          :state (or (get-in item [:task :state])
                                     (get-in item [:action :phase]))
                          :owner-id (or (get-in item [:task :owner-id])
                                        (get-in item [:action :agent-id]))})
                       (progressable-set board))
   :tasks (task-tree board)
   :sleepers (vec (keys (:sleepers board)))})