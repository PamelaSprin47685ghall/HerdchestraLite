(ns cljs.architecture-test
  (:require
   ["node:fs" :as fs]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.test :as t]))

(def src-root (path/dirname (.-__herdEntryPath js/globalThis)))
(def repo-root (path/join src-root ".."))
(def tests-root (path/join repo-root "tests"))

(defn- walk-files [root pred]
  (mapcat (fn [name]
            (let [target (path/join root name)
                  stat (fs/statSync target)]
              (if (.isDirectory stat)
                (walk-files target pred)
                (when (pred name) [target]))))
          (fs/readdirSync root)))

(defn- relative [target]
  (str/replace (path/relative repo-root target) "\\" "/"))

(defn- source-files []
  (walk-files src-root
              (fn [name] (or (str/ends-with? name ".cljs")
                             (str/ends-with? name ".mjs")))))

(defn- read-all [files]
  (mapv (fn [file] [relative file (fs/readFileSync file "utf8")]) files))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(t/describe "clean-break architecture invariants"
  (fn []
    (t/it "keeps only run-ticket asynchronous in the station service desk"
      (fn []
        (let [source (fs/readFileSync (path/join src-root "herd/station.cljs") "utf8")
              async-defs (mapv second
                               (re-seq #"(?m)^\(defn\s+\^:async\s+([^\s)]+)" source))]
          (same async-defs ["run-ticket"]))))
    (t/it "keeps the bridge layer synchronous and free of awaited tickets"
      (fn []
        (let [files (walk-files (path/join src-root "bridge")
                                #(str/ends-with? % ".cljs"))
              offenders (filterv (fn [file]
                                   (boolean (re-find #"\b(async|await)\b"
                                                     (fs/readFileSync file "utf8"))))
                                 files)]
          (same (mapv relative offenders) []))))
    (t/it "keeps system gatekeepers synchronous and ticket-shaped async helpers explicit"
      (fn []
        (let [source (fs/readFileSync (path/join src-root "herd/system.cljs") "utf8")
              gatekeepers ["gate-execute!" "s5-review!" "audit-execute!"
                           "invoke-service" "before-agent-start!" "session-start!"
                           "herd-command!"]
              async-signatures (filterv (fn [name]
                                          (or (str/includes? source (str "(defn ^:async " name))
                                              (str/includes? source (str "(defn- ^:async " name))))
                                        gatekeepers)]
          (same async-signatures []))))
    (t/it "removes legacy board entry names and keeps board writes on station"
      (fn []
        (let [sources (read-all (source-files))
              legacy ["apply-board!" "execute-tool!" "swarm.apply" "Mission slug:"]
              hits (vec (for [[file _ text] sources
                              marker legacy
                              :when (str/includes? text marker)]
                          [file marker]))
              board (fs/readFileSync (path/join src-root "herd/swarm/board.cljs") "utf8")]
          (same hits [])
          (t/to-be (str/includes? board "station/submit!") true)
          (t/to-be (str/includes? board "submit-board-command!") true))))
    (t/it "keeps exactly one production and one test bootstrap .mjs"
      (fn []
        (let [src-mjs (sort (mapv relative (walk-files src-root #(str/ends-with? % ".mjs"))))
              test-mjs (sort (mapv relative (walk-files tests-root #(str/ends-with? % ".mjs"))))]
          (same src-mjs ["src/clj-main.mjs"])
          (same test-mjs ["tests/cljs-suite.test.mjs"]))))))

