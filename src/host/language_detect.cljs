(ns host.language-detect
  (:require
   [clojure.string :as str]))

(def ^:private detect-languages
  ["clojure" "javascript" "typescript" "json" "bash" "markdown" "xml" "yaml" "sql"])

(def ^:private host-language
  {"clojure" "clojure"
   "javascript" "javascript"
   "typescript" "typescript"
   "json" "json"
   "bash" "bash"
   "markdown" "markdown"
   "xml" "html"
   "yaml" "yaml"
   "sql" "sql"})

(defn make-language-detector [hljs]
  (fn [text]
    (when (and (string? text) (pos? (count (str/trim text))))
      (let [result (.highlightAuto hljs text (clj->js detect-languages))]
        (get host-language (.-language result))))))

(defn load-language-detector [require-fn]
  (let [hljs (require-fn "highlight.js/lib/core")]
    (doseq [language-name detect-languages]
      (let [language (require-fn (str "highlight.js/lib/languages/" language-name))]
        (.registerLanguage hljs language-name (or (.-default language) language))))
    (make-language-detector hljs)))
