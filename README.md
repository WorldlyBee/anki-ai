# Aristotle

**Anki-style spaced repetition with an integrated AI tutor.**

Named for history's most famous tutor. Flashcards with an AI tutor one tap away. Study like you do in AnkiDroid, and when a card doesn't click, tap the mic, ask your question out loud, and read the answer right there. The card (text and images) is sent along automatically.

- Anki-like look: deck list with New / Learn / Due counts, Show Answer, Again / Hard / Good / Easy with intervals
- FSRS scheduling (the same algorithm modern Anki uses), daily limits per deck, learning steps, undo, bury, suspend
- Imports `.apkg` and `.colpkg` from Anki/AnkiDroid, old and new formats, including images and review history
- Claude or ChatGPT, your choice in Settings, with streaming answers and optional read-aloud
- Dictation with Chrome's free speech recognition, or OpenAI Whisper; sends automatically when you pause
- Works offline for studying (the AI needs internet); installs to your home screen like a normal app
- Sync between your phone and laptop through a private GitHub repo (free); link a new device by scanning a QR code
- One-tap backup and restore

## Put it on your phone

1. Open the app's address in **Chrome on Android** (after deploying, it's `https://<your-github-username>.github.io/<repo-name>/`).
2. Chrome menu → **Add to Home screen** → **Install**. It now opens full-screen from its own icon.
3. Open **Settings** (⋮ menu) and paste an API key:
   - Claude: [console.anthropic.com](https://console.anthropic.com) → API keys
   - ChatGPT: [platform.openai.com](https://platform.openai.com) → API keys
4. Bring your cards over from AnkiDroid: AnkiDroid menu → **Export** → **Collection package (.colpkg)** with media and scheduling included → in Aristotle tap **+ Import** and pick the file.

### Use it on your laptop too

1. On the device that already has your cards: **Settings → Sync between devices → First-time setup**. Create a private repo and a token as described there (about 3 minutes), paste them, tap **Turn on sync**.
2. Still in Settings, tap **Link another device**. It shows a QR code.
3. Get that link onto the other device. If the QR code is on your laptop screen, scan it with your phone's camera. If it's on your phone, tap **Share…** and send the link to yourself (email, chat), then open it on the laptop. Either way, sync gets set up and your cards download.

After that, each device syncs when you open the app, about 30 seconds after you study, and when you switch away. If you study on both before they sync, each card keeps whichever version you studied most recently, and reviews from both devices are combined. Your API key is per device, so paste it into Settings on the laptop as well.

### Rough cost

One question is about one card plus a sentence or two:

| Model | Per question (approx.) |
|---|---|
| Claude Haiku 5.5 | well under 0.1¢ |
| Claude Sonnet 5.5 | ~1¢ |
| Claude Opus 5.5 (default) | ~2¢ |

Heavy daily use is usually a dollar or two a month. Whisper dictation adds a fraction of a cent per question.

## Things that don't work yet

- **No sync with AnkiDroid/AnkiWeb.** Import once and study here. Re-importing an updated deck adds new cards and keeps your progress on existing ones. (Sync between your own devices running this app works; see above.)
- Sync suits collections up to a few hundred MB of images; GitHub repos get slow beyond a couple of GB.
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
npm run test:e2e   # phone-sized browser tests with mocked mic, AI and GitHub (incl. two-device sync)
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
| `src/sync/*` | Device sync via a private GitHub repo: per-device change journals, image bundles, snapshots |
