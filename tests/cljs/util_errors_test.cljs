(ns cljs.util-errors-test
  (:require
   ["node:fs" :as fs]
   [clojure.string :as str]
   [herd.errors :as errors]
   [herd.test :as t]))

(def code-names
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

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(defn- thrown-message [f]
  (try
    (f)
    nil
    (catch :default error
      (.-message error))))

(t/describe "ERROR_CODES"
  (fn []
    (t/it "registers every SSOT code as a frozen keyword"
      (fn []
        (t/to-be (js/Object.isFrozen errors/ERROR_CODES) true)
        (same (vec (sort (js/Object.keys errors/ERROR_CODES))) (vec (sort code-names)))
        (doseq [name code-names]
          (t/to-be (aget errors/ERROR_CODES name) (str ":" name)))))
    (t/it "covers every code listed in AGENTS.md section 10.3"
      (fn []
        (let [markdown (fs/readFileSync "AGENTS.md" "utf8")
              start (str/index-of markdown "### 10.3 错误码与状态词")
              end (str/index-of markdown "**状态词**" (inc start))
              section (subs markdown start end)
              documented (vec (keep (fn [line]
                                      (let [line (str/triml line)
                                            match (re-find #"^\|\s*`(:[^`]+)`\s*\|" line)]
                                        (when match (second match))))
                                    (str/split-lines section)))
              registered (set (js->clj (js/Object.values errors/ERROR_CODES)))]
          (t/to-be (> (count documented) 0) true)
          (same (filterv #(not (contains? registered %)) documented) []))))))

(t/describe "herdError"
  (fn []
    (t/it "builds a named error with normalized code, copied data, and cause"
      (fn []
        (let [nested #js {:keep true}
              data #js {:path "a.md" :nested nested}
              cause (js/Error. "root cause")
              error (errors/herd-error "FILE_CONFLICT" "conflict" data cause)]
          (t/to-be (instance? js/Error error) true)
          (t/to-be (.-name error) "HerdError")
          (t/to-be (.-code error) ":FILE_CONFLICT")
          (t/to-be (.-message error) "conflict")
          (t/to-be (aget (.-data error) "path") "a.md")
          (t/to-be (some? (aget (.-data error) "nested")) true)
          (t/to-be (identical? (.-nested (.-data error)) nested) true)
          (t/to-be (.-cause error) cause)
          (t/to-be (errors/is-herd-error error) true)
          (t/to-be (.-code (errors/herd-error ":changed-during-read" "moved")) ":changed-during-read")
          (t/to-be (.-length (js/Object.keys (.-data (errors/herd-error "FILE_CONFLICT" "no data")))) 0))))
    (t/it "rejects unregistered codes and non-object data"
      (fn []
        (t/to-be (str/includes? (or (thrown-message #(errors/herd-error "NOT_REGISTERED" "x")) "") "herdError:") true)
        (t/to-be (str/includes? (or (thrown-message #(errors/herd-error ":NOT_REGISTERED" "x")) "") "herdError:") true)
        (t/to-be (str/includes? (or (thrown-message #(errors/herd-error 42 "x")) "") "herdError:") true)
        (t/to-be (str/includes? (or (thrown-message #(errors/herd-error "FILE_CONFLICT" "x" #js [])) "") "herdError:") true)
        (t/to-be (str/includes? (or (thrown-message #(errors/herd-error "FILE_CONFLICT" "x" "data")) "") "herdError:") true)))
    (t/it "is not confused with ordinary errors"
      (fn []
        (t/to-be (errors/is-herd-error (js/Error. "plain")) false)
        (t/to-be (errors/is-herd-error #js {:name "HerdError" :code ":FILE_CONFLICT"}) false)
        (t/to-be (errors/is-herd-error nil) false)))))

(t/describe "legacy helpers"
  (fn []
    (t/it "keeps messageOf and errorCode behavior"
      (fn []
        (t/to-be (errors/message-of (js/Error. "boom")) "boom")
        (t/to-be (errors/message-of "plain") "plain")
        (let [system (js/Error. "disk full")]
          (aset system "code" "ENOSPC")
          (t/to-be (errors/error-code system) "ENOSPC"))
        (t/to-be (errors/error-code #js {:code 1}) js/undefined)
        (t/to-be (errors/error-code "plain") js/undefined)))))

(t/describe "renderError"
  (fn []
    (t/it "renders a herd error as aligned EDN with a trailing newline"
      (fn []
        (same (errors/render-error
               (errors/herd-error "FILE_CONFLICT" "conflict" #js {:path "a.md"}))
              "{:code :FILE_CONFLICT\n :message \"conflict\"\n :data {:path \"a.md\"}}\n")))
    (t/it "uses a raw fence and keeps colon-prefixed messages as strings"
      (fn []
        (let [text (errors/render-error
                    (errors/herd-error "INVALID_ARGUMENT" "bad \"x\" \\ path"))]
          (t/to-contain text " :message #\"bad \"x\" \\ path\"#\n")
          (t/to-be (str/includes? text "\\\"") false))
        (t/to-contain (errors/render-error
                       (errors/herd-error "INVALID_ARGUMENT" ":not-a-keyword"))
                      " :message \":not-a-keyword\"\n")))
    (t/it "uses a multiline fence aligned to the message field"
      (fn []
        (same (errors/render-error
               (errors/herd-error "INVALID_ARGUMENT" "first\nsecond line"))
              (str "{:code :INVALID_ARGUMENT\n :message \"\"\"\n"
                   (apply str (repeat 10 " ")) "first\n"
                   (apply str (repeat 10 " ")) "second line\n"
                   (apply str (repeat 10 " ")) "\"\"\"\n :data {}}\n"))))
    (t/it "normalizes raw exceptions, includes system codes, and never throws"
      (fn []
        (same (errors/render-error (js/Error. "a\rb"))
              "{:code nil\n :message \"a\\rb\"\n :data {:system-code nil}}\n")
        (let [system (js/Error. "disk full")]
          (aset system "code" "ENOSPC")
          (same (errors/render-error system)
                "{:code nil\n :message \"disk full\"\n :data {:system-code \"ENOSPC\"}}\n"))
        (let [cyclic #js {}]
          (aset cyclic "self" cyclic)
          (let [text (errors/render-error
                      (errors/herd-error "INVALID_ARGUMENT" "cycle" cyclic))]
            (t/to-be (str/ends-with? text "\n") true)
            (t/to-contain text ":render-error")
            (t/to-contain text ":error-code :INVALID_ARGUMENT")))
        (same (errors/render-error js/undefined)
              "{:code nil\n :message \"undefined\"\n :data {:system-code nil}}\n")
        (let [hostile #js {}]
          (js/Object.defineProperty
           hostile "message"
           #js {:get (fn [] (throw (js/Error. "unreadable")))})
          (t/to-be (string? (errors/render-error hostile)) true))))
    (t/it "includes a nested cause chain"
      (fn []
        (let [root (errors/herd-error "LOCK_OWNER_DEAD" "owner dead" #js {:agent_id "a1"})
              outer (errors/herd-error "FILE_CONFLICT" "conflict" #js {} root)
              expected (str "{:code :FILE_CONFLICT\n"
                            " :message \"conflict\"\n"
                            " :data {}\n"
                            " :cause {:code :LOCK_OWNER_DEAD\n"
                            "         :message \"owner dead\"\n"
                            "         :data {:agent_id \"a1\"}}}\n")]
          (same (errors/render-error outer) expected))))))

(t/describe "printEdn scalars"
  (fn []
    (t/it "prints nil, booleans, numbers, bigints, and strings"
      (fn []
        (t/to-be (errors/print-edn nil nil) "nil")
        (t/to-be (errors/print-edn true nil) "true")
        (t/to-be (errors/print-edn false nil) "false")
        (t/to-be (errors/print-edn 42 nil) "42")
        (t/to-be (errors/print-edn -7 nil) "-7")
        (t/to-be (errors/print-edn (js/BigInt 10) nil) "10N")
        (t/to-be (errors/print-edn "plain" nil) "\"plain\"")
        (t/to-be (errors/print-edn ":ready" nil) ":ready")
        (t/to-be (errors/print-edn ":not a keyword" nil) "\":not a keyword\"")
        (t/to-be (errors/print-edn ":" nil) "\":\"")))
    (t/it "rejects non-finite numbers with INVALID_ARGUMENT"
      (fn []
        (doseq [value [js/Number.NaN js/Infinity (- js/Infinity)]]
          (t/to-be (str/includes? (or (thrown-message #(errors/print-edn value nil)) "")
                                 "printEdn:") true))))))

(t/describe "printEdn strings"
  (fn []
    (t/it "uses the minimal raw fence for inline quotes and backslashes"
      (fn []
        (t/to-be (errors/print-edn "say \"hi\"" nil) "#\"say \"hi\"\"#")
        (t/to-be (errors/print-edn "C:\\tmp" nil) "#\"C:\\tmp\"#")
        (t/to-be (errors/print-edn "a\"#b" nil) "##\"a\"#b\"##")))
    (t/it "uses triple-quote blocks for multiline strings"
      (fn []
        (t/to-be (errors/print-edn "a\nb" nil) "\"\"\"\na\nb\n\"\"\"")
        (t/to-be (errors/print-edn "a\nb\n" nil) "\"\"\"\na\nb\n\n\"\"\"")
        (t/to-be (errors/print-edn "a\\b\nc" nil) "#\"\"\"\na\\b\nc\n\"\"\"#")
        (t/to-be (errors/print-edn "x \"\"\" y\nz" nil) "#\"\"\"\nx \"\"\" y\nz\n\"\"\"#")
        (t/to-be (errors/print-edn "x \"\"\"# y\nz" nil) "##\"\"\"\nx \"\"\"# y\nz\n\"\"\"##")))
    (t/it "aligns multiline blocks to the provided indent"
      (fn []
        (t/to-be (errors/print-edn "a\n\nb" #js {:indent "  "})
                 "\"\"\"\n  a\n\n  b\n  \"\"\"")))
    (t/it "falls back to standard escapes for control characters"
      (fn []
        (t/to-be (errors/print-edn "a\rb" nil) "\"a\\rb\"")
        (t/to-be (errors/print-edn "a\u0001b" nil) "\"a\\u0001b\"")
        (t/to-be (errors/print-edn "a\tb" nil) "\"a\tb\"")))))

(t/describe "printEdn collections"
  (fn []
    (t/it "prints arrays, sets, and maps deterministically"
      (fn []
        (t/to-be (errors/print-edn #js [] nil) "[]")
        (t/to-be (errors/print-edn #js [1 2 3] nil) "[1 2 3]")
        (t/to-be (errors/print-edn (js/Set. #js [":a" ":b"]) nil) "#{:a :b}")
        (t/to-be (errors/print-edn
                  (js/Map. (clj->js [["k" 1] [2 ":v"]])) nil)
                 "{\"k\" 1\n 2 :v}")
        (t/to-be (errors/print-edn (js/Map. (clj->js [[":k" 1]])) nil) "{:k 1}")
        (t/to-be (errors/print-edn #js [#js {:a 1 :b 2}] nil) "[{:a 1\n  :b 2}]")
        (t/to-be (errors/print-edn #js [#js {:a 1 :b 2} #js {:c 3 :d 4}] nil)
                 "[{:a 1\n  :b 2}\n {:c 3\n  :d 4}]")))
    (t/it "prints keyword-able object keys as keywords and aligns nested objects"
      (fn []
        (t/to-be (errors/print-edn
                  (js-obj "path" "a.md" "dry run" true "skipped" js/undefined) nil)
                 "{:path \"a.md\"\n \"dry run\" true}")
        (t/to-be (errors/print-edn #js {":stage" ":s1"} nil) "{:stage :s1}")
        (t/to-be (errors/print-edn #js {":dry run" 1} nil) "{\":dry run\" 1}")
        (t/to-be (errors/print-edn #js {:state ":ready" :colon ":not a keyword"} nil)
                 "{:state :ready\n :colon \":not a keyword\"}")
        (t/to-be (errors/print-edn #js {:a #js {:b 1 :c 2} :d 3} nil)
                 "{:a {:b 1\n     :c 2}\n :d 3}")))
    (t/it "rejects circular references but permits shared siblings"
      (fn []
        (let [cyclic #js {}]
          (aset cyclic "self" cyclic)
          (t/to-be (str/includes? (or (thrown-message #(errors/print-edn cyclic nil)) "")
                                 "printEdn:") true))
        (let [shared #js {:a 1}]
          (t/to-be (errors/print-edn #js [shared shared] nil) "[{:a 1} {:a 1}]"))))
    (t/it "never appends a trailing newline"
      (fn []
        (t/to-be (str/ends-with? (errors/print-edn "a\nb" nil) "\n") false)
        (t/to-be (errors/print-edn #js {:a 1} nil) "{:a 1}")))))

