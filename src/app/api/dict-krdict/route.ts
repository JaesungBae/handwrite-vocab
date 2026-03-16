import { NextRequest, NextResponse } from "next/server";

interface KoreanMeaning {
  partOfSpeech: string;
  definitions: { definition: string; example?: string }[];
}

async function translateToKorean(word: string): Promise<string> {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=en&tl=ko&dt=t&q=${encodeURIComponent(word)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Translation failed");
  const data = await res.json();
  const translated: string = data[0]?.map((item: [string]) => item[0]).join("") ?? word;
  return translated.trim();
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? stripCdata(m[1]) : null;
}

function extractAllTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) results.push(stripCdata(m[1]));
  return results;
}

function parseKrDictXml(xml: string, originalWord: string): KoreanMeaning[] {
  const total = extractTag(xml, "total");
  if (!total || parseInt(total) === 0) return [];

  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const meanings: KoreanMeaning[] = [];

  for (const item of itemMatches) {
    const word = extractTag(item, "word") ?? "";
    const pos = extractTag(item, "pos") ?? "단어";

    // Skip items whose Korean word doesn't relate to the search
    // (sometimes KrDict returns unrelated entries)
    const senseBlocks = item.match(/<sense>[\s\S]*?<\/sense>/g) ?? [];
    const definitions: { definition: string; example?: string }[] = [];

    for (const sense of senseBlocks.slice(0, 3)) {
      const def = extractTag(sense, "definition");
      if (!def) continue;

      // Try to find an example sentence
      const examples = extractAllTags(sense, "example");
      const example = examples.find((ex) => ex.length < 80);

      definitions.push({ definition: def, ...(example ? { example } : {}) });
    }

    if (definitions.length > 0) {
      // Prepend the Korean word so user knows the equivalent
      const posLabel = word ? `${pos} (${word})` : pos;
      meanings.push({ partOfSpeech: posLabel, definitions });
    }

    if (meanings.length >= 3) break;
  }

  return meanings;
}

export async function GET(req: NextRequest) {
  const word = req.nextUrl.searchParams.get("word");
  if (!word) return NextResponse.json({ error: "No word" }, { status: 400 });

  const apiKey = process.env.KRDICT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "KRDICT_API_KEY not configured" }, { status: 500 });
  }

  // Step 1: translate English → Korean to get the headword
  let koreanWord: string;
  try {
    koreanWord = await translateToKorean(word);
  } catch {
    return NextResponse.json({ error: "Could not find Korean equivalent" }, { status: 502 });
  }

  // Step 2: search KrDict with the Korean word
  let res: Response;
  try {
    res = await fetch(
      `https://krdict.korean.go.kr/api/search` +
        `?key=${apiKey}` +
        `&q=${encodeURIComponent(koreanWord)}` +
        `&translated=y&trans_lang=1` +
        `&sort=popular&num=5&method=exact`,
      { headers: { "User-Agent": "Drawword/1.0 (educational project)" } }
    );
  } catch (e) {
    console.error("KrDict fetch error:", e);
    return NextResponse.json({ error: "Network error" }, { status: 502 });
  }

  if (!res.ok) return NextResponse.json({ error: "KrDict error" }, { status: 502 });

  const xml = await res.text();
  const meanings = parseKrDictXml(xml, word);

  if (!meanings.length) {
    // Fallback: try with "include" method instead of "exact"
    let res2: Response;
    try {
      res2 = await fetch(
        `https://krdict.korean.go.kr/api/search` +
          `?key=${apiKey}` +
          `&q=${encodeURIComponent(koreanWord)}` +
          `&translated=y&trans_lang=1` +
          `&sort=popular&num=5&method=include`,
        { headers: { "User-Agent": "Drawword/1.0 (educational project)" } }
      );
      if (res2.ok) {
        const xml2 = await res2.text();
        const meanings2 = parseKrDictXml(xml2, word);
        if (meanings2.length) {
          return NextResponse.json({ word, koreanWord, meanings: meanings2 });
        }
      }
    } catch {
      // ignore fallback error
    }
    return NextResponse.json({ error: `Korean definition not found for "${word}"` }, { status: 404 });
  }

  return NextResponse.json({ word, koreanWord, meanings });
}
