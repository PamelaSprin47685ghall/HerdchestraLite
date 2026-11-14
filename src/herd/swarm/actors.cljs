(ns herd.swarm.actors
  (:require
   [herd.swarm.edn :as edn]))

(def role-values #{:normal :holder})

(defn actor-id-of [actor]
  (cond
    (string? actor) actor
    (map? actor) (or (:agent-id actor) (:agentId actor) (:agent_id actor) (:id actor))
    :else nil))

(defn actor-term-of [actor]
  (when (map? actor)
    (or (:term-id actor) (:termId actor) (:term_id actor))))

(defn normalize-actor-spec [spec]
  (let [agent-id (edn/read-field spec :agent-id :agentId :agent_id)
        slot-id (or (edn/read-field spec :slot-id :slotId :slot_id) agent-id)
        role (or (edn/read-field spec :role) :normal)]
    (cond
      (not (edn/text? agent-id))
      {:ok false :error {:code :INVALID_ARGUMENT :message "actor needs agent_id"}}

      (not (edn/text? slot-id))
      {:ok false :error {:code :INVALID_ARGUMENT :message "actor needs slot_id"}}

      (not (contains? role-values role))
      {:ok false :error {:code :INVALID_ARGUMENT :message (str "unknown actor role: " role)}}

      :else {:ok true
             :value {:agent-id agent-id
                     :slot-id slot-id
                     :role role
                     :life-state :alive
                     :active-action-id nil
                     :term-id nil
                     :take-attempt-id nil}})))

(defn resolve-actor
  ([board actor-arg]
   (resolve-actor board actor-arg {}))
  ([board actor-arg options]
   (let [allow-dead (= :allow-dead (:allow options))
         agent-id (actor-id-of actor-arg)]
     (if-not (edn/text? agent-id)
       {:ok false :error {:code :ACTOR_DEAD :message "actor identity is required"}}
       (let [actor (get-in board [:actors agent-id])
             term-id (actor-term-of actor-arg)
             retired (get-in board [:token-slot :retired-terms] [])]
         (cond
           (nil? actor)
           {:ok false :error {:code :ACTOR_DEAD
                              :message "actor is not registered"
                              :agent-id agent-id}}

           (and (not allow-dead) (some #(= % term-id) retired) (some? term-id))
           {:ok false :error {:code :TENURE_RETIRED
                              :message "term has retired"
                              :agent-id agent-id
                              :term-id term-id}}

           (and (not= :alive (:life-state actor)) (not allow-dead))
           {:ok false :error {:code :ACTOR_DEAD
                              :message "actor is not alive"
                              :agent-id agent-id
                              :life-state (:life-state actor)}}

           (and (some? term-id) (some? (:term-id actor))
                (not= (:term-id actor) term-id)
                (not allow-dead))
           {:ok false :error {:code :TENURE_RETIRED
                              :message "term does not match the live Holder term"
                              :agent-id agent-id
                              :expected (:term-id actor)
                              :actual term-id}}

           :else {:ok true :agent-id agent-id :actor actor}))))))