//! Projects are plain folders; Overleaf/Prism zips are extracted into one.

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Hidden entries (`.git`, `.DS_Store`) are skipped too.
const SKIP_DIRS: &[&str] = &["node_modules", "__MACOSX"];
/// Build artifacts left next to sources by other tools.
const SKIP_EXTS: &[&str] = &[
    "aux", "log", "out", "toc", "lof", "lot", "fls", "fdb_latexmk", "synctex.gz", "bbl", "blg", "bcf",
    "run.xml", "xdv", "nav", "snm", "vrb",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// Relative to the project root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    pub tree: Vec<FileNode>,
    pub main: Option<String>,
}

fn is_artifact(name: &str) -> bool {
    SKIP_EXTS.iter().any(|ext| name.ends_with(&format!(".{ext}")))
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn walk(root: &Path, dir: &Path, depth: usize) -> io::Result<Vec<FileNode>> {
    let mut nodes = Vec::new();
    if depth > 12 {
        return Ok(nodes);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let children = walk(root, &path, depth + 1)?;
            nodes.push(FileNode { name, path: rel(root, &path), is_dir: true, children });
        } else if !is_artifact(&name) {
            nodes.push(FileNode { name, path: rel(root, &path), is_dir: false, children: vec![] });
        }
    }
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

/// Every file's project-relative path.
fn flatten(nodes: &[FileNode], out: &mut Vec<String>) {
    for n in nodes {
        if n.is_dir {
            flatten(&n.children, out);
        } else {
            out.push(n.path.clone());
        }
    }
}

/// Shallowest `.tex` with `\documentclass` and `\begin{document}`, preferring `main.tex`.
pub fn detect_main(root: &Path, tree: &[FileNode]) -> Option<String> {
    let mut candidates = Vec::new();
    flatten(tree, &mut candidates);
    candidates.retain(|p| p.ends_with(".tex"));
    let is_document = |p: &String| {
        fs::read(root.join(p))
            .map(|bytes| {
                let src = String::from_utf8_lossy(&bytes);
                let body: String = src.lines().filter(|l| !l.trim_start().starts_with('%')).collect::<Vec<_>>().join("\n");
                body.contains("\\documentclass") && body.contains("\\begin{document}")
            })
            .unwrap_or(false)
    };
    let mut docs: Vec<String> = candidates.into_iter().filter(is_document).collect();
    docs.sort_by_key(|p| (p.matches('/').count(), p.rsplit('/').next() != Some("main.tex"), p.clone()));
    docs.into_iter().next()
}

pub fn open(root: &Path) -> io::Result<Project> {
    let root = root.canonicalize()?;
    let tree = walk(&root, &root, 0)?;
    let main = detect_main(&root, &tree);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Project { root: root.to_string_lossy().into_owned(), name, tree, main })
}

/// Resolves a project-relative path, rejecting anything outside the project.
pub fn resolve(root: &Path, relative: &str) -> io::Result<PathBuf> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path escapes the project"));
    }
    let path = root.join(rel);
    // A symlink inside the project can still point outside it.
    let target = path.canonicalize().or_else(|_| path.parent().ok_or(io::ErrorKind::NotFound)?.canonicalize());
    if let Ok(target) = target
        && !target.starts_with(root.canonicalize()?)
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path escapes the project"));
    }
    Ok(path)
}

/// Against zip bombs.
const MAX_UNZIPPED_BYTES: u64 = 4 << 30;

