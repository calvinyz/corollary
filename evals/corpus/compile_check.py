#!/usr/bin/env python3
"""Compile every project in a corpus and report pass/fail per engine setup.

    python3 -I evals/corpus/compile_check.py --corpus ~/corollary-corpus --setup tectonic
    python3 -I evals/corpus/compile_check.py --corpus ~/corollary-corpus --setup texlive --texbin /path/to/texlive/bin/<arch>

Setups:
  tectonic  bundled-Tectonic candidate (XeTeX engine, packages fetched on demand)
  texlive   TeX Live + latexmk with the engine Overleaf would pick: pdfLaTeX unless the
            source needs XeLaTeX/LuaLaTeX. With --auto-install, missing packages are
            installed through tlmgr and the compile retried (the "managed TeX Live" candidate).

Every compile runs in a scratch copy, with TeX Live's default restricted shell-escape (as in the app).
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time

TIMEOUT = 300
MISSING = re.compile(r"File `([^']+)' not found|I can't find file `([^']+)'|Font \\[^=]+=(\S+) .*not loadable: Metric \(TFM\) file not found")


def pick_engine(main_src: str) -> str:
    """The engine an Overleaf user would have selected for this project."""
    if re.search(r"\\usepackage(\[[^\]]*\])?\{(fontspec|polyglossia|xeCJK|unicode-math)\}", main_src):
        return "xelatex"
    if re.search(r"\\usepackage(\[[^\]]*\])?\{(luacode|luatextra|lua-[a-z]+)\}|\\directlua", main_src):
        return "lualatex"
    return "pdflatex"


def run(cmd: list[str], cwd: pathlib.Path, env: dict) -> tuple[bool, str, bool]:
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, errors="replace", timeout=TIMEOUT)
        return p.returncode == 0, p.stdout + p.stderr, False
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return False, out, True


def first_error(log: str) -> str:
    for line in log.splitlines():
        if line.startswith("!") or line.startswith("error:") or "LaTeX Error" in line:
            return line.strip()[:200]
    tail = [l for l in log.splitlines() if l.strip()]
    return tail[-1][:200] if tail else ""


def compile_tectonic(work: pathlib.Path, main: str, env: dict) -> dict:
    ok, log, timed_out = run(["tectonic", "-X", "compile", "--synctex", "--keep-logs", main], work, env)
    return {"ok": ok, "engine": "tectonic(xetex)", "timedOut": timed_out, "log": log}


def compile_texlive(work: pathlib.Path, main: str, env: dict, texbin: pathlib.Path, auto_install: bool) -> dict:
    src = (work / main).read_text(errors="ignore")
    engine = pick_engine(src)
    flag = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}[engine]
    cmd = [str(texbin / "latexmk"), flag, "-interaction=nonstopmode", "-halt-on-error",
           "-synctex=1", "-norc", "-file-line-error", main]
    installed: list[str] = []
    for _ in range(12 if auto_install else 1):
        ok, log, timed_out = run(cmd, work, env)
        if ok or timed_out or not auto_install:
            break
        tex_log = (work / pathlib.Path(main).with_suffix(".log")).read_text(errors="ignore") if (work / pathlib.Path(main).with_suffix(".log")).exists() else ""
        m = MISSING.search(log + tex_log)
        if not m:
            break
        missing = next(g for g in m.groups() if g)
        name = missing if "." in missing else missing + ".tfm"
        found = subprocess.run([str(texbin / "tlmgr"), "search", "--global", "--file", "/" + name],
                               capture_output=True, text=True, env=env).stdout
        pkg = next((l.rstrip(":") for l in found.splitlines() if l and not l.startswith(" ") and not l.startswith("tlmgr")), None)
        if not pkg or pkg in installed:
            break
        subprocess.run([str(texbin / "tlmgr"), "install", pkg], capture_output=True, env=env)
        installed.append(pkg)
        subprocess.run([str(texbin / "latexmk"), "-C", main], cwd=work, capture_output=True, env=env)
    return {"ok": ok, "engine": engine, "timedOut": timed_out, "installed": installed, "log": log}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, type=pathlib.Path)
    ap.add_argument("--setup", required=True, choices=["tectonic", "texlive"])
    ap.add_argument("--texbin", type=pathlib.Path, help="TeX Live bin directory (texlive setup)")
    ap.add_argument("--auto-install", action="store_true", help="install missing packages with tlmgr and retry")
    ap.add_argument("--only", nargs="*", help="project ids to run")
    args = ap.parse_args()
    if args.setup == "texlive" and not args.texbin:
        ap.error("--texbin is required for the texlive setup")

    manifest = json.loads((args.corpus / "manifest.json").read_text())
    env = dict(os.environ, PATH=f"{args.texbin}:{os.environ['PATH']}" if args.texbin else os.environ["PATH"])
    label = args.setup + ("+auto-install" if args.auto_install else "")
    results = []
    for p in manifest:
        if args.only and p["id"] not in args.only:
            continue
        with tempfile.TemporaryDirectory(prefix="corollary-compile-") as tmp:
            work = pathlib.Path(tmp) / "proj"
            shutil.copytree(args.corpus / p["dir"], work, symlinks=False)
            start = time.time()
            r = (compile_tectonic(work, p["main"], env) if args.setup == "tectonic"
                 else compile_texlive(work, p["main"], env, args.texbin, args.auto_install))
            r["seconds"] = round(time.time() - start, 1)
            r["pdf"] = (work / pathlib.Path(p["main"]).with_suffix(".pdf")).exists()
        log = r.pop("log")
        r.update(id=p["id"], category=p["category"], error=None if r["ok"] else first_error(log))
        results.append(r)
        status = "PASS" if r["ok"] else ("TIMEOUT" if r["timedOut"] else "FAIL")
        extra = f"  +{','.join(r['installed'])}" if r.get("installed") else ""
        print(f"  {p['id']:<16} {p['category']:<16} {r['engine']:<16} {status:<7} {r['seconds']:>6.1f}s{extra}"
              + (f"  {r['error']}" if r["error"] else ""), flush=True)

    passed = sum(r["ok"] for r in results)
    print(f"\n{label}: {passed}/{len(results)} compiled")
    out = args.corpus / f"results-{label}.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
