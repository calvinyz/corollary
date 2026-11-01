#!/usr/bin/env node
// Writes src-tauri/THIRD_PARTY_LICENSES.txt, the notices for everything shipped inside the app:
// Rust crates linked into it, npm packages in the frontend bundle, the on-device helper's Swift
// packages and the bundled font. Run it after changing dependencies. Swift packages are only
// checked out where the helper is built, so the release build runs it with --require-swift.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(desktop, "../..");
const out = join(desktop, "src-tauri/THIRD_PARTY_LICENSES.txt");
const requireSwift = process.argv.includes("--require-swift");

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const texts = (dir) =>
  readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim());

const entries = [];
const add = (name, version, license, dir) => entries.push({ name, version, license, texts: existsSync(dir) ? texts(dir) : [] });

// Rust: the app's normal dependencies on Apple silicon, not build or dev dependencies.
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin", "--manifest-path", join(desktop, "src-tauri/Cargo.toml")], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }),
);
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const packages = new Map(meta.packages.map((p) => [p.id, p]));
const linked = new Set();
const walk = (id) => {
  for (const d of nodes.get(id).deps) {
    if (linked.has(d.pkg) || !d.dep_kinds.some((k) => k.kind === null)) continue;
    linked.add(d.pkg);
    walk(d.pkg);
  }
};
walk(meta.resolve.root);
for (const id of linked) {
  const p = packages.get(id);
  add(p.name, p.version, p.license ?? "", dirname(p.manifest_path));
}

// npm: production dependencies. Type packages and pdf.js's Node-only canvas aren't bundled.
const npm = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: desktop, encoding: "utf8", maxBuffer: 1 << 26 }));
for (const [license, list] of Object.entries(npm)) {
  for (const p of list) {
    if (p.name.startsWith("@types/") || p.name.startsWith("@napi-rs/")) continue;
    p.versions.forEach((v, i) => add(p.name, v, license, p.paths[i]));
  }
}

// Swift: the helper's packages, and libraries vendored inside them (MLX's C++ core and its
// dependencies keep their own licenses). swift-syntax only runs at build time.
const checkouts = join(repo, "helpers/corollary-fm/.build/dd/SourcePackages/checkouts");
const vendored = (root, dir, depth) => {
  for (const name of readdirSync(dir).sort()) {
    const sub = join(dir, name);
    if (name.startsWith(".") || /^tests?$/i.test(name) || !statSync(sub).isDirectory()) continue;
    if (texts(sub).length) add(relative(checkouts, sub), "", "", sub);
    if (depth < 4) vendored(root, sub, depth + 1);
  }
};
if (existsSync(checkouts)) {
  for (const name of readdirSync(checkouts).sort()) {
    if (name.startsWith(".") || name === "swift-syntax") continue;
    add(name, "", "", join(checkouts, name));
    vendored(name, join(checkouts, name), 1);
  }
} else if (requireSwift) {
  console.error(`No Swift packages at ${checkouts}; build the helper first.`);
  process.exit(1);
} else {
  console.warn("Swift packages not checked out here; leaving them out.");
}

entries.push({
  name: "Latin Modern Roman (font)",
  version: "",
  license: "GUST Font License",
  texts: [readFileSync(join(repo, "packaging/licenses/GUST-FONT-LICENSE.txt"), "utf8").trim()],
});

// Packages with the same license text share one copy of it.
const groups = new Map();
for (const e of entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const key = e.texts.length ? e.texts.join("\n\n") : `(The package ships no license file. License: ${e.license || "unknown"})`;
  if (!groups.has(key)) groups.set(key, []);
  const label = [e.name, e.version].filter(Boolean).join(" ") + (e.license && e.texts.length ? ` (${e.license})` : "");
  if (!groups.get(key).includes(label)) groups.get(key).push(label);
}

const rule = "=".repeat(78);
const body = [...groups].map(([text, names]) => `${rule}\n${names.join("\n")}\n${"-".repeat(78)}\n${text}\n`);
writeFileSync(
  out,
  `Corollary is licensed under the Apache License 2.0 (LICENSE). It includes the third-party
software below, under the licenses that follow each list of names.

On first use of image-to-LaTeX, Corollary downloads the GLM-OCR model (zai-org/GLM-OCR, MLX
conversion mlx-community/GLM-OCR-4bit), which its authors publish under the MIT license; see
https://huggingface.co/zai-org/GLM-OCR. It isn't part of the app.

${body.join("\n")}
${rule}
Packages above that ship no license file are used under the license named next to them. Those
offered under Apache-2.0 are used under it; its text follows. Source code for MPL-2.0 packages
is available from https://crates.io under the same name and version.
${"-".repeat(78)}
${readFileSync(join(repo, "LICENSE"), "utf8").trim()}
`,
);
console.log(`Wrote ${relative(process.cwd(), out)}: ${entries.length} components, ${groups.size} license texts.`);