/// Extracts into `dest_parent/<zip name>`, unwrapping a single top-level folder.
pub fn import_zip(zip_path: &Path, dest_parent: &Path) -> io::Result<PathBuf> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(io::Error::other)?;

    let stem = zip_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    let mut dest = dest_parent.join(&stem);
    let mut n = 2;
    while dest.exists() {
        dest = dest_parent.join(format!("{stem} {n}"));
        n += 1;
    }

    // Folder entries (`paper/`) are left out, or a zip made in Finder would never look wrapped.
    let names: Vec<PathBuf> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().filter(|f| !f.is_dir()).and_then(|f| f.enclosed_name()))
        .filter(|p| !p.starts_with("__MACOSX"))
        .collect();
    let first = names.first().and_then(|p| p.components().next()).map(|c| c.as_os_str().to_owned());
    let wrapped = first.as_ref().is_some_and(|f| names.iter().all(|p| p.components().next().map(|c| c.as_os_str()) == Some(f.as_os_str()) && p.components().count() > 1));

    fs::create_dir_all(&dest)?;
    let mut budget = MAX_UNZIPPED_BYTES;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(io::Error::other)?;
        let Some(mut path) = entry.enclosed_name() else { continue };
        if path.starts_with("__MACOSX") {
            continue;
        }
        if wrapped {
            path = path.components().skip(1).collect();
        }
        if path.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent)?;
            }
            // Declared sizes can lie, so count what is actually written.
            let written = io::copy(&mut io::Read::take(&mut entry, budget + 1), &mut fs::File::create(&out)?)?;
            if written > budget {
                let _ = fs::remove_dir_all(&dest);
                return Err(io::Error::other("The zip unpacks to more than 4 GB, which is too large for a LaTeX project."));
            }
            budget -= written;
        }
    }
    Ok(dest)
}

fn check_name(name: &str) -> io::Result<()> {
    let bad = name.trim().is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." || name.starts_with('.');
    if bad {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "That name can’t be used."));
    }
    Ok(())
}

/// Renames a file or folder inside the project, keeping it in the same folder. Returns the new
/// project-relative path.
pub fn rename(root: &Path, relative: &str, new_name: &str) -> io::Result<String> {
    check_name(new_name)?;
    let from = resolve(root, relative)?;
    let to_rel = match relative.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/{new_name}"),
        None => new_name.to_string(),
    };
    let to = resolve(root, &to_rel)?;
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("“{new_name}” already exists.")));
    }
    fs::rename(from, to)?;
    Ok(to_rel)
}

/// Renames the project folder itself. Returns the new root.
pub fn rename_project(root: &Path, new_name: &str) -> io::Result<PathBuf> {
    check_name(new_name)?;
    let to = root.parent().ok_or(io::ErrorKind::InvalidInput)?.join(new_name);
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("A folder named “{new_name}” is already there.")));
    }
    fs::rename(root, &to)?;
    Ok(to)
}

