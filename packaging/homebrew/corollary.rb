# Cask template for the personal tap (calvinyz/homebrew-tap). .github/workflows/homebrew.yml
# fills in the version and checksum and pushes it there when a release is published.
cask "corollary" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/calvinyz/corollary/releases/download/v#{version}/Corollary_#{version}_aarch64.dmg"
  name "Corollary"
  desc "LaTeX workspace with on-device AI"
  homepage "https://github.com/calvinyz/corollary"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself; `brew upgrade` leaves it alone unless run with --greedy.
  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Corollary.app"

  zap trash: [
    "~/Library/Application Support/io.github.calvinyz.corollary",
    "~/Library/Caches/io.github.calvinyz.corollary",
    "~/Library/Corollary",
    "~/Library/Preferences/io.github.calvinyz.corollary.plist",
    "~/Library/Saved Application State/io.github.calvinyz.corollary.savedState",
    "~/Library/WebKit/io.github.calvinyz.corollary",
  ]

  caveats <<~EOS
    Corollary isn't notarized by Apple. The first time you open it, macOS blocks it:
    click Done, then open System Settings > Privacy & Security and click Open Anyway.
  EOS
end
