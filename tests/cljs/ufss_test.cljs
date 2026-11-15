(ns cljs.ufss-test
  (:require
   [clojure.string :as str]
   [herd.prompts :as prompts]
   [herd.test :as t]
   [herd.ufss :as u]))

(defn- fs [] ((.-__herdRequire js/globalThis) "node:fs"))
(defn- read-source [name]
  ((.-readFileSync (fs)) (str "src/herd/" name) "utf8"))

(def source-files
  ["prompts.cljs" "sandbox.cljs" "repl.cljs" "main.cljs" "ufss.cljs" "ui.cljs"
   "bootstrap.cljs" "stages/parsers.cljs" "stages/tenure.cljs" "stages/disclosures.cljs"
   "stages/scores.cljs" "stages/paths.cljs" "stages/mission.cljs" "stages/attach.cljs"
   "stages/approval.cljs" "stages/store.cljs" "stages/report.cljs"
   "stages/audit.cljs" "stages/gates.cljs" "gates_host.cljs" "util/atomic_write.cljs"
   "system.cljs"])

(t/describe "CLJS UFSS"
  (fn []
    (t/it "round-trips arbitrary strings"
      (fn []
        (t/to-be
         (every? (fn [value] (= value (u/read (u/canonical (pr-str value)))))
                 ["abc" "a\"b" "line1\nline2" "a\"\"\"b" "back\\slash" "tab\there"])
         true)))
        (t/it "accepts a closing fence with trailing syntax"
      (fn []
        (let [fence (str (apply str (repeat 2 "#")) "\"\"\"")
              close (str "\"\"\"" (apply str (repeat 2 "#")))
              text (str "{:a " fence "\nx\n" close "}")]
          (t/to-be (get (u/read text) :a) "x"))))
    (t/it "accepts short-indented body lines without error"
      (fn []
        (let [fence (str (apply str (repeat 2 "#")) "\"\"\"")
              close (str "\"\"\"" (apply str (repeat 2 "#")))
              text (u/unwrap (str fence "\n  ok\n bad\n  " close))]
          (t/to-contain text "ok")
          (t/to-contain text "bad"))))
(t/it "keeps the lenient prompt note"
      (fn []
        (t/to-be (> (count prompts/ufss-prompt-note) 3000) true)
        (t/to-be (str/includes? prompts/ufss-prompt-note "may share its line") true)
        (t/to-be (str/includes? prompts/ufss-prompt-note "stand alone") false)))
    (t/it "reads every source string through the official reader"
      (fn []
        (doseq [name source-files]
          (let [source (read-source name)]
            (t/to-be
             (every? (fn [value] (= value (u/read (u/canonical (pr-str value)))))
                     (u/literals source))
             true)))))
    (t/it "keeps every source canonical under the formatter pipeline"
      (fn []
        (doseq [name source-files]
          (let [source (read-source name)]
            (t/to-be (u/canonical source) source)))))
    (t/it "lays out data with cljs.pprint"
      (fn []
        (let [value (vec (range 40))
              text (u/canonical value)]
          (t/to-be (= value (u/read text)) true)
          (t/to-be (> (count (str/split-lines text)) 1) true))))
    (t/it "escapes control characters canonically without raw control bytes"
      (fn []
        (let [samples [(str (char 0) (char 1) (char 7) (char 8) (char 11) (char 12) (char 27) (char 31) (char 127))
                       (str "line1\n" (char 1) "\nline2")]]
          (doseq [sample samples]
            (let [out (u/canonical {:v sample})]
              (t/to-be (nil? (re-find #"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]" out)) true)
              (t/to-be (= {:v sample} (u/read out)) true))))))))
