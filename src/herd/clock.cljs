(ns herd.clock)

;; Explicit time source. Production leaves globalThis.__herdClock unset and uses
;; the host clock. Tests install a fake clock and drive it by hand; no test
;; waits on wall-clock time.

(defn- injected []
  (.-__herdClock js/globalThis))

(defn now []
  (if-let [source (injected)]
    (.now source)
    (.now js/Date)))

(defn performance-now []
  (if-let [source (injected)]
    (.performanceNow source)
    (js/performance.now)))

(defn set-timeout [f ms]
  (if-let [source (injected)]
    (.setTimeout source f ms)
    (js/setTimeout f ms)))

(defn clear-timeout [id]
  (if-let [source (injected)]
    (.clearTimeout source id)
    (js/clearTimeout id)))

(defn sleep [ms]
  (js/Promise. (fn [resolve] (set-timeout resolve ms))))