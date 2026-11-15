(ns cljs.herd-mode-test
  (:require ["node:fs" :as fs]
            ["node:os" :as os]
            ["node:path" :as path]
            [herd.system :as system]
            [herd.stages.store :as store]
            [herd.test :as t]
            [promesa.core :as p]))

(defn- root [] (fs/mkdtempSync (path/join (os/tmpdir) "herd-mode-")))
(defn- host []
  (let [tools (atom {}) commands (atom {}) hooks (atom {})
        active (atom ["read" "bash" "board_finish" "clj_devops" "wait"])]
    #js {:registerTool (fn [d] (swap! tools assoc (.-name d) d))
         :registerCommand (fn [n d] (swap! commands assoc n d))
         :on (fn [n f] (swap! hooks assoc n f))
         :getActiveTools (fn [] (clj->js @active))
         :setActiveTools (fn [v] (reset! active (vec (js->clj v))) (js/Promise.resolve nil))
         :sendUserMessage (fn [& _])
         :tools tools :commands commands :hooks hooks :active active}))
(defn- ctx [root id]
  (let [file (path/join root ".sessions" (str id ".jsonl"))]
    #js {:cwd root :hasUI false :mode "print"
         :sessionManager
         #js {:getSessionId (fn [] id)
              :getSessionFile (fn [] file)
              :appendCustomEntry
              (fn [kind data]
                (fs/mkdirSync (path/dirname file) #js {:recursive true})
                (fs/appendFileSync file
                                   (str (js/JSON.stringify
                                         #js {:type "custom"
                                              :customType kind
                                              :data data}) "\n")))}}))
(defn- install [root]
  (let [pi (host)]
    (system/reset-state!)
    (system/install! pi {:root root})
    pi))

(t/describe "/herd mode toggle"
  (fn []
    (t/it "switches to devops and back without dropping the task"
      (fn []
        (p/let [r (root)
                pi (install r)
                handler (get @(.-commands pi) "herd")
                _ ((.-handler handler) "Build parser" (ctx r "session-1"))
                active-s1 (set @(aget pi "active"))
                _ ((.-handler handler) "" (ctx r "session-1"))
                active-devops (set @(aget pi "active"))
                mode-devops (get-in @system/state [:sessions "session:session-1" :mode])
                _ ((.-handler handler) "" (ctx r "session-1"))
                active-herd (set @(aget pi "active"))
                mode-herd (get-in @system/state [:sessions "session:session-1" :mode])
                mission (store/read-mission r "session-1")]
          (t/to-be (contains? active-s1 "clj_plan") true)
          (t/to-be (contains? active-devops "clj_devops") true)
          (t/to-be (contains? active-devops "wait") true)
          (t/to-be (contains? active-devops "handoff") true)
          (t/to-be (contains? active-devops "clj_plan") false)
          (t/to-be (contains? active-devops "review") false)
          (t/to-be mode-devops :devops)
          (t/to-be (contains? active-herd "clj_plan") true)
          (t/to-be (contains? active-herd "review") true)
          (t/to-be mode-herd :herd)
          (t/to-be (:ok mission) true))))))

