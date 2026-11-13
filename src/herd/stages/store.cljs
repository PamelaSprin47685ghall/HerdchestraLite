(ns herd.stages.store
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [clojure.string :as string]
   [herd.stages.mission :as mission]
   [herd.stages.paths :as paths]
   [herd.ufss :as ufss]
   [herd.util.atomic-write :as atomic]))

(def ^:private slug-pattern #"^[a-z0-9][a-z0-9-]{0,63}$")

(defn- text? [value]
  (and (string? value) (pos? (count (string/trim value)))))

(defn- failure [code message data]
  {:ok false :error (merge {:code code :message message} data)})

(defn- exists? [target]
  (-> (.access fs target)
      (.then (fn [_] true))
      (.catch (fn [_] false))))

(defn ^:async create-mission! [root options]
  (let [root (or root ".")
        slug (:slug options)]
    (if-not (and (string? slug) (re-matches slug-pattern slug))
      (failure :INVALID_ARGUMENT
               "slug must be 1-64 lowercase letters, digits, or hyphens"
               {:field :slug})
      (let [target (path/join root (paths/mission-path-of slug))]
        (if (await (exists? target))
          (failure :SLUG_TAKEN (str "mission already exists: " slug) {:slug slug})
          (let [timestamp (or (:now options) (.toISOString (js/Date.)))
                mission {:mission-id (or (:mission-id options) (.randomUUID crypto))
                         :slug slug
                         :seed (or (:seed options) nil)
                         :created-at timestamp
                         :updated-at timestamp
                         :stage :s1
                         :revision 0
                         :tenure (or (:tenure options)
                                     {:tenure-id (.randomUUID crypto)
                                      :index 1
                                      :started-at timestamp
                                      :ended-at nil})
                         :attach (or (:attach options) {})
                         :barrier nil
                         :approval nil
                         :limits (or (:limits options) {})
                         :settings (or (:settings options) {})}
                valid (mission/validate-mission mission)]
            (if-not (:ok valid)
              valid
              (let [written (await (atomic/write-edn-atomic! target mission))]
                {:ok true
                 :mission mission
                 :path (:path written)
                 :existed (:existed written)}))))))))

(declare read-mission)

(def ^:private protected-keys
  #{:mission-id :slug :revision :created-at :stage :tenure :attach :barrier :approval})

(defn ^:async update-mission! [root slug patch]
  (let [current (await (read-mission root slug))]
    (if-not (:ok current)
      current
      (let [mission (:mission current)
            result (loop [entries (seq patch)
                          next mission
                          error nil]
                     (if (or (nil? entries) error)
                       {:mission next :error error}
                       (let [[key value] (first entries)]
                         (cond
                           (and (nil? value) (protected-keys key))
                           (recur (next entries) next
                                  {:code :INVALID_ARGUMENT
                                   :message (str "mission field " (name key) " cannot be removed")
                                   :field key})

                           (nil? value)
                           (recur (next entries) (dissoc next key) nil)

                           :else
                           (recur (next entries) (assoc next key value) nil)))))]
        (if (:error result)
          {:ok false :error (:error result)}
          (let [timestamp (or (:updated-at patch) (.toISOString (js/Date.)))
                next (assoc (:mission result) :updated-at timestamp)
                valid (mission/validate-mission next)]
            (if-not (:ok valid)
              valid
              (let [written (await (atomic/write-edn-atomic!
                                     (path/join (or root ".") (paths/mission-path-of slug))
                                     next))]
                {:ok true :mission next :path (:path written)}))))))))
(defn ^:async read-mission [root slug]
  (let [target (path/join (or root ".") (paths/mission-path-of slug))]
    (try
      (let [mission (ufss/read (await (.readFile fs target "utf8")))
            valid (mission/validate-mission mission)]
        (if (:ok valid)
          {:ok true :mission mission :path target}
          (assoc valid :path target)))
      (catch :default error
        {:ok false
         :error {:code (or (:code (ex-data error)) :INVALID_ARGUMENT)
                 :message (str error)}
         :path target}))))