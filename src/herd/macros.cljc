(ns herd.macros)

(defmacro park [& args]
  (list 'await (list 'herd.sandbox/park-with-name '__herd-program-name (first args))))

(defmacro unpark [& args]
  (list 'await (cons 'herd.sandbox/unpark args)))

(defmacro abandon [& args]
  (list 'await (cons 'herd.repl/abandon args)))

(defmacro where [& args]
  (list 'await (list 'herd.sandbox/where-with-name '__herd-program-name (first args))))

(defmacro cat [& args] (list 'await (cons 'herd.sandbox/cat args)))
(defmacro read [& args] (list 'await (cons 'herd.sandbox/read args)))
(defmacro stat [& args] (list 'await (cons 'herd.sandbox/stat args)))
(defmacro ls [& args] (list 'await (cons 'herd.sandbox/ls args)))
(defmacro write [& args]
  (list 'await (list 'herd.sandbox/write-with-name '__herd-program-name (first args))))
(defmacro mkdir [& args]
  (list 'await (list 'herd.sandbox/mkdir-with-name '__herd-program-name (first args))))
(defmacro rm [& args]
  (list 'await (list 'herd.sandbox/rm-with-name '__herd-program-name (first args))))
(defmacro mv [& args]
  (list 'await (list 'herd.sandbox/mv-with-name '__herd-program-name (first args))))
(defmacro glob [& args] (list 'await (cons 'herd.sandbox/glob args)))
(defmacro call [& args]
  (list 'await (list 'herd.sandbox/call-with-name '__herd-program-name (first args) (second args))))
