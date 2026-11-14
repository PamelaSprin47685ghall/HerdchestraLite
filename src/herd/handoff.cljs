(ns herd.handoff
  "Two-anchor handoff codec.

  [AAA⯮BBB] selects the substring from the unique occurrence of AAA
  to the unique occurrence of BBB. Everything else is literal. A ref that
  cannot be parsed or resolved stays literal. Decoded spans are emitted in
  document order; ranges already emitted by earlier refs are skipped.

  The output is always the author's literals plus a subset of the dictionary:
  it can be too large, never fabricated.")

(def arrow "⯮")

(defn- span
  "Return [start end) for the unique AAA .. BBB pair, or nil.
  Non-unique anchors are ambiguous and stay literal."
  [ctx a b]
  (let [s (if (pos? (count a)) (.indexOf ctx a) -1)
        e (if (pos? (count b)) (.lastIndexOf ctx b) -1)]
    (when (and (>= s 0)
               (>= e 0)
               (= s (.lastIndexOf ctx a))
               (= e (.indexOf ctx b))
               (>= e s)
               (>= (+ e (count b)) (+ s (count a))))
      [s (+ e (count b))])))

(defn decode
  "Decode `doc` against `ctx`. Malformed or unresolved refs stay literal."
  [doc ctx]
  (let [covered (js/Uint8Array. (count ctx))
        out (js/Array.)
        arrow-len (count arrow)]
    (loop [i 0]
      (let [k (.indexOf doc arrow i)]
        (if (neg? k)
          (do (.push out (subs doc i))
              (.join out ""))
          (let [lb (.lastIndexOf doc "[" k)
                rb (.indexOf doc "]" k)]
            (if (or (< lb i) (neg? rb))
              (do (.push out (subs doc i (+ k arrow-len)))
                  (recur (+ k arrow-len)))
              (let [a (subs doc (inc lb) k)
                    b (subs doc (+ k arrow-len) rb)
                    hit (span ctx a b)]
                (if (nil? hit)
                  (do (.push out (subs doc i (inc rb)))
                      (recur (inc rb)))
                  (let [[start end] hit]
                    (.push out (subs doc i lb))
                    (loop [p start]
                      (when (< p end)
                        (if (pos? (aget covered p))
                          (recur (inc p))
                          (let [q (loop [q p]
                                    (if (or (>= q end) (pos? (aget covered q)))
                                      q
                                      (recur (inc q))))]
                            (.push out (subs ctx p q))
                            (recur q)))))
                    (.fill covered 1 start end)
                    (recur (inc rb))))))))))))