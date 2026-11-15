(ns cljs.ticket-naming-test
  (:require
   ["node:fs" :as fs]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.test :as t]))

(def src-root (path/dirname (.-__herdEntryPath js/globalThis)))

(t/describe "explicit TicketStation naming"
  (fn []
    (t/it "names gate and station ticket capabilities explicitly"
      (fn []
        (let [gates (fs/readFileSync (path/join src-root "herd/stages/gates.cljs") "utf8")
              board (fs/readFileSync (path/join src-root "herd/swarm/board.cljs") "utf8")
              gate-tickets ["review-ticket!" "attach-ticket!" "ask-user-ticket!"
                            "devops-ticket!" "submit-devops-report-ticket!"
                            "resume-approval-ticket!"]
              missing (filterv #(not (str/includes? gates (str "(defn ^:async " %)))
                               gate-tickets)]
          (t/to-be (count missing) 0)
          (t/to-be (str/includes? gates "(declare resume-approval-ticket!)") true)
          (t/to-be (str/includes? gates "(resume-approval-ticket! settings replay") true)
          (t/to-be (str/includes? board "(defn- ^:async open-station-ticket!") true)
          (t/to-be (str/includes? board "(open-station-ticket! handle)") true)
          (t/to-be (str/includes? board "open-station!") false))))))

