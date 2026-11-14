(ns herd.main
  (:require
   ["node:fs/promises" :as fs]
   [clojure.string :as str]
   [herd.clock :as clock]
   [herd.handoff :as handoff]
   [herd.prompts :as prompts]
   [herd.repl :as repl]
   [herd.system :as system]
   [herd.ufss :as ufss]
   [herd.ui :as ui]))

(defn- text-block [text]
  {:type "text" :text text})

(defn- tool-result [text]
  {:content [(text-block text)]})

(defn- normalized-error [error]
  (let [data (ex-data error)
        message (or (ex-message error) (.-message error) (str error))]
    (cond-> {:code (or (:code data)
                       (when (str/includes? message "Could not resolve symbol")
                         :CAPABILITY_DENIED)
                       :INTERNAL)
             :message message}
      (:name data) (assoc :name (:name data))
      (:path data) (assoc :path (:path data))
      (:field data) (assoc :field (:field data)))))

(defn- tool-error [error]
  {:isError true
   :content [(text-block (ufss/canonical (normalized-error error)))]})

(defn- byte-length [text]
  (js/Buffer.byteLength text "utf8"))

(defn- sandbox-deadline [code]
  (+ 2000 (* 200 (byte-length code))))

(defonce receipts (atom {}))

(defonce last-agent-states (atom {}))

(defonce last-handoffs (atom {}))
(defonce live-session-manager (atom nil))

(defn- digest [params]
  (pr-str (js->clj params :keywordize-keys true)))

(defn- replay-mismatch []
  (ex-info "the same call id arrived with a different payload"
           {:code :CALL_REPLAY_MISMATCH}))

(defn- error-text [error]
  (ufss/canonical (normalized-error error)))

(defn- receipt-response [cached]
  (if (:error? cached)
    {:isError true
     :content [(text-block (:text cached))]}
    (tool-result (:text cached))))

(defn- session-key [ctx]
  (or (some-> ctx .-agent .-id) "main"))

(def ^:private agent-state-values
  ["Orienting" "Converging" "Consolidating" "Stagnant" "Drifting" "Densifying" "Reorienting" "Settled"])

(def ^:private agent-state-set (set agent-state-values))

(def ^:private agent-state-comments
  {"Orienting" "; Karl Popper's piecemeal engineering and falsification, Herbert Simon's bounded rationality and satisficing, and Friedrich Hayek's respect for local, dispersed knowledge all converge on one practical rule: act now, in small steps, without hoarding context or over-planning. Let reality correct you before you re-orient."
   "Converging" "; Stop hedging: Søren Aabye Kierkegaard's commitment, William James's will to believe, and Martin Heidegger's resoluteness turn a chosen hypothesis into a disciplined line of action—hold it until evidence, not nerves, moves you."
   "Consolidating" "; Do not treat a gain as a victory lap: Imre Lakatos's progressive research programme, Norbert Wiener's feedback loop, and Joseph Moses Juran's quality trilogy say extend the gain, but verify differentially—only what the change can break, plus a generation marker; do not re-run the whole world or pay proof tax for facts that cannot change the next step."
   "Stagnant" "; Do not hibernate in a loop: Mary Parker Follett's integrative authority, Chester Irving Barnard's acceptance theory of authority, and Ronald Harry Coase's boundary of the firm all say the same thing—if the next useful move lies outside your mandate or competence, hand the work to its rightful owner and leave a clean baton, not another loop. Use the handoff tool. I mean it."
   "Drifting" "; Do not confuse effort with relevance: Charles Sanders Peirce's pragmatic maxim, George Herbert Mead's taking the role of the other, and Alfred Schutz's relevance structures return you to the effects the user actually wants—if the work belongs to another owner, hand it over instead of dragging it further off course. Use the handoff tool. I mean it."
   "Densifying" "; Offload, do not hoard: Daniel Kahneman's attention budget, Andy Clark's extended mind, and Edwin Hutchins's distributed cognition put the subsidiary detail into the record or into another pair of hands, keep the decisive fact focal, and hand off what no longer needs your attention. Use the handoff tool. I mean it."
   "Reorienting" "; Keep the lesson and drop the scoreboard: Gaston Bachelard's epistemological obstacle, Epictetus's dichotomy of control, and Georg Wilhelm Friedrich Hegel's negation turn failure into a sharper epistemological instrument—win without vanity, lose without surrender, and re-enter with a better question."
   "Settled" "; Do not endure for endurance's sake: Aristotle's telos, Lucius Annaeus Seneca's timely departure, and Simone Weil's attention to obligation ask only whether every duty still on your shoulders has been completed or handed to its rightful owner; only then leave the evidence and go—silence is not an exit, and being stuck is not a reason to stop."})

(defn- prepend-state-comment [state text]
  (if-let [comment (get agent-state-comments state)]
    (str comment "\n" text)
    text))

(defn- claim-state-transition! [session state]
  (loop []
    (let [old @last-agent-states
          previous (get old session)]
      (if (= previous state)
        false
        (if (compare-and-set! last-agent-states old (assoc old session state))
          true
          (recur))))))

(defn- validate-agent-state! [params]
  (let [state (.-agent_state params)]
    (when-not (contains? agent-state-set state)
      (throw (ex-info (str "agent_state must be one of " (str/join ", " agent-state-values))
                      {:code :INVALID_ARGUMENT :field :agent_state})))
    state))

(defn- execute-role [role tool-call-id params _signal _on-update ctx]
  (validate-agent-state! params)
  (let [request-digest (digest params)]
    (if-let [cached (and tool-call-id (@receipts tool-call-id))]
      (if (= request-digest (:digest cached))
        (clj->js (receipt-response cached))
        (clj->js (tool-error (replay-mismatch))))
      (let [state (.-agent_state params)
            transition? (claim-state-transition! (session-key ctx) state)
            name (.-name params)
            code (.-code params)]
        (-> (repl/run name code (sandbox-deadline code) role)
            (.then (fn [result]
                     (let [raw (ufss/canonical result)
                           text (if transition? (prepend-state-comment state raw) raw)]
                       (when tool-call-id
                         (swap! receipts assoc tool-call-id
                                {:digest request-digest :text text :error? false}))
                       (clj->js (tool-result text)))))
            (.catch (fn [error]
                      (let [raw (error-text error)
                            text (if transition? (prepend-state-comment state raw) raw)]
                        (when tool-call-id
                          (swap! receipts assoc tool-call-id
                                 {:digest request-digest :text text :error? true}))
                        (clj->js {:isError true
                                  :content [(text-block text)]})))))))))
