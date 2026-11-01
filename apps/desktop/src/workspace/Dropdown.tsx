import { useEffect, useRef, useState } from "react";

/** A button with a menu below it that closes on outside click or Escape. */
export function Dropdown({
  label,
  className = "",
  align = "left",
  up = false,
  children,
}: {
  label: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  /** Open above the button, e.g. from the status bar. */
  up?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  // The menu is fixed-position so the pane it sits in can't clip it.
  const toggle = () => {
    const r = root.current!.getBoundingClientRect();
    setPos({
      ...(up ? { bottom: innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      ...(align === "right" ? { right: innerWidth - r.right } : { left: r.left }),
      minWidth: Math.max(230, r.width),
    });
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`dropdown ${className}`} ref={root}>
      <button className={`dropdown-button${open ? " open" : ""}`} onClick={toggle} aria-expanded={open}>
        {label}
        <svg className="caret" viewBox="0 0 10 6" aria-hidden>
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="dropdown-menu" style={pos}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, shortcut, checked, children }: { onClick(): void; shortcut?: string; checked?: boolean; children: React.ReactNode }) {
  return (
    <button className="menu-item" onClick={onClick} role={checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={checked}>
      {checked !== undefined && <span className={`box${checked ? " on" : ""}`} />}
      <span className="menu-label">{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}
