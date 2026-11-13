(ns herd.ufss
  (:require
   ["@chrisoakman/standard-clojure-style" :as formatter-module]
   [clojure.edn :as edn]
   [clojure.string :as str]
   [edamame.core :as edamame]))

(def ^:private formatter (.-default formatter-module))

(def ^:private quote-code 34)
(def ^:private backslash-code 92)
(def ^:private semicolon-code 59)
(def ^:private space-char \space)
(def ^:private quote-str (str (char 34)))
(def ^:private triple-quote (apply str (repeat 3 (char 34))))
(def ^:private newline-str (str (char 10)))
(def ^:private backslash-str (str (char 92)))

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

(defn- read-fence [s i min-hashes]
  (let [n (count s)
        hashes (loop [h 0]
                 (if (and (< (+ i h) n) (= "#" (subs s (+ i h) (inc (+ i h)))))
                   (recur (inc h))
                   h))
        q (+ i hashes)]
    (when (and (>= hashes min-hashes) (< q n) (= quote-str (subs s q (inc q))))
      (if (str/starts-with? (subs s q) (str triple-quote newline-str))
        (read-multi s hashes q)
        (read-single s hashes q)))))

(defn unwrap
  "Replace UFSS fences with standard CLJS strings."
  ([source] (unwrap source 1))
  ([source min-hashes]
   (let [n (count source)]
     (loop [i 0 out []]
       (if (>= i n)
         (apply str out)
         (let [c (char-code source i)]
           (cond
             (= c semicolon-code)
             (let [nl (str/index-of source newline-str i)
                   end (if nl (inc nl) n)]
               (recur end (conj out (subs source i end))))

             (= c quote-code)
             (if (str/starts-with? (subs source i) (str triple-quote newline-str))
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

(defn wrap
  "Render standard strings as canonical UFSS."
  [text]
  (let [n (count text)]
    (loop [i 0 out []]
      (if (>= i n)
        (apply str out)
        (let [ch (subs text i (inc i))]
          (cond
            (= ch ";")
            (let [nl (str/index-of text newline-str i)
                  end (if nl (inc nl) n)]
              (recur end (conj out (subs text i end))))

            (= ch quote-str)
            (let [end (skip-string text i)
                  body (try
                         (edn/read-string (subs text i end))
                         (catch :default error
                           (throw (ex-info "invalid string literal"
                                           {:code :INVALID_ARGUMENT
                                            :error (str error)}))))]
              (recur end (conj out (format-string body))))

            (= ch "#")
            (if (and (< (inc i) n) (= (subs text (inc i) (+ i 2)) quote-str))
              (let [end (skip-string text (inc i))]
                (recur end (conj out (subs text i end))))
              (recur (inc i) (conj out ch)))

            :else
            (recur (inc i) (conj out ch))))))))

(defn print
  "Print a value as EDN + UFSS."
  [value]
  (wrap (format-text (pr-str value))))

(defn canonical-source
  "Canonicalize a CLJS source file: unwrap fences, format, re-wrap strings."
  [source]
  (wrap (format-text (unwrap source))))