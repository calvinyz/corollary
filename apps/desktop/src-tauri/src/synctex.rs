//! SyncTeX lookups through TeX Live's `synctex` tool.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// A box on a PDF page, in PDF points from the page's top-left corner.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub file: String,
    pub line: u32,
}

fn run(bin: &Path, args: &[String]) -> Option<String> {
    let out = Command::new(crate::latex::tool(bin, "synctex")).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn field<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block.lines().find_map(|l| l.strip_prefix(key)).map(str::trim)
}

pub fn parse_view(out: &str) -> Vec<PdfBox> {
    out.split("Output:")
        .skip(1)
        .filter_map(|b| {
            let num = |k: &str| field(b, k).and_then(|v| v.parse::<f64>().ok());
            let (h, v, w, hgt) = (num("h:")?, num("v:")?, num("W:")?, num("H:")?);
            Some(PdfBox { page: field(b, "Page:")?.parse().ok()?, x: h, y: v - hgt, width: w, height: hgt })
        })
        .collect()
}

/// First result inside the project; text generated into the build folder (e.g. `.bbl`) is skipped.
pub fn parse_edit(out: &str, root: &Path) -> Option<SourceLocation> {
    out.split("Output:").skip(1).find_map(|b| {
        let rel = Path::new(field(b, "Input:")?).strip_prefix(root).ok()?.to_string_lossy().into_owned();
        let line: u32 = field(b, "Line:")?.parse().ok()?;
        Some(SourceLocation { file: rel.trim_start_matches("./").to_string(), line: line.max(1) })
    })
}

/// Source line → PDF boxes. SyncTeX records input names as TeX saw them, so a few
/// spellings of the path are tried.
pub fn forward(bin: &Path, pdf: &Path, root: &Path, file: &str, line: u32) -> Vec<PdfBox> {
    let dir = pdf.parent().unwrap_or(Path::new("."));
    for name in [root.join(file).to_string_lossy().into_owned(), format!("./{file}"), file.to_string()] {
        let args = vec![
            "view".into(),
            "-i".into(),
            format!("{line}:0:{name}"),
            "-o".into(),
            pdf.to_string_lossy().into_owned(),
            "-d".into(),
            dir.to_string_lossy().into_owned(),
        ];
        let boxes = run(bin, &args).map(|o| parse_view(&o)).unwrap_or_default();
        if !boxes.is_empty() {
            return boxes;
        }
    }
    Vec::new()
}

/// PDF point (from the page's top-left) → source location.
pub fn inverse(bin: &Path, pdf: &Path, root: &Path, page: u32, x: f64, y: f64) -> Option<SourceLocation> {
    let dir = pdf.parent().unwrap_or(Path::new("."));
    let args = vec![
        "edit".into(),
        "-o".into(),
        format!("{page}:{x}:{y}:{}", pdf.display()),
        "-d".into(),
        dir.to_string_lossy().into_owned(),
    ];
    parse_edit(&run(bin, &args)?, root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_view_output() {
        let out = "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:/b/main.pdf\nPage:2\nx:100.0\ny:200.0\nh:72.0\nv:210.5\nW:400.0\nH:10.5\nbefore:\noffset:0\nmiddle:\nafter:\nSyncTeX result end\n";
        assert_eq!(parse_view(out), vec![PdfBox { page: 2, x: 72.0, y: 200.0, width: 400.0, height: 10.5 }]);
    }

    #[test]
    fn parses_edit_output() {
        let out = "SyncTeX result begin\nOutput:/b/main.pdf\nInput:/proj/./sections/intro.tex\nLine:42\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n";
        assert_eq!(parse_edit(out, Path::new("/proj")), Some(SourceLocation { file: "sections/intro.tex".into(), line: 42 }));
        let bbl = "SyncTeX result begin\nOutput:/b/main.pdf\nInput:/cache/build/main.bbl\nLine:2\nSyncTeX result end\n";
        assert_eq!(parse_edit(bbl, Path::new("/proj")), None);
    }
}
