(ns cljs.board-store-test
  (:require
   [clojure.string :as str]
   [herd.swarm.board :as apply]
   [herd.swarm.store :as store]
   [herd.swarm.token :as token]
   [herd.test :as t]
   [promesa.core :as p]))

(def fs ((.-__herdRequire js/globalThis) "node:fs"))
(def os ((.-__herdRequire js/globalThis) "node:os"))
(def path ((.-__herdRequire js/globalThis) "node:path"))

(defn- root []
  (.mkdtempSync fs (.join path (.tmpdir os) "cljs-board-store-m-")))

(defn- base [root]
  (str root "/herd/demo/"))

(t/describe "CLJS board store and two-phase apply"
  (fn []
    (t/it "persists board, events and checkpoint through the file store"
      (fn []
        (let [root (root)
              handle (store/open-board root "demo")]
          (p/let [_ (store/initialize-board! handle)
                  r1 (apply/apply-board! {:board handle
                                          :command {:type "register_actor"
                                                    :agentId "A" :slotId "S1"}
                                          :request-id "r1" :turn-id "boot"})
                  r2 (apply/apply-board! {:board handle
                                          :command {:type "add_tasks"
                                                    :tasks [{:goal "job"
                                                             :remaining-work "work"
                                                             :done-when "done"}]}
                                          :actor "A" :request-id "r2" :turn-id "add"})
                  board (store/read-board handle)
                  base (base root)
                  events-text (.readFileSync fs (str base "events.jsonl") "utf8")
                  checkpoint-text (.readFileSync fs (str base "checkpoint.edn") "utf8")]
            (t/to-be (:ok r1) true)
            (t/to-be (:ok r2) true)
            (t/to-be (:board-version board) 2)
            (t/to-be (count (:tasks board)) 1)
            (t/to-be (get-in board [:actors "A" :agent-id]) "A")
            (t/to-be (>= (count (remove str/blank? (str/split-lines events-text))) 2) true)
            (t/to-be (str/includes? checkpoint-text "board-version") true)))))
    (t/it "replays a completed request without a second version or event"
      (fn []
        (let [root (root)
              handle (store/open-board root "demo")]
          (p/let [_ (store/initialize-board! handle)
                  command {:type "register_actor" :agentId "A" :slotId "S1"}
                  r1 (apply/apply-board! {:board handle :command command
                                          :request-id "same" :turn-id "boot"})
                  r2 (apply/apply-board! {:board handle :command command
                                          :request-id "same" :turn-id "boot"})
                  board (store/read-board handle)
                  events-text (.readFileSync fs (str (base root) "events.jsonl") "utf8")]
            (t/to-be (:ok r1) true)
            (t/to-be (:replayed r2) true)
            (t/to-be (:board-version board) 1)
            (t/to-be (= (:receipt r1) (:receipt r2)) true)
            (t/to-be (count (remove str/blank? (str/split-lines events-text))) 1)))))
    (t/it "refuses to rebuild a missing board while the ledger still exists"
      (fn []
        (let [root (root)
              handle (store/open-board root "demo")]
          (p/let [_ (store/initialize-board! handle)
                  _ (apply/apply-board! {:board handle
                                         :command {:type "register_actor"
                                                   :agentId "A" :slotId "S1"}
                                         :request-id "r1" :turn-id "boot"})
                  _ (.unlinkSync fs (str (base root) "board.edn"))
                  r2 (apply/apply-board! {:board handle
                                          :command {:type "record_input" :text "new"}
                                          :request-id "r2" :turn-id "user"})]
            (t/to-be (:ok r2) false)
            (t/to-be (name (get-in r2 [:error :code])) "STALE_CONTROL")))))
    (t/it "never overwrites a corrupt board during initialize"
      (fn []
        (let [root (root)
              corrupt (.join path root "herd/demo/board.edn")]
          (.mkdirSync fs (.dirname path corrupt) #js {:recursive true})
          (.writeFileSync fs corrupt "{:board-version 1 :tasks oops")
          (let [before (.readFileSync fs corrupt "utf8")
                handle (store/open-board root "demo")]
            (p/let [out (-> (store/initialize-board! handle)
                            (.then (fn [_] #js {:ok true}))
                            (.catch (fn [error]
                                      #js {:ok false
                                           :code (:code (ex-data error))})))]
              (t/to-be (aget out "ok") false)
              (t/to-be (name (aget out "code")) "STALE_CONTROL")
              (t/to-be (.readFileSync fs corrupt "utf8") before))))))
    (t/it "serializes two irreversible take attempts into one win and one loss"
      (fn []
        (let [root (root)
              handle (store/open-board root "demo")]
          (p/let [_ (store/initialize-board! handle)
                  _ (apply/apply-board! {:board handle
                                         :command {:type "register_actor"
                                                   :agentId "A" :slotId "S1"}
                                         :request-id "r1" :turn-id "boot"})
                  _ (apply/apply-board! {:board handle
                                         :command {:type "register_actor"
                                                   :agentId "B" :slotId "S2"}
                                         :request-id "r2" :turn-id "boot"})
                  _ (apply/apply-board! {:board handle
                                         :command {:type "add_tasks"
                                                   :tasks [{:goal "token"
                                                            :remaining-work "run"
                                                            :done-when "green"
                                                            :needs-token true}]}
                                         :actor "A" :request-id "r3" :turn-id "add"})
                  take-a (apply/apply-board! {:board handle
                                              :command {:type "take_or_die"
                                                        :confirm token/take-or-die-confirmation
                                                        :handoff-markdown "A handoff"}
                                              :actor "A" :request-id "take-a" :turn-id "take"})
                  take-b (apply/apply-board! {:board handle
                                              :command {:type "take_or_die"
                                                        :confirm token/take-or-die-confirmation
                                                        :handoff-markdown "B handoff"}
                                              :actor "B" :request-id "take-b" :turn-id "take"})
                  board (store/read-board handle)]
            (t/to-be (:ok take-a) true)
            (t/to-be (name (get-in take-a [:receipt :outcome])) "attempt-won")
            (t/to-be (:ok take-b) true)
            (t/to-be (name (get-in take-b [:receipt :outcome])) "attempt-lost")
            (t/to-be (get-in board [:token-slot :holder-id]) "A")
            (t/to-be (name (get-in board [:actors "B" :life-state])) "dead")
            (t/to-be (:board-version board) 7))))))
)