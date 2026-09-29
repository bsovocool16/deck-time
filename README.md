# deck-time

Physical matter timers on a Stream Deck, local-AI billing narratives, and a
one-click export to **Intapp Time** (`.TIM`).

```
 Stream Deck Neo                       deck-time companion (localhost:7331)
 ┌──────┬──────┬──────┬──────┐         ┌──────────────────────────────────┐
 │Acme  │Init. │Umbr. │Stark │  tap →  │ timers · notes · entries (SQLite) │
 │12:34 │ 1.5h │      │      │ ← state │ Ollama → narratives               │
 ├──────┼──────┼──────┼──────┤   SSE   │ sox + whisper.cpp → dictation     │
 │Wayne │ 🎙   │ ■    │Review│         │ export → deck-time-YYYY-MM-DD.TIM │
 └──────┴──────┴──────┴──────┘         └──────────────────────────────────┘
 [ Acme M&A   ● 12:34 ]  ← info bar                  ↓ import in Intapp Time
```

- **Tap a matter key** to start its timer. Tapping another matter switches (only
  one runs at a time); tapping the running one stops it. The live key shows the
  elapsed clock, idle keys show today's hours, and the Neo info bar shows what's running.
- **Dictate** (hold to talk, or tap/tap) into the running matter's notes. It is
  transcribed locally with Whisper.
- **Review** opens the day: edit notes, hit ✨ to turn shorthand into a polished
  narrative (local model via Ollama), adjust hours, then **Export .tim**.
- Time is summed per matter per day, then rounded (default: up to the next 0.1h).
  Midnight-spanning timers split across days.

**Privacy:** everything runs on this Mac. No cloud AI, audio is deleted after
transcription, and the server only listens on `127.0.0.1` and rejects cross-site
requests. Matters, time, and config live in `~/.deck-time/`, **never in this repo**.

## Setup

Requires Node 22.13+ (24 recommended) and macOS.

```bash
npm start            # companion app → http://127.0.0.1:7331
npm run demo         # same, with fictional matters in ./data/demo
npm test
```

### AI narratives (Ollama)

```bash
brew install ollama && ollama serve   # or install the Ollama app
ollama pull gemma3:12b                # any chat model works; set it in Settings
```

Tune the house style guide and examples in **Settings**. Past narratives you
mark *ready* or *exported* on the same matter are fed back as style examples.

### Dictation (sox + whisper.cpp)

```bash
brew install sox whisper-cpp
mkdir -p ~/.deck-time/models
curl -L -o ~/.deck-time/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

Dictation records from the **macOS default input** (System Settings → Sound →
Input). Pick your mic there, e.g. a DJI Mic Mini receiver. The first recording
triggers a macOS microphone permission prompt for whatever app launched the
server (Terminal, etc.). To pin a specific device instead, set
`dictation.device` in `~/.deck-time/config.json` to the device name.

### Stream Deck plugin

Needs the Stream Deck app **7.6+** (for the Neo info bar).

```bash
cd plugin
npm install
npm run build
npx streamdeck link com.bsovocool.decktime.sdPlugin   # dev install
npx streamdeck restart com.bsovocool.decktime
```

In the Stream Deck app, drag from the **deck-time** category:

| Action | What it does |
|---|---|
| Matter Timer | Pick a matter in the key's settings. Tap = start/stop. |
| Dictate Note | Hold to talk / tap to toggle. Adds to the running matter's notes. |
| Stop Timer | Stops whatever is running. Shows today's total. |
| Review Day | Opens the companion in your browser. |
| Timer Info Bar | Drag onto the Neo's info bar. Running matter + clock. |

Suggested Neo layout: 5 matter keys + Dictate + Stop + Review, with the info
bar on top. Use the Neo's page buttons for more matters.

## Intapp Time `.TIM` format

Reverse-engineered from a real export (see
[`docs/samples/intapp-export.example.tim`](docs/samples/intapp-export.example.tim),
sanitized). Each line is one entry: `key=value` pairs joined by `|`, keys
alphabetical, CRLF line endings.

| Key | Meaning | We write |
|---|---|---|
| `am` | duration in **seconds** | rounded hours × 3600 |
| `cl` / `ma` | client / `client.matter` | from the matter |
| `na` | narrative | your narrative (never raw notes) |
| `tk` `op` `lmb` | timekeeper / operator / last modified by | your timekeeper ID |
| `wd` | work date, `M/D/YYYY 12:00:00 AM` | entry date |
| `ed` `md` | created / modified, `M/D/YYYY h:mm:ss AM` | export time |
| `ref` | GUID | fresh per entry |
| `ss` | `888888` + `am` zero-padded to 6 | computed (meaning unknown) |
| `ar` `shortref` | Intapp-assigned record ids | **omitted** |
| everything else | constant metadata | copied from your export |

Teach it your firm's constants and timekeeper ID from any export:

```bash
npm run tim:inspect -- ~/Downloads/export.TIM   # summarize
npm run tim:learn   -- ~/Downloads/export.TIM   # save to ~/.deck-time/config.json
```

(or Settings → *Learn format from an Intapp export*).

**Still to verify on a real import:** that Intapp accepts entries without
`ar`/`shortref`, and what `u1` and `ss` mean. Test with one entry on a
non-billable matter first.

## Layout

```
companion/src/     server.js (HTTP + SSE), store.js (SQLite), export.js (.TIM/CSV),
                   ai.js (Ollama), dictation.js (sox + whisper), time.js, config.js
companion/public/  review UI (vanilla JS), includes a clickable virtual deck
plugin/            Stream Deck plugin (TypeScript, @elgato/streamdeck v3)
scripts/           tim-inspect.js, seed-demo.js
```
