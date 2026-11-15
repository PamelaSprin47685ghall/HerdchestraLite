(ns cljs.bootstrap-contract-test
  (:require
   ["node:fs" :as fs]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.test :as t]))

(def src-root (path/dirname (.-__herdEntryPath js/globalThis)))

(t/describe "production bootstrap host contract"
  (fn []
    (t/it "keeps the entry thin and host-loadable"
      (fn []
        (let [entry (fs/readFileSync (path/join src-root "clj-main.mjs") "utf8")
              bootstrap (fs/readFileSync (path/join src-root "herd/bootstrap.cljs") "utf8")
              lines (count (str/split-lines entry))
              entry-cljs (fs/readFileSync (path/join src-root "herd/entry.cljs") "utf8")
              host-cljs (fs/readFileSync (path/join src-root "herd/host.cljs") "utf8")]
          (t/to-be (<= lines 50) true)
          (t/to-be (str/includes? entry "export default async function activate") true)
          (t/to-be (str/includes? entry "createRequire(entryPath)") true)
          (t/to-be (str/includes? entry "require(\"nbb\")") true)
          (t/to-be (str/includes? entry "import * as formatter") true)
          (t/to-be (str/includes? entry "import * as nbb") false)
          (t/to-be (str/includes? entry-cljs "(require 'herd.errors 'herd.host 'bridge.command-host 'bridge.hack-context 'herd.main)") true)
          (t/to-be (str/includes? host-cljs "fact (fn [name & [mark-missing]]") true)
          (t/to-be (str/includes? host-cljs "ctx-ui (when ctx") true)
          (t/to-be (str/includes? bootstrap "\"entry\" \"system\"") true))))))
