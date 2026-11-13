(ns herd.ufss
  (:require [clojure.string :as str]))

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
                (when (< spaces indent)
                  (throw (ex-info "block line has too little indentation"
                                  {:code :UFSS_INDENT_VIOLATION
                                   :expected indent
                                   :actual spaces})))
                (subs line indent))))
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
            (let [tail (str/trimr (subs after (count fence)))]
              (when-not (empty? tail)
                (throw (ex-info "closing fence must stand alone" {:code :INVALID_ARGUMENT})))
              (let [body-end (max body-start (dec line-start))
                    body (subs s body-start body-end)]
                [(strip-block body spaces) (+ line-start (count line))]))
            (recur (if (= line-end n) n (inc line-end)))))))))

(defn- read-single [s hashes q]
  (let [fence (apply str (repeat hashes "#"))
        close (str "\"" fence)
        end (str/index-of s close (inc q))]
    (when (and end (not (str/includes? (subs s (inc q) end) "\n")))
      [(subs s (inc q) end) (+ end (count close))])))

(defn- read-fence [s i]
  (let [n (count s)
        hashes (loop [h 0]
                 (if (and (< (+ i h) n) (= "#" (subs s (+ i h) (inc (+ i h)))))
                   (recur (inc h))
                   h))
        q (+ i hashes)]
    (when (and (>= hashes 2) (< q n) (= "\"" (subs s q (inc q))))
      (if (str/starts-with? (subs s q) "\"\"\"\n")
        (read-multi s hashes q)
        (read-single s hashes q)))))

(defn unwrap
  "Replace UFSS fences with standard CLJS strings. Code state only."
  [source]
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
            (let [end (skip-string source i)]
              (recur end (conj out (subs source i end))))

            (= c backslash-code)
            (let [end (min n (+ i 2))]
              (recur end (conj out (subs source i end))))

            (= c 35)
            (if-let [[body end] (read-fence source i)]
              (recur end (conj out (pr-str body)))
              (recur (inc i) (conj out (subs source i (inc i)))))

            :else
            (recur (inc i) (conj out (subs source i (inc i))))))))))

(defn print
  "Print a value as EDN. UFSS post-pass is added with the writer migration."
  [value]
  (pr-str value))
