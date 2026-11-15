(ns herd.swarm.board
  "Station-backed board command execution.

  Every durable board transition goes through `herd.station`: the station owns
  the in-memory state and opens one ticket per command. This namespace only
  wires the board kernel, the file store, and the station kernel together."
  (:require
   [herd.station :as station]
   [herd.swarm.edn :as edn]
   [herd.swarm.kernel :as kernel]
   [herd.swarm.model :as model]
   [herd.swarm.store :as store]
   [promesa.core :as p]))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn- station-result [result]
  (if (:ok result)
    {:ok true
     :receipt (:receipt result)
     :board-version (or (:board-version result) (:version result))
     :replayed (or (:replayed result)
                   (get-in result [:receipt :replayed]))}
    (let [error (:error result)
          code (or (some-> (:error-name result) keyword)
                   (when (map? error) (:code error))
                   :INTERNAL)
          message (or (when (map? error) (:message error))
                      (when (string? error) error)
                      (str error))]
      {:ok false
       :error {:code code :message message}})))

(defn- ^:async open-station! [handle]
  (try
    (let [current (await (store/read-board handle))
          board (cond
                  (model/board-state? current) current
                  (and (nil? current) (not (:durable handle)))
                  (model/initial-board {:mode (or (:mode handle) :swarm)})
                  :else nil)]
      (when board
        (station/create-station
         {:initial-board board
          :apply-command (fn [current command _context]
                           (kernel/apply-command current command))
          :open-ticket (station/make-ticket-runner
                        (fn [ticket planned-board]
                          (let [events (get-in ticket [:plan :result :events])]
                            (if (:durable handle)
                              (store/commit-board! handle planned-board events)
                              ((:transaction (:store handle))
                               (fn [_current]
                                 {:board planned-board
                                  :events events
                                  :commit true
                                  :response {:ok true}}))))))})))
    (catch :default _ nil)))

(defn- submit-command! [station command args]
  (let [request-id (:request-id args)]
    (station/submit! station
                     (assoc command
                            :actor (:actor args)
                            :request-id request-id
                            :turn-id (:turn-id args))
                     {:request-id request-id
                      :kind (kernel/command-type command)})))

(defn- take-or-die! [station command args request-id]
  (let [accept-request-id (str request-id ":accept")
        accept-command (-> command
                           (assoc :type :accept-take
                                  :original-request-id request-id
                                  :actor (:actor args)
                                  :request-id accept-request-id
                                  :turn-id (:turn-id args))
                           (dissoc :expected-board-version
                                   :expected_board_version
                                   :observed-board-version
                                   :observed_board_version))
        accept-promise (station/submit! station accept-command
                                        {:request-id accept-request-id
                                         :kind :take-accept})]
    (-> accept-promise
        (.then
         (fn [accepted]
           (if-not (:ok accepted)
             (station-result accepted)
             (if (= :no-progressable-work (get-in accepted [:receipt :outcome]))
               (assoc-in (station-result accepted) [:receipt :request-id] request-id)
               (let [resolve-command {:type :resolve-take
                                      :attempt-id accept-request-id
                                      :take-digest (edn/canonical command)
                                      :actor (:actor args)
                                      :request-id request-id
                                      :turn-id (:turn-id args)}
                     resolved-promise (station/submit! station resolve-command
                                                       {:request-id request-id
                                                        :kind :take-resolve})]
                 (-> resolved-promise
                     (.then
                      (fn [resolved]
                        (if (:ok resolved)
                          (-> (station-result resolved)
                              (assoc-in [:receipt :accepted-version]
                                        (or (get-in accepted [:receipt :board-version])
                                            (:board-version accepted)
                                            (:version accepted)))
                              (assoc-in [:receipt :token-tasks]
                                        (or (get-in resolved [:receipt :token-tasks])
                                            (get-in accepted [:receipt :token-tasks])
                                            [])))
                          (station-result resolved)))))))))))))

(defn submit-board-command! [raw-args]
  (let [board-arg (:board raw-args)
        args (dissoc raw-args :board)
        command (:command args)]
    (cond
      (store/board-handle? board-arg)
      (let [handle board-arg]
        (if (= :take-or-die (kernel/command-type command))
          (let [request-id (:request-id args)]
            (if-not (edn/text? request-id)
              (failure :INVALID_ARGUMENT "request_id is required" {:field :request-id})
              (-> (open-station! handle)
                  (.then (fn [board-station]
                           (if-not board-station
                             (failure :STALE_CONTROL "slice board is missing or unreadable" {})
                             (take-or-die! board-station command args request-id)))))))
          (-> (open-station! handle)
              (.then (fn [board-station]
                       (if-not board-station
                         (failure :STALE_CONTROL "slice board is missing or unreadable" {})
                         (-> (submit-command! board-station command args)
                             (.then station-result))))))))

      (model/board-state? board-arg)
      (kernel/apply-command board-arg args)

      :else
      (failure :INVALID_ARGUMENT
               "board must be a board value or an open-board handle" {}))))
