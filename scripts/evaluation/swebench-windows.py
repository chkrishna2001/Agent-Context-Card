"""Launch the official SWE-bench evaluator on Windows.

SWE-bench 4.1 imports its image-preparation module from package __init__, and
that module imports Unix''s resource module unconditionally. The actual
run_evaluation entry point already guards every resource-limit call by
platform.system() == "Linux". Supplying an empty module therefore restores the
entry point''s intended Windows behavior without changing evaluator logic.
"""

from __future__ import annotations

import runpy
import sys
import types
from pathlib import Path


if sys.platform == "win32" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

if sys.platform == "win32":
    _write_text = Path.write_text

    def _write_text_lf(
        self: Path,
        data: str,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ) -> int:
        return _write_text(
            self,
            data,
            encoding=encoding,
            errors=errors,
            newline="\n" if newline is None else newline,
        )

    Path.write_text = _write_text_lf

runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")
