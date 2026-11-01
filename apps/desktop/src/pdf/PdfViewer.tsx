import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
// The legacy build polyfills APIs that older macOS WebKit lacks.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PdfBox } from "../api";

GlobalWorkerOptions.workerSrc = workerUrl;

export type Zoom = "fit" | number;

interface Props {
  data: ArrayBuffer | null;
  /** "fit" fills the pane's width; a number is a fraction of actual size (1 = 100%). */
  zoom: Zoom;
  onPageInfo(current: number, total: number): void;
  highlight: PdfBox[];
  /** PDF points from the page's top-left, the coordinates SyncTeX uses. */
  onInverseSearch(page: number, x: number, y: number): void;
}

interface PageSize {
  width: number;
  height: number;
}

// Matches .pdf-scroller padding and gap in App.css.
const GAP = 16;

// PDF points to CSS pixels at 100%.
const PT = 96 / 72;

export function PdfViewer({ data, zoom, onPageInfo, highlight, onInverseSearch }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const loaded = useRef<PDFDocumentLoadingTask | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    // pdf.js takes ownership of the buffer, so hand it a copy.
    const task = getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise
      .then(async (d) => {
        const s: PageSize[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          s.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) return task.destroy();
        if (!loaded.current) scroller.current?.scrollTo({ top: 0 });
        loaded.current?.destroy();
        loaded.current = task;
        setSizes(s);
        setDoc(d);
      })
      .catch((e) => {
        if (!cancelled) console.warn("couldn't open the PDF", e);
        task.destroy();
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(
    () => () => {
      loaded.current?.destroy();
      loaded.current = null;
    },
    [],
  );

  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = !sizes.length ? 1 : zoom === "fit" ? (width - 2 * GAP) / sizes[0].width : zoom * PT;
  const pageInfo = useRef(onPageInfo);
  pageInfo.current = onPageInfo;

  // The current page is the one crossing the middle of the pane.
  useEffect(() => {
    const el = scroller.current!;
    const update = () => {
      if (!sizes.length) return pageInfo.current(0, 0);
      const mid = el.scrollTop + el.clientHeight / 2;
      let top = GAP;
      let page = sizes.length;
      for (let i = 0; i < sizes.length; i++) {
        top += sizes[i].height * scale + GAP;
        if (top > mid) {
          page = i + 1;
          break;
        }
      }
      pageInfo.current(page, sizes.length);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [sizes, scale]);

  useEffect(() => {
    const box = highlight[0];
    const el = scroller.current;
    if (!box || !el || !sizes.length) return;
    const pageTop = sizes.slice(0, box.page - 1).reduce((t, s) => t + s.height * scale + GAP, GAP);
    el.scrollTo({ top: pageTop + box.y * scale - el.clientHeight / 3, behavior: "smooth" });
  }, [highlight, sizes, scale]);

  return (
    <div className="pdf-scroller" ref={scroller}>
      {!data && <div className="pdf-empty">Compile to see the PDF</div>}
      {data &&
        doc &&
        width > 0 &&
        sizes.map((s, i) => (
          <Page
            key={i}
            doc={doc}
            number={i + 1}
            scale={scale}
            size={s}
            boxes={highlight.filter((b) => b.page === i + 1)}
            onInverseSearch={onInverseSearch}
          />
        ))}
    </div>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  number: number;
  scale: number;
  size: PageSize;
  boxes: PdfBox[];
  onInverseSearch(page: number, x: number, y: number): void;
}

function Page({ doc, number, scale, size, boxes, onInverseSearch }: PageProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "800px" });
    io.observe(holder.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    doc
      .getPage(number)
      .then((page) => {
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      // Render offscreen and swap in, so recompiles don't flash blank pages.
      const off = document.createElement("canvas");
      off.width = vp.width;
      off.height = vp.height;
      task = page.render({ canvas: off, viewport: vp });
      task.promise
        .then(() => {
          const c = canvas.current;
          if (cancelled || !c) return;
          c.width = off.width;
          c.height = off.height;
          c.getContext("2d")!.drawImage(off, 0, 0);
          setError(null);
        })
        .catch(fail);
      })
      .catch(fail);
    function fail(e: unknown) {
      if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") setError(String(e));
    }
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, scale, visible]);

  const onClick = (e: React.MouseEvent) => {
    if (!(e.metaKey || e.detail === 2)) return;
    const r = holder.current!.getBoundingClientRect();
    onInverseSearch(number, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
  };

  return (
    <div className="pdf-page" ref={holder} style={{ width: size.width * scale, height: size.height * scale }} onClick={onClick}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
      {error && <div className="pdf-page-error">{error}</div>}
      {boxes.map((b, i) => (
        <div
          key={i}
          className="pdf-highlight"
          style={{ left: b.x * scale, top: b.y * scale, width: b.width * scale, height: b.height * scale }}
        />
      ))}
    </div>
  );
}
