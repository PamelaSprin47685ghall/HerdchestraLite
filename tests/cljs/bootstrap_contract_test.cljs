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
              lines (count (str/split-lines entry))]
          (t/to-be (<= lines 50) true)
          (t/to-be (str/includes? entry "export default async function activate") true)
          (t/to-be (str/includes? entry "createRequire(entryPath)") true)
          (t/to-be (str/includes? entry "require(\"nbb\")") true)
          (t/to-be (str/includes? entry "import * as formatter") true)
          (t/to-be (str/includes? entry "import * as nbb") false)
          (t/to-be (str/includes? bootstrap "\"native_runner\" \"entry\"") true))))))
