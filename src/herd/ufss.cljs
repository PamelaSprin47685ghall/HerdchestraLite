(ns herd.ufss
  (:require [clojure.edn :as edn]
            [clojure.string :as str]
            [cljs.pprint :as pp]))

(def ^:private quote-code 34)
(def ^:private backslash-code 92)
(def ^:private semicolon-code 59)
(def ^:private space-char \space)

(defn- char-code [s i] (.charCodeAt s i))

(defn- skip-string [s start]
  (let [n (count s)]
    (loop [i (inc start)]
      (if (>= i n)
        n
        (let [c (char-code s i)]
          (cond
            (= c backslash-code) (recur (+ i 2))
            (= c quote-code) (inc i)
            :else (recur (inc i))))))))

(defn- strip-block [body indent]
  (let [lines (str/split body #"\n" -1)]
    (str/join
     "\n"
     (map (fn [line]
            (if (empty? line)
              ""
              (let [spaces (count (take-while #(= % space-char) line))]
                (subs line (min spaces indent)))))
          lines))))

(defn- read-multi [s hashes q]
  (let [fence (str "\"\"\"" (apply str (repeat hashes "#")))
        body-start (+ q 4)
        n (count s)]
    (loop [line-start body-start]
      (if (>= line-start n)
        (throw (ex-info "unclosed raw block" {:code :UFSS_UNCLOSED}))
        (let [line-end (or (str/index-of s "\n" line-start) n)
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
        close (str "\"" fence)
        end (str/index-of s close (inc q))]
    (when (and end (not (str/includes? (subs s (inc q) end) "\n")))
      [(subs s (inc q) end) (+ end (count close))])))

(defn- read-fence [s i min-hashes]
  (let [n (count s)
        hashes (loop [h 0]
                 (if (and (< (+ i h) n) (= "#" (subs s (+ i h) (inc (+ i h)))))
                   (recur (inc h))
                   h))
        q (+ i hashes)]
    (when (and (>= hashes min-hashes) (< q n) (= "\"" (subs s q (inc q))))
      (if (str/starts-with? (subs s q) "\"\"\"\n")
        (read-multi s hashes q)
        (read-single s hashes q)))))

(defn unwrap
  "Replace UFSS fences with standard CLJS strings. Code state only.

  `min-hashes` is 2 for ClojureScript source (`#\"` is regex) and 1 for EDN
  data (`#\"` is a fence)."
  ([source] (unwrap source 2))
  ([source min-hashes]
  (let [n (count source)]
    (loop [i 0 out []]
      (if (>= i n)
        (apply str out)
        (let [c (char-code source i)]
          (cond
            (= c semicolon-code)
            (let [nl (str/index-of source "\n" i)
                  end (if nl (inc nl) n)]
              (recur end (conj out (subs source i end))))

            (= c quote-code)
            (if (str/starts-with? (subs source i) "\"\"\"\n")
              (if-let [[body end] (read-multi source 0 i)]
                (recur end (conj out (pr-str body)))
                (recur (inc i) (conj out (subs source i (inc i)))))
              (let [end (skip-string source i)]
                (recur end (conj out (subs source i end)))))

            (= c backslash-code)
            (let [end (min n (+ i 2))]
              (recur end (conj out (subs source i end))))

            (= c 35)
            (if-let [[body end] (read-fence source i min-hashes)]
              (recur end (conj out (pr-str body)))
              (recur (inc i) (conj out (subs source i (inc i)))))

            :else
            (recur (inc i) (conj out (subs source i (inc i)))))))))))

(defn read
  "Read EDN data with UFSS fences."
  [text]
  (edn/read-string (unwrap text 1)))

(defn- invisible-control? [s]
  (boolean (some (fn [ch]
                   (let [code (.charCodeAt ch 0)]
                     (and (< code 32)
                          (not= code 9)
                          (not= code 10))))
                 s)))

(defn- max-hash-run [s quote-count]
  (let [n (count s)]
    (loop [i 0 maximum 0]
      (if (>= i n)
        maximum
        (if (not= "\"" (subs s i (inc i)))
          (recur (inc i) maximum)
          (let [quote-end (loop [j i]
                            (if (and (< j n) (= "\"" (subs s j (inc j))))
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
  (and (not (str/includes? s "\"\"\""))
       (not (str/includes? s "\\"))
       (not-any? #(str/starts-with? % "\"\"\"") (str/split s #"\n" -1))))

(defn- format-string [body indent]
  (cond
    (invisible-control? body) (pr-str body)

    (not (str/includes? body "\n"))
    (if (or (str/includes? body "\"") (str/includes? body "\\"))
      (let [fence (apply str (repeat (smallest-single body) "#"))]
        (str fence "\"" body "\"" fence))
      (str "\"" body "\""))

    :else
    (let [fence (if (bare-multiline? body)
                  ""
                  (apply str (repeat (smallest-multi body) "#")))
          prefix (apply str (repeat indent " "))
          lines (str/split body #"\n" -1)
          rendered (str/join "\n" (map #(if (empty? %) "" (str prefix %)) lines))]
      (str fence "\"\"\"\n" rendered "\n" prefix "\"\"\"" fence))))

(defn- read-standard-string [s start]
  (let [n (count s)]
    (loop [i (inc start) body []]
      (if (>= i n)
        nil
        (let [ch (subs s i (inc i))]
          (cond
            (= ch "\"") [(apply str body) (inc i)]
            (= ch "\\")
            (let [next (subs s (inc i) (min n (+ i 2)))]
              (case next
                "\"" (recur (+ i 2) (conj body "\""))
                "\\" (recur (+ i 2) (conj body "\\"))
                "n" (recur (+ i 2) (conj body "\n"))
                "t" (recur (+ i 2) (conj body "\t"))
                "r" (recur (+ i 2) (conj body "\r"))
                "b" (recur (+ i 2) (conj body "\b"))
                "f" (recur (+ i 2) (conj body "\f"))
                "u" (let [hex (subs s (+ i 2) (min n (+ i 6)))]
                      (recur (+ i 6) (conj body (js/String.fromCharCode (js/parseInt hex 16)))))
                (recur (+ i 2) (conj body next))))
            :else (recur (inc i) (conj body ch))))))))

(defn- string-column [out]
  (let [text (apply str out)
        line-start (inc (or (str/last-index-of text "\n") -1))]
    (- (count text) line-start)))

(defn wrap
  "Upgrade standard strings to the shortest UFSS fence."
  [text]
  (let [n (count text)]
    (loop [i 0 out []]
      (if (>= i n)
        (apply str out)
        (let [ch (subs text i (inc i))]
          (if (= ch "\"")
            (if-let [[body end] (read-standard-string text i)]
              (let [indent (string-column out)
                    rendered (format-string body indent)
                    multiline? (str/includes? rendered "\"\"\"\n")
                    next-char (when (< end n) (subs text end (inc end)))
                    comma? (and multiline? (= next-char ","))
                    suffix (if multiline?
                             (str (if comma? "," "") "\n" (apply str (repeat indent " ")))
                             "")]
                (recur (if comma? (inc end) end)
                       (conj out (str rendered suffix))))
              (recur (inc i) (conj out ch)))
            (recur (inc i) (conj out ch))))))))

(defn print
  "Print a value as EDN + UFSS."
  [value]
  (wrap (with-out-str (pp/pprint value))))

(def UFSS_PROMPT_NOTE
  (str/join
   "\n"
   ["# Universal Fence-Scaled String (UFSS): Arbitrary-Depth Raw Fences"
    "UFSS is the raw string notation used in every EDN receipt. It avoids escaping quotes, backslashes, and newlines by choosing a fence deeper than any closing sequence in the body. Use `##` by default for ordinary text; use `###` when developing HerdchestraLite itself, because its source, docs, and prompts contain many quotes, backslashes, and fence-like sequences. Fence depth is arbitrary: zero hashes (bare multi-line), one, or more all work; the printer picks the smallest, but you're free. Raise the fence instead of escaping."
    ""
    "Every receipt you get is EDN, and every string in it is printed as UFSS (Universal Fence-Scaled String). You are not restricted to one escaping style; you are expected to pick the strongest one."
    ""
    "Three string forms, all accepted by the same reader:"
    "1. Standard escaped string — only for short text with no quote, no backslash, no newline. This is the fallback, not the default."
    "2. Single-line raw fence: `##\"...\"##` for ordinary text, or `###\"...\"###` when developing HerdchestraLite. The body is taken verbatim: quotes, backslashes, and hash characters inside stay literal."
    "3. Multi-line raw block: `##\"\"\"...\"\"\"##` for ordinary text, or `###\"\"\"...\"\"\"###` when developing HerdchestraLite. The closing indent is stripped from every non-empty body line; shorter lines are accepted as-is; a trailing newline is preserved exactly."
    ""
    "Scaling is the point. With two hashes the forms are `##\"...\"##` and `##\"\"\"...\"\"\"##`; with three hashes, `###\"...\"###` and `###\"\"\"...\"\"\"###`. If the body already contains a quote, a backslash, or a line beginning with three quotes, raise the fence by one hash; continue without a ceiling. The printer chooses the smallest n whose closing sequence does not appear in the body, so a raw fence always exists. The reader and printer are a bijection: round-tripping any string returns it byte for byte."
    ""
    "Examples (all obey the default depth):"
    "- Ordinary text: `##\"He said \"hello\".\"##`"
    "- Herd source: `###\"const marker = '\"\"\"';\"###`"
    "- Ordinary block:"
    "##\"\"\""
    "ordinary body with \"quotes\""
    "\"\"\"##"
    "- Herd block:"
    "###\"\"\""
    "const marker = '\"\"\"';"
    "\"\"\"###"
    ""
    ""
    "Concrete repair example (Herd source, so `###`):"
    "LLM classic: models often say `strawberry` has two r's. The wrong text is `2 r's`; the repair must hit that exact occurrence and leave the rest untouched."
    "Before: `###\"export const STRAWBERRY_FACT = \"strawberry has 2 r's\";\"###`"
    "Program:"
    "(let [path \"src/llm-meme.mjs\""
    "      src  (cat {:path path})"
    "      [b e] (where {:content src"
    "                    :needle ###\"export const STRAWBERRY_FACT = \"strawberry has 2 r's\";\"###})]"
    "  (write {:path path"
    "          :content (str (subs src 0 b)"
    "                        ###\"export const STRAWBERRY_FACT = \"strawberry has 3 r's\";\"###"
    "                        (subs src e))}))"
    ""
    "Why this beats `python/replace` or `apply_patch`:"
    "- `cat` is byte-exact; `read` may reformat and is not a patch basis."
    "- `where` returns one exact UTF-16 span; 0 or multiple matches park with candidates instead of guessing."
    "- UFSS `###` keeps inner quotes literal; the needle and replacement need no escaping."
    "- `write` replaces only `[b e]`; surrounding text is never retyped."
    "- Python `str.replace` defaults to all occurrences and silently no-ops when the target drifts; regex adds escaping noise."
    "- `apply_patch` depends on diff context and line drift; the model must reproduce surrounding lines. This path uses the real file text and exact spans."
    ""
    "WARNING — the mistakes that actually break a fence:"
    "- A raw fence is not a regex. `##\"...\"##` is a raw string; write regexes as `(re-pattern ##\"...\"##)`."
    "- Never hand-build backslash escapes for quotes, backslashes, or newlines in code, paths, diffs, or multi-line prose. If the body needs those escapes, raise the fence depth instead."
    "- The closing fence may share its line with trailing syntax such as `}`; the string ends at the fence and parsing continues with the rest of the line."
    "- Body indentation is stripped up to the closing fence indent; shorter lines are accepted as-is."
    "- If the body contains three consecutive quotes, a closing-fence sequence, or a line of hashes, raise the fence by one hash until the closing sequence does not occur in the body."
    "- Control characters other than newline and tab cannot live in a raw fence; use a standard escaped string for those."
    "- JSON, standard EDN, and UFSS are all accepted on input and normalized. On output the framework never sends escaped JSON noise for text a fence can carry; do not pre-escape it yourself."]))
