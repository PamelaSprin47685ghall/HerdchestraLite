(ns herd.tool-hide)

(def ^:private hidden-tools
  #{"read" "write" "edit" "apply_patch" "ast_edit" "ast_grep"
    "bash" "exec" "eval" "glob" "grep" "find"})

(defn- tool-name [tool]
  (or (when (object? tool) (.-name tool))
      (when (object? tool) (some-> (.-function tool) (.-name)))
      (get tool "name")
      (get-in tool ["function" "name"])))

(defn hide
  "Strip model-facing tool definitions while keeping them active in the host."
  [payload]
  (let [tools (when (object? payload) (.-tools payload))]
    (if (and tools (array? tools))
      (let [kept (vec (remove (fn [tool] (contains? hidden-tools (tool-name tool)))
                              (array-seq tools)))]
        (if (= (count kept) (.-length tools))
          payload
          (let [copy (js/Object.assign #js {} payload)]
            (aset copy "tools" (.from js/Array kept))
            copy)))
      payload)))
