(ns herd.ufss
  (:require
   ["@chrisoakman/standard-clojure-style" :as formatter-module]
   [cljs.pprint :as pp]
   [clojure.edn :as edn]
   [clojure.string :as str]
   [edamame.core :as edamame]))

(def ^:private formatter (.-default formatter-module))

(def ^:private space-char \space)
(def ^:private quote-str (str (char 34)))
(def ^:private triple-quote (apply str (repeat 3 (char 34))))
(def ^:private newline-str (str (char 10)))
(def ^:private backslash-str (str (char 92)))
(def ^:private space-str (str (char 32)))
(def ^:private tab-str (str (char 9)))
(def ^:private cr-str (str (char 13)))
(def ^:private ff-str (str (char 12)))

(defn- skip-string [s start]
  (let [n (count s)]
    (loop [i (inc start)]
      (if (>= i n)
        n
        (let [ch (subs s i (inc i))]
          (cond
            (= ch backslash-str) (recur (+ i 2))
            (= ch quote-str) (inc i)
            :else (recur (inc i))))))))

(defn- strip-block [body indent]
  (let [lines (str/split body #"\n" -1)]
    (str/join
      newline-str
      (map (fn [line]
             (if (empty? line)
               ""
               (let [spaces (count (take-while #(= % space-char) line))]
                 (subs line (min spaces indent)))))
           lines))))

(defn- read-multi [s hashes q]
  (let [fence (str triple-quote (apply str (repeat hashes "#")))
        body-start (+ q 4)
        n (count s)]
    (loop [line-start body-start]
      (if (>= line-start n)
        (throw (ex-info "unclosed raw block" {:code :UFSS_UNCLOSED}))
        (let [line-end (or (str/index-of s newline-str line-start) n)
              line (subs s line-start line-end)
              spaces (count (take-while #(= % space-char) line))
              after (subs line spaces)]
          (if (str/starts-with? after fence)
            (let [body-end (max body-start (dec line-start))
                  body (subs s body-start body-end)
                  end (+ line-start spaces (count fence))]
              [(strip-block body spaces) end])
            (recur (if (= line-end n) n (inc line-end)))))))))

(defn- read-single [s hashes q]
  (let [fence (apply str (repeat hashes "#"))
        close (str quote-str fence)
        end (str/index-of s close (inc q))]
    (when (and end (not (str/includes? (subs s (inc q) end) newline-str)))
      [(subs s (inc q) end) (+ end (count close))])))

(defn- fence-at [s i]
  (let [n (count s)
        hashes (loop [h 0]
                 (if (and (< (+ i h) n) (= "#" (subs s (+ i h) (inc (+ i h)))))
                   (recur (inc h))
                   h))
        q (+ i hashes)]
    (when (and (< q n) (= quote-str (subs s q (inc q))))
      (let [multiline? (str/starts-with? (subs s q) (str triple-quote newline-str))]
        (if-let [[body end] (if multiline?
                              (read-multi s hashes q)
                              (read-single s hashes q))]
          {:hashes hashes :multiline? multiline? :body body :end end}
          nil)))))

(defn- read-fence [s i min-hashes]
  (when-let [f (fence-at s i)]
    (when (>= (:hashes f) min-hashes)
      [(:body f) (:end f)])))

(defn- comment-end [source i]
  (let [nl (str/index-of source newline-str i)]
    (if nl (inc nl) (count source))))

(defn- char-literal-end [source i]
  (min (count source) (+ i 2)))

(defn unwrap
  "Replace UFSS fences with standard CLJS strings."
  ([source] (unwrap source 1))
  ([source min-hashes]
   (let [n (count source)]
     (loop [i 0 out []]
       (if (>= i n)
         (apply str out)
         (let [ch (subs source i (inc i))]
           (cond
             (= ch ";")
             (let [end (comment-end source i)]
               (recur end (conj out (subs source i end))))

             (= ch quote-str)
             (if (str/starts-with? (subs source i) (str triple-quote newline-str))
               (if-let [[body end] (read-multi source 0 i)]
                 (recur end (conj out (pr-str body)))
                 (recur (inc i) (conj out (subs source i (inc i)))))
               (let [end (skip-string source i)]
                 (recur end (conj out (subs source i end)))))

             (= ch backslash-str)
             (let [end (char-literal-end source i)]
               (recur end (conj out (subs source i end))))

             (= ch "#")
             (if-let [[body end] (read-fence source i min-hashes)]
               (recur end (conj out (pr-str body)))
               (recur (inc i) (conj out (subs source i (inc i)))))

             :else
             (recur (inc i) (conj out (subs source i (inc i)))))))))))

(defn syntax-spans
  "Read source with the formatter's parser and return string, delimiter, and verb spans."
  [source]
  (try
    (let [strings (atom [])
          delims (atom {})
          verbs (atom {})
          tree (.parse formatter source)
          collections #{"parens" "brackets" "braces" "set"}]
      (letfn [(walk [node depth]
                (let [name (.-name node)
                      kids (.-children node)]
                  (cond
                    (= name "string")
                    (swap! strings conj {:start (.-startIdx node)
                                         :end (.-endIdx node)
                                         :base-depth depth})

                    (contains? collections name)
                    (let [open (aget kids 0)
                          close (aget kids (dec (.-length kids)))
                          open-text (.-text open)
                          body (aget kids 1)
                          open-index (+ (.-startIdx open) (dec (count open-text)))
                          close-index (.-startIdx close)]
                      (swap! delims assoc open-index depth)
                      (swap! delims assoc close-index depth)
                      (when (= name "parens")
                        (let [body-kids (.-children body)
                              verb (loop [i 0]
                                     (if (>= i (.-length body-kids))
                                       nil
                                       (let [kid (aget body-kids i)
                                             nm (.-name kid)]
                                         (cond
                                           (= nm "whitespace") (recur (inc i))
                                           (= nm "comment") (recur (inc i))
                                           (= nm "token") kid
                                           :else nil))))]
                          (when verb
                            (swap! verbs assoc (.-startIdx verb) (.-endIdx verb)))))
                      (doseq [kid (array-seq (or (.-children body) #js []))]
                        (walk kid (inc depth))))

                    :else
                    (doseq [kid (array-seq (or kids #js []))]
                      (walk kid depth)))))]
        (walk tree 0)
        {:strings @strings :delims @delims :verbs @verbs}))
    (catch :default _
      {:strings [] :delims {} :verbs {}})))

(defn delimiter-spans
  "Return [index char depth] for delimiters outside strings and comments."
  [source]
  (->> (:delims (syntax-spans source))
       (sort-by key)
       (mapv (fn [[i depth]] [i (subs source i (inc i)) depth]))))
(defn read
  "Read EDN data with UFSS fences."
  [text]
  (edn/read-string (unwrap text 1)))

(defn literals
  "Return every string literal in the source."
  [source]
  (let [forms (edamame/parse-string-all (unwrap source) {:deref true :fn true :regex true})]
    (letfn [(walk [x]
              (cond
                (string? x) [x]
                (map? x) (mapcat (fn [[k v]] (concat (walk k) (walk v))) x)
                (coll? x) (mapcat walk x)
                :else []))]
      (vec (mapcat walk forms)))))

(defn- invisible-control? [s]
  (boolean (re-find #"[\x00-\x08\x0B\x0C\x0E-\x1F]" s)))

(defn- max-hash-run [s quote-count]
  (let [n (count s)]
    (loop [i 0 maximum 0]
      (if (>= i n)
        maximum
        (if (not= quote-str (subs s i (inc i)))
          (recur (inc i) maximum)
          (let [quote-end (loop [j i]
                            (if (and (< j n) (= quote-str (subs s j (inc j))))
                              (recur (inc j))
                              j))
                hashes (loop [h 0]
                         (if (and (< (+ quote-end h) n)
                                  (= "#" (subs s (+ quote-end h) (inc (+ quote-end h)))))
                           (recur (inc h))
                           h))]
            (recur quote-end (max maximum (if (>= (- quote-end i) quote-count) hashes 0)))))))))

(defn- smallest-single [s]
  (inc (max-hash-run s 1)))

(defn- smallest-multi [s]
  (inc (max-hash-run s 3)))

(defn- bare-multiline? [s]
  (and (not (str/includes? s triple-quote))
       (not (str/includes? s backslash-str))
       (not-any? #(str/starts-with? % triple-quote) (str/split s #"\n" -1))))

(defn- format-string [body]
  (cond
    (invisible-control? body) (pr-str body)

    (and (str/includes? body newline-str)
         (every? #(or (= % \newline) (= % \tab) (= % \space)) body))
    (pr-str body)

    (not (str/includes? body newline-str))
    (if (or (str/includes? body quote-str) (str/includes? body backslash-str))
      (let [fence (apply str (repeat (smallest-single body) "#"))]
        (str fence quote-str body quote-str fence))
      (str quote-str body quote-str))

    :else
    (let [fence (if (bare-multiline? body)
                  ""
                  (apply str (repeat (smallest-multi body) "#")))]
      (str fence triple-quote newline-str body newline-str triple-quote fence))))

(defn- format-text [text]
  (let [result (.format formatter text)]
    (when-not (= "success" (.-status result))
      (throw (ex-info "UFSS formatter failed"
                      {:code :INVALID_ARGUMENT
                       :error (.-error result)})))
    (.-out result)))

(defn- plain-wrap
  "Render standard strings as canonical UFSS."
  ([text] (plain-wrap text nil))
  ([text options]
   (let [n (count text)]
     (loop [i 0 out []]
       (if (>= i n)
         (apply str out)
         (let [ch (subs text i (inc i))]
           (cond
             (= ch ";")
             (let [end (comment-end text i)]
               (recur end (conj out (subs text i end))))

             (= ch quote-str)
             (let [end (skip-string text i)
                   body (try
                          (edn/read-string (subs text i end))
                          (catch :default error
                            (throw (ex-info "invalid string literal"
                                            {:code :INVALID_ARGUMENT
                                             :error (str error)}))))]
               (recur end (conj out (if (and (:collapse-strings? options)
                                             (or (str/includes? body newline-str)
                                                 (> (count body) 40)))
                                      ((or (:placeholder options) identity) "$$$")
                                      (format-string body)))))

             (= ch "#")
             (if (and (< (inc i) n) (= (subs text (inc i) (+ i 2)) quote-str))
               (let [end (skip-string text (inc i))]
                 (recur end (conj out (subs text i end))))
               (recur (inc i) (conj out ch)))

             :else
             (recur (inc i) (conj out ch)))))))))

(defn- fence-open [{:keys [hashes multiline?]}]
  (str (apply str (repeat hashes "#"))
       (if multiline?
         (str (char 34) (char 34) (char 34) "\n")
         (str (char 34)))))

(defn- fence-close [{:keys [hashes multiline?]}]
  (str (if multiline?
         (str "\n" (char 34) (char 34) (char 34))
         (str (char 34)))
       (apply str (repeat hashes "#"))))

(defn- ansi-seq-end [text i]
  (let [m (str/index-of text "m" i)]
    (if m (inc m) (inc i))))

(defn- skip-visible [text i n]
  (loop [i i n n]
    (if (or (>= i (count text)) (zero? n))
      i
      (if (= (subs text i (inc i)) (str (char 27)))
        (recur (ansi-seq-end text i) n)
        (recur (inc i) (dec n))))))

(defn- restore-ansi [raw ansi strings delims verbs highlighter]
  (let [string-map (into {}
                         (map (fn [{:keys [start end render]}]
                                [start [end render]])
                              strings))
        n (count ansi)]
    (loop [i 0 j 0 out [] active ""]
      (if (>= i n)
        (apply str out)
        (let [ch (subs ansi i (inc i))]
          (if (= ch (str (char 27)))
            (let [end (ansi-seq-end ansi i)
                  seq (subs ansi i end)]
              (recur end j (conj out seq)
                     (if (str/ends-with? seq "m") seq active)))
            (if-let [[end render] (get string-map j)]
              (let [ansi-end (skip-visible ansi i (- end j))]
                (recur ansi-end end (conj out render) active))
              (if-let [end (get verbs j)]
                (let [ansi-end (skip-visible ansi i (- end j))
                      verb (subs raw j end)]
                  (recur ansi-end end
                         (conj out (str (highlighter verb :accent) active))
                         active))
                (if (or (>= j (count raw))
                        (not= ch (subs raw j (inc j))))
                  nil
                  (if-let [depth (get delims j)]
                    (recur (inc i) (inc j)
                           (conj out (str (highlighter ch [:rainbow depth]) active))
                           active)
                    (recur (inc i) (inc j) (conj out ch) active)))))))))))

(defn- highlight-body [body highlighter base-depth]
  (let [syntax (syntax-spans body)
        delims (into {} (map (fn [[i depth]] [i (+ base-depth depth)])
                             (:delims syntax)))
        ansi (highlighter body nil)]
    (or (restore-ansi body ansi [] delims (:verbs syntax) highlighter)
        ansi)))

(defn- highlight-wrap [text highlighter options]
  (try
    (let [syntax (syntax-spans text)
          outer (highlighter text "clojure")
          collapse? (:collapse-strings? options)
          placeholder (when collapse?
                        (or (:placeholder options)
                            (fn [s] (highlighter s :dim))))
          strings (keep (fn [{:keys [start end base-depth]}]
                          (let [literal (subs text start end)
                                canonical (plain-wrap literal)
                                f (fence-at canonical 0)
                                short? (let [body (or (:body f)
                                                      (try (edn/read-string canonical)
                                                           (catch :default _ nil)))]
                                         (and (string? body)
                                              (not (str/includes? body newline-str))
                                              (<= (count body) 40)))]
                            (if (and collapse? (not short?))
                              {:start start
                               :end end
                               :render (placeholder "$$$")}
                              (if f
                                {:start start
                                 :end end
                                 :render (str (highlighter (fence-open f) :dim)
                                              (highlight-body (:body f) highlighter base-depth)
                                              (highlighter (fence-close f) :dim))}
                                (let [body (try (edn/read-string canonical)
                                                (catch :default _ literal))]
                                  {:start start
                                   :end end
                                   :render (str (highlighter quote-str :dim)
                                                (highlight-body body highlighter base-depth)
                                                (highlighter quote-str :dim))})))))
                        (:strings syntax))
          delims (:delims syntax)
          verbs (:verbs syntax)]
      (or (restore-ansi text outer strings delims verbs highlighter)
          (plain-wrap text options)))
    (catch :default _
      (plain-wrap text options))))

(defn wrap
  "Render standard strings as canonical UFSS, optionally highlighted."
  ([text] (plain-wrap text))
  ([text highlighter]
   (if highlighter
     (highlight-wrap text highlighter nil)
     (plain-wrap text)))
  ([text highlighter options]
   (if highlighter
     (highlight-wrap text highlighter options)
     (plain-wrap text options))))

(defn canonical
  "Canonicalize source text or an EDN value, optionally highlighted."
  ([value] (canonical value nil nil))
  ([value highlighter] (canonical value highlighter nil))
  ([value highlighter options]
   (let [text (if (string? value)
                value
                (str/trimr (with-out-str (pp/pprint value))))]
     (wrap (format-text (unwrap text)) highlighter options))))