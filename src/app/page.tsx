"use client";

import { useState, useRef } from "react";
import MeaningCard from "@/components/MeaningCard";

interface Definition {
  definition: string;
  example?: string;
}

interface Meaning {
  partOfSpeech: string;
  definitions: Definition[];
}

interface DictResult {
  word: string;
  phonetic?: string;
  meanings: Meaning[];
}

export default function Home() {
  const [word, setWord] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<DictResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const lookup = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(trimmed)}`
      );
      if (!res.ok) throw new Error(`"${trimmed}" not found in dictionary`);
      const data = await res.json();
      setResult(data[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") lookup(word);
  };

  const handleClose = () => {
    setResult(null);
    setWord("");
    inputRef.current?.focus();
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-slate-800 mb-2">
            Handwrite a Word
          </h1>
          <p className="text-slate-500 text-sm">
            Use Apple Pencil to write a word, then tap Look Up.
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 flex flex-col gap-4">
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write here…"
            className="w-full text-4xl font-light text-slate-800 placeholder:text-slate-200 outline-none border-b-2 border-slate-100 focus:border-blue-300 transition-colors pb-3 bg-transparent"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />

          <button
            onClick={() => lookup(word)}
            disabled={!word.trim() || isLoading}
            className="w-full py-3 rounded-xl bg-slate-800 text-white font-medium hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Looking up…
              </>
            ) : (
              "Look Up"
            )}
          </button>
        </div>

        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm text-center">
            {error}
          </div>
        )}
      </div>

      {result && (
        <MeaningCard
          word={result.word}
          phonetic={result.phonetic}
          meanings={result.meanings}
          onClose={handleClose}
        />
      )}
    </main>
  );
}
