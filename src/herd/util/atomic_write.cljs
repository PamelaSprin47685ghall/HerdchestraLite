(ns herd.util.atomic-write
  (:require
   ["node:crypto" :as crypto]
   ["node:fs/promises" :as fs]
   ["node:path" :as path]
   [herd.ufss :as ufss]))

(defn- invalid [argument expected value]
  (ex-info (str "atomic write requires " argument " to be " expected)
           {:code :INVALID_ARGUMENT
            :argument argument
            :expected expected
            :actual (if (nil? value) "nil" (type value))}))

(defn- data-bytes [data]
  (cond
    (string? data) (js/Buffer.from data "utf8")
    (instance? js/Uint8Array data)
    (js/Buffer.from (.-buffer data) (.-byteOffset data) (.-byteLength data))
    :else (throw (invalid "data" "a string or Uint8Array" data))))

(defn- previous-stat [target]
  (-> (.lstat fs target)
      (.catch (fn [_] nil))))

(defn ^:async write-file-atomic! [dir name data]
  (when-not (and (string? dir) (pos? (count dir)))
    (throw (invalid "dir" "a non-empty string" dir)))
  (when-not (and (string? name) (pos? (count name)))
    (throw (invalid "name" "a non-empty string" name)))
  (let [target (path/resolve dir name)
        target-dir (path/dirname target)
        temp (path/join target-dir (str ".tmp-" (.randomUUID crypto)))
        previous (await (previous-stat target))
        existed (some? previous)
        bytes (data-bytes data)]
    (let [handle (atom nil)
          created (atom false)
          stage (atom "write")]
      (try
        (await (.mkdir fs target-dir #js {:recursive true}))
        (reset! handle (await (.open fs temp "wx" 384)))
        (reset! created true)
        (when (and previous (.isFile previous))
          (await (.chmod @handle (bit-and (.-mode previous) 511))))
        (await (.writeFile @handle bytes))
        (reset! stage "fsync")
        (await (.sync @handle))
        (await (.close @handle))
        (reset! handle nil)
        (reset! stage "rename")
        (await (.rename fs temp target))
        {:path target :existed existed}
        (catch :default error
          (when @handle
            (try (await (.close @handle)) (catch :default _ nil))
            (reset! handle nil))
          (when @created
            (try (await (.rm fs temp #js {:force true})) (catch :default _ nil)))
          (throw (ex-info (str error)
                          {:code (or (:code (ex-data error)) :INVALID_ARGUMENT)
                           :stage @stage
                           :path target
                           :temp temp
                           :cause error})))))))

(defn ^:async write-edn-atomic! [target-path value]
  (when-not (and (string? target-path) (pos? (count target-path)))
    (throw (invalid "path" "a non-empty string" target-path)))
  (let [target (path/resolve target-path)
        text (str (ufss/canonical value) "\n")]
    (await (write-file-atomic! (path/dirname target) (path/basename target) text))))