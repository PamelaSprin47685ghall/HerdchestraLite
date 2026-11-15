(ns bridge.native-tools
  (:require
   [clojure.string :as str]
   [promesa.core :as p]))

(defonce ^:private storage
  (let [ctor (.-AsyncLocalStorage (js/require "node:async_hooks"))]
    (ctor.)))

(defn with-context [context thunk]
  (.run storage context thunk))

(defn current-context []
  (.getStore storage))

(defn- controller []
  (.-__herdNativeTools js/globalThis))

(defn available?
  ([name] (available? name (current-context)))
  ([name context]
   (let [tools (controller)]
     (boolean (and tools
                   (fn? (.-available tools))
                   ((.-available tools) name context))))))

(defn invoke
  ([name params] (invoke name params #js {} (current-context)))
  ([name params options] (invoke name params options (current-context)))
  ([name params options context]
   (let [tools (controller)]
     (if (and tools (fn? (.-invoke tools)))
       ((.-invoke tools) name params (or options #js {}) context)
       (throw (ex-info "host native tools are unavailable"
                       {:code :HOST_API_MISMATCH :tool name}))))))

(defn text-of [result]
  (cond
    (string? result) result
    (and result (.-content result))
    (->> (array-seq (.-content result))
         (keep (fn [block] (when (= "text" (.-type block)) (.-text block))))
         (str/join ""))
    :else (str result)))

(defn read!
  ([path] (read! path (current-context)))
  ([path context]
   (p/let [result (invoke "read" #js {:path path} #js {} context)]
     (text-of result))))

(defn write!
  ([path content] (write! path content (current-context)))
  ([path content context]
   (invoke "write" #js {:path path :content content} #js {} context)))

(defn wait!
  ([] (wait! (current-context)))
  ([context]
   (invoke "wait" #js {} #js {} context)))

(defn wait-for-job!
  ([job-id] (wait-for-job! job-id (current-context)))
  ([job-id context]
   (p/loop [attempt 0]
     (if (>= attempt 4)
       nil
       (p/let [result (wait! context)
               details (when result (.-details result))
               jobs (when details (.-jobs details))
               done? (boolean
                       (some (fn [job]
                               (and job
                                    (= job-id (.-id job))
                                    (not= "running" (.-status job))))
                             (when jobs (array-seq jobs))))]
         (if done? result (p/recur (inc attempt))))))))

(defn task!
  ([params] (task! params #js {} (current-context)))
  ([params context] (task! params #js {} context))
  ([params options context]
   (invoke "task" params options context)))
