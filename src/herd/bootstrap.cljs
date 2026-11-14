(ns herd.bootstrap
  (:require
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [herd.ufss :as ufss]
   [nbb.classpath :as cp]
   [nbb.core :as nbb]))

(defn- ^:async file-exists? [target]
  (-> (.access fs target)
      (.then (fn [_] true))
      (.catch (fn [_] false))))

(defn- ^:async classpath-plugin-src []
  (let [delimiter (.-delimiter path)
        entries (->> (.split (cp/get-classpath) delimiter)
                     (remove (fn [entry] (.includes entry ".herd")))
                     vec)]
    (loop [index 0]
      (if (>= index (count entries))
        nil
        (let [entry (nth entries index)]
          (if (await (file-exists? (path/join entry "herd" "ufss.cljs")))
            entry
            (recur (inc index))))))))

(defn- ^:async plugin-src []
  (or (let [root (.-__herdPluginSrc js/globalThis)]
        (when (string? root) root))
      (await (classpath-plugin-src))
      (path/join (js/process.cwd) "src")))

(defn- ^:async module-path [name]
  (path/join (await (plugin-src)) "herd" (str name ".cljs")))

(defn- ^:async fresh?
  "True when the preprocessed file is at least as new as its source."
  [source target]
  (-> (.stat fs source)
      (.then
        (fn [source-stat]
          (-> (.stat fs target)
              (.then (fn [target-stat]
                       (<= (.-mtimeMs source-stat) (.-mtimeMs target-stat))))
              (.catch (fn [_] false)))))
      (.catch (fn [_] false))))

(defn- ^:async preprocess! [root name]
  (let [source-path (await (module-path name))
        target (path/join root "herd" (str name ".cljs"))]
    (if (await (fresh? source-path target))
      false
      (let [source (await (.readFile fs source-path "utf8"))]
        (await (.mkdir fs (path/dirname target) #js {:recursive true}))
        (await (.writeFile fs target (ufss/unwrap source) "utf8"))
        true))))

(def ^:private modules
  ["clock" "prompts" "handoff" "highlight" "ui" "sandbox" "repl" "stages/parsers" "stages/tenure"
   "stages/disclosures" "stages/paths" "stages/mission" "util/atomic_write"
   "stages/store" "stages/attach" "stages/review" "stages/approval"
   "stages/scores" "stages/audit" "stages/report" "stages/gates" "gates_host"
   "swarm/edn" "swarm/model" "swarm/ledger" "swarm/actors" "swarm/tasks"
   "swarm/commands" "swarm/token" "swarm/kernel" "swarm/store" "swarm/apply"
   "swarm/tools" "swarm/runner" "swarm/auditors" "system"])

(defn ^:async main []
  (let [started (.now js/Date)
        root (path/join (js/process.cwd) ".herd" "eval" "herd-src")
        source-root (await (plugin-src))
        written (atom 0)
        skipped (atom 0)]
    (aset js/globalThis "__herdPluginSrc" source-root)
    (await (.mkdir fs (path/join root "herd") #js {:recursive true}))
    (await (nbb/load-file (await (module-path "ufss"))))
    (doseq [name modules]
      (if (await (preprocess! root name))
        (swap! written inc)
        (swap! skipped inc)))
    (cp/add-classpath root)
    (doseq [name modules]
      (await (nbb/load-file (path/join root "herd" (str name ".cljs")))))
    (if (await (preprocess! root "main"))
      (swap! written inc)
      (swap! skipped inc))
    (await (nbb/load-file (path/join root "herd" "main.cljs")))
    (aset js/globalThis "__herdPreprocessStats"
          (clj->js {:modules (inc (count modules))
                    :written @written
                    :skipped @skipped
                    :ms (- (.now js/Date) started)}))))
(main)