(defn- execute [tool-call-id params signal on-update ctx]
  (execute-role :devops tool-call-id params signal on-update ctx))

(defn- host-text [result]
  (cond
    (string? result) result
    (and result (.-content result))
    (->> (array-seq (.-content result))
         (keep (fn [block] (when (= "text" (.-type block)) (.-text block))))
         (clojure.string/join ""))
    :else (str result)))

(defn- host-wait []
  (let [native (.-__herdNative js/globalThis)
        runner (when native ((.-getRunner native)))]
    (when (and runner (.hasNativeTool runner "wait"))
      (.invokeNativeTool runner "wait" #js {} #js {}))))

(defn- wait-execute [_tool-call-id params _signal _on-update ctx]
  (let [work (.-otherwise_independent_work params)]
    (when-not (string? work)
      (throw (ex-info "otherwise_independent_work must be a string"
                      {:code :INVALID_ARGUMENT :field :otherwise_independent_work})))
    (-> (repl/wait-for-result (sandbox-deadline work))
        (.then (fn [result]
                 (if (= :idle (:state result))
                   (if-let [host (host-wait)]
                     (-> host
                         (.then (fn [host-result]
                                  (clj->js
                                    (tool-result
                                      (ufss/canonical {:state :host-wait
                                                       :message (host-text host-result)})))))
                         (.catch (fn [error]
                                   (clj->js
                                     (tool-result
                                       (ufss/canonical (assoc result
                                                         :host-error (error-text error))))))))
                     (clj->js (tool-result (ufss/canonical result))))
                   (clj->js (tool-result (ufss/canonical result))))))
        (.catch (fn [error]
                  (clj->js
                    (tool-result
                      (ufss/canonical {:state :waiting
                                       :reason :deadline
                                       :message (str error)}))))))))
(def ^:private newline-char (js/String.fromCharCode 10))

(defn- handoff-parameters []
  {:type "object"
   :additionalProperties false
   :required ["markdown"]
   :properties {:markdown {:type "string" :minLength 1}}})

(defn- content-block-text [block]
  (let [kind (.-type block)]
    (cond
      (= kind "text") (or (.-text block) "")
      (= kind "thinking") (or (.-thinking block) "")
      (= kind "toolCall") (let [args (.-arguments block)]
                            (str "[toolCall " (or (.-name block) "") "] "
                                 (cond
                                   (string? args) args
                                   (nil? args) ""
                                   :else (js/JSON.stringify args))))
      :else "")))

(defn- content-text [content]
  (cond
    (string? content) content
    (array? content) (->> (array-seq content)
                          (map content-block-text)
                          (remove str/blank?)
                          (str/join newline-char))
    (nil? content) ""
    :else (str content)))

(defn- message-text [message]
  (let [base (content-text (.-content message))
        tcs (or (.-tool_calls message) (.-toolCalls message))
        calls (when (array? tcs)
                (->> (array-seq tcs)
                     (map (fn [tc]
                            (let [f (.-function tc)
                                  args (.-arguments f)]
                              (str (or (.-name f) "toolCall") " "
                                   (if (string? args) args (js/JSON.stringify args))))))
                     (str/join newline-char)))]
    (str/join newline-char (remove str/blank? [base calls]))))

(defn- dictionary-text [messages]
  (->> (array-seq messages)
       (map message-text)
       (remove str/blank?)
       (str/join newline-char)))

(defn- message-call-ids [message]
  (let [direct (cond-> []
                 (.-toolCallId message) (conj (.-toolCallId message))
                 (.-tool_call_id message) (conj (.-tool_call_id message)))
        blocks (.-content message)
        calls (let [tcs (or (.-tool_calls message) (.-toolCalls message))]
                (if (array? tcs)
                  (keep (fn [tc] (or (.-id tc) (.-toolCallId tc))) (array-seq tcs))
                  []))
        block-ids (if (array? blocks)
                    (keep (fn [block]
                            (when (= "toolCall" (.-type block))
                              (or (.-toolCallId block) (.-id block))))
                          (array-seq blocks))
                    [])]
    (concat direct block-ids calls)))

(def ^:private handoff-scan-window 512)

(defn- handoff-cut-index [messages tool-call-id]
  (let [n (.-length messages)
        floor (max 0 (- n handoff-scan-window))]
    (loop [i (dec n)]
      (if (< i floor)
        -1
        (if (some (fn [id] (= tool-call-id id)) (message-call-ids (aget messages i)))
          (let [message (aget messages i)]
            (if (and (pos? i)
                     (contains? #{"toolResult" "tool"} (.-role message))
                     (= "assistant" (.-role (aget messages (dec i)))))
              (dec i)
              i))
          (recur (dec i)))))))

(defn- handoff-result? [message tool-call-id]
  (and (contains? #{"toolResult" "tool"} (.-role message))
       (some (fn [id] (= tool-call-id id)) (message-call-ids message))))

(defn- handoff-result-index [messages tool-call-id]
  (let [n (.-length messages)
        floor (max 0 (- n handoff-scan-window))]
    (loop [i (dec n)]
      (if (< i floor)
        -1
        (if (handoff-result? (aget messages i) tool-call-id)
          i
          (recur (dec i)))))))

(defn- handoff-message
  ([text] (handoff-message text (.now js/Date)))
  ([text timestamp]
   (js-obj "role" "user"
           "content" (array (js-obj "type" "text" "text" text))
           "timestamp" timestamp)))

(def ^:private handoff-preamble
  "You are the successor of the previous AI. The following is the handoff material left by your predecessor. Treat it as the authoritative starting context: continue from where it stopped, verify claims against the real workspace, and do not restart from scratch.")

(defn- content-head-text [content]
  (cond
    (string? content) content
    (array? content) (let [block (aget content 0)]
                       (when (and block (string? (.-text block)))
                         (.-text block)))
    :else nil))

(def ^:private handoff-doc-window 32)

(defn- preamble-user?
  """
The handoff document is a user message whose first text block starts with
  the preamble. Check that block first so the hot path never joins a large
  message body; the join stays as a fallback for split preambles.
"""
  [message]
  (and (= "user" (.-role message))
       (let [head (content-head-text (.-content message))]
         (and (string? head)
              (or (.startsWith head handoff-preamble)
                  (and (> (count handoff-preamble) (count head))
                       (.startsWith handoff-preamble head)
                       (.startsWith (content-text (.-content message)) handoff-preamble)))))))

(defn- last-doc-index
  """
Index of the last persisted handoff document, searched in the trailing
  window only. A document older than the window is left in place: the request
  keeps its messages instead of losing them.
"""
  [messages]
  (let [n (.-length messages)
        floor (max 0 (- n handoff-doc-window))]
    (loop [i (dec n)]
      (if (< i floor)
        -1
        (if (preamble-user? (aget messages i))
          i
          (recur (dec i)))))))
(defn- consume-handoff! [ctx messages]
  (let [key (session-key ctx)
        pending (get @last-handoffs key)]
    (or (when pending
          (let [fresh? (nil? (:text pending))
                text (or (:text pending)
                         (let [cut (handoff-cut-index messages (:tool-call-id pending))
                               before (if (>= cut 0) (.slice messages 0 cut) messages)
                               decoded (handoff/decode (:markdown pending) (dictionary-text before))]
                           (if (.startsWith decoded handoff-preamble)
                             decoded
                             (str handoff-preamble newline-char newline-char "---" newline-char newline-char decoded))))
                _ (when-not (:text pending)
                    (swap! last-handoffs assoc-in [key :text] text))
                cached (:result-index pending)
                ridx (if (and (integer? cached)
                              (>= cached 0)
                              (< cached (.-length messages))
                              (handoff-result? (aget messages cached) (:tool-call-id pending)))
                       cached
                       (handoff-result-index messages (:tool-call-id pending)))
                _ (when-not (= ridx (:result-index pending))
                    (swap! last-handoffs assoc-in [key :result-index] ridx))
                tail (if (>= ridx 0) (.slice messages (inc ridx)) (let [idx (last-doc-index messages)] (if (>= idx 0) (.slice messages (inc idx)) (array))))]
            {:messages (.concat (array (handoff-message text (:timestamp pending))) tail)
             :fresh? fresh?}))
        (let [idx (last-doc-index messages)]
          (when (>= idx 0)
            {:messages (.slice messages idx)
             :fresh? false})))))

(defn- handoff-execute [tool-call-id params _signal _on-update ctx]
  (let [markdown (.-markdown params)]
    (when-not (and (string? markdown) (pos? (count (str/trim markdown))))
      (throw (ex-info "markdown must be a non-empty string"
                      {:code :INVALID_ARGUMENT :field :markdown})))
    (let [full (if (.startsWith markdown handoff-preamble)
                 markdown
                 (str handoff-preamble newline-char newline-char "---" newline-char newline-char markdown))]
      (swap! last-handoffs assoc (session-key ctx)
             {:markdown full :tool-call-id tool-call-id :timestamp (.now js/Date) :text nil :result-index nil})
      (clj->js
        (tool-result
          (ufss/canonical {:state :handoff-queued
                           :markdown-chars (count full)
                           :build "handoff-boundary-v9"
                           :note "hackContext applies the cut to the request and synchronizes the host session manager; append-only turns stay O(delta), replacements rewrite once"}))))))

(defn- code-schema [] {:type "string"})
(defn- name-schema [] {:type "string" :minLength 1})
(defn- agent-state-schema []
  {:type "string"
   :enum agent-state-values
   :description "Self-reported control-flow state. Orienting: divergent exploration and framing. Converging: steady progress that verifiably narrows the goal gap. Consolidating: checkpointing and preserving completed work. Stagnant: repeated ineffective actions without state change. Drifting: activity diverging from the original goal. Densifying: context has accumulated rich details and working memory is crowded with data; success may still come smoothly, but focus must stay razor-sharp. Reorienting: rolling back, pruning, or replanning after stagnation or drift. Settled: the goal is reached and verified."})
(defn- workers-schema [] {:type "integer" :minimum 0})
(defn- work-schema [] {:type "string" :minLength 1})

(defn- devops-parameters []
  {:type "object"
   :additionalProperties false
   :required ["code" "name" "agent_state"]
   :properties {:code (code-schema)
                :name (name-schema)
                :agent_state (agent-state-schema)
                :more_workers_without_hitting_mythical_man_month (workers-schema)}})

(defn- wait-parameters []
  {:type "object"
   :additionalProperties false
   :required ["otherwise_independent_work"]
   :properties {:otherwise_independent_work (work-schema)}})

(defn- safe-execute [handler]
  (fn [tool-call-id params signal on-update ctx]
    (try
      (handler tool-call-id params signal on-update ctx)
      (catch :default error
        (clj->js (tool-error error))))))

(defn- register! [pi definition]
  (.registerTool pi (clj->js definition)))

(defn- role-execute [role]
  (safe-execute (fn [id params signal update ctx]
                  (execute-role role id params signal update ctx))))

(defn- worker-execute [id params signal update ctx]
  (execute-role (if (= "Swarm Holder" (system/role-of-ctx ctx)) :holder :worker)
                id params signal update ctx))

(defn- register-role! [pi role name label description]
  (register! pi {:name name
                 :label label
                 :description description
                 :parameters (devops-parameters)
                 :renderCall ui/clj-render-call
                 :renderResult ui/clj-render-result
                 :execute (role-execute role)}))

(defn- register-worker! [pi]
  (register! pi {:name "clj_worker"
                 :label "Clojure Sandbox (Swarm Worker)"
                 :description "All capabilities return js/Promise (no await). Always (require '[promesa.core :as p]) and use p/let, p/do, p/loop/p/recur, p/catch, p/all; never hand-roll .then/.catch chains. Holder gets call; Worker does not. Require other namespaces at the top level as needed."
                 :parameters (devops-parameters)
                 :renderCall ui/clj-render-call
                 :renderResult ui/clj-render-result
                 :execute (safe-execute worker-execute)}))

(defn register-all! [pi]
  (register! pi {:name "clj_devops"
                 :label "Clojure Sandbox (Plan DevOps)"
                 :description "All capabilities return js/Promise (no await). Always (require '[promesa.core :as p]) and use p/let, p/do, p/loop/p/recur, p/catch, p/all; never hand-roll .then/.catch chains or custom combinators. Require other namespaces at the top level as needed; writes may run concurrently and are serialized by the write gate."
                 :parameters (devops-parameters)
                 :renderCall ui/clj-render-call
                 :renderResult ui/clj-render-result
                 :execute (safe-execute execute)})
  (register! pi {:name "wait"
                 :label "Wait"
                 :description "Collect the next completed sandbox program."
                 :parameters (wait-parameters)
                 :renderCall ui/wait-render-call
                 :renderResult ui/wait-render-result
                 :execute (safe-execute wait-execute)})
  (register-role! pi :plan "clj_plan" "Clojure Sandbox (Plan)" "Read-only planning sandbox: cat, read, where, whereAll, park, unpark. No write or call.")
  (register-role! pi :review "clj_review" "Clojure Sandbox (Reviewer)" "Read-only reviewer sandbox: cat, read, stat, ls, glob, where, whereAll, unpark. No write, call, or park.")
  (register-worker! pi)
  (register-role! pi :auditor "clj_auditor" "Clojure Sandbox (Manual Auditor)" "Auditor sandbox: read-only main workspace plus call for tmux and isolated /tmp experiments. No write."))

(defn- ignore-rejection [value]
  (when (and value (fn? (.-catch value)))
    (.catch value (fn [_] nil))))

(declare subagent-ctx?)

(def ^:private herd-tools ["clj_devops" "wait" "handoff"])

(def ^:private host-tool-blacklist
  #{"read" "write" "edit" "apply_patch" "ast_edit" "ast_grep"
    "bash" "exec" "eval" "glob" "grep" "find"})

(defn- apply-tool-surface! [ctx]
  ;; A mission owns a narrow surface. Without one every session is the
  ;; devops surface: drop the host edit/shell tools, keep everything else,
  ;; and ensure the herd tools are active.
  (if (system/apply-mission-surface! js/globalThis.__pi ctx)
    nil
    (try
      (let [pi js/globalThis.__pi
            active (vec (js->clj (.getActiveTools pi)))
            kept (->> active
                      (remove host-tool-blacklist)
                      (concat herd-tools)
                      distinct
                      vec)]
        (when (not= (set active) (set kept))
          (ignore-rejection (.setActiveTools pi (clj->js kept)))))
      (catch :default _ nil))))

(def ^:private system-prompt-start "<!-- herdchestra:system-prompt v1 -->")
(def ^:private system-prompt-end "<!-- /herdchestra:system-prompt -->")

(defn- managed-block []
  (str system-prompt-start "\n" prompts/common-rules-text "\n" system-prompt-end))

(defn- replace-managed [text]
  (let [b (str/index-of text system-prompt-start)
        e (str/index-of text system-prompt-end (if b (+ b (count system-prompt-start)) 0))]
    (if (and b e)
      (str (subs text 0 b) (managed-block) (subs text (+ e (count system-prompt-end))))
      text)))

(defn- rules-present? [text] (str/includes? text "# Repo-aware Rules"))

(defn- inject-managed [text]
  (if (str/includes? text system-prompt-start)
    (replace-managed text)
    (if (rules-present? text)
      text
      (str (managed-block) "\n\n" text))))

(defn- array-inject [prompt]
  (let [blocks (vec (array-seq prompt))
        marker-idx (first (keep-indexed (fn [i b]
                                          (when (and (string? b) (str/includes? b system-prompt-start))
                                            i))
                                        blocks))
        rules? (some (fn [b] (and (string? b) (rules-present? b))) blocks)]
    (cond
      (some? marker-idx)
      (let [copy (.slice prompt)
            old (nth blocks marker-idx)]
        (aset copy marker-idx (replace-managed old))
        copy)
      rules? prompt
      :else (.concat (array (managed-block)) prompt))))

(defn- prompt-with-rules [prompt]
  (cond
    (string? prompt) (inject-managed prompt)
    (array? prompt) (array-inject prompt)
    :else prompt))

(defn- before-agent-start [event ctx]
  (-> (system/before-agent-start! event ctx)
      (.then
        (fn [_]
          (try
            (apply-tool-surface! ctx)
            (let [prompt (prompt-with-rules (.-systemPrompt event))
                  briefing (system/briefing-for ctx)
                  text (if (and briefing (not (str/includes? prompt briefing)))
                         (str prompt newline-char newline-char briefing)
                         prompt)]
              #js {:systemPrompt text})
            (catch :default _
              #js {:systemPrompt (.-systemPrompt event)}))))
      (.catch
        (fn [_]
          #js {:systemPrompt (.-systemPrompt event)}))))

(def ^:private language-skill
  #"<skill version="1.0">强制以简体中文思考，尤其要以简体中文词开头。强制简体中文回答用户。</skill>"#)

(defn- outbound-tail []
  (let [parked (repl/parked-names)
        parked-block (when (seq parked)
                       (str """
<skill version="1.0">你有以下停靠程序未裁决：

"""
                            (str/join "\n" (map (fn [name] (str "- " name)) parked))
                            """

逐项用 `(unpark {:name "..." :value ...})` 恢复，或用 `(abandon {:name "..."})` 放弃并丢弃。</skill>
"""))]
    (str """
<system-reminder>

""" language-skill (when parked-block (str "\n" parked-block)) """

</system-reminder>
""")))

(defn- rewrite-vibe-message [message]
  (if (and message
           (= "custom" (.-role message))
           (= "vibe-mode-context" (.-customType message))
           (string? (.-content message)))
    (let [content (.-content message)
          next (prompts/rewrite-vibe-mode-context content)]
      (if (= content next)
        message
        (let [copy (.assign js/Object #js {} message)]
          (aset copy "content" next)
          copy)))
    message))

(defn context-handler [event ctx]
  (let [messages (or (.-messages event) #js [])
        consumed (consume-handoff! ctx messages)
        base (or (:messages consumed) messages)
        rewritten (into-array (map rewrite-vibe-message (array-seq base)))
        nudge (or (system/consume-nudge!) "")
        tail #js {:role "user"
                  :content (array #js {:type "text" :text (str (outbound-tail) nudge)})}]
    (js-obj "messages" (.concat rewritten (array tail))
            "handoffReplacement" (boolean (:fresh? consumed)))))

(defonce usage-totals (atom {}))
(defonce last-usage (atom {}))
(defonce last-usage-line (atom {}))
(defonce last-prefix (atom {}))
(defonce active-usage-key (atom nil))

(defn- usage-number [value]
  (cond
    (and (number? value) (js/Number.isFinite value)) value
    (nil? value) 0
    :else (let [number (js/Number value)]
            (if (js/Number.isNaN number) 0 number))))

(defn- usage-field [usage names]
  (try
    (some (fn [name]
            (let [value (aget usage name)]
              (when (some? value) value)))
          names)
    (catch :default _ nil)))

(defn- usage-cost [usage]
  (let [cost (.-cost usage)
        total-cost (usage-field usage ["total_cost" "totalCost" "cost_total"])]
    (cond
      (number? cost) (usage-number cost)
      (and cost (some? (.-total cost))) (usage-number (.-total cost))
      (some? total-cost) (usage-number total-cost)
      :else 0)))

(defn- usage-snapshot [usage]
  {:input (usage-number (usage-field usage ["input" "input_tokens" "inputTokens" "prompt_tokens" "promptTokens"]))
   :cache-read (usage-number (usage-field usage ["cacheRead" "cache_read" "cache_read_input_tokens" "cacheReadInputTokens"]))
   :cache-write (usage-number (usage-field usage ["cacheWrite" "cache_write" "cache_creation_input_tokens" "cacheCreationInputTokens"]))
   :output (usage-number (usage-field usage ["output" "output_tokens" "outputTokens" "completion_tokens" "completionTokens"]))
   :cost (usage-cost usage)})

(defn- zero-usage []
  {:input 0 :cache-read 0 :cache-write 0 :output 0 :cost 0})

(defn- total-input [snapshot]
  (+ (:input snapshot) (:cache-read snapshot) (:cache-write snapshot)))

(defn- cache-rate [snapshot]
  (let [total (total-input snapshot)]
    (if (pos? total) (* 100.0 (/ (:cache-read snapshot) total)) 0.0)))

(defn- k-format [tokens]
  (str (.toFixed (/ tokens 1000) 1) "k"))

(defn- pct-format [rate]
  (str (.toFixed rate 1) "%"))

(def ^:private bold-digits ["𝟬" "𝟭" "𝟮" "𝟯" "𝟰" "𝟱" "𝟲" "𝟳" "𝟴" "𝟵"])

(defn- bold-number [text]
  (apply str (map (fn [ch]
                    (let [d (- (.charCodeAt ch 0) 48)]
                      (if (and (>= d 0) (<= d 9)) (nth bold-digits d) ch)))
                  text)))

(defn- usage-line [current total]
  (str "Δ: " (k-format (total-input current))
       " × " (pct-format (cache-rate current))
       " → " (k-format (:output current))
       " [¥" (bold-number (.toFixed (:cost current) 3)) "]; Σ: "
       (k-format (total-input total))
       " × " (pct-format (cache-rate total))
       " → " (k-format (:output total))
       " [¥" (bold-number (.toFixed (:cost total) 3)) "];"))

(defn- add-usage! [key snapshot]
  (swap! usage-totals update key #(merge-with + (or % {}) snapshot)))

(defn- subagent-ctx? [ctx]
  (let [agent (.-agent ctx)]
    (and agent
         (or (= "sub" (.-kind agent))
             (= "subagent" (.-kind agent))
             (let [depth (.-depth agent)]
               (and (number? depth) (pos? depth)))))))

(defn- total-usage []
  (reduce (fn [total snapshot] (merge-with + total snapshot))
          (zero-usage)
          (vals @usage-totals)))

(defn- entry-usage [entry]
  (case (.-type entry)
    "message" (let [message (.-message entry)]
                (when (and message (= "assistant" (.-role message)))
                  (.-usage message)))
    "model_usage" (.-usage entry)
    nil))

(defonce ui-render
  (atom {:usage-last nil :last-working {}}))

(defonce usage-timers (atom {}))
(defonce usage-last-emit (atom {}))
(def ^:private usage-throttle-ms 100)

(defonce wrapped-working-uis (js/WeakSet.))
(defonce last-host-working-text (atom nil))

(defn- install-working-message-guard! [ui]
  (when (and ui
             (fn? (.-setWorkingMessage ui))
             (not (fn? (.-getWorkingMessage ui)))
             (not (.has wrapped-working-uis ui)))
    (.add wrapped-working-uis ui)
    (let [original (.-setWorkingMessage ui)]
      (aset ui "setWorkingMessage"
            (fn [text]
              (reset! last-host-working-text text)
              (.call original ui text))))))

(defn- current-host-working-text [ui]
  (try
    (if (and ui (fn? (.-getWorkingMessage ui)))
      (.getWorkingMessage ui)
      @last-host-working-text)
    (catch :default _ @last-host-working-text)))

(defn- init-session-usage! [ctx]
  (let [key (session-key ctx)]
    (swap! usage-totals assoc key (zero-usage))
    (swap! last-usage assoc key (zero-usage))
    (swap! last-usage-line dissoc key)
    (swap! last-prefix dissoc key)
    (when-not (subagent-ctx? ctx)
      (swap! ui-render (fn [state]
                         (-> state
                             (assoc :usage-last nil)
                             (update :last-working dissoc key)))))
    (try
      (let [manager (.-sessionManager ctx)
            branch (when (and manager (fn? (.-getBranchView manager)))
                     (.getBranchView manager))]
        (when branch
          (doseq [entry (array-seq branch)]
            (when-let [usage (entry-usage entry)]
              (add-usage! key (usage-snapshot usage))))))
      (catch :default _ nil))))

(defn- apply-working-message! [ctx text]
  (when-not (subagent-ctx? ctx)
    (let [ui (.-ui ctx)]
      (when (and (.-hasUI ctx) ui (fn? (.-setWorkingMessage ui)))
        (install-working-message-guard! ui)
        (.setWorkingMessage ui text)
        (reset! last-host-working-text text)
        (swap! ui-render assoc-in [:last-working (session-key ctx)] text)))))

(defn- usage-current-text [ctx]
  (let [key (session-key ctx)
        own (get @last-usage key (zero-usage))
        active @active-usage-key
        active-snapshot (when active (get @last-usage active))
        current (if (and active-snapshot
                         (some pos? [(:input active-snapshot)
                                     (:cache-read active-snapshot)
                                     (:cache-write active-snapshot)
                                     (:output active-snapshot)
                                     (:cost active-snapshot)]))
                  active-snapshot
                  own)]
    (usage-line current (total-usage))))

(defn- flush-usage! [ctx]
  (try
    (let [key (session-key ctx)
          text (usage-current-text ctx)
          last (get (:last-working @ui-render) key)]
      (when (not= text last)
        (swap! ui-render assoc :usage-last text)
        (apply-working-message! ctx text)))
    (catch :default _ nil)))

(defn- reconcile-working-message! [ctx]
  (try
    (when (and (not (subagent-ctx? ctx)) (.-hasUI ctx))
      (let [ui (.-ui ctx)]
        (when (and ui (fn? (.-setWorkingMessage ui)))
          (install-working-message-guard! ui)
          (let [target (usage-current-text ctx)
                host (current-host-working-text ui)]
            (when (not= host target)
              (apply-working-message! ctx target))))))
    (catch :default _ nil)))

(defn- clear-usage-timer! [key]
  (when-let [timer (get @usage-timers key)]
    (clock/clear-timeout timer)
    (swap! usage-timers dissoc key)))

(defn- mark-usage-emitted! [key]
  (swap! usage-last-emit assoc key (clock/now)))

(defn- show-usage!
  "Event-driven UI update: only a real hook event may write the working line. Identical text is never re-sent; a host overwrite is restored on the next event."
  [ctx]
  (try
    (when (and (not (subagent-ctx? ctx)) (.-hasUI ctx))
      (let [key (session-key ctx)]
        (clear-usage-timer! key)
        (mark-usage-emitted! key))
      (flush-usage! ctx)
      (reconcile-working-message! ctx))
    (catch :default _ nil)))

(defn- schedule-usage!
  "Coalesce streaming usage ticks; at most one UI write per 100ms per session."
  [ctx]
  (try
    (when (and (not (subagent-ctx? ctx)) (.-hasUI ctx))
      (let [key (session-key ctx)
            now (clock/now)
            last (get @usage-last-emit key 0)
            wait (max 0 (- usage-throttle-ms (- now last)))]
        (when-not (contains? @usage-timers key)
          (swap! usage-timers assoc key
                 (clock/set-timeout
                   (fn []
                     (swap! usage-timers dissoc key)
                     (show-usage! ctx))
                   wait)))))
    (catch :default _ nil)))

(defn- session-prefix [ctx]
  (let [manager (.-sessionManager ctx)
        name (when (and manager (fn? (.-getSessionName manager)))
               (.getSessionName manager))]
    (when (and name (string? name))
      (if-let [match (re-matches #"^(\S+) ([A-Z0-9]{1,6}): .*$" name)]
        (str (nth match 1) " " (nth match 2))
        name))))

(defn- show-session-prefix!
  "Event-driven status update: write only when the prefix changes."
  [ctx]
  (try
    (let [key (session-key ctx)
          prefix (session-prefix ctx)]
      (when (and prefix
                 (not (subagent-ctx? ctx))
                 (not= prefix (get @last-prefix key)))
        (swap! last-prefix assoc key prefix)
        (let [ui (.-ui ctx)]
          (when (and (.-hasUI ctx) ui (fn? (.-setStatus ui)))
            (.setStatus ui "herd-session" prefix)))))
    (catch :default _ nil)))

(defn- host-label []
  (try
    (let [os (js/require "node:os")
          user (.-username (.userInfo os))
          host (aget (.split (.hostname os) ".") 0)]
      (when (and user host (not (str/blank? user)) (not (str/blank? host)))
        (str user "@" host)))
    (catch :default _ nil)))

(defn- show-host! [ctx]
  (try
    (let [label (host-label)
          ui (.-ui ctx)]
      (when (and (.-hasUI ctx) ui (fn? (.-setStatus ui)) label)
        (.setStatus ui "herd-host" label)))
    (catch :default _ nil)))

(defn- activity-handler [event ctx]
  (let [message (.-message event)]
    (when (and message (= "user" (.-role message)))
      (system/note-human-input! event)))
  (try
    (show-usage! ctx)
    (catch :default _ nil)))

(defn- message-end-handler [event ctx]
  (try
    (let [message (.-message event)]
      (when (and message (= "assistant" (.-role message)))
        (let [usage (.-usage message)]
          (when usage
            (let [key (session-key ctx)
                  snapshot (usage-snapshot usage)]
              (add-usage! key snapshot)
              (swap! last-usage assoc key snapshot)
              (when (subagent-ctx? ctx)
                (reset! active-usage-key key))
              (show-session-prefix! ctx))))))
    ;; A completed message is a discrete event, not a streaming tick.
    ;; Check every message_end so a host overwrite is restored even when
    ;; the event carries no usage payload.
    (show-usage! ctx)
    (catch :default _ nil)))

(defn- tool-start-handler [_event ctx]
  (show-usage! ctx)
  (js/queueMicrotask (fn [] (show-usage! ctx))))

(defn- message-update-handler [_event ctx]
  (schedule-usage! ctx))

(defn- tool-update-handler [_event ctx]
  (schedule-usage! ctx))

(defn- session-start [_event ctx]
  (reset! last-agent-states {})
  (let [manager (.-sessionManager ctx)]
    (reset! live-session-manager manager)
    (when manager
      (js/Reflect.set js/globalThis "__herdSessionManager" manager)))
  (init-session-usage! ctx)
  (show-session-prefix! ctx)
  (show-host! ctx)
  (show-usage! ctx)
  (apply-tool-surface! ctx)
  (-> (system/session-start! ctx)
      (.then (fn [_] (apply-tool-surface! ctx)))
      (.catch (fn [_] nil))))

(defonce probe-last-write (atom nil))
(defonce probe-tail (atom (js/Promise.resolve nil)))
(defonce probe-truncated (atom nil))

(def ^:private probe-file-limit (* 1024 1024))
(def ^:private probe-window-bytes 1024)

(defn- env-value [name]
  (try (aget (.-env js/process) name) (catch :default _ nil)))

(defn- probe-enabled? []
  (= "1" (env-value "HERD_CACHE_PROBE")))

(defn- probe-target []
  (or (env-value "HERD_CACHE_PROBE_PATH") ".herd/cache-probe.jsonl"))

(defn- probe-dir [target]
  (let [i (.lastIndexOf target "/")]
    (if (pos? i) (.substring target 0 i) ".")))

(def ^:private trace-file-limit (* 1024 1024))
(defonce trace-tail (atom (js/Promise.resolve nil)))
(defonce trace-truncated (atom nil))

(defn- trace-enabled? []
  (= "1" (env-value "HERD_TRACE")))

(defn- trace-target []
  (or (env-value "HERD_TRACE_PATH") ".herd/perf-trace.jsonl"))

(defn- trace-payload-bytes
  "Measured after the handler, so the cost never inflates the timing itself."
  [value]
  (try
    (js/Buffer.byteLength (js/JSON.stringify (or value #js {})) "utf8")
    (catch :default _ -1)))

(defn- append-trace!
  """
Append one diagnostic line off the hook path. Serial queue, 1 MiB cap, one
  truncated marker. Diagnostics must never break a request.
"""
  [line]
  (swap! trace-tail
         (fn [previous]
           (-> previous
               (.then
                 (fn [_]
                   (let [target (trace-target)]
                     (when-not (= target @trace-truncated)
                       (-> (.stat fs target)
                           (.then (fn [stats] (.-size stats)))
                           (.catch (fn [_] 0))
                           (.then
                             (fn [size]
                               (let [bytes (js/Buffer.byteLength line "utf8")]
                                 (if (> (+ size bytes) trace-file-limit)
                                   (do
                                     (reset! trace-truncated target)
                                     (-> (.mkdir fs (probe-dir target) #js {:recursive true})
                                         (.then
                                           (fn [_]
                                             (.appendFile fs target
                                                          (str newline-char
                                                               (js/JSON.stringify
                                                                 #js {:truncated true
                                                                      :limit trace-file-limit
                                                                      :at (.now js/Date)})
                                                               newline-char)
                                                          "utf8")))
                                         (.catch (fn [_] nil))))
                                   (-> (.mkdir fs (probe-dir target) #js {:recursive true})
                                       (.then (fn [_] (.appendFile fs target line "utf8")))
                                       (.catch (fn [_] nil))))))))))))
               (.catch (fn [_] nil))))))

(defn- trace-handler-name [hook handler]
  (let [name (try (.-name handler) (catch :default _ nil))]
    (if (and (string? name) (pos? (count name))) name hook)))

(defn- record-trace! [hook handler total-ms sync-ms event ctx]
  (when (>= total-ms 20)
    (try
      (append-trace!
        (str (js/JSON.stringify
               #js {:at (.now js/Date)
                    :hook hook
                    :handler handler
                    :ms (.toFixed total-ms 1)
                    :sync-ms (.toFixed sync-ms 1)
                    :bytes (trace-payload-bytes event)
                    :agent (session-key ctx)})
             newline-char))
      (catch :default _ nil))))

(defn- trace-hook [hook handler]
  (fn [event ctx]
    (let [started (.now js/performance)
          name (trace-handler-name hook handler)
          record (fn [sync-ms]
                   (record-trace!
                     hook name (- (.now js/performance) started) sync-ms event ctx))]
      (when (and (= hook "before_agent_start")
                 (not (subagent-ctx? ctx))
                 (not (.-__herdAgentShapeLogged js/globalThis)))
        (aset js/globalThis "__herdAgentShapeLogged" true)
        (let [agent (when ctx (.-agent ctx))]
          (append-trace!
            (str (js/JSON.stringify
                   #js {:at (.now js/Date)
                        :hook "agent-shape"
                        :kind (when agent (.-kind agent))
                        :depth (when agent (.-depth agent))
                        :id (when agent (.-id agent))})
                 newline-char))))
      (try
        (let [result (handler event ctx)
              sync-ms (- (.now js/performance) started)]
          (if (and result (fn? (.-then result)))
            (.then result
                   (fn [value] (record sync-ms) value)
                   (fn [error] (record sync-ms) (js/Promise.reject error)))
            (do (record sync-ms) result)))
        (catch :default error
          (record (- (.now js/performance) started))
          (throw error))))))

(defn- install-trace-proxy!
  """
Wrap `pi.on` before any hook is registered, so system and main handlers
  share one timer. Only installed when tracing is enabled; default runs keep
  the original function.
"""
  []
  (let [pi js/globalThis.__pi
        original (.-on pi)]
    (when (and (fn? original) (not (.-__herdTraceProxy pi)))
      (aset pi "__herdTraceProxy" true)
      (aset pi "on"
            (fn [hook handler]
              (.call original pi hook (trace-hook (str hook) handler)))))))

(defn- sha256-bytes [bytes]
  (let [crypto (js/require "node:crypto")]
    (.digest (.update (.createHash crypto "sha256") bytes) "hex")))

(defn- text-summary
  """
Length plus a hash of the whole text, or of its first and last 1 KiB.
  Never serializes anything beyond the two fixed-size windows.
"""
  [value]
  (let [text (str value)
        buf (js/Buffer.from text "utf8")
        n (.-length buf)]
    (if (<= n (* 2 probe-window-bytes))
      {:chars (count text) :hash (sha256-bytes buf)}
      {:chars (count text)
       :head (sha256-bytes (.subarray buf 0 probe-window-bytes))
       :tail (sha256-bytes (.subarray buf (- n probe-window-bytes)))})))

(defn- tools-text [tools]
  (try (js/JSON.stringify (or tools #js [])) (catch :default _ "unserializable")))

(defn- messages-summary [messages]
  (let [n (if (and messages (number? (.-length messages))) (.-length messages) 0)
        last (when (and (pos? n) (array? messages)) (aget messages (dec n)))
        size (when last
               (try (count (js/JSON.stringify last)) (catch :default _ -1)))]
    (cond-> {:count n}
      last (assoc :last-role (str (or (.-role last) "unknown"))
                  :last-chars size))))

(defn- probe-entry [payload]
  (let [system (text-summary (or (.-system payload) (.-systemPrompt payload) ""))
        tools (text-summary (tools-text (.-tools payload)))
        messages (messages-summary (.-messages payload))]
    {:at (.now js/Date)
     :payload-keys (try (vec (js/Object.keys payload)) (catch :default _ []))
     :prompt-cache-key (str (.-prompt_cache_key payload))
     :model (str (.-model payload))
     :max-tokens (str (.-max_tokens payload))
     :reasoning-effort (str (.-reasoning_effort payload))
     :system system
     :tools tools
     :messages messages
     :signature (str/join "|" [(pr-str system) (pr-str tools) (pr-str messages)])}))

(defn- append-probe!
  """
Append one diagnostic line off the request path. The queue is serial, so a
  failed write never reorders later lines. The file stops at 1 MiB and ends
  with a single :truncated marker.
"""
  [line]
  (swap! probe-tail
         (fn [previous]
           (-> previous
               (.then
                 (fn [_]
                   (let [target (probe-target)]
                     (when-not (= target @probe-truncated)
                       (-> (.stat fs target)
                           (.then (fn [stats] (.-size stats)))
                           (.catch (fn [_] 0))
                           (.then
                             (fn [size]
                               (let [bytes (js/Buffer.byteLength line "utf8")
                                     total (+ size bytes)]
                                 (if (> total probe-file-limit)
                                   (do
                                     (reset! probe-truncated target)
                                     (-> (.mkdir fs (probe-dir target) #js {:recursive true})
                                         (.then
                                           (fn [_]
                                             (.appendFile fs target
                                                          (str newline-char
                                                               (js/JSON.stringify
                                                                 #js {:truncated true
                                                                      :limit probe-file-limit
                                                                      :at (.now js/Date)})
                                                               newline-char)
                                                          "utf8")))
                                         (.catch (fn [_] nil))))
                                   (-> (.mkdir fs (probe-dir target) #js {:recursive true})
                                       (.then (fn [_] (.appendFile fs target line "utf8")))
                                       (.catch (fn [_] nil))))))))))))
               (.catch (fn [_] nil))))))

(defn- record-probe! [payload]
  (try
    (let [entry (probe-entry payload)
          now (.now js/Date)
          previous @probe-last-write]
      (when-not (and previous
                     (= (:signature previous) (:signature entry))
                     (< (- now (:at previous)) 5000))
        (reset! probe-last-write {:signature (:signature entry) :at now})
        (append-probe! (str (js/JSON.stringify (clj->js (dissoc entry :signature)))
                            newline-char))))
    (catch :default _ nil)))

(defn- probe-request [event ctx]
  (show-usage! ctx)
  (let [payload (or (.-payload event) event)]
    (when (probe-enabled?)
      (record-probe! payload))
    payload))
(defonce activated-pis (js/WeakSet.))

(defn install-hooks!
  ([] (install-hooks! js/globalThis.__pi))
  ([pi]
   (.on pi "before_agent_start" before-agent-start)
   (.on pi "session_start"
        session-start)
   (.on pi "before_provider_request" probe-request)
   (.on pi "message_end" message-end-handler)
   (.on pi "message_update" message-update-handler)
   (.on pi "tool_execution_start" tool-start-handler)
   (.on pi "tool_execution_update" tool-update-handler)
   (.on pi "before_agent_start" activity-handler)
   (.on pi "message_start" activity-handler)
   (.on pi "tool_execution_end" activity-handler)))

(defonce registered-clj-pis (js/WeakSet.))

(defn- register-clj-tools! [pi]
  (when-not (.has registered-clj-pis pi)
    (.add registered-clj-pis pi)
    (register-all! pi)
    (register! pi {:name "handoff"
                   :label "Handoff"
                   :description "Compress the current conversation into a handoff that lets a successor continue. Let the content determine the form: choose sections, headings, and length from what the successor actually needs. Do not apply a fixed template, add ceremonial sections, or pad for symmetry; omit anything that does not change the successor's next decision. markdown uses [AAA⯮BBB] refs: from the unique AAA to the unique BBB; non-unique or unresolvable refs stay literal; spans already emitted by earlier refs are not repeated. Returns a placeholder immediately; the next context hook decodes the document against the messages before this call and replaces the whole conversation with the result."
                   :parameters (handoff-parameters)
                   :renderCall ui/handoff-render-call
                   :renderResult ui/handoff-render-result
                   :execute (safe-execute handoff-execute)})))

(defn activate-session! [pi]
  (when (and pi (not (.has activated-pis pi)))
    (.add activated-pis pi)
    (register-clj-tools! pi)
    (system/install! pi)
    (install-hooks! pi)
    true))

(when (trace-enabled?)
  (install-trace-proxy!))
(activate-session! js/globalThis.__pi)