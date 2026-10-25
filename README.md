# Anki AI

Anki-style flashcards with an AI tutor one tap away. Study like you do in AnkiDroid, and when a card doesn't click, tap the mic, ask your question out loud, and read the answer right there. The card (text and images) is sent along automatically.

- Anki-like look: deck list with New / Learn / Due counts, Show Answer, Again / Hard / Good / Easy with intervals
- FSRS scheduling (the same algorithm modern Anki uses), daily limits per deck, learning steps, undo, bury, suspend
- Imports `.apkg` and `.colpkg` from Anki/AnkiDroid, old and new formats, including images and review history
- Claude or ChatGPT, your choice in Settings, with streaming answers and optional read-aloud
- Dictation with Chrome's free speech recognition, or OpenAI Whisper; sends automatically when you pause
- Works offline for studying (the AI needs internet); installs to your home screen like a normal app
- Everything stays on your phone. One-tap backup and restore.

## Put it on your phone

1. Open the app's address in **Chrome on Android** (after deploying, it's `https://<your-github-username>.github.io/anki-ai/`).
2. Chrome menu → **Add to Home screen** → **Install**. It now opens full-screen from its own icon.
3. Open **Settings** (⋮ menu) and paste an API key:
   - Claude: [console.anthropic.com](https://console.anthropic.com) → API keys
   - ChatGPT: [platform.openai.com](https://platform.openai.com) → API keys
4. Bring your cards over from AnkiDroid: AnkiDroid menu → **Export** → **Collection package (.colpkg)** with media and scheduling included → in Anki AI tap **+ Import** and pick the file.

### Rough cost

One question is about one card plus a sentence or two:

| Model | Per question (approx.) |
|---|---|
| Claude Haiku 5.5 | well under 0.1¢ |
| Claude Sonnet 5.5 | ~1¢ |
| Claude Opus 5.5 (default) | ~2¢ |

Heavy daily use is usually a dollar or two a month. Whisper dictation adds a fraction of a cent per question.

## Things that don't work yet

- **No sync with AnkiDroid/AnkiWeb.** Import once and study here. Re-importing an updated deck adds new cards and keeps your progress on existing ones.
- **JavaScript inside card templates doesn't run.** Decks that rely on it (clickable hint buttons in some shared decks, Image Occlusion masks) show their content without those extras.
- No card editor, card browser or stats screen yet.
- Audio on cards plays when you tap ▶; it doesn't autoplay.
- Old `[latex]…[/latex]` image tags aren't regenerated. MathJax-style `\( … \)` and `\[ … \]` work.

## Development

```bash
npm install
npm run dev        # local dev server
npm test           # parser, renderer and scheduler tests (Node)
npm run build && npm run preview &   # then:
npm run test:e2e   # phone-sized browser tests with mocked mic and AI
```

Test decks in `test/fixtures` are generated with the official Anki library: `pip install anki && python test/make_fixtures.py test/fixtures`.

Pushing to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions** once.

### How it's put together

| File | What it does |
|---|---|
| `src/import/apkg.js` | Reads Anki exports (zip, SQLite via sql.js, zstd, protobuf) |
| `src/scheduler.js` | FSRS via ts-fsrs, Anki → FSRS conversion, daily queues and limits |
| `src/render.js` | Anki template engine: fields, conditionals, cloze, type-in, hints, KaTeX |
| `src/ai.js` | Claude / OpenAI streaming, card context with images, Whisper |
| `src/voice.js` | Dictation (browser or Whisper) with silence auto-send, read-aloud |
| `src/ui/*` | Deck list, study screen, chat sheet, settings |
| `src/db.js`, `src/store.js`, `src/backup.js` | On-device storage (IndexedDB), import/save, backup zip |
