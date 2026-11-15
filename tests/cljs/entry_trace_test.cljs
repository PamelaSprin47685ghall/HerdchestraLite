(ns cljs.entry-trace-test
  (:require
   [clojure.string :as str]
   [herd.entry :as entry]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- env [] (.-env (.-process js/globalThis)))
(defn- fs [] ((.-__herdRequire js/globalThis) "node:fs/promises"))
(defn- os [] ((.-__herdRequire js/globalThis) "node:os"))
(defn- path [] ((.-__herdRequire js/globalThis) "node:path"))

(defn- set-env! [key value]
  (if (nil? value)
    (js-delete (env) key)
    (aset (env) key value)))

(defn- temp-target []
  (let [fs-mod (fs)
        os-mod (os)
        path-mod (path)]
    (p/let [root (.mkdtemp fs-mod (.join path-mod (.tmpdir os-mod) "herd-boot-trace-"))]
      (.join path-mod root "perf-trace.jsonl"))))

(t/describe "boot trace"
  (fn []
    (t/it "stays silent unless HERD_TRACE is 1"
      (fn []
        (set-env! "HERD_TRACE" nil)
        (set-env! "HERD_TRACE_PATH" nil)
        (t/to-be (entry/trace-enabled?) false)
        (t/to-be (entry/trace-target) ".herd/perf-trace.jsonl")
        (p/let [target (temp-target)
                wrote (entry/trace-boot-event "boot-start" #js {:pid 1})
                size (-> (.stat (fs) target)
                         (.then (fn [stats] (.-size stats)))
                         (.catch (fn [_] nil)))]
          (t/to-be wrote false)
          (t/to-be size nil))))
    (t/it "appends one parseable JSON line when enabled"
      (fn []
        (p/let [target (temp-target)
                _ (set-env! "HERD_TRACE" "1")
                _ (set-env! "HERD_TRACE_PATH" target)
                wrote (entry/trace-boot-event "boot-start"
                                              #js {:pid 4321
                                                   :cwd "/tmp/x"
                                                   :pluginSrc "/tmp/x/src"})
                text (p/let [value (.readFile (fs) target "utf8")] value)]
          (t/to-be wrote true)
          (t/to-be (str/ends-with? text "\n") true)
          (let [lines (remove str/blank? (str/split-lines text))
                entry (js/JSON.parse (first lines))]
            (t/to-be (count lines) 1)
            (t/to-be (aget entry "event") "boot-start")
            (t/to-be (aget entry "pid") 4321)
            (t/to-be (aget entry "cwd") "/tmp/x")
            (t/to-be (aget entry "pluginSrc") "/tmp/x/src")
            (t/to-be (number? (aget entry "at")) true)))))
    (t/it "never grows the file past the 1 MiB cap"
      (fn []
        (p/let [target (temp-target)
                _ (set-env! "HERD_TRACE" "1")
                _ (set-env! "HERD_TRACE_PATH" target)
                _ (.writeFile (fs) target (apply str (repeat (* 1024 1024) "x")) "utf8")
                wrote (entry/trace-boot-event "boot-end" #js {:total 1})
                size (-> (.stat (fs) target) (.then (fn [stats] (.-size stats))))]
          (t/to-be wrote false)
          (t/to-be size (* 1024 1024)))))
    (t/it "builds records without reading the clock when at is given"
      (fn []
        (let [record (entry/boot-trace-record "boot-phase"
                                              #js {:phase "nbb-import" :ms 1.5}
                                              1234)]
          (t/to-be (aget record "at") 1234)
          (t/to-be (aget record "event") "boot-phase")
          (t/to-be (aget record "phase") "nbb-import")
          (t/to-be (aget record "ms") 1.5))))))
