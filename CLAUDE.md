# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build
npm run lint     # Run ESLint
npm start        # Run production server
```

No test framework is configured yet.

## Architecture

Next.js 15 App Router project using TypeScript and Tailwind CSS v4.

**Data flow:** User types a word → `lookup()` in `src/app/page.tsx` fetches from the public Dictionary API (`https://api.dictionaryapi.dev/api/v2/entries/en/{word}`) → result is passed to `MeaningCard` modal component.

**Key files:**
- `src/app/page.tsx` — client component with all lookup state and logic
- `src/components/MeaningCard.tsx` — modal overlay that renders word, phonetic, and up to 3 meanings

**Path alias:** `@/*` → `./src/*`

## Environment

- `ANTHROPIC_API_KEY` in `.env.local` — not yet used in code, planned for future Anthropic integration
- No backend; the app calls public APIs directly from the browser
