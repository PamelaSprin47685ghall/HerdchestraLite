(ns herd.native-runner)

(def ^:private capture-key (js/Symbol.for "herdchestra.runnerCapture.v1"))
(defonce ^:private install-promise (atom nil))

(defn- js-type [value]
  (cond
    (nil? value) "object"
    (boolean? value) "boolean"
    (number? value) "number"
    (string? value) "string"
    (fn? value) "function"
    :else "object"))

(defn- capture-state []
  (let [existing (aget js/globalThis capture-key)]
    (if (some? existing)
      existing
      (let [created #js {:status "idle"
                         :error nil
                         :runner nil
                         :prototype nil
                         :original nil
                         :byContext (js/WeakMap.)}]
        (js/Object.defineProperty js/globalThis capture-key
                                  #js {:value created :enumerable false :configurable true :writable false})
        created))))

(defn restore-capture! []
  (let [state (capture-state)]
    (when (and (= "installed" (.-status state))
               (some? (.-prototype state))
               (some? (.-original state)))
      (set! (.-createContext (.-prototype state)) (.-original state)))
    (set! (.-status state) "idle")
    (set! (.-error state) nil)
    (set! (.-runner state) nil)
    (set! (.-prototype state) nil)
    (set! (.-original state) nil)
    (set! (.-byContext state) (js/WeakMap.))))

(defn ^:async install-capture! []
  (let [state (capture-state)]
    (cond
      (= "installed" (.-status state)) (fn [] (restore-capture!))
      (= "unavailable" (.-status state))
      (throw (js/Error. (or (.-error state) "native tool runner capture is unavailable")))
      (some? @install-promise) (await @install-promise)
      :else
      (let [promise (^:async
                     (try
                       (let [module (.-__herdRunnerModule js/globalThis)
                             prototype (.-prototype (.-ExtensionRunner module))]
                         (when (or (nil? prototype) (not (fn? (.-createContext prototype))))
                           (throw (js/Error. "ExtensionRunner.createContext is unavailable")))
                         (let [original (.-createContext prototype)]
                           (set! (.-original state) original)
                           (set! (.-prototype state) prototype)
                           (set! (.-createContext prototype)
                                 (fn [& args]
                                   (this-as this
                                     (let [ctx (.apply (.-original (capture-state)) this (clj->js args))]
                                       (set! (.-runner (capture-state)) this)
                                       (when (and (some? ctx)
                                                  (or (= "object" (js-type ctx)) (fn? ctx)))
                                         (.set (.-byContext (capture-state)) ctx this))
                                       ctx)))))
                         (set! (.-status state) "installed")
                         (set! (.-error state) nil)
                         (fn [] (restore-capture!)))
                       (catch :default error
                         (set! (.-status state) "unavailable")
                         (set! (.-error state) (if (instance? js/Error error) (.-message error) (str error)))
                         (throw error))
                       (finally (reset! install-promise nil))))]
        (reset! install-promise promise)
        (await promise)))))

(defn get-native-runner [] (.-runner (capture-state)))

(defn runner-for-context [context]
  (let [state (capture-state)]
    (if (and (some? context) (or (= "object" (js-type context)) (fn? context)))
      (or (.get (.-byContext state) context) (.-runner state))
      (.-runner state))))

(defn capture-status []
  (let [state (capture-state)]
    (js/Object.freeze #js {:status (.-status state)
                           :error (.-error state)
                           :captured (some? (.-runner state))})))
