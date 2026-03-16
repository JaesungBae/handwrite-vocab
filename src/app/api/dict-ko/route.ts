import { NextRequest, NextResponse } from "next/server";

interface KoreanMeaning {
  partOfSpeech: string;
  definitions: { definition: string; example?: string }[];
}

function cleanWikiMarkup(text: string): string {
  return text
    .replace(/'{2,3}/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isKorean(text: string): boolean {
  return /[\uAC00-\uD7A3]/.test(text);
}

function parseWikitext(wikitext: string): KoreanMeaning[] {
  const lines = wikitext.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // ── 1. 영어 section 추출 ──────────────────────────────────────────────────
  let inEnglish = false;
  const englishLines: string[] = [];

  for (const line of lines) {
    if (/^==\s*영어\s*==$/.test(line)) { inEnglish = true; continue; }
    if (inEnglish && /^==\s*[^=]/.test(line)) break;
    if (inEnglish) englishLines.push(line);
  }

  if (!englishLines.length) return [];

  // ── 2. POS 단위로 파싱 ───────────────────────────────────────────────────
  const skipPos = new Set([
    "발음", "어원", "표기", "참고", "관련어",
    "동의어", "반의어", "파생어", "숙어", "외부 링크",
  ]);

  const meanings: KoreanMeaning[] = [];
  let currentPos: string | null = null;
  let currentDefs: { definition: string; example?: string }[] = [];
  let currentDef: { definition: string; example?: string } | null = null;

  const flushPos = () => {
    if (currentDef) { currentDefs.push(currentDef); currentDef = null; }
    if (currentPos && !skipPos.has(currentPos) && currentDefs.length > 0) {
      meanings.push({ partOfSpeech: currentPos, definitions: currentDefs.slice(0, 3) });
    }
    currentDefs = [];
  };

  for (const line of englishLines) {
    // === POS ===
    const posMatch = line.match(/^===\s*([^=]+?)\s*===$/);
    if (posMatch) {
      flushPos();
      currentPos = posMatch[1].trim();
      continue;
    }

    if (!currentPos || skipPos.has(currentPos)) continue;

    // # definition (not ##, #:, #*)
    if (/^#[^#:*]/.test(line)) {
      if (currentDef) currentDefs.push(currentDef);
      const def = cleanWikiMarkup(line.replace(/^#+\s*/, ""));
      if (def) currentDef = { definition: def };
      continue;
    }

    // #: example — prefer Korean
    if (/^#:/.test(line) && currentDef) {
      const ex = cleanWikiMarkup(line.replace(/^#:\s*/, ""));
      if (ex && (!currentDef.example || (!isKorean(currentDef.example) && isKorean(ex)))) {
        currentDef.example = ex;
      }
    }
  }
  flushPos();

  return meanings;
}

export async function GET(req: NextRequest) {
  const word = req.nextUrl.searchParams.get("word");
  if (!word) return NextResponse.json({ error: "No word" }, { status: 400 });

  let res: Response;
  try {
    res = await fetch(
      `https://ko.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(word)}` +
      `&prop=revisions&rvprop=content&format=json&formatversion=2`,
      { headers: { "User-Agent": "Drawword/1.0 (educational project)" } }
    );
  } catch (e) {
    console.error("dict-ko fetch error:", e);
    return NextResponse.json({ error: "Network error" }, { status: 502 });
  }

  if (!res.ok) return NextResponse.json({ error: "Upstream error" }, { status: 502 });

  const data = await res.json();
  const page = data.query?.pages?.[0];

  if (!page || page.missing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const wikitext: string = page.revisions?.[0]?.content ?? "";
  const meanings = parseWikitext(wikitext);

  if (!meanings.length) {
    return NextResponse.json({ error: "No Korean definitions found" }, { status: 404 });
  }

  return NextResponse.json({ word, meanings });
}
