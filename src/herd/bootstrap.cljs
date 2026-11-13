(ns herd.bootstrap
  (:require
   ["node:fs" :as fs]
   ["node:path" :as path]
   [herd.ufss :as ufss]
   [nbb.classpath :as cp]
   [nbb.core :as nbb]))

(defn- module-path [name]
  (path/join (js/process.cwd) "src" "herd" (str name ".cljs")))

(defn- preprocess! [root name]
  (let [target (path/join root "herd" (str name ".cljs"))
        source (fs/readFileSync (module-path name) "utf8")]
    (fs/mkdirSync (path/dirname target) #js {:recursive true})
    (fs/writeFileSync target (ufss/unwrap source))))

(def ^:private modules
  ["prompts" "ariadne" "sandbox" "repl" "stages/parsers"])

(defn ^:async main []
  (let [root (path/join (js/process.cwd) ".herd" "eval" "herd-src")]
    (fs/mkdirSync (path/join root "herd") #js {:recursive true})
    (await (nbb/load-file (module-path "ufss")))
    (doseq [name modules]
      (preprocess! root name))
    (cp/add-classpath root)
    (doseq [name modules]
      (await (nbb/load-file (path/join root "herd" (str name ".cljs")))))
    (preprocess! root "main")
    (await (nbb/load-file (path/join root "herd" "main.cljs")))))

(main)