import { createWorker, PSM } from "tesseract.js";

let workerPromise: ReturnType<typeof createWorker> | null = null;

function getWorker(): ReturnType<typeof createWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        // Single-line mode: works for 1–3 word phrases
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      });
      return worker;
    })();
  }
  return workerPromise;
}

export async function recognizeWord(canvas: HTMLCanvasElement): Promise<string> {
  const worker = await getWorker();
  const { data: { text } } = await worker.recognize(canvas);
  return text.trim().toLowerCase().replace(/[^a-z'\- ]/g, "").replace(/\s+/g, " ").trim();
}

/** Warm up the worker in the background so first recognition is fast */
export function warmUp(): void {
  getWorker();
}
