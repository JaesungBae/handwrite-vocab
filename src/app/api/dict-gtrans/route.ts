import { NextRequest, NextResponse } from "next/server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Definition { definition: string; example?: string; }
interface Meaning { partOfSpeech: string; definitions: Definition[]; }
interface DictResponse { word: string; meanings: Meaning[]; }

// ── Google Translate ───────────────────────────────────────────────────────────

async function lookupGtrans(word: string, lang: string): Promise<DictResponse | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx` +
        `&sl=en&tl=${encodeURIComponent(lang)}&dt=t&dt=bd&q=${encodeURIComponent(word)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
  } catch { return null; }

  if (!res.ok) return null;

  const data = await res.json();
  const dictData: unknown[] | null = Array.isArray(data[1]) ? data[1] : null;

  if (!dictData || dictData.length === 0) {
    const translation: string = Array.isArray(data[0])
      ? (data[0] as [string][]).map((item) => item[0]).join("")
      : "";
    if (!translation) return null;
    return { word, meanings: [{ partOfSpeech: "translation", definitions: [{ definition: translation }] }] };
  }

  const meanings = (dictData as unknown[][]).slice(0, 4).map((entry) => {
    const pos = String(entry[0] ?? "");
    const words: string[] = Array.isArray(entry[1]) ? (entry[1] as string[]).slice(0, 5) : [];
    const detailed: unknown[][] = Array.isArray(entry[2]) ? (entry[2] as unknown[][]) : [];
    const definitions = words.map((kw) => {
      const detail = detailed.find((d) => d[0] === kw);
      const backTrans: string[] = Array.isArray(detail?.[1]) ? (detail![1] as string[]).slice(0, 3) : [];
      return { definition: kw, ...(backTrans.length > 1 ? { example: backTrans.join(", ") } : {}) };
    });
    return { partOfSpeech: pos, definitions };
  });

  return { word, meanings };
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const word = req.nextUrl.searchParams.get("word");
  const lang = req.nextUrl.searchParams.get("lang") ?? "ko";
  if (!word) return NextResponse.json({ error: "No word" }, { status: 400 });

  const result = await lookupGtrans(word, lang);

  if (!result) {
    return NextResponse.json({ error: `Definition not found for "${word}"` }, { status: 404 });
  }

  return NextResponse.json({ ...result, source: "google" });
}
