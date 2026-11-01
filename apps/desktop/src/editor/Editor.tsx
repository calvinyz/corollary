import { useEffect, useRef } from "react";
import { Compartment, EditorState, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { acceptChunk, getChunks, rejectChunk, unifiedMergeView } from "@codemirror/merge";
import { EditorView, Decoration, DecorationSet, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { latexHighlight } from "./theme";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { stex } from "@codemirror/legacy-modes/mode/stex";

export interface Marker {
  line: number;
  level: "error" | "warning";
}

export interface Selection {
  from: number;
  to: number;
  text: string;
}

export interface EditorHandle {
  goToLine(line: number): void;
  cursorLine(): number;
  selection(): Selection;
  /** Replaces a range and shows the change as accept/reject hunks. */
  propose(from: number, to: number, text: string): void;
  resolveAll(accept: boolean): void;
  insert(pos: number, text: string): void;
  replaceLine(line: number, text: string): void;
  posAtCoords(x: number, y: number): number | null;
  lines(): string[];
}

interface Props {
  doc: string;
  /** Changes when a different file is opened, so the editor resets its history. */
  docKey: string;
  markers: Marker[];
  onChange(doc: string): void;
  onSave(): void;
  onCompile(): void;
  onSyncToPdf(line: number): void;
  onAiCommand(sel: Selection): void;
  onPasteImage(file: File, pos: number): void;
  /** Called when every proposed hunk has been accepted or rejected. */
  onReviewDone(): void;
  handleRef: React.MutableRefObject<EditorHandle | null>;
}

const setMarkers = StateEffect.define<Marker[]>();
const markerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarkers)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const doc = tr.state.doc;
      for (const m of [...e.value].sort((a, c) => a.line - c.line)) {
        if (m.line < 1 || m.line > doc.lines) continue;
        b.add(doc.line(m.line).from, doc.line(m.line).from, Decoration.line({ class: `cm-marker-${m.level}` }));
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function Editor(props: Props) {
  const { doc, docKey, markers, handleRef } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Callbacks change every render; the editor reads the latest through this ref.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const cursorLine = (v: EditorView) => v.state.doc.lineAt(v.state.selection.main.head).number;
    const review = new Compartment();
    const selection = (v: EditorView): Selection => {
      const r = v.state.selection.main;
      return { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to) };
    };
    const endReviewIfDone = (v: EditorView) => {
      const chunks = getChunks(v.state);
      if (chunks && chunks.chunks.length === 0) {
        v.dispatch({ effects: review.reconfigure([]) });
        cb.current.onReviewDone();
      }
    };
    const imageFrom = (files: FileList | undefined | null) => [...(files ?? [])].find((f) => f.type.startsWith("image/"));
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        bracketMatching(),
        EditorView.lineWrapping,
        StreamLanguage.define(stex),
        syntaxHighlighting(latexHighlight),
        markerField,
        review.of([]),
        EditorView.domEventHandlers({
          paste(e, v) {
            const img = imageFrom(e.clipboardData?.files);
            if (!img) return false;
            e.preventDefault();
            cb.current.onPasteImage(img, v.state.selection.main.head);
            return true;
          },
        }),
        keymap.of([
          { key: "Mod-k", preventDefault: true, run: (v) => (cb.current.onAiCommand(selection(v)), true) },
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          { key: "Mod-Enter", preventDefault: true, run: () => (cb.current.onCompile(), true) },
          { key: "Mod-Alt-ArrowRight", preventDefault: true, run: (v) => (cb.current.onSyncToPdf(cursorLine(v)), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          if (getChunks(u.state) && u.transactions.length) queueMicrotask(() => endReviewIfDone(u.view));
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    // For scripts/screenshots.mjs.
    if (import.meta.env.DEV) Object.assign(host.current!, { cmView: v });
    handleRef.current = {
      goToLine(line) {
        const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
        v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
        v.focus();
      },
      cursorLine: () => cursorLine(v),
      selection: () => selection(v),
      propose(from, to, text) {
        const original = v.state.doc;
        v.dispatch({
          effects: review.reconfigure(unifiedMergeView({ original, mergeControls: true, gutter: true, syntaxHighlightDeletions: true })),
        });
        v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from }, scrollIntoView: true });
      },
      resolveAll(accept) {
        for (let guard = 0; guard < 500; guard++) {
          const chunks = getChunks(v.state)?.chunks;
          if (!chunks?.length) break;
          (accept ? acceptChunk : rejectChunk)(v, chunks[0].fromB);
        }
        endReviewIfDone(v);
      },
      insert(pos, text) {
        v.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
        v.focus();
      },
      replaceLine(line, text) {
        if (line < 1 || line > v.state.doc.lines) return;
        const l = v.state.doc.line(line);
        handleRef.current?.propose(l.from, l.to, text);
      },
      posAtCoords: (x, y) => v.posAtCoords({ x, y }),
      lines: () => v.state.doc.toString().split("\n"),
    };
    return () => {
      // Leaving a file mid-review keeps the proposed text; the checkpoint still has the original.
      if (getChunks(v.state)?.chunks.length) cb.current.onReviewDone();
      v.destroy();
      view.current = null;
      handleRef.current = null;
    };
    // Recreate only when switching files; edits flow out through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarkers.of(markers) });
  }, [markers, docKey]);

  return <div className="editor" ref={host} />;
}
