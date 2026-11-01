//! Compiles every project in a corpus the way the app does, including on-demand package installs
//! into the managed TeX Live:
//!
//!   cargo run --release --example corpus -- ~/corollary-corpus [--bin <texlive bin dir>]
use desktop_lib::{latex, texlive};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = e.file_type()?;
        if t.is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()))?;
        } else if t.is_file() {
            std::fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let corpus = PathBuf::from(args.get(1).expect("corpus dir"));
    let bin = args.iter().position(|a| a == "--bin").map(|i| PathBuf::from(&args[i + 1])).or_else(latex::find_tex_bin).expect("no TeX");
    let installable = texlive::is_managed(&bin);
    println!("TeX: {} (managed: {installable})", bin.display());
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(corpus.join("manifest.json")).unwrap()).unwrap();
    let (mut passed, mut total) = (0, 0);
    for p in manifest.as_array().unwrap() {
        let (id, dir, main) = (p["id"].as_str().unwrap(), p["dir"].as_str().unwrap(), p["main"].as_str().unwrap());
        let work = std::env::temp_dir().join(format!("corollary-corpus-{}-{}", std::process::id(), id.replace('/', "_")));
        let _ = std::fs::remove_dir_all(&work);
        copy_dir(&corpus.join(dir), &work.join("proj")).unwrap();
        let out = work.join("build");
        let start = Instant::now();
        let mut installed = Vec::new();
        let mut tried = std::collections::BTreeSet::new();
        let mut r = latex::compile_with(&bin, &work.join("proj"), main, &out, &latex::Running::default());
        // MAX_INSTALL_ROUNDS in App.tsx.
        for _ in 0..4 {
            let files: Vec<String> = r.missing_files.iter().filter(|f| !tried.contains(*f)).cloned().collect();
            if !installable || files.is_empty() {
                break;
            }
            tried.extend(files.iter().cloned());
            match texlive::install_for(&bin, &files, |_| {}) {
                Ok(p) => installed.extend(p),
                Err(e) => {
                    installed.push(format!("ERR {e}"));
                    break;
                }
            }
            r = latex::compile_with(&bin, &work.join("proj"), main, &out, &latex::Running::default());
        }
        total += 1;
        let ok = r.status == latex::Status::Success;
        passed += usize::from(ok);
        let first = r.entries.iter().find(|e| e.level == latex::Level::Error).map(|e| e.message.chars().take(90).collect::<String>()).unwrap_or_default();
        println!(
            "{:<14} {:<14} {:<8} {:<5} pdf={:<5} {:>6.1}s {}{}",
            id,
            p["category"].as_str().unwrap_or(""),
            format!("{:?}", r.engine.unwrap_or(latex::Engine::Pdflatex)).to_lowercase(),
            if ok { "PASS" } else { "FAIL" },
            r.pdf.is_some(),
            start.elapsed().as_secs_f64(),
            if installed.is_empty() { String::new() } else { format!("+{} ", installed.join(",")) },
            if ok { String::new() } else { first }
        );
        let _ = std::fs::remove_dir_all(&work);
    }
    println!("\n{passed}/{total} compiled");
}
