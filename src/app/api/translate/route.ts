import { NextRequest, NextResponse } from "next/server";

async function translateText(text: string, targetLang: string): Promise<string> {
  if (!text?.trim()) return text;
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) return text;
  const data = await res.json();
  // Response: [[[translatedChunk, original], ...], ...]
  const translated: string = data[0]?.map((item: [string]) => item[0]).join("") ?? text;
  return translated;
}

export async function POST(req: NextRequest) {
  const { meanings, targetLang } = await req.json();

  const translated = await Promise.all(
    meanings.map(async (m: {
      partOfSpeech: string;
      definitions: { definition: string; example?: string }[];
    }) => ({
      ...m,
      definitions: await Promise.all(
        m.definitions.map(async (d) => ({
          definition: await translateText(d.definition, targetLang),
          ...(d.example ? { example: await translateText(d.example, targetLang) } : {}),
        }))
      ),
    }))
  );

  return NextResponse.json({ meanings: translated });
}
