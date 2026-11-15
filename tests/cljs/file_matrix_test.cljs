(ns cljs.file-matrix-test
  (:require
   ["node:fs" :as fs]
   ["node:fs/promises" :as fsp]
   ["node:os" :as os]
   ["node:path" :as path]
   [clojure.string :as str]
   [herd.sandbox :as sandbox]
   [herd.test :as t]
   [promesa.core :as p]))

(defn- make-root []
  (fs/mkdtempSync (path/join (os/tmpdir) "herd-file-matrix-")))

(def lock-root (make-root))

(defn- native-read [params]
  (-> (fsp/readFile (aget params "path") "utf8")
      (.then (fn [text]
               #js {:content #js [#js {:type "text" :text text}]}))))

(defn- native-write [params]
  (-> (fsp/writeFile (aget params "path") (aget params "content") "utf8")
      (.then (fn [_] #js {:content #js []}))))

(defn- native-runner []
  #js {:getRunner
       (fn []
         #js {:hasNativeTool (fn [name] (or (= name "read") (= name "write")))
              :invokeNativeTool
              (fn [name params]
                (if (= name "read")
                  (native-read params)
                  (native-write params)))})})

(defn- failing-runner [f2]
  #js {:getRunner
       (fn []
         #js {:hasNativeTool
              (fn [name] (or (= name "read") (= name "write")))
              :invokeNativeTool
              (fn [name params]
                (if (and (= name "write") (= (aget params "path") f2))
                  (js/Promise.reject (js/Error. "simulated crash on second write"))
                  (if (= name "read")
                    (native-read params)
                    (native-write params))))})})

(set! (.-__herdLockRoot js/globalThis) lock-root)
(set! (.-__herdNative js/globalThis) (native-runner))

(defn- error-text [error]
  (or (:code (ex-data error))
      (.-code error)
      (.-message error)
      (str error)))

(defn- attempt-write
  ([file content]
   (attempt-write file content nil))
  ([file content stamp]
   (let [request (cond-> {:path file :content content}
                   stamp (assoc :expected-stamp stamp))]
     (-> (sandbox/write request)
         (.then (fn [_] "ok"))
         (.catch (fn [error] (error-text error)))))))

(defn- same [actual expected]
  (t/to-be (= actual expected) true))

(t/describe "file matrix: stat/stamp contract"
  (fn []
    (t/it "F01: rejects a stale expected-stamp and keeps the external content"
      (fn []
        (p/let [root (make-root)
                file (path/join root "f01.txt")
                _ (fsp/writeFile file "v1")
                first (sandbox/stat {:path file})]
          (t/to-be (:exists first) true)
          (t/to-be (number? (:mtime-sec first)) true)
          (t/to-be (number? (:mtime-nsec first)) true)
          (t/to-be (number? (:size first)) true)
          (t/to-be (boolean? (:is-dir first)) true)
          (p/let [_ (fsp/writeFile file "v2")
                  conflict (attempt-write file "v3" first)]
            (t/to-contain conflict "FILE_CONFLICT")
            (p/let [content (fsp/readFile file "utf8")
                    second (sandbox/stat {:path file})
                    ok (attempt-write file "v3" second)
                    final (fsp/readFile file "utf8")]
              (t/to-be content "v2")
              (t/to-be ok "ok")
              (t/to-be final "v3")))))))
    (t/it "F03: keeps earlier writes when a later target is structurally invalid"
      (fn []
        (p/let [root (make-root)
                one (path/join root "f03-one.txt")
                two (path/join root "f03-two.txt")
                blocked (path/join root "f03-blocked")
                _ (fs/mkdirSync blocked #js {:recursive true})]
          (p/let [_ (sandbox/write {:path one :content "one"})
                  _ (sandbox/write {:path two :content "two"})
                  result (-> (sandbox/write {:path blocked :content "three"})
                             (.then (fn [_] "unexpected"))
                             (.catch (fn [error] (error-text error))))
                  one-text (fsp/readFile one "utf8")
                  two-text (fsp/readFile two "utf8")]
            (t/to-be (not= result "unexpected") true)
            (t/to-contain result "EISDIR")
            (t/to-be one-text "one")
            (t/to-be two-text "two")))))
    (t/it "F09: accepts an old stamp when only atime changed"
      (fn []
        (p/let [root (make-root)
                file (path/join root "f09.txt")
                _ (fsp/writeFile file "stable")
                base (js/Date. 1000000000000)
                _ (fsp/utimes file base base)
                stamp (sandbox/stat {:path file})]
          (t/to-be (:mtime-sec stamp) 1000000000)
          (t/to-be (:mtime-nsec stamp) 0)
          (p/let [_ (fsp/utimes file (js/Date. 1000060000000) base)
                  ok (attempt-write file "updated" stamp)
                  final (fsp/readFile file "utf8")]
            (t/to-be ok "ok")
            (t/to-be final "updated")))))
    (t/it "F04: moves to a new path and then writes it"
      (fn []
        (p/let [root (make-root)
                source (path/join root "f04-old.txt")
                target (path/join root "f04-new.txt")
                _ (fsp/writeFile source "moved")
                moved (-> (sandbox/mv {:source source :target target})
                          (.then (fn [_] "ok"))
                          (.catch (fn [error] (error-text error))))]
          (t/to-be moved "ok")
          (p/let [written (attempt-write target "after-move")
                  target-text (fsp/readFile target "utf8")
                  removed-dir (path/join root "f04-dir")
                  _ (fs/mkdirSync removed-dir #js {:recursive true})
                  _ (fsp/writeFile (path/join removed-dir "keep.txt") "keep")
                  removed (-> (sandbox/rm {:path removed-dir})
                              (.then (fn [_] "ok"))
                              (.catch (fn [error] (error-text error))))
                  stat (sandbox/stat {:path removed-dir})
                  blocked (attempt-write (path/join removed-dir "new.txt") "nope")
                  keep (-> (fsp/readFile (path/join removed-dir "keep.txt") "utf8")
                           (.catch (fn [_] "gone")))]
            (t/to-be written "ok")
            (t/to-be target-text "after-move")
            (t/to-be removed "ok")
            (t/to-be (:exists stat) false)
            (t/to-be (not= blocked "ok") true)
            (t/to-be (boolean (re-find #"ENOENT|EISDIR|ENOTDIR" blocked)) true)
            (t/to-be keep "gone")))))
    (t/it "F07: allows cat and stat reads without waiting while call holds the write lock W"
      (fn []
        (p/let [root (make-root)
                target (path/join root "f07.txt")
                _ (fsp/writeFile target "before-call")
                call-promise (sandbox/call {:argv ["sh" "-c" "sleep 0.25; printf done"]
                                            :name "f07-call"} 5000)
                _ (sandbox/await-call-start "f07-call")
                during-cat (sandbox/cat {:path target})
                during-stat (sandbox/stat {:path target})
                call-active (some? (get @sandbox/active-calls "f07-call"))
                result call-promise]
          (t/to-be during-cat "before-call")
          (t/to-be (:exists during-stat) true)
          (t/to-be (:size during-stat) 11)
          (t/to-be call-active true)
          (t/to-be (:exit result) 0))))
    (t/it "F02: rejects when a read-only dependency stamp changes even if target stamp is unchanged"
      (fn []
        (p/let [root (make-root)
                api (path/join root "f02-api.txt")
                client (path/join root "f02-client.txt")
                _ (fsp/writeFile api "v1")
                _ (fsp/writeFile client "c1")
                api-stamp (sandbox/stat {:path api})
                client-stamp (sandbox/stat {:path client})
                _ (fsp/writeFile api "v2-breaking")
                res (-> (sandbox/stat {:path api})
                        (.then (fn [cur]
                                 (if (or (not= (:mtime-sec cur) (:mtime-sec api-stamp))
                                         (not= (:mtime-nsec cur) (:mtime-nsec api-stamp))
                                         (not= (:size cur) (:size api-stamp)))
                                   (js/Promise.reject
                                    (ex-info "FILE_CONFLICT: dependency changed"
                                             {:code :FILE_CONFLICT}))
                                   (sandbox/write {:path client :content "c2"
                                                   :expected-stamp client-stamp}))))
                        (.then (fn [_] "ok"))
                        (.catch (fn [error] (error-text error))))
                client-text (fsp/readFile client "utf8")]
          (t/to-contain res "FILE_CONFLICT")
          (t/to-be client-text "c1"))))
    (t/it "F05: keeps current write on cancellation and skips subsequent steps"
      (fn []
        (p/let [root (make-root)
                f1 (path/join root "f05-1.txt")
                f2 (path/join root "f05-2.txt")
                f3 (path/join root "f05-3.txt")
                res (-> (sandbox/write {:path f1 :content "step1"})
                        (.then (fn [_] (sandbox/write {:path f2 :content "step2"})))
                        (.then (fn [_]
                                 (js/Promise.reject
                                  (ex-info "AUDIT_ABORTED: cancelled mid-sequence"
                                           {:code :AUDIT_ABORTED}))))
                        (.then (fn [_] (sandbox/write {:path f3 :content "step3"})))
                        (.then (fn [_] "ok"))
                        (.catch (fn [error] (error-text error))))
                t1 (fsp/readFile f1 "utf8")
                t2 (fsp/readFile f2 "utf8")
                t3 (-> (fsp/readFile f3 "utf8") (.catch (fn [_] "missing")))]
          (t/to-contain res "AUDIT_ABORTED")
          (t/to-be t1 "step1")
          (t/to-be t2 "step2")
          (t/to-be t3 "missing"))))
    (t/it "F08: accepts write when external edit preserves exact mtime and size (A02-15 boundary)"
      (fn []
        (p/let [root (make-root)
                file (path/join root "f08.txt")
                _ (fsp/writeFile file "aaaa")
                base (js/Date. 1700000000000)
                _ (fsp/utimes file base base)
                stamp (sandbox/stat {:path file})
                _ (fsp/writeFile file "bbbb")
                _ (fsp/utimes file base base)
                ok (attempt-write file "cccc" stamp)
                final (fsp/readFile file "utf8")]
          (t/to-be ok "ok")
          (t/to-be final "cccc"))))
    (t/it "F10: allows stale observation summary without blocking, requiring successor re-read"
      (fn []
        (p/let [root (make-root)
                file (path/join root "f10.txt")
                _ (fsp/writeFile file "compat-present")
                observed (sandbox/cat {:path file})
                _ (fsp/writeFile file "compat-removed")
                latest (sandbox/cat {:path file})]
          (t/to-be observed "compat-present")
          (t/to-be latest "compat-removed"))))
    (t/it "F11: queues write behind call holding W without stealing W and completes after call releases"
      (fn []
        (p/let [root (make-root)
                file (path/join root "f11.txt")
                _ (fsp/writeFile file "init")
                order (atom [])
                call-promise (sandbox/call {:argv ["sh" "-c" "sleep 0.15; printf done"]
                                            :name "f11-call"} 5000)
                _ (sandbox/await-call-start "f11-call")
                write-promise (-> (sandbox/write {:path file :content "after-call"})
                                  (.then (fn [_] (swap! order conj :write))))
                call-chain (-> call-promise
                               (.then (fn [res] (swap! order conj :call) res)))
                arr (js/Promise.all #js [call-chain write-promise])
                results (p/let [[call-res _] arr] call-res)
                final (fsp/readFile file "utf8")]
          (same @order [:call :write])
          (t/to-be (:exit results) 0)
          (t/to-be final "after-call"))))
    (t/it "F12: tracks active call while running and releases W once outermost command exits"
      (fn []
        (p/let [root (make-root)
                call-promise (sandbox/call {:argv ["sh" "-c" "sleep 0.15; printf ok"]
                                            :name "f12-call"} 5000)
                _ (sandbox/await-call-start "f12-call")
                active-mid (some? (get @sandbox/active-calls "f12-call"))
                res call-promise
                active-end (some? (get @sandbox/active-calls "f12-call"))]
          (t/to-be active-mid true)
          (t/to-be active-end false)
          (t/to-be (:exit res) 0))))
    (t/it "F13: keeps first write and leaves third unwritten on mid-sequence native write failure"
      (fn []
        (let [orig (.-__herdNative js/globalThis)]
          (try
            (p/let [root (make-root)
                    f1 (path/join root "f13-1.txt")
                    f2 (path/join root "f13-2.txt")
                    f3 (path/join root "f13-3.txt")]
              (set! (.-__herdNative js/globalThis) (failing-runner f2))
              (p/let [res (-> (sandbox/write {:path f1 :content "first"})
                              (.then (fn [_] (sandbox/write {:path f2 :content "second"})))
                              (.then (fn [_] (sandbox/write {:path f3 :content "third"})))
                              (.then (fn [_] "ok"))
                              (.catch (fn [error] (.-message error))))
                      t1 (fsp/readFile f1 "utf8")
                      t2 (-> (fsp/readFile f2 "utf8") (.catch (fn [_] "missing")))
                      t3 (-> (fsp/readFile f3 "utf8") (.catch (fn [_] "missing")))]
                (t/to-contain res "simulated crash on second write")
                (t/to-be t1 "first")
                (t/to-be t2 "missing")
                (t/to-be t3 "missing")))
            (finally
              (set! (.-__herdNative js/globalThis) orig))))))
    (t/it "F14: documents best-effort boundary when external writer mutates file outside protocol"
      (fn []
        (p/let [root (make-root)
                file (path/join root "f14.txt")
                _ (fsp/writeFile file "initial")
                s1 (sandbox/stat {:path file})
                ok (attempt-write file "protocol-write" s1)
                _ (fsp/writeFile file "external-bypass")
                final (fsp/readFile file "utf8")]
          (t/to-be ok "ok")
          (t/to-be final "external-bypass")))))

