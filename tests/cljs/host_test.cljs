(ns cljs.host-test
  (:require
   [herd.host :as host]
   [herd.test :as t]))

(t/describe "host capability detection"
  (fn []
    (t/it "reports missing UI and session manager without throwing"
      (fn []
        (let [table (host/detect-capabilities #js {} nil)]
          (t/to-be (aget table "hasCtxAgent") false)
          (t/to-be (aget table "hasSetWidget") false)
          (t/to-be (aget table "hasOnTerminalInput") false)
          (t/to-be (aget table "hasArtifactsDir") false)
          (t/to-be (aget table "hasSessionFile") false)
          (t/to-be (some #{"hasSetWidget"} (vec (array-seq (aget table "unverified")))) "hasSetWidget"))))
    (t/it "detects available UI, session manager, and model registry"
      (fn []
        (let [ui #js {:setWidget (fn []) :onTerminalInput (fn []) :setHookWidget (fn [])}
              session-manager #js {:getArtifactsDir (fn []) :getSessionFile (fn [])}
              ctx #js {:ui ui :sessionManager session-manager :agent #js {} :modelRegistry #js {}}
              pi #js {:registerShortcut (fn []) :setActiveTools (fn [])}
              table (host/detect-capabilities pi ctx)]
          (t/to-be (aget table "hasCtxAgent") true)
          (t/to-be (aget table "hasSetWidget") true)
          (t/to-be (aget table "hasOnTerminalInput") true)
          (t/to-be (aget table "hasHookWidget") true)
          (t/to-be (aget table "hasArtifactsDir") true)
          (t/to-be (aget table "hasSessionFile") true)
          (t/to-be (aget table "hasModelRegistry") true))))))
