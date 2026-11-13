(ns herd.macros)

(defmacro park [& args]
  (list 'await (cons 'herd.sandbox/park args)))

(defmacro unpark [& args]
  (list 'await (cons 'herd.sandbox/unpark args)))

(defmacro abandon [& args]
  (list 'await (cons 'herd.sandbox/abandon args)))

(defmacro where [& args]
  (list 'await (cons 'herd.sandbox/where args)))
