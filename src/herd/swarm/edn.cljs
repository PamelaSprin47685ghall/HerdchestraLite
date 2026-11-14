(ns herd.swarm.edn
  (:require
   [clojure.string :as string]))

(defn text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn read-field [object & names]
  (when (map? object)
    (loop [entries (seq names)]
      (when entries
        (let [name (first entries)]
          (if (and (contains? object name) (some? (get object name)))
            (get object name)
            (recur (next entries))))))))

(defn first-defined [& values]
  (loop [entries (seq values)]
    (when entries
      (if (some? (first entries))
        (first entries)
        (recur (next entries))))))

(defn unique-values [values]
  (vec (distinct values)))

(defn canonical [value]
  (cond
    (map? value)
    (str "{"
         (string/join ","
                      (map (fn [[k v]] (str (canonical k) ":" (canonical v)))
                           (sort-by (fn [[k _]] (str k)) value)))
         "}")
    (set? value)
    (str "#{"
         (string/join "," (map canonical (sort-by str value)))
         "}")
    (sequential? value)
    (str "[" (string/join "," (map canonical value)) "]")
    :else (pr-str value)))

(defn digest-of [value]
  (let [crypto (js/require "node:crypto")]
    (.digest (.update (.createHash crypto "sha256") (canonical value) "utf8") "hex")))

(defn normalize-key [key]
  (cond
    (string? key) (keyword (string/replace key "_" "-"))
    (keyword? key) (keyword (string/replace (name key) "_" "-"))
    :else key))

(defn normalize-keys [value]
  (cond
    (map? value)
    (into {} (map (fn [[key entry]] [(normalize-key key) (normalize-keys entry)]) value))

    (sequential? value)
    (mapv normalize-keys value)

    :else value))