import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Selection } from "../editor/Editor";
import { ACTIONS, editMessages, retryMessages, type EditAction } from "./prompts";
import { check, clean } from "./validate";

interface Props {
  selection: Selection;
  modelLabel: string;
  /** Saves and snapshots the project; called before the edit is shown. */
  beforeApply(): Promise<void>;
  onPropose(sel: Selection, text: string, action: EditAction): void;
  /** With nothing selected, ⌘K offers to insert an equation from an image instead. */
  onImage(): void;
  onClose(): void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "running"; preview: string; retry: boolean }
  | { kind: "rejected"; text: string; problems: string[]; action: EditAction }
  | { kind: "error"; message: string }
  | { kind: "unchanged" };

const MAX_TOKENS = 1024;

export function AiBar({ selection, modelLabel, beforeApply, onPropose, onImage, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [custom, setCustom] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const close = () => {
    run.current++;
    onClose();
  };

  const propose = async (text: string, action: EditAction) => {
    const id = run.current;
    await beforeApply();
    // Closed (Esc) while the snapshot was being taken.
    if (run.current !== id) return;
    onPropose(selection, text, action);
  };

  const start = async (action: EditAction) => {
    if (action === "custom" && !custom.trim()) return;
    const id = ++run.current;
    const live = () => run.current === id;
    const messages = editMessages(action, selection.text, custom);
    try {
      setPhase({ kind: "running", preview: "", retry: false });
      let preview = "";
      let out = clean(
        await api.aiChat(messages, MAX_TOKENS, (d) => {
          preview += d;
          if (live()) setPhase({ kind: "running", preview, retry: false });
        }),
      );
      if (!live()) return;
      let result = check(selection.text, out);
      if (!result.ok) {
        setPhase({ kind: "running", preview: "", retry: true });
        const second = clean(await api.aiChat(retryMessages(messages, out, result.problems), MAX_TOKENS, () => {}));
        if (!live()) return;
        const r2 = check(selection.text, second);
        if (r2.ok || r2.problems.length < result.problems.length) {
          out = second;
          result = r2;
        }
      }
      if (!result.ok) {
        setPhase({ kind: "rejected", text: out, problems: result.problems, action });
        return;
      }
      // An identical reply would open an empty review; say so instead.
      if (out.trim() === selection.text.trim()) {
        setPhase({ kind: "unchanged" });
        return;
      }
      await propose(out, action);
    } catch (e) {
      if (live()) setPhase({ kind: "error", message: String(e) });
    }
  };

  if (!selection.text.trim()) {
    return (
      <div className="ai-bar" role="dialog" aria-label="Insert">
        <div className="ai-bar-head">
          Insert at cursor
          <span className="spacer" />
          <button className="icon" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ai-bar-row">
          <button className="chip" onClick={onImage} autoFocus>
            Equation from image…
          </button>
        </div>
        <div className="ai-bar-meta">You can also paste or drop an image of an equation into the editor. To edit text, select it first.</div>
      </div>
    );
  }

  const words = selection.text.trim().split(/\s+/).length;

  return (
    <div className="ai-bar" role="dialog" aria-label="AI edit">
      <div className="ai-bar-head">
        Edit selection
        <span className="spacer" />
        <span className="ai-bar-meta">
          {words} word{words === 1 ? "" : "s"} · {modelLabel}
        </span>
        <button className="icon" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="ai-bar-row">
        {ACTIONS.map((a) => (
          <button key={a.id} className="chip" title={a.hint} disabled={phase.kind === "running"} onClick={() => start(a.id)}>
            {a.label}
          </button>
        ))}
        <input
          ref={input}
          className="ai-custom"
          placeholder="Or say what to change…"
          value={custom}
          disabled={phase.kind === "running"}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start("custom")}
        />
      </div>
      {phase.kind === "running" && (
        <div className="ai-bar-status">
          <span className="spinner" /> {phase.retry ? "Trying again…" : "Thinking…"}
          {phase.preview && <pre className="ai-preview">{phase.preview}</pre>}
        </div>
      )}
      {phase.kind === "rejected" && (
        <div className="ai-bar-status warn">
          Held back: {phase.problems.join("; ")}.
          <div className="ai-bar-row">
            <button onClick={() => propose(phase.text, phase.action)}>Show it anyway</button>
            <button onClick={() => setPhase({ kind: "idle" })}>Discard</button>
          </div>
        </div>
      )}
      {phase.kind === "error" && <div className="ai-bar-status error">{phase.message}</div>}
      {phase.kind === "unchanged" && <div className="ai-bar-status info">No changes needed. The text already reads well for this edit.</div>}
    </div>
  );
}
