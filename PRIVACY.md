# Privacy

Corollary has no account, no telemetry and no analytics. Your papers stay on your Mac unless you
choose a model that runs somewhere else.

## What leaves your Mac

| When | Where it goes | What is sent |
|---|---|---|
| Corollary opens | github.com | A request for the latest release's `latest.json`. If there's a newer version, the update downloads from there. |
| You install TeX Live from Setup | The TeX Live 2025 archive at ftp.math.utah.edu (or ftp.tu-chemnitz.de if that's down) | Requests for the installer and package archives |
| A project needs a LaTeX package you don't have | The same server | Requests for the package index and the package archives to install. Finding which package has a missing file happens on your Mac. Never your document. |
| You download the image-to-LaTeX model | huggingface.co | A request for the model files (1.2 GB, once) |
| You pick a remote model (a server on your network, or a cloud API with your key) | That server | The text you selected for ⌘K, or the compile error with the 80 surrounding source lines. The status bar says "leaves this Mac" while a remote model is selected. |

Nothing else makes a network request. With Apple's on-device model or Ollama on your Mac, AI edits
work with Wi-Fi off.

## What stays on your Mac

- **Your projects**, where you keep them. Corollary writes build output to a cache folder, not into
  the project.
- **Snapshots** taken before each AI edit, in
  `~/Library/Application Support/io.github.calvinyz.corollary/checkpoints`. They exist so you can
  undo an AI edit. Delete that folder to remove them.
- **API keys** you enter, in your macOS Keychain.
- **A log of AI edits** (time, model, kind of edit, whether you accepted it) used by the "AI use"
  button to draft an acknowledgments sentence. It holds no text from your paper.
- **TeX Live**, in `~/Library/Corollary/texlive`, and the image model, in
  `~/Library/Application Support/io.github.calvinyz.corollary/models`.

## Models

Apple's on-device model runs through Apple's Foundation Models framework on your Mac. GLM-OCR runs
through MLX on your Mac. Ollama models run wherever your Ollama runs. If you use a cloud API, that
provider's privacy policy applies to what you send it.
