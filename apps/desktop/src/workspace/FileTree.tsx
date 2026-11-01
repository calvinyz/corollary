import { useState } from "react";
import { InlineName } from "./InlineName";
import type { FileNode } from "../api";

interface Props {
  tree: FileNode[];
  open: string | null;
  main: string | null;
  dirty: Set<string>;
  onOpen(path: string): void;
  onSetMain(path: string): void;
  onRename(path: string, newName: string): void;
  /** Shows a name field at the top of the tree for a new file. */
  creating: boolean;
  onCreate(path: string): void;
  onCancelCreate(): void;
}

const KINDS: [RegExp, string][] = [
  [/\.tex$/i, "tex"],
  [/\.bib$/i, "bib"],
  [/\.(sty|cls|bst|bbx|cbx)$/i, "sty"],
  [/\.pdf$/i, "pdf"],
  [/\.(png|jpe?g|gif|svg|eps|webp|tiff?)$/i, "img"],
];
const kind = (name: string) => KINDS.find(([re]) => re.test(name))?.[1] ?? "file";

export function FileTree(props: Props) {
  return (
    <div className="file-tree" role="tree">
      {props.creating && (
        <div className="tree-row file creating" style={{ paddingLeft: 8 }}>
          <span className="file-kind file" />
          <InlineName value="" placeholder="name.tex" onSave={props.onCreate} onCancel={props.onCancelCreate} />
        </div>
      )}
      {props.tree.map((n) => (
        <Node key={n.path} node={n} depth={0} {...props} />
      ))}
    </div>
  );
}

function Node({ node, depth, ...p }: Props & { node: FileNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [renaming, setRenaming] = useState(false);
  const startRename = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRenaming(true);
  };
  const name = renaming ? (
    <InlineName
      value={node.name}
      onSave={(n) => {
        setRenaming(false);
        p.onRename(node.path, n);
      }}
      onCancel={() => setRenaming(false)}
    />
  ) : null;
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.isDir) {
    return (
      <>
        <div
          className="tree-row dir"
          style={pad}
          onClick={() => setExpanded(!expanded)}
          onDoubleClick={startRename}
          onContextMenu={startRename}
          role="treeitem"
          aria-expanded={expanded}
          title="Double-click to rename"
        >
          <span className={`chevron${expanded ? " open" : ""}`}>›</span>
          {name ?? node.name}
        </div>
        {expanded && node.children.map((c) => <Node key={c.path} node={c} depth={depth + 1} {...p} />)}
      </>
    );
  }
  const isTex = node.name.endsWith(".tex");
  return (
    <div
      className={`tree-row file${p.open === node.path ? " active" : ""}`}
      style={pad}
      onClick={() => p.onOpen(node.path)}
      onDoubleClick={startRename}
      onContextMenu={startRename}
      role="treeitem"
      title={`${node.path} · double-click to rename`}
    >
      <span className={`file-kind ${kind(node.name)}`} />
      <span className="name">
        {name ?? node.name}
        {!renaming && p.dirty.has(node.path) && <span className="dirty-dot">●</span>}
      </span>
      {p.main === node.path ? (
        <span className="main-badge">main</span>
      ) : (
        isTex && !renaming && (
          <button
            className="set-main"
            onClick={(e) => {
              e.stopPropagation();
              p.onSetMain(node.path);
            }}
          >
            Set main
          </button>
        )
      )}
    </div>
  );
}
