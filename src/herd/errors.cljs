(ns herd.errors
  (:require
   [clojure.string :as str]))

(def ^:private error-code-names
  ["SLUG_TAKEN" "STAGE_MISMATCH" "CALL_REPLAY_MISMATCH" "APPROVAL_REQUIRED"
   "INSUFFICIENT_WORKTREES" "RESOURCES_NOT_QUIESCENT" "FF_NOT_READY" "NO_RESULTS"
   "CASE_SCHEMA_INVALID" "CASE_DUPLICATE_ID" "CASE_THRESHOLD_INVALID"
   "CASE_REQUIRED_PATH_MISSING" "MAPPED_CASE_UNKNOWN" "MAPPED_CASE_MISSING"
   "BOARD_CONFLICT" "TASK_NOT_READY" "CLAIM_CONFLICT" "PARENT_NOT_READY"
   "TOKEN_REQUIRED" "CONFIRMATION_REQUIRED" "TENURE_RETIRED" "ACTOR_DEAD"
   "CLAIM_CHANGED" "NO_PROGRESSABLE_WORK" "TASK_HAS_CHILDREN" "NAME_TAKEN"
   "FILE_CONFLICT" "STRUCTURE_CONFLICT" "PREPARE_REJECTED" "LIMIT_EXCEEDED"
   "changed-during-read" "PATH_ESCAPE" "NOT_UTF8" "OUTPUT_TRUNCATED"
   "CAPABILITY_DENIED" "PROGRAM_UNKNOWN" "STALE_CONTROL" "INVALID_ARGUMENT"
   "BOARD_NOT_QUIESCENT" "ATTACH_ALREADY_PENDING" "ATTACH_STAGE_MISMATCH"
   "REVIEW_LEDGER_NOT_EMPTY" "ATTACH_NOT_READY" "UFSS_INDENT_VIOLATION"
   "UFSS_UNCLOSED" "SCOPE_UNINITIALIZED" "SCOPE_BUDGET_SPENT" "INTENT_REQUIRED"
   "SCOPE_INVALID" "ASK_FORBIDDEN_OUTSIDE_S1" "AUDIT_MISSING" "AUDIT_UNKNOWN_CASE"
   "AUDIT_DUPLICATE_CASE" "AUDIT_INVALID_SCORE" "AUDIT_WORKSPACE_MUTATED"
   "AUDIT_TIMEOUT" "AUDIT_ABORTED" "STALLED" "UPSTREAM_ABORTED"
   "AGENT_SPAWN_FAILED" "HOST_API_MISMATCH" "SETTINGS_UNAVAILABLE"
   "MODEL_FALLBACK" "LOCK_OWNER_DEAD"])

