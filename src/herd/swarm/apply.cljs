(ns herd.swarm.apply
  (:require
   [herd.swarm.edn :as edn]
   [herd.swarm.kernel :as kernel]
   [herd.swarm.model :as model]
   [herd.swarm.store :as store]))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn ^:async board-transaction [handle args]
  (await ((:transaction (:store handle))
           (fn [current]
             (let [plan? (= :plan (:mode handle))]
               (if (and (nil? current) (:durable handle) (not plan?))
                 {:board nil
                  :events []
                  :commit false
                  :response (assoc (failure :STALE_CONTROL
                                            "slice board is missing or unreadable"
                                            {:board-path (:board-path handle)
                                             :next "seed the tenure board; do not rebuild a missing ledger"})
                                   :board nil)}
                 (let [base (or current (model/initial-board {:mode (if plan? :plan :swarm)}))
                       result (kernel/apply-command base args)]
                   {:board (:board result)
                    :events (or (:events result) [])
                    :response result
                    :commit (boolean (and (:ok result) (:changed result)))})))))))

(defn- ^:async apply-take-two-phase [handle args]
  (let [request-id (edn/first-defined (:request-id args) (:request_id args))]
    (if-not (edn/text? request-id)
      (failure :INVALID_ARGUMENT "request_id is required" {:field :request-id})
      (let [accept-request-id (str request-id ":accept")
            accept-command (-> (:command args)
                               (assoc :type :accept-take
                                      :original-request-id request-id)
                               (dissoc :expected-board-version :expected_board_version
                                       :observed-board-version :observed_board_version))
            accept-args (-> args
                            (assoc :request-id accept-request-id :command accept-command)
                            (dissoc :expected-board-version :expected_board_version))
            accepted (await (board-transaction handle accept-args))]
        (if-not (:ok accepted)
          accepted
          (if (= :no-progressable-work (get-in accepted [:receipt :outcome]))
            (assoc-in accepted [:receipt :request-id] request-id)
            (let [resolve-args (-> args
                                   (assoc :request-id request-id
                                          :command {:type :resolve-take
                                                    :attempt-id accept-request-id
                                                    :take-digest (edn/canonical (:command args))})
                                   (dissoc :expected-board-version :expected_board_version))
                  resolved (await (board-transaction handle resolve-args))]
              (if (:ok resolved)
                (-> resolved
                    (assoc-in [:receipt :accepted-version] (get-in accepted [:receipt :board-version]))
                    (assoc-in [:receipt :token-tasks]
                              (or (get-in resolved [:receipt :token-tasks])
                                  (get-in accepted [:receipt :token-tasks])
                                  [])))
                resolved))))))))

(defn ^:async apply-board! [raw-args]
  (let [board-arg (:board raw-args)
        args (dissoc raw-args :board)]
    (cond
      (store/board-handle? board-arg)
      (if (= :take-or-die (kernel/command-type (:command args)))
        (await (apply-take-two-phase board-arg args))
        (await (board-transaction board-arg args)))

      (model/board-state? board-arg)
      (kernel/apply-command board-arg args)

      :else
      (failure :INVALID_ARGUMENT
               "board must be a board value or an open-board handle" {}))))