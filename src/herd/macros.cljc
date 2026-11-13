(ns herd.macros)

(defmacro park [& args]
  (list 'await (cons 'herd.sandbox/park args)))

(defmacro unpark [& args]
  (list 'await (cons 'herd.sandbox/unpark args)))

(defmacro abandon [& args]
  (list 'await (cons 'herd.sandbox/abandon args)))

(defmacro where [& args]
  (list 'await (cons 'herd.sandbox/where args)))

(defmacro cat [& args] (list 'await (cons 'herd.sandbox/cat args)))
(defmacro read [& args] (list 'await (cons 'herd.sandbox/read args)))
(defmacro stat [& args] (list 'await (cons 'herd.sandbox/stat args)))
(defmacro ls [& args] (list 'await (cons 'herd.sandbox/ls args)))
(defmacro write [& args] (list 'await (cons 'herd.sandbox/write args)))
(defmacro mkdir [& args] (list 'await (cons 'herd.sandbox/mkdir args)))
(defmacro rm [& args] (list 'await (cons 'herd.sandbox/rm args)))
(defmacro mv [& args] (list 'await (cons 'herd.sandbox/mv args)))
(defmacro glob [& args] (list 'await (cons 'herd.sandbox/glob args)))
(defmacro call [& args] (list 'await (cons 'herd.sandbox/call args)))
