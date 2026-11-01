import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Selection } from "../editor/Editor";
import type { ChatMessage } from "../api";
import { ACTIONS, editMessages, retryMessages, writeMessages, writeRetryMessages, type EditAction, type WriteContext } from "./prompts";
import { check, checkWrite, clean, type Check } from "./validate";

interface Props {
  selection: Selection;
  modelLabel: string;
  /** Saves and snapshots the project; called before the edit is shown. */
  beforeApply(): Promise<void>;
  onPropose(sel: Selection, text: string, action: EditAction): void;
  /** With nothing selected, ⌘K writes at the cursor; this gathers what the model sees. */
  writeContext(): Promise<WriteContext>;
  /** …or inserts an equation from an image. */
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

export function AiBar({ selection, modelLabel, beforeApply, onPropose, writeContext, onImage, onClose }: Props) {
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
    if ((action === "custom" || action === "write") && !custom.trim()) return;
    const id = ++run.current;
    const live = () => run.current === id;
    try {
      setPhase({ kind: "running", preview: "", retry: false });
      let messages: ChatMessage[];
      let verify: (out: string) => Check;
      let retryMessagesFor: (out: string, problems: string[]) => ChatMessage[];
      if (action === "write") {
        const ctx = await writeContext();
        if (!live()) return;
        messages = writeMessages(custom, ctx);
        verify = (out) => checkWrite(out, new Set(ctx.cites), new Set(ctx.labels), new Set(ctx.packages), `${custom}\n${ctx.before}\n${ctx.after}`);
        retryMessagesFor = (out, problems) => writeRetryMessages(messages, out, problems);
      } else {
        messages = editMessages(action, selection.text, custom);
        verify = (out) => check(selection.text, out);
        retryMessagesFor = (out, problems) => retryMessages(messages, out, problems);
      }
      let preview = "";
      let out = clean(
        await api.aiChat(messages, MAX_TOKENS, (d) => {
          preview += d;
          if (live()) setPhase({ kind: "running", preview, retry: false });
        }),
      );
      if (!live()) return;
      let result = verify(out);
      if (!result.ok) {
        setPhase({ kind: "running", preview: "", retry: true });
        const second = clean(await api.aiChat(retryMessagesFor(out, result.problems), MAX_TOKENS, () => {}));
        if (!live()) return;
        const r2 = verify(second);
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
      if (action !== "write" && out.trim() === selection.text.trim()) {
        setPhase({ kind: "unchanged" });
        return;
      }
      await propose(out, action);
    } catch (e) {
      if (live()) setPhase({ kind: "error", message: String(e) });
    }
  };

  const status = (
    <>
      {phase.kind === "running" && (
        <div className="ai-bar-status">
          <span className="spinner" /> {phase.retry ? "Trying again…" : selection.text.trim() ? "Thinking…" : "Writing…"}
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
    </>
  );

  if (!selection.text.trim()) {
    return (
      <div className="ai-bar" role="dialog" aria-label="Write at cursor">
        <div className="ai-bar-head">
          Write at cursor
          <span className="spacer" />
          <span className="ai-bar-meta">{modelLabel}</span>
          <button className="icon" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ai-bar-row">
          <input
            ref={input}
            className="ai-custom"
            placeholder="What should go here? e.g. a table comparing three methods"
            value={custom}
            disabled={phase.kind === "running"}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start("write")}
          />
          <button className="chip" disabled={phase.kind === "running" || !custom.trim()} onClick={() => start("write")}>
            Write
          </button>
          <button className="chip" disabled={phase.kind === "running"} onClick={onImage}>
            Equation from image…
          </button>
        </div>
        {status}
        {phase.kind === "idle" && (
          <div className="ai-bar-meta">You review the draft before it goes in. To edit existing text, select it first.</div>
        )}
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
      {status}
    </div>
  );
}
