(ns cljs.command-host-test
  (:require
   [bridge.command-host :as host]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- field [value key] (aget value (name key)))

(t/describe "bridge command host"
  (fn []
    (t/it "returns the same core result for five backends"
      (fn []
        (let [backends ["tui" "print" "rpc" "acp" "subagent"]
              results (mapv (fn [backend]
                              (host/normalize-command-result
                               "herd"
                               backend
                               #js {:mode "herd"
                                    :status "ok"
                                    :output "switched"}))
                            backends)]
          (doseq [result results]
            (t/to-be (field result :command) "herd")
            (t/to-be (field result :mode) "herd")
            (t/to-be (field result :status) "ok")
            (t/to-be (field result :consumed) true)
            (t/to-be (field result :output) "switched"))
          (t/to-equal (mapv #(field % :backend) results) backends)
          (t/to-be (count (filter #(= "present" (field % :ui)) results)) 1))))
    (t/it "degrades UI without rejecting the command"
      (fn []
        (let [instance (host/create-command-host
                        #js {:dispatch (fn [request]
                                         (js/Promise.resolve
                                          #js {:mode "herd"
                                               :status "ok"
                                               :ui (if (= "tui" (field request :backend))
                                                     "missing"
                                                     "none")}))})]
          (p/let [result (.handleTui instance "herd" #js {} #js {})]
            (t/to-be (field result :status) "ok")
            (t/to-be (field result :ui) "missing")
            (t/to-equal (field result :missing_deps) #js [])))))
    (t/it "fails closed when no dispatcher is installed"
      (fn []
        (let [instance (host/create-command-host nil)]
          (p/let [result (.handle instance "herd" #js {} #js {})]
            (t/to-be (field result :status) "error")
            (t/to-be (field result :error) "no-dispatch")))))))