(def ERROR_CODES
  (let [codes #js {}]
    (doseq [name error-code-names]
      (aset codes name (str ":" name)))
    (js/Object.freeze codes)))

(def ^:private control-character
  (js/RegExp. "[\\r\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]"))
(def ^:private keyword-part
  (js/RegExp. "^[\\p{L}_*+!?$%&=<>.-][\\p{L}\\p{N}_*+!?$%&=<>.-]*$" "u"))
(def ^:private max-cause-depth 8)

(defn- js-type [value]
  (cond
    (nil? value) "object"
    (boolean? value) "boolean"
    (number? value) "number"
    (string? value) "string"
    (fn? value) "function"
    (instance? js/BigInt value) "bigint"
    :else "object"))

(defn- bigint-value? [value]
  (and (some? value)
       (= "[object BigInt]" (.call (.-toString (.-prototype js/Object)) value))))

(defn- plain-object? [value]
  (and (some? value)
       (= "object" (js-type value))
       (let [proto (js/Object.getPrototypeOf value)]
         (or (nil? proto) (identical? proto (.-prototype js/Object))))))

(defn message-of [error]
  (cond
    (instance? js/Error error) (.-message error)
    (nil? error) (if (identical? error js/undefined) "undefined" "null")
    (string? error) error
    :else (str error)))

(defn error-code [error]
  (if (and (some? error) (= "object" (js-type error)) (string? (.-code error)))
    (.-code error)
    js/undefined))

(defn- normalize-code [code]
  (when-not (string? code)
    (throw (js/TypeError. "herdError: code must be a string")))
  (let [name (if (str/starts-with? code ":") (subs code 1) code)]
    (or (aget ERROR_CODES name)
        (throw (js/TypeError. (str "herdError: unknown error code " (js/JSON.stringify code)))))))

(defn- copy-data [data]
  (if (nil? data)
    #js {}
    (if (plain-object? data)
      (let [copy #js {}]
        (doseq [key (array-seq (js/Object.keys data))]
          (aset copy key (aget data key)))
        copy)
      (throw (js/TypeError. "herdError: data must be a plain object")))))

(defn herd-error
  ([code] (herd-error code "" #js {} nil))
  ([code message] (herd-error code message #js {} nil))
  ([code message data] (herd-error code message data nil))
  ([code message data cause]
   (let [error (js/Error. (if (nil? message) "" (str message)))]
     (set! (.-name error) "HerdError")
     (set! (.-code error) (normalize-code code))
     (set! (.-data error) (copy-data data))
     (when (some? cause) (set! (.-cause error) cause))
     error)))

(defn is-herd-error [value]
  (and (instance? js/Error value)
       (= "HerdError" (.-name value))
       (string? (.-code value))))

(defn- is-keyword-name [name]
  (and (string? name)
       (pos? (count name))
       (let [parts (.split name "/")]
         (if (= 1 (.-length parts))
           (boolean (re-matches keyword-part (aget parts 0)))
           (and (= 2 (.-length parts))
                (pos? (.-length (aget parts 0)))
                (pos? (.-length (aget parts 1)))
                (re-matches keyword-part (aget parts 0))
                (re-matches keyword-part (aget parts 1)))))))

(defn- is-keyword-literal [value]
  (and (str/starts-with? value ":") (is-keyword-name (subs value 1))))

(defn- invalid [message data]
  (herd-error "INVALID_ARGUMENT" message (or data #js {})))

(defn- normalize-indent [indent]
  (cond
    (string? indent) indent
    (and (number? indent) (js/Number.isFinite indent) (pos? indent))
    (apply str (repeat (js/Math.floor indent) " "))
    :else ""))

(defn- enter [active value]
  (when (.has active value)
    (throw (invalid "printEdn: circular reference" #js {:kind "cycle"})))
  (.add active value))

(defn- render-sequence [open close parts item-indent]
  (if (every? #(not (str/includes? % "
")) parts)
    (str open (str/join " " parts) close)
    (str open (first parts)
         (apply str (map #(str "
" item-indent %) (rest parts)))
         close)))

(declare render-value print-string render-object-key)

(defn- render-vector [items indent keyword-strings active]
  (if (zero? (.-length items))
    "[]"
    (do
      (enter active items)
      (try
        (let [item-indent (str indent " ")
              parts (mapv #(render-value % item-indent keyword-strings active) (array-seq items))]
          (render-sequence "[" "]" parts item-indent))
        (finally (.delete active items))))))

(defn- render-set [items indent keyword-strings active]
  (if (zero? (.-length items))
    "#{}"
    (do
      (enter active items)
      (try
        (let [item-indent (str indent "  ")
              parts (mapv #(render-value % item-indent keyword-strings active) (array-seq items))]
          (render-sequence "#{" "}" parts item-indent))
        (finally (.delete active items))))))

(defn- render-entries [entries indent keyword-strings active keywordize-keys]
  (let [entry-indent (str indent " ")
        lines (mapv
               (fn [entry]
                 (let [key (aget entry 0)
                       entry-value (aget entry 1)
                       key-text (if keywordize-keys
                                  (render-object-key key entry-indent)
                                  (render-value key entry-indent keyword-strings active))
                       value-indent (str entry-indent
                                         (apply str (repeat (inc (count key-text)) " ")))
                       value-text (render-value entry-value value-indent keyword-strings active)]
                   (str key-text " " value-text)))
               entries)]
    (str "{" (first lines)
         (apply str (map #(str "
" entry-indent %) (rest lines)))
         "}")))

(defn- render-object [value indent keyword-strings active]
  (let [entries (filterv #(not (identical? js/undefined (aget % 1)))
                         (array-seq (js/Object.entries value)))]
    (if (empty? entries)
      "{}"
      (do
        (enter active value)
        (try
          (render-entries entries indent keyword-strings active true)
          (finally (.delete active value)))))))

(defn- render-map [value entries indent keyword-strings active]
  (if (zero? (.-length entries))
    "{}"
    (do
      (enter active value)
      (try
        (render-entries entries indent keyword-strings active false)
        (finally (.delete active value))))))

(defn- render-object-key [key indent]
  (let [name (if (str/starts-with? key ":") (subs key 1) key)]
    (if (is-keyword-name name) (str ":" name) (print-string key indent))))

(defn- escape-string [value]
  (loop [remaining (seq value)
         text "\""]
    (if (empty? remaining)
      (str text "\"")
      (let [character (first remaining)
            encoded (cond
                      (= (str character) "\"") (str text "\\\"")
                      (= (str character) "\\") (str text "\\\\")
                      (= (str character) "\n") (str text "\\n")
                      (= (str character) "\r") (str text "\\r")
                      (= (str character) "\t") (str text "\\t")
                      :else
                      (let [code (.codePointAt character 0)]
                        (str text (if (< code 0x20)
                                    (str "\\u" (.padStart (.toString code 16) 4 "0"))
                                    character))))]
        (recur (rest remaining) encoded)))))

(defn- print-raw-line [value]
  (loop [hashes 1]
    (let [fence (apply str (repeat hashes "#"))]
      (if (str/includes? value (str "\"" fence))
        (recur (inc hashes))
        (str fence "\"" value "\"" fence)))))

(defn- print-block [value indent]
  (let [lines (.split value "
")
        bare (and (not (str/includes? value "\"\"\""))
                  (not (str/includes? value "\\"))
                  (not-any? #(str/starts-with? % "\"\"\"") (array-seq lines)))
        hashes (if bare
                 0
                 (loop [n 1]
                   (if (str/includes? value (str "\"\"\"" (apply str (repeat n "#"))))
                     (recur (inc n))
                     n)))
        fence (str (apply str (repeat hashes "#")) "\"\"\"")
        close (str "\"\"\"" (apply str (repeat hashes "#")))
        body (str/join "
" (mapv #(if (= % "") "" (str indent %)) (array-seq lines)))]
    (str fence "
" body "
" indent close)))

(defn- print-string [value indent]
  (cond
    (re-find control-character value) (escape-string value)
    (not (str/includes? value "
"))
    (if (and (not (str/includes? value "\"")) (not (str/includes? value "\\")))
      (str "\"" value "\"")
      (print-raw-line value))
    :else (print-block value indent)))

(defn- render-value [value indent keyword-strings active]
  (cond
    (nil? value) "nil"
    (boolean? value) (if value "true" "false")
    (number? value) (if (js/Number.isFinite value)
                      (str value)
                      (throw (invalid "printEdn: numbers must be finite" #js {:value (str value)})))
    (bigint-value? value) (str value "N")
    (string? value) (if (and keyword-strings (is-keyword-literal value))
                      value
                      (print-string value indent))
    (array? value) (render-vector value indent keyword-strings active)
    (instance? js/Map value) (render-map value (js/Array.from (.entries value)) indent keyword-strings active)
    (instance? js/Set value) (render-set (js/Array.from value) indent keyword-strings active)
    (map? value) (render-map value (mapv (fn [[k v]] #js [k v]) value) indent keyword-strings active)
    (plain-object? value) (render-object value indent keyword-strings active)
    :else (throw (invalid (str "printEdn: unsupported value type " (js-type value)) #js {}))))

(defn print-edn [value options]
  (let [settings (if (and (some? options) (= "object" (js-type options))) options #js {})
        indent (normalize-indent (aget settings "indent"))
        keyword-strings (not (false? (aget settings "keywordStrings")))]
    (render-value value indent keyword-strings (js/Set.))))

(defn- safe-message [value]
  (try
    (let [text (message-of value)]
      (if (string? text) text (str text)))
    (catch :default _ "unprintable error value")))

(defn- render-error-code [code indent]
  (when (string? code)
    (let [name (if (str/starts-with? code ":") (subs code 1) code)]
      (or (aget ERROR_CODES name) (print-string code indent)))))

(defn- render-error-data [error herd indent]
  (let [data (if herd
               (let [value (try (.-data error) (catch :default _ nil))]
                 (if (plain-object? value) value #js {}))
               #js {"system-code"
                    (try
                      (let [code (error-code error)]
                        (if (string? code) code nil))
                      (catch :default _ nil))})]
    (try
      (print-edn data #js {:indent indent})
      (catch :default failure
        (let [fallback #js {"render-error" (safe-message failure)}]
          (try
            (let [code (try (error-code failure) (catch :default _ nil))]
              (when (and (string? code) (pos? (count code)))
                (aset fallback "error-code" code))
              (print-edn fallback #js {:indent indent}))
            (catch :default _ "{}")))))))

(defn- render-error-body [error indent seen depth]
  (let [herd (is-herd-error error)
        code (when herd (render-error-code (.-code error) (str indent "       ")))
        message (print-string (safe-message error) (str indent "          "))
        data (render-error-data error herd (str indent "       "))
        body (str "{:code " (or code "nil")
                  "
" indent " :message " message
                  "
" indent " :data " data)]
    (if-not herd
      (str body "}")
      (let [has-cause (some? (.-cause error))]
        (if-not has-cause
          (str body "}")
          (let [cause (.-cause error)
                trackable (or (= "object" (js-type cause)) (fn? cause))]
            (if (or (and trackable (.has seen cause)) (>= depth max-cause-depth))
              (str body "
" indent " :cause nil}")
              (do
                (when trackable (.add seen cause))
                (try
                  (str body "
" indent " :cause "
                       (render-error-body cause (str indent "        ") seen (inc depth)) "}")
                  (finally
                    (when trackable (.delete seen cause))))))))))))

(defn render-error [error]
  (try
    (let [seen (js/Set.)
          trackable (or (= "object" (js-type error)) (fn? error))]
      (when trackable (.add seen error))
      (str (render-error-body error "" seen 0) "
"))
    (catch :default _
      "{:code :INVALID_ARGUMENT
 :message \"renderError failed\"
 :data {}}
")))
