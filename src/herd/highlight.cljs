(ns herd.highlight
  (:require
   [clojure.string :as str]))

(defn- tui-root []
  (.-__herdTui js/globalThis))

(def ^:private palette
  ["syntaxKeyword" "syntaxFunction" "syntaxString"
   "syntaxNumber" "syntaxType" "syntaxOperator"])

(defn- colored [theme role text]
  (try (.fg theme role text)
       (catch :default _ text)))

(defn- detect-language [text]
  (when-let [detect (.-__herdDetectLanguage js/globalThis)]
    (try (detect text)
         (catch :default _ nil))))

(defn make-highlighter
  "Build the optional highlighter accepted by herd.ufss/canonical.
  Contract: (highlighter text lang) -> ANSI string.
  lang = \"clojure\" for outer code, nil for auto body, :dim for fences,
  [:rainbow depth] for delimiters."
  [theme]
  (when-let [highlight-code (some-> (tui-root) (.-highlightCode))]
    (fn [text lang]
      (cond
        (= lang :accent) (colored theme "accent" text)
        (= lang :dim) (colored theme "dim" text)

        (vector? lang)
        (let [[_ depth] lang]
          (colored theme (nth palette (mod depth (count palette))) text))

        (nil? lang)
        (if-let [detected (detect-language text)]
          (str/join "\n" (array-seq (highlight-code text detected theme)))
          text)

        :else
        (str/join "\n" (array-seq (highlight-code text lang theme)))))))