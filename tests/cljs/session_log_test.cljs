(ns cljs.session-log-test
  (:require
   [herd.stages.session-log :as session-log]
   [herd.test :as t]
   [promesa.core :as p]))

(t/describe "session log journal lifecycle"
  (fn []
    (t/it "awaits ensureOnDisk and flush when available"
      (fn []
        (let [calls (atom [])
              manager #js {:ensureOnDisk (fn []
                                           (swap! calls conj :ensure)
                                           (js/Promise.resolve nil))
                           :flush (fn []
                                    (swap! calls conj :flush)
                                    (js/Promise.resolve nil))}
              ctx #js {:sessionManager manager}]
          (p/let [ensured (session-log/ensure-journal! ctx)
                  flushed (session-log/flush-journal! ctx)]
            (t/to-be (:ok ensured) true)
            (t/to-be (:ok flushed) true)
            (t/to-be (= @calls [:ensure :flush]) true)))))
    (t/it "is a no-op when the host has no journal lifecycle hooks"
      (fn []
        (p/let [ensured (session-log/ensure-journal! #js {:sessionManager #js {}})
                flushed (session-log/flush-journal! #js {:sessionManager #js {}})]
          (t/to-be (:ok ensured) true)
          (t/to-be (:ok flushed) true))))))
