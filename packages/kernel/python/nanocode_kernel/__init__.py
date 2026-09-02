"""nanocode's persistent Python REPL kernel.

M1 scope: the bare REPL engine (see repl.py) — a persistent, interruptible CPython namespace that
executes code cells over a newline-delimited JSON stdio protocol. Unlike prime-agent's `rlm` package,
this package does not (yet) bind an `rlm`/`harness`/`bash` object into the executed code's namespace:
that's introduced in M2, when `rlm.run()`-style recursive child-session spawning is built on top of
this same kernel (see decisions/0001-rlm-mechanism.md and PLAN.md's M2).
"""