/// Zips the project's source files (no build output, `.git` or hidden files) into `dest`.
pub fn export_zip(root: &Path, dest: &Path) -> io::Result<()> {
    use std::io::Write;
    let mut paths = Vec::new();
    flatten(&walk(root, root, 0)?, &mut paths);
    let mut zip = zip::ZipWriter::new(fs::File::create(dest)?);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for p in paths {
        zip.start_file(&p, opts).map_err(io::Error::other)?;
        zip.write_all(&fs::read(root.join(&p))?)?;
    }
    zip.finish().map_err(io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_zip_with_folder_entries() {
        use std::io::Write;
        let base = std::env::temp_dir().join(format!("corollary-unwrap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("paper.zip");
        let mut z = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        z.add_directory("paper/", opts).unwrap();
        z.start_file("paper/main.tex", opts).unwrap();
        z.write_all(b"x").unwrap();
        z.finish().unwrap();
        let out = import_zip(&zip_path, &base.join("out")).unwrap();
        assert!(out.join("main.tex").is_file(), "the outer folder should be dropped");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn renames_files_and_project() {
        let base = std::env::temp_dir().join(format!("corollary-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("paper");
        fs::create_dir_all(root.join("sec")).unwrap();
        fs::write(root.join("sec/a.tex"), "a").unwrap();
        fs::write(root.join("sec/b.tex"), "b").unwrap();
        assert_eq!(rename(&root, "sec/a.tex", "intro.tex").unwrap(), "sec/intro.tex");
        assert!(root.join("sec/intro.tex").is_file());
        assert!(rename(&root, "sec/intro.tex", "b.tex").is_err(), "won't overwrite");
        assert!(rename(&root, "sec/b.tex", "../x.tex").is_err(), "no paths");
        assert_eq!(rename(&root, "sec", "sections").unwrap(), "sections");
        let moved = rename_project(&root, "thesis").unwrap();
        assert!(moved.join("sections/intro.tex").is_file());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn export_round_trips() {
        let base = std::env::temp_dir().join(format!("corollary-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("paper");
        fs::create_dir_all(src.join("sec")).unwrap();
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::write(src.join("main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}").unwrap();
        fs::write(src.join("sec/a.tex"), "a").unwrap();
        fs::write(src.join("main.aux"), "build output").unwrap();
        fs::write(src.join(".git/HEAD"), "ref").unwrap();
        let zip = base.join("paper.zip");
        export_zip(&src, &zip).unwrap();
        let mut names: Vec<String> = zip::ZipArchive::new(fs::File::open(&zip).unwrap()).unwrap().file_names().map(|n| n.unwrap().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["main.tex", "sec/a.tex"]);
        let out = import_zip(&zip, &base.join("imported")).unwrap();
        assert_eq!(fs::read_to_string(out.join("sec/a.tex")).unwrap(), "a");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("/tmp/p");
        assert!(resolve(root, "../x").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
        assert!(resolve(root, "a/../../x").is_err());
        assert_eq!(resolve(root, "sec/intro.tex").unwrap(), root.join("sec/intro.tex"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escapes() {
        let dir = std::env::temp_dir().join(format!("corollary-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("p")).unwrap();
        fs::write(dir.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("secret"), dir.join("p/notes.tex")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("p/up")).unwrap();
        let root = dir.join("p");
        assert!(resolve(&root, "notes.tex").is_err());
        assert!(resolve(&root, "up/new.tex").is_err());
        assert!(resolve(&root, "new.tex").is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn detects_main_file() {
        let dir = std::env::temp_dir().join(format!("corollary-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sections")).unwrap();
        fs::write(dir.join("sections/intro.tex"), "\\section{Intro}").unwrap();
        fs::write(dir.join("paper.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}").unwrap();
        fs::write(dir.join("old.tex"), "% \\documentclass{article}\n% \\begin{document}").unwrap();
        let p = open(&dir).unwrap();
        assert_eq!(p.main.as_deref(), Some("paper.tex"));
        fs::remove_dir_all(&dir).unwrap();
    }
}

/// Imports and compiles a real export: `COROLLARY_SAMPLE_ZIP=… cargo test -- --ignored sample_zip`
#[cfg(test)]
mod sample_tests {
    #[test]
    #[ignore]
    fn sample_zip_imports_and_compiles() {
        let zip = std::path::PathBuf::from(std::env::var("COROLLARY_SAMPLE_ZIP").expect("COROLLARY_SAMPLE_ZIP"));
        let dest = std::env::temp_dir().join(format!("corollary-sample-{}", std::process::id()));
        std::fs::create_dir_all(&dest).unwrap();
        let dir = super::import_zip(&zip, &dest).unwrap();
        let p = super::open(&dir).unwrap();
        let main = p.main.expect("main file detected");
        let r = crate::latex::compile(&dir, &main, &dest.join("build"), &crate::latex::Running::default());
        eprintln!("main={main} status={:?} engine={:?} pdf={} {:.1}s missing={:?}", r.status, r.engine, r.pdf.is_some(), r.seconds, r.missing_files);
        for e in r.entries.iter().filter(|e| e.level == crate::latex::Level::Error) {
            eprintln!("  error: {:?}:{:?} {}", e.file, e.line, e.message);
        }
        assert_eq!(r.status, crate::latex::Status::Success);
        std::fs::remove_dir_all(&dest).unwrap();
    }
}
