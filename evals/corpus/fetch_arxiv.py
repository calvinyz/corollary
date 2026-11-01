#!/usr/bin/env python3
"""Download recent arXiv LaTeX sources as a compile-test corpus.

    python3 -I evals/corpus/fetch_arxiv.py --out ~/corollary-corpus --per-category 2

Each paper is extracted into OUT/<arxiv-id>/ and listed in OUT/manifest.json.
arXiv compiled every one of these with TeX Live, so they are known-good inputs.
Sources are untrusted: compile them with latexmk -norc and restricted shell-escape.
"""
import argparse
import gzip
import io
import json
import pathlib
import tarfile
import time
import urllib.request
import xml.etree.ElementTree as ET

# Fields that write in LaTeX, weighted toward the arXiv-heavy beachhead (ML/CS, physics, math).
CATEGORIES = [
    "cs.LG", "cs.CL", "cs.CV", "cs.RO", "cs.DC", "cs.CR",
    "hep-th", "cond-mat.str-el", "astro-ph.GA", "quant-ph", "physics.optics",
    "math.AP", "math.CO", "math.PR", "stat.ME",
    "q-bio.NC", "econ.EM", "eess.SP",
]
API = "https://export.arxiv.org/api/query?search_query=cat:{cat}&sortBy=submittedDate&sortOrder=descending&max_results={n}"
EPRINT = "https://arxiv.org/e-print/{id}"
ATOM = "{http://www.w3.org/2005/Atom}"
UA = {"User-Agent": "corollary-corpus/0.1 (compile test corpus)"}
DELAY = 3.5  # arXiv asks for at most one request every 3 seconds


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def recent_ids(cat: str, n: int) -> list[str]:
    feed = ET.fromstring(get(API.format(cat=cat, n=n * 3)))
    ids = []
    for entry in feed.iter(ATOM + "entry"):
        url = entry.findtext(ATOM + "id", "")
        ids.append(url.rsplit("/abs/", 1)[-1].split("v")[0])
    return ids


def safe_extract(tar: tarfile.TarFile, dest: pathlib.Path) -> None:
    root = dest.resolve()
    for m in tar.getmembers():
        target = (dest / m.name).resolve()
        if not target.is_relative_to(root) or m.issym() or m.islnk() or m.isdev():
            continue
        tar.extract(m, dest)


def extract(blob: bytes, dest: pathlib.Path) -> bool:
    """e-prints are a gzipped tar, a gzipped single .tex, or a PDF (no source)."""
    dest.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as tar:
            safe_extract(tar, dest)
            return True
    except tarfile.ReadError:
        pass
    try:
        text = gzip.decompress(blob)
    except OSError:
        text = blob
    if text.startswith(b"%PDF"):
        return False
    (dest / "main.tex").write_bytes(text)
    return True


def main_file(project: pathlib.Path) -> str | None:
    for tex in sorted(project.rglob("*.tex")):
        src = tex.read_text(errors="ignore")
        if "\\documentclass" in src and "\\begin{document}" in src:
            return str(tex.relative_to(project))
    return None


def fetch_one(pid: str, cat: str, out: pathlib.Path, manifest: list, have: set, manifest_path: pathlib.Path) -> bool:
    dest = out / pid.replace("/", "_")
    try:
        ok = extract(get(EPRINT.format(id=pid)), dest)
    except Exception as e:  # network errors etc.: skip this paper
        print(f"  {cat} {pid}: download failed ({e})")
        ok = False
    time.sleep(DELAY)
    main = main_file(dest) if ok else None
    if not main:
        print(f"  {cat} {pid}: no LaTeX source, skipped")
        return False
    manifest.append({"id": pid, "category": cat, "dir": dest.name, "main": main})
    have.add(pid)
    print(f"  {cat} {pid}: {main}")
    manifest_path.write_text(json.dumps(manifest, indent=2))
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--per-category", type=int, default=2)
    ap.add_argument("--categories", nargs="*", default=CATEGORIES)
    ap.add_argument("--ids", nargs="*", default=[], help="specific arXiv ids to include")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    have = {p["id"] for p in manifest}

    for pid in args.ids:
        if pid not in have:
            fetch_one(pid, "listed", args.out, manifest, have, manifest_path)

    for cat in args.categories:
        got = sum(1 for p in manifest if p["category"] == cat)
        if got >= args.per_category:
            continue
        try:
            ids = recent_ids(cat, args.per_category)
        except Exception as e:
            print(f"  {cat}: listing failed ({e})")
            continue
        time.sleep(DELAY)
        for pid in ids:
            if got >= args.per_category:
                break
            if pid in have:
                continue
            if fetch_one(pid, cat, args.out, manifest, have, manifest_path):
                got += 1
    print(f"{len(manifest)} projects in {manifest_path}")


if __name__ == "__main__":
    main()
