(ns cljs.approval-test
  (:require
   [herd.stages.approval :as approval]
   [herd.test :as t]))

(defn- token [mission-id revision report-sha key]
  (approval/approval-token {:mission-id mission-id :revision revision}
                           report-sha key))

(t/describe "approval token"
  (fn []
    (t/it "is deterministic and binds the mission revision report and key"
      (fn []
        (let [base (token "M1" 1 "report-a" "key-a")]
          (t/to-be (= 64 (count base)) true)
          (t/to-be (= base (token "M1" 1 "report-a" "key-a")) true)
          (t/to-be (not= base (token "M2" 1 "report-a" "key-a")) true)
          (t/to-be (not= base (token "M1" 2 "report-a" "key-a")) true)
          (t/to-be (not= base (token "M1" 1 "report-b" "key-a")) true)
          (t/to-be (not= base (token "M1" 1 "report-a" "key-b")) true))))
    (t/it "rejects a changed mission identity even with the same revision"
      (fn []
        (t/to-be (= (token "M1" 7 "sha" "key") (token "M1" 7 "sha" "key")) true)
        (t/to-be (not= (token "M1" 7 "sha" "key")
                       (token "M9" 7 "sha" "key"))
                 true)))))
