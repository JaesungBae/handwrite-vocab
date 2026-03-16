"use client";

interface Definition {
  definition: string;
  example?: string;
}

interface Meaning {
  partOfSpeech: string;
  definitions: Definition[];
}

interface MeaningCardProps {
  word: string;
  phonetic?: string;
  meanings: Meaning[];
  onClose: () => void;
}

export default function MeaningCard({
  word,
  phonetic,
  meanings,
  onClose,
}: MeaningCardProps) {
  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 relative max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors text-lg"
        >
          ✕
        </button>

        <div className="mb-6">
          <h2 className="text-4xl font-bold text-slate-800 capitalize">
            {word}
          </h2>
          {phonetic && (
            <p className="text-slate-400 text-sm mt-1">{phonetic}</p>
          )}
        </div>

        <div className="flex flex-col gap-5">
          {meanings.slice(0, 3).map((m, i) => (
            <div key={i}>
              <span className="text-xs font-semibold uppercase tracking-widest text-blue-500">
                {m.partOfSpeech}
              </span>
              <p className="text-slate-700 mt-1 text-base leading-relaxed">
                {m.definitions[0].definition}
              </p>
              {m.definitions[0].example && (
                <p className="text-slate-400 text-sm mt-1 italic">
                  &ldquo;{m.definitions[0].example}&rdquo;
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
