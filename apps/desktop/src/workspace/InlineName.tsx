import { useEffect, useRef, useState } from "react";

/** A name being typed in place. Enter saves, Escape or clicking away cancels. */
export function InlineName({ value, placeholder, onSave, onCancel }: { value: string; placeholder?: string; onSave(name: string): void; onCancel(): void }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current!;
    el.focus();
    // Select the name without its extension, like Finder.
    const dot = value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, [value]);
  return (
    <input
      ref={input}
      className="inline-name"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") text.trim() && text !== value ? onSave(text.trim()) : onCancel();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
    />
  );
}
