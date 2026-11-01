import { openUrl } from "@tauri-apps/plugin-opener";

const SHORTCUTS: [string, string][] = [
  ["⌘K", "With text selected: edit it. With nothing selected: write at the cursor, or turn an image into an equation"],
  ["⌘↩", "Compile"],
  ["⌘S", "Save"],
  ["⌥⌘→", "Show the cursor’s line in the PDF"],
  ["⌘-click", "In the PDF: jump to that line in the source"],
  ["⌘N", "New file (or a new project from the start window)"],
  ["⌘O", "Open a project folder"],
  ["⌘I", "Import an Overleaf or Prism zip"],
  ["⌘+ / ⌘− / ⌘0", "Zoom the PDF in, out, or to fit"],
  ["⌘?", "This help"],
];

const TIPS = [
  "Double-click a file or folder to rename it. Type a path like sections/intro.tex in New file to make folders as you go.",
  "Drop a project folder or zip anywhere in the window to open it. Paste or drop an image of an equation into the editor to get its LaTeX.",
  "Every AI change is shown as a diff to accept or reject, and a snapshot is saved first (project menu › Snapshots).",
  "AI changes that drop a citation, change an equation or cite something that isn’t in your .bib are held back.",
  "Click an error under the PDF to jump to it, or ask the AI to explain it.",
];

export function Help({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help" onClick={(e) => e.stopPropagation()}>
        <h3>Using Corollary</h3>
        <dl className="help-keys">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <h4>Good to know</h4>
        <ul className="help-tips">
          {TIPS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="link" onClick={() => openUrl("https://github.com/calvinyz/corollary/issues").catch(() => {})}>
            Report a problem or ask for a feature
          </button>
          <span className="spacer" />
          <button className="primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
