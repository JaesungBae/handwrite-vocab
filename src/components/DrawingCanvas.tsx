"use client";

import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from "react";

export interface DrawingCanvasHandle {
  clear: () => void;
  clearScribble: () => void;
  toBlob: () => Promise<Blob | null>;
  toBase64: () => string | null;
  isEmpty: () => boolean;
  getCanvas: () => HTMLCanvasElement | null;
}

interface DrawingCanvasProps {
  onScribble?: (text: string) => void;
}

/** Returns a new canvas cropped to the drawn content, or null if canvas is blank. */
function cropToContent(canvas: HTMLCanvasElement, padding = 16): HTMLCanvasElement | null {
  const ctx = canvas.getContext("2d")!;
  const { width: pw, height: ph } = canvas;
  const data = ctx.getImageData(0, 0, pw, ph).data;

  let minX = pw, maxX = 0, minY = ph, maxY = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      if (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX >= maxX || minY >= maxY) return null;

  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const w = Math.min(pw, maxX + padding) - x;
  const h = Math.min(ph, maxY + padding) - y;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

const applyCtxStyle = (ctx: CanvasRenderingContext2D) => {
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
};

const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(
  ({ onScribble }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const isDrawingRef = useRef(false);
    const hasDrawnRef = useRef(false);
    const [showPlaceholder, setShowPlaceholder] = useState(true);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.width, rect.height);
      applyCtxStyle(ctx);
    }, []);

    // Touch + mouse → draw on canvas
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const getPos = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
      };

      const startDraw = (x: number, y: number) => {
        const ctx = canvas.getContext("2d")!;
        isDrawingRef.current = true;
        if (!hasDrawnRef.current) {
          hasDrawnRef.current = true;
          setShowPlaceholder(false);
        }
        ctx.beginPath();
        ctx.moveTo(x, y);
      };

      const continueDraw = (x: number, y: number) => {
        if (!isDrawingRef.current) return;
        const ctx = canvas.getContext("2d")!;
        ctx.lineTo(x, y);
        ctx.stroke();
      };

      const endDraw = () => { isDrawingRef.current = false; };

      const onMouseDown = (e: MouseEvent) => { const p = getPos(e.clientX, e.clientY); startDraw(p.x, p.y); };
      const onMouseMove = (e: MouseEvent) => { const p = getPos(e.clientX, e.clientY); continueDraw(p.x, p.y); };

      const onTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        const p = getPos(e.touches[0].clientX, e.touches[0].clientY);
        startDraw(p.x, p.y);
      };
      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        const p = getPos(e.touches[0].clientX, e.touches[0].clientY);
        continueDraw(p.x, p.y);
      };

      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", endDraw);
      canvas.addEventListener("mouseleave", endDraw);
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("touchend", endDraw);

      return () => {
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("mouseup", endDraw);
        canvas.removeEventListener("mouseleave", endDraw);
        canvas.removeEventListener("touchstart", onTouchStart);
        canvas.removeEventListener("touchmove", onTouchMove);
        canvas.removeEventListener("touchend", endDraw);
      };
    }, []);

    // Apple Pencil → focus Scribble input
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const onPointerDown = (e: PointerEvent) => {
        if (e.pointerType === "pen") {
          e.preventDefault();
          inputRef.current?.focus();
        }
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      return () => canvas.removeEventListener("pointerdown", onPointerDown);
    }, []);

    useImperativeHandle(ref, () => ({
      clearScribble: () => {
        if (inputRef.current) inputRef.current.value = "";
      },
      clear: () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        applyCtxStyle(ctx);
        hasDrawnRef.current = false;
        setShowPlaceholder(true);
        if (inputRef.current) inputRef.current.value = "";
      },
      toBlob: () => {
        const canvas = canvasRef.current;
        if (!canvas) return Promise.resolve(null);
        const cropped = cropToContent(canvas);
        const target = cropped ?? canvas;
        return new Promise<Blob | null>((resolve) =>
          target.toBlob(
            (blob) => {
              if (blob) { resolve(blob); return; }
              target.toBlob((b) => resolve(b), "image/jpeg", 0.85);
            },
            "image/webp",
            0.85
          )
        );
      },
      toBase64: () => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        return canvas.toDataURL("image/png").split(",")[1];
      },
      isEmpty: () => !hasDrawnRef.current,
      getCanvas: () => canvasRef.current,
    }));

    return (
      <div className="relative w-full h-full">
        <canvas ref={canvasRef} className="w-full h-full touch-none cursor-crosshair" />

        {/* Transparent Scribble overlay — Apple Pencil writes here via iOS Scribble */}
        <input
          ref={inputRef}
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            const val = e.target.value.trim();
            if (val) onScribble?.(val);
          }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-default bg-transparent"
          style={{ fontSize: "16px", caretColor: "transparent", color: "transparent" }}
          aria-label="Scribble input"
        />

        {showPlaceholder && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-1">
            <p className="text-slate-300 text-xl font-light select-none">Draw with finger</p>
            <p className="text-slate-200 text-sm select-none">or write with Pencil (Scribble)</p>
          </div>
        )}
      </div>
    );
  }
);

DrawingCanvas.displayName = "DrawingCanvas";
export default DrawingCanvas;
