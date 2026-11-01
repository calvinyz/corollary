# Releasing

`.github/workflows/release.yml` builds an ad-hoc-signed DMG and a signed updater package when a
`v*` tag is pushed, then drafts a GitHub release. Publishing the draft ships it: installed copies
read `releases/latest/download/latest.json` on launch, install the update in the background and
run it from the next launch. Publishing also runs `.github/workflows/homebrew.yml`, which fills in
[`packaging/homebrew/corollary.rb`](../packaging/homebrew/corollary.rb) and pushes it to
[calvinyz/homebrew-tap](https://github.com/calvinyz/homebrew-tap).

There is no Apple Developer ID, so the app isn't notarized. Users approve the first launch under
System Settings › Privacy & Security › Open Anyway; updates after that aren't quarantined and open
normally. The hardened runtime is off (`tauri.macos.conf.json`): with ad-hoc signing, library
validation would stop `corollary-fm` from loading `libswiftCompatibilitySpan.dylib`.

## Secrets

| Secret | |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/corollary-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | In the login keychain as "Corollary updater key password" |
| `HOMEBREW_TAP_DEPLOY_KEY` | Private half of a deploy key with write access to `calvinyz/homebrew-tap` only |

The public key is in `tauri.conf.json`. **Back up the private key and its password.** Without
them no installed copy will accept another update.

## Before the first release

- [x] Add the secrets above.
- [ ] Settings › Pages › Source: GitHub Actions (`.github/workflows/pages.yml` publishes `apps/web`).
- [ ] Check that the `macos-26` runner has Xcode 26.4 or later and can download the Metal
      Toolchain; the workflow fails early if not.
- [ ] On a clean Mac, download the DMG from the draft release and confirm:
  - Open Anyway appears for it (a broken signature shows "damaged" instead, with no way past it);
  - the on-device AI and GLM-OCR work from the installed app;
  - an update replaces the app in `/Applications` without an App Management prompt.
- [ ] Run the USPTO check for "Corollary".

## Each release

1. Bump the version in `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` and `package.json`.
   The workflow refuses a tag that doesn't match `tauri.conf.json`.
2. Run the corpus check (`cargo run --release --example corpus -- <corpus>`) and `pnpm test`.
3. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
4. Check the draft release, then publish it. Check that the homebrew workflow updated the tap; if
   it failed, rerun it from the Actions tab with the tag.

## Later: Developer ID

To notarize, add the certificate and notarization secrets, import the certificate before the
build, set `APPLE_SIGNING_IDENTITY`, and turn `hardenedRuntime` back on. The updater key stays
the same.
