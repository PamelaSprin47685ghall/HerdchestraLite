(ns herd.station
  "Independent ticket station kernel.

  The station owns board memory and ticket records. Every station function is
  synchronous: it changes memory first and then calls the injected
  `:open-ticket` capability in tail position. Ticket functions own all
  asynchronous work and are the only functions in this namespace declared
  async.

  Board writes are queued on one promise chain. The committed board and its
  version move only after the injected persist capability reports success.
  Uncommitted memory is never presented as the board. A crashed process is
  reconstructed from the board value read from file.")

(def ticket-states #{:pending :running :applied :failed :cancelled :unknown})
(def terminal-states #{:applied :failed :cancelled :unknown})

(def ticket-transitions
  {:pending #{:running :failed :cancelled}
   :running #{:applied :failed :cancelled :unknown}
   :applied #{}
   :failed #{}
   :cancelled #{}
   :unknown #{}})

(defn ticket-terminal?
  [state]
  (contains? terminal-states state))

(defn- now-ms []
  (.now js/Date))

(defn- ex-data-of [error]
  (try
    (ex-data error)
    (catch :default _
      nil)))

(defn- error-message [error]
  (cond
    (nil? error) nil
    (string? error) error
    (map? error) (or (:message error) (pr-str error))
    (instance? js/Error error) (or (.-message error) (str error))
    :else (str error)))

(defn- error-name [error]
  (let [data (ex-data-of error)
        code (or (:code data)
                 (when (map? error) (or (:code error) (:name error)))
                 (when (instance? js/Error error) (.-name error)))]
    (cond
      (nil? code) nil
      (keyword? code) (name code)
      (symbol? code) (name code)
      (string? code) code
      :else (str code))))

(defn- error-detail [error]
  {:error (error-message error)
   :error-name (error-name error)})

(defn- uncertain-error? [error]
  (let [data (ex-data-of error)]
    (boolean
     (or (:uncertain data)
         (and (map? error) (:uncertain error))))))

(defn- state-of [station]
  (:state station))

(defn- in-transaction! [station f]
  (let [state (state-of station)]
    (when (:busy? @state)
      (throw (ex-info "station transaction is not reentrant"
                      {:code :STATION-REENTRANT})))
    (swap! state assoc :busy? true)
    (try
      (f state)
      (finally
        (swap! state assoc :busy? false)))))

(defn- settle*! [state ticket-id next-state detail]
  (let [ticket (get-in @state [:tickets ticket-id])
        allowed (get ticket-transitions (:state ticket))]
    (when (and ticket (contains? allowed next-state))
      (swap! state update-in [:tickets ticket-id]
             merge
             (merge {:state next-state
                     :finished-at (now-ms)}
                    (or detail {})))
      true)))

(defn- admission* [state ticket-id]
  (let [current @state
        ticket (get-in current [:tickets ticket-id])]
    (cond
      (nil? ticket)
      {:ok false
       :state :failed
       :reason :unknown-ticket
       :error {:code "UNKNOWN_TICKET"
               :message "ticket does not exist"}}

      (ticket-terminal? (:state ticket))
      {:ok false
       :state (:state ticket)
       :reason :terminal}

      (:aborted? ticket)
      {:ok false
       :state :cancelled
       :reason :aborted
       :error {:code "ABORTED"
               :message "ticket was cancelled"}}

      (not= (:epoch ticket) (:epoch current))
      {:ok false
       :state :failed
       :reason :stale-epoch
       :error {:code "STALE_EPOCH"
               :message "ticket epoch is stale"}}

      (:aborted? current)
      {:ok false
       :state :cancelled
       :reason :aborted
       :error {:code "ABORTED"
               :message "station is cancelled"}}

      (:needs-resync? current)
      {:ok false
       :state :failed
       :reason :needs-resync
       :error {:code "NEEDS_RESYNC"
               :message "board must be resynced from file"}}

      :else
      {:ok true})))

(defn- settle-denied*! [state ticket-id admission]
  (let [target (:state admission)]
    (when (contains? #{:cancelled :failed :unknown} target)
      (settle*! state ticket-id target
                (merge (error-detail (:error admission))
                       {:reason (:reason admission)
                        :aborted? (= target :cancelled)})))))

(defn ticket
  [station ticket-id]
  (get-in @(state-of station) [:tickets ticket-id]))

(defn ticket-state
  [station ticket-id]
  (get-in @(state-of station) [:tickets ticket-id :state]))

(defn tickets
  [station]
  (:tickets @(state-of station)))

(defn epoch-current?
  [station epoch]
  (let [current @(state-of station)]
    (and (not (:aborted? current))
         (= epoch (:epoch current)))))

(defn ticket-current?
  [station ticket-id]
  (let [current @(state-of station)
        ticket (get-in current [:tickets ticket-id])]
    (boolean
     (and ticket
          (not (ticket-terminal? (:state ticket)))
          (not (:aborted? ticket))
          (not (:aborted? current))
          (= (:epoch ticket) (:epoch current))))))

(defn snapshot
  [station]
  (let [current @(state-of station)
        tickets (:tickets current)
        states (frequencies (map :state (vals tickets)))]
    {:board (:board current)
     :committed-board (:board current)
     :board-version (:committed-version current)
     :committed-version (:committed-version current)
     :epoch (:epoch current)
     :aborted? (:aborted? current)
     :busy? (:busy? current)
     :needs-resync? (:needs-resync? current)
     :ticket-count (count tickets)
     :ticket-states (into {}
                          (map (fn [[ticket-id ticket]]
                                 [ticket-id (:state ticket)]))
                          tickets)
     :counts (into {}
                   (map (fn [[state n]]
                          [(name state) n]))
                   states)
     :transaction-count (:transaction-count current)}))

(defn create-station
  "Build a station from injected capabilities.

  Options:
  - :open-ticket     required, (fn [station ticket] promise)
  - :apply-command   required, pure (fn [board command context] outcome)
  - :initial-board   optional committed board read from file

  An apply outcome is {:ok true :changed? true :board next} or
  {:ok false :error error}. The station owns :board-version; it overwrites the
  version supplied by the command function."
  [options]
  (when-not (map? options)
    (throw (ex-info "create-station needs an options object"
                    {:code :INVALID_ARGUMENT})))
  (let [open-ticket (:open-ticket options)
        apply-command (:apply-command options)
        provided (or (:initial-board options) {})
        version (if (integer? (:board-version provided))
                  (:board-version provided)
                  0)]
    (when-not (fn? open-ticket)
      (throw (ex-info "create-station needs :open-ticket"
                      {:code :INVALID_ARGUMENT :field :open-ticket})))
    (when-not (fn? apply-command)
      (throw (ex-info "create-station needs :apply-command"
                      {:code :INVALID_ARGUMENT :field :apply-command})))
    (when-not (and (map? provided) (not (neg? version)))
      (throw (ex-info "initial board needs a non-negative integer board-version"
                      {:code :INVALID_ARGUMENT :field :initial-board})))
    {:state (atom {:board (assoc provided :board-version version)
                   :committed-version version
                   :epoch 0
                   :aborted? false
                   :busy? false
                   :needs-resync? false
                   :next-ticket-id 1
                   :tickets {}
                   :write-tail (js/Promise.resolve nil)
                   :transaction-count 0})
     :open-ticket open-ticket
     :apply-command apply-command}))

(defn begin-ticket!
  "Move a pending ticket to running unless it is stale, aborted, or terminal.
  Settles denied tickets and returns the admission map."
  [station ticket-id]
  (in-transaction!
   station
   (fn [state]
     (let [admission (admission* state ticket-id)]
       (if (:ok admission)
         (do
           (swap! state update-in [:tickets ticket-id]
                  merge {:state :running
                         :started-at (now-ms)})
           {:ok true :state :running :ticket-id ticket-id})
         (do
           (settle-denied*! state ticket-id admission)
           {:ok false
            :state (:state admission)
            :reason (:reason admission)
            :error (:error admission)}))))))

(defn check-ticket!
  "Recheck a running ticket inside the serialized write slot."
  [station ticket-id]
  (in-transaction!
   station
   (fn [state]
     (let [admission (admission* state ticket-id)
           ticket (get-in @state [:tickets ticket-id])]
       (if (and (:ok admission) (= :running (:state ticket)))
         {:ok true :state :running}
         (let [denied (if (:ok admission)
                        {:ok false
                         :state :failed
                         :reason :not-running
                         :error {:code "NOT_RUNNING"
                                 :message "ticket is not running"}}
                        admission)]
           (settle-denied*! state ticket-id denied)
           {:ok false
            :state (:state denied)
            :reason (:reason denied)
            :error (:error denied)}))))))

(defn plan-board!
  "Apply the ticket command to the committed board without persistence.
  Returns {:ok true :changed? true :board next :version n} or an error map."
  [station ticket-id]
  (in-transaction!
   station
   (fn [state]
     (let [current @state
           ticket (get-in current [:tickets ticket-id])]
       (cond
         (nil? ticket)
         {:ok false
          :error {:code "UNKNOWN_TICKET" :message "ticket does not exist"}}

         (not= :running (:state ticket))
         {:ok false
          :error {:code "NOT_RUNNING" :message "ticket is not running"}}

         (:write-started? ticket)
         {:ok false
          :error {:code "WRITE_ALREADY_STARTED"
                  :message "ticket already started writing"}}

         (:needs-resync? current)
         {:ok false
          :error {:code "NEEDS_RESYNC"
                  :message "board must be resynced from file"}}

         (or (:aborted? ticket)
             (:aborted? current)
             (not= (:epoch ticket) (:epoch current)))
         {:ok false
          :error {:code "STALE_EPOCH"
                  :message "ticket epoch is stale"}}

         :else
         (try
           (let [version (inc (:committed-version current))
                 result ((:apply-command station)
                         (:board current)
                         (:command ticket)
                         {:ticket-id ticket-id
                          :epoch (:epoch ticket)
                          :version version})
                 plan
                 (if-not (and (map? result) (:ok result))
                   {:ok false
                    :error (or (:error result)
                               {:code "INVALID_COMMAND"
                                :message "apply-command rejected the command"})}
                   (let [changed? (if (contains? result :changed?)
                                    (boolean (:changed? result))
                                    (not= (:board result) (:board current)))]
                     (if-not changed?
                       {:ok true
                        :changed? false
                        :board (:board current)
                        :version (:committed-version current)
                        :result result}
                       (if-not (map? (:board result))
                         {:ok false
                          :error {:code "INVALID_BOARD"
                                  :message "apply-command did not return a board"}}
                         {:ok true
                          :changed? true
                          :board (assoc (:board result) :board-version version)
                          :version version
                          :result result}))))]
             (when (:ok plan)
               (swap! state assoc-in [:tickets ticket-id :plan] plan)
               (when (:changed? plan)
                 (swap! state assoc-in [:tickets ticket-id :planned-version] version)))
             plan)
           (catch :default error
             {:ok false :error error})))))))

(defn mark-write-started!
  "Record that the ticket is about to call the non-idempotent persist step.
  After this point a cancellation no longer suppresses an already-issued write."
  [station ticket-id version]
  (in-transaction!
   station
   (fn [state]
     (let [current @state
           ticket (get-in current [:tickets ticket-id])]
       (cond
         (not= :running (:state ticket))
         {:ok false
          :error {:code "NOT_RUNNING" :message "ticket is not running"}}

         (:write-started? ticket)
         {:ok false
          :error {:code "WRITE_ALREADY_STARTED"
                  :message "ticket already started writing"}}

         (not (integer? version))
         {:ok false
          :error {:code "INVALID_VERSION" :message "write needs a version"}}

         :else
         (do
           (swap! state update-in [:tickets ticket-id]
                  merge {:write-started? true
                         :version version})
           {:ok true :state :running :version version}))))))

(defn apply-written!
  "Commit a completed write. This runs after persistence succeeded, so a
  cancellation that arrived while the write was in flight still records
  applied: the file changed and the station does not pretend otherwise.
  A write that never started cannot pass this gate."
  [station ticket-id board version]
  (in-transaction!
   station
   (fn [state]
     (let [current @state
           ticket (get-in current [:tickets ticket-id])
           committed (:committed-version current)]
       (cond
         (nil? ticket)
         {:ok false
          :state :failed
          :error {:code "UNKNOWN_TICKET" :message "ticket does not exist"}}

         (not= :running (:state ticket))
         {:ok false
          :state (:state ticket)
          :error {:code "ALREADY_SETTLED"
                  :message "ticket is not running"}}

         (not (:write-started? ticket))
         {:ok false
          :state :running
          :error {:code "WRITE_NOT_STARTED"
                  :message "ticket never started a durable write"}}

         (not (and (map? board) (integer? version)))
         {:ok false
          :state :running
          :error {:code "INVALID_BOARD"
                  :message "written board or version is invalid"}}

         (not= version (inc committed))
         (do
           (settle*! state ticket-id :unknown
                     (merge (error-detail
                             {:code "NON_MONOTONIC"
                              :message "board version is not monotonic"})
                            {:reason :non-monotonic
                             :uncertain? true}))
           (swap! state assoc :needs-resync? true)
           {:ok false
            :state :unknown
            :error {:code "NON_MONOTONIC"
                    :message "board version is not monotonic"}})

         :else
         (do
           (swap! state assoc
                  :board (assoc board :board-version version)
                  :committed-version version)
           (settle*! state ticket-id :applied
                     {:version version
                      :durable? true
                      :changed? true})
           {:ok true :state :applied :version version}))))))

(defn fail-ticket!
  [station ticket-id error]
  (in-transaction!
   station
   (fn [state]
     (let [detail (error-detail error)]
       (if (settle*! state ticket-id :failed detail)
         {:ok true
          :state :failed
          :error (:error detail)
          :error-name (:error-name detail)}
         {:ok false
          :state (get-in @state [:tickets ticket-id :state])
          :error {:code "ALREADY_SETTLED"
                  :message "ticket is already terminal"}})))))

(defn cancel-ticket!
  [station ticket-id reason]
  (in-transaction!
   station
   (fn [state]
     (if (settle*! state ticket-id :cancelled
                   {:reason reason
                    :aborted? true
                    :error "cancelled"
                    :error-name "CANCELLED"})
       {:ok true :state :cancelled}
       {:ok false
        :state (get-in @state [:tickets ticket-id :state])
        :error {:code "ALREADY_SETTLED"
                :message "ticket is already terminal"}}))))

(defn unknown-ticket!
  "Record an uncertain durable outcome. The station blocks new writes until the
  board is read back from file and resynced."
  [station ticket-id error]
  (in-transaction!
   station
   (fn [state]
     (let [detail (merge (error-detail error)
                         {:uncertain? true
                          :reason :unknown})]
       (if (settle*! state ticket-id :unknown detail)
         (do
           (swap! state assoc :needs-resync? true)
           {:ok true
            :state :unknown
            :error (:error detail)
            :error-name (:error-name detail)})
         {:ok false
          :state (get-in @state [:tickets ticket-id :state])
          :error {:code "ALREADY_SETTLED"
                  :message "ticket is already terminal"}})))))

(defn enqueue-write!
  "Append one write thunk to the station write chain and return its promise.
  The station only manipulates promises; the ticket is the caller that waits."
  [station ticket-id f]
  (in-transaction!
   station
   (fn [state]
     (let [previous (:write-tail @state)
           run (-> previous
                   (.catch (fn [_] nil))
                   (.then (fn [_] (f))))]
       (swap! state assoc :write-tail (.catch run (fn [_] nil)))
       run))))

(defn mark-applied!
  "Settle a no-op command without touching the board file."
  [station ticket-id version changed?]
  (in-transaction!
   station
   (fn [state]
     (let [ticket (get-in @state [:tickets ticket-id])]
       (if (and ticket (= :running (:state ticket)))
         (do
           (settle*! state ticket-id :applied
                     {:version version
                      :durable? false
                      :changed? (boolean changed?)})
           {:ok true :state :applied :version version})
         {:ok false
          :state (:state ticket)
          :error {:code "ALREADY_SETTLED"
                  :message "ticket is not running"}})))))

(defn cancel!
  "Gatekeeper for cancellation. Pending tickets become cancelled at once.
  Running tickets carry :aborted? and settle themselves at their next check.
  Returns synchronously: no ticket is created for a cancellation."
  ([station]
   (cancel! station :cancel))
  ([station reason]
   (in-transaction!
    station
    (fn [state]
      (let [epoch (inc (:epoch @state))
            outcome (atom {:cancelled [] :running []})]
        (swap! state assoc :epoch epoch :aborted? true)
        (doseq [[ticket-id ticket] (:tickets @state)]
          (when-not (ticket-terminal? (:state ticket))
            (swap! state update-in [:tickets ticket-id] assoc :aborted? true)
            (if (= :pending (:state ticket))
              (do
                (settle*! state ticket-id :cancelled
                          {:reason reason
                           :aborted? true
                           :error "cancelled before start"
                           :error-name "CANCELLED"})
                (swap! outcome update :cancelled conj ticket-id))
              (swap! outcome update :running conj ticket-id))))
        (merge {:ok true :epoch epoch} @outcome))))))

(defn resync!
  "Replace memory with the board read from file and clear an uncertain state.
  Active tickets are invalidated. The caller must ensure no write is still
  in flight; this is the crash-recovery gate, not a retry mechanism."
  [station board]
  (in-transaction!
   station
   (fn [state]
     (let [version (when (map? board) (:board-version board))
           committed (:committed-version @state)]
       (cond
         (not (and (map? board)
                   (integer? version)
                   (not (neg? version))))
         {:ok false
          :error {:code "INVALID_BOARD"
                  :message "resync needs a board with integer board-version"}}

         (< version committed)
         {:ok false
          :error {:code "STALE_CONTROL"
                  :message "resync board is older than committed memory"}}

         :else
         (do
           (swap! state assoc
                  :epoch (inc (:epoch @state))
                  :aborted? true)
           (doseq [[ticket-id ticket] (:tickets @state)]
             (when-not (ticket-terminal? (:state ticket))
               (swap! state update-in [:tickets ticket-id] assoc :aborted? true)
               (when (= :pending (:state ticket))
                 (settle*! state ticket-id :cancelled
                           {:reason :resync
                            :aborted? true
                            :error "cancelled by resync"
                            :error-name "CANCELLED"}))))
           (swap! state assoc
                  :board board
                  :committed-version version
                  :needs-resync? false
                  :write-tail (js/Promise.resolve nil))
           {:ok true :board-version version}))))))

(defn submit!
  "Gatekeeper for one command. Memory is updated first (ticket record and
  generation), then the injected ticket capability is called in tail position.
  A new submission after cancellation starts a new generation; older tickets
  stay invalid because their epoch no longer matches."
  ([station command]
   (submit! station command {}))
  ([station command options]
   (let [ticket-id (atom nil)]
     (in-transaction!
      station
      (fn [state]
        (when (:aborted? @state)
          (swap! state assoc :aborted? false))
        (let [current @state
              id (str "t" (:next-ticket-id current))
              epoch (:epoch current)
              record {:id id
                      :state :pending
                      :epoch epoch
                      :aborted? false
                      :command command
                      :request-id (:request-id options)
                      :kind (:kind options)
                      :created-at (now-ms)
                      :write-started? false}]
          (swap! state (fn [next-state]
                         (-> next-state
                             (update :next-ticket-id inc)
                             (update :transaction-count inc)
                             (assoc-in [:tickets id] record))))
          (reset! ticket-id id))))
     (try
       ((:open-ticket station) station (ticket station @ticket-id))
       (catch :default error
         (fail-ticket! station @ticket-id error)
         (js/Promise.reject error))))))

;; ===== Ticket (asynchronous, the only await area) =====

(defn- ticket-result [station ticket-id]
  (let [record (ticket station ticket-id)]
    {:ok (boolean (and record (= :applied (:state record))))
     :state (:state record)
     :ticket-id ticket-id
     :version (:version record)
     :error (:error record)
     :error-name (:error-name record)
     :receipt (get-in record [:plan :result :receipt])
     :board-version (get-in record [:plan :result :board-version])
     :replayed (or (get-in record [:plan :result :replayed])
                   (get-in record [:plan :result :receipt :replayed]))
     :aborted? (boolean (:aborted? record))
     :durable? (boolean (:durable? record))}))

(defn- classify-write-result! [station ticket-id board version result]
  (cond
    (or (nil? result) (true? result) (= :ok result))
    (apply-written! station ticket-id board version)

    (false? result)
    (fail-ticket! station ticket-id
                  {:code "WRITE_FAILED"
                   :message "board write failed"})

    (map? result)
    (cond
      (true? (:ok result))
      (apply-written! station ticket-id board version)

      (:uncertain result)
      (unknown-ticket! station ticket-id
                       (or (:error result)
                           {:code "WRITE_UNCERTAIN"
                            :message "board write outcome is uncertain"}))

      :else
      (fail-ticket! station ticket-id
                    (or (:error result)
                        {:code "WRITE_FAILED"
                         :message "board write failed"})))

    :else
    (fail-ticket! station ticket-id
                  {:code "WRITE_FAILED"
                   :message "unexpected persist result"})))

(defn ^:async run-ticket
  "Ticket capability. Persist is (fn [ticket board] promise) and owns the only
  real I/O. The ticket checks epoch and aborted before the serialized write,
  records that a write started, and settles one terminal state."
  [station ticket-value persist!]
  (let [ticket-id (:id ticket-value)]
    (try
      (if-not (:ok (begin-ticket! station ticket-id))
        (ticket-result station ticket-id)
        (do
          (let [work
                (enqueue-write!
                 station
                 ticket-id
                 (fn []
                   (let [admission (check-ticket! station ticket-id)]
                     (if-not (:ok admission)
                       (js/Promise.resolve (ticket-result station ticket-id))
                       (let [plan (plan-board! station ticket-id)]
                         (if-not (:ok plan)
                           (js/Promise.resolve
                            (do
                              (fail-ticket! station ticket-id (:error plan))
                              (ticket-result station ticket-id)))
                           (if (false? (:changed? plan))
                             (js/Promise.resolve
                              (do
                                (mark-applied! station ticket-id
                                               (:version plan) false)
                                (ticket-result station ticket-id)))
                             (let [started (mark-write-started!
                                            station ticket-id (:version plan))]
                               (if-not (:ok started)
                                 (js/Promise.resolve
                                  (do
                                    (fail-ticket! station ticket-id
                                                  (:error started))
                                    (ticket-result station ticket-id)))
                                 (-> (try
                                       (js/Promise.resolve
                                        (persist! (ticket station ticket-id)
                                                  (:board plan)))
                                       (catch :default error
                                         (js/Promise.reject error)))
                                     (.then
                                      (fn [result]
                                        (classify-write-result!
                                         station ticket-id
                                         (:board plan) (:version plan)
                                         result)
                                        (ticket-result station ticket-id)))
                                     (.catch
                                      (fn [error]
                                        (if (uncertain-error? error)
                                          (unknown-ticket! station ticket-id error)
                                          (fail-ticket! station ticket-id error))
                                        (ticket-result station ticket-id)))))))))))))]
            (await work)
            (when-not (ticket-terminal? (ticket-state station ticket-id))
              (fail-ticket! station ticket-id
                            {:code "TICKET_DID_NOT_SETTLE"
                             :message "ticket ended without a terminal state"}))
            (ticket-result station ticket-id))))
      (catch :default error
        (if (:write-started? (ticket station ticket-id))
          (unknown-ticket! station ticket-id error)
          (fail-ticket! station ticket-id error))
        (ticket-result station ticket-id)))))

(defn make-ticket-runner
  "Bind a persist capability to the ticket function for one-hop wiring."
  [persist!]
  (when-not (fn? persist!)
    (throw (ex-info "make-ticket-runner needs a persist function"
                    {:code :INVALID_ARGUMENT :field :persist!})))
  (fn [station ticket]
    (run-ticket station ticket persist!)))
