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
- **Dictate** (tap to start, tap again to stop) into the running matter's notes. It is
  transcribed locally with Whisper.
- **Review** opens the day: **Draft narrative** turns shorthand or dictation into
  a narrative instantly (rules plus your phrasebook; no AI model), adjust hours,
  then **Export .TIM**.
- Time is summed per matter per day, then rounded (default: up to the next 0.1h).
  Midnight-spanning timers split across days.

**Privacy:** everything runs on this Mac. No cloud AI, audio is deleted after
transcription, and the server only listens on `127.0.0.1` and rejects cross-site
requests. Matters, time, and config live in `~/.deck-time/`, **never in this repo**.

## Editions

| | Full (your Mac) | Office (work PC) |
|---|---|---|
| Runs as | `npm start` (Node 22.13+) | inside the Stream Deck plugin; nothing else to install |
| Timers, keys, sidebar, notes, splits, client rules, `.TIM` export | yes | yes |
| AI narratives and code suggestions | yes (local Ollama) | off |
| Dictation | yes (sox + Whisper) | off |
| Data folder | `~/.deck-time` | `%APPDATA%\deck-time` (Windows) |

**Office edition install:** install the Stream Deck app, then double-click
`com.bsovocool.decktime.streamDeckPlugin` (build it with `cd plugin && npm run
build && npm run pack`; it lands in `dist/`). Put the **deck-time Key** action on
each key, press any key marked *Empty* to open the app, and arrange matters
from the sidebar. For IT review, see [docs/IT-OVERVIEW.md](docs/IT-OVERVIEW.md).

When the plugin starts it runs deck-time itself unless one is already running
on the machine. On a Mac where you use the full edition, set `"embedded": false`
in `~/.deck-time/config.json` so the plugin always uses your `npm start` copy.

**Demo day:** Settings → *Demo day* swaps in fictional matters (kept in a
separate `demo.db`) so you can show deck-time without client names on screen.

## Setup

Requires Node 22.13+ (24 recommended) and macOS.

```bash
npm start            # companion app (full edition) → http://127.0.0.1:7331
DECK_TIME_EDITION=office npm start   # try the office edition
npm run demo         # same, with fictional matters in ./data/demo
npm test
```

### AI narratives (Ollama)

```bash
brew install ollama
scripts/ollama-serve.sh &             # keeps models in ./models/ollama (gitignored)
ollama pull gemma3:12b                # any chat model works; set it in Settings
```

Tune the house style guide and examples in **Settings**. Ollama unloads the
model two minutes after use (`ai.keepAlive`), so it only takes memory while
drafting. Past narratives you
mark *ready* or *exported* on the same matter are fed back as style examples.

### Dictation (sox + whisper.cpp)

```bash
brew install sox whisper-cpp
mkdir -p models/whisper   # inside this repo, gitignored
curl -L -o models/whisper/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

For better accuracy, use `ggml-large-v3-turbo.bin` (about 1.6 GB, same source)
and set `dictation.model` to it in `~/.deck-time/config.json`; it takes about
1.3 s per note on an M4 Pro. Settings → *Dictation* takes a list of words to
listen for (client names, deal code names); matter names and common legal terms
are always included.

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

**Easiest setup:** in the Stream Deck app, put the **deck-time Key** action
on every key once. From then on, arrange the deck from the companion app's
**Keys** sidebar: drag a matter onto a key, drag keys to swap them, drag a key
back to the sidebar to clear it, and edit each matter's short key label
inline. The physical keys update immediately. Each key follows its position,
so the layout lives in one place.

Or set keys up individually from the **deck-time** category:

| Action | What it does |
|---|---|
| deck-time Key | Shows whatever the app's layout assigns to that position (matter or function). |
| Matter Timer | Pick a matter in the key's settings. Tap = start/stop. |
| Dictate Note | Hold to talk / tap to toggle. Adds to the running matter's notes. |
| Next Task | Marks a task boundary on the running timer (shows task # and time in task). |
| Stop Timer | Stops whatever is running. Shows today's total. |
| Review Day | Opens the companion in your browser. |
| Timer Info Bar | Drag onto the Neo's info bar. Running matter + clock. |

Default layout: 5 matter keys + Dictate + Next Task + Stop, with the info
bar showing the running timer. Put Review and more matters on page 2
(the Neo's touch page buttons), or open Review from the browser.

## Instant drafting and the phrasebook

Drafting doesn't call an AI model. Most of it is mechanical, so rules do it in
about a millisecond, and they never add facts that aren't in your notes:

- **Shorthand** expands from a built-in legal list (`officer cert` →
  officer's certificate, `rogs` → interrogatories, `tc w/ opp counsel` →
  telephone conference with opposing counsel, …) plus your own entries in
  Settings → *Phrasebook* (`pike = Project Pike`).
- **Verbs** go into the past tense, and actions are split and joined:
  `prepare officer cert send to client` → *Prepared officer's certificate and
  sent to client.*
- **It learns from your edits.** Each draft is remembered; at export, whatever
  you changed is logged to `corrections.jsonl` and becomes a substitution. It
  applies on that matter right away, and everywhere once you've made it twice.
  Corrections fade with a 45-day half-life, so a deal's vocabulary fades after
  it closes. Settings lists what's been learned and where it applies.
- The same learned phrasing feeds Whisper's vocabulary hint, so dictation
  hears your terms better too.

The design principle: no model in the click path. A model can later act as an
offline teacher that reviews accumulated corrections and proposes rules.

## Late nights (midnight rollover)

You don't have to answer anything when you work past midnight. The timer keeps running, and the time is split at midnight: each day gets the hours worked on it, and notes go to the day they were taken. If you'd rather keep late-night time on the day you started, set **Settings → Late nights → Time after midnight** to "Previous day until 2/4/6 AM". The workday then rolls over at that hour.

The one question it asks: if a timer from last night is still running at the check hour (5 AM by default), and nothing was logged on it for two hours before then, deck-time asks once whether you forgot it. You can stop it a minute after your last note, at midnight, or at a time you pick. Or you can keep it all. Until you answer, the Neo info bar reads "Overnight timer?". You can change the hour or turn the check off in the same Settings section.

## Client billing rules & block billing

**Matters → Client billing rules** remembers instructions per client number:
a *No block billing* switch and free-text guidelines (e.g. "separate legal
analysis, the internal email about it, and any call into distinct entries").
Every matter under that client inherits them. A matter can override
(*prohibited* / *allowed*) and add its own guidelines. The rules are fed to
the local model whenever it drafts for that client.

On days when you've done several tasks for a no-block client:

- **Split into tasks** proposes one entry per task, instantly: exact durations
  from your **Next task** marks, or, without marks, one entry per clause of
  your notes with time estimated by kind of work. Edit the proposal, then apply
  it.
- **+ Split entry** splits one off by hand.
- The timer total is the anchor: split-off entries have their own hours and
  the main entry keeps the remainder, so the day always reconciles.
- Export flags narratives that look block-billed ("…; …", "Reviewed X and
  drafted Y") on no-block matters and asks before exporting anyway.

**Next Task** makes splits exact. Press it (deck key, or ⏭ in the web app)
when you move from, say, the analysis to the email about it. The timer keeps
running on the same matter, but a new task starts. Tap Dictate right after to
label it. When you split, each marked task becomes its own entry with its real
duration (tenths allocated by largest remainder so they add up, each at least
the minimum), and the model only writes the narratives and codes. Without
marks, the model estimates the split from your timestamped notes. Switching to
another matter and back continues the same task.

## Task / activity codes

For matters that require UTBMS codes, set **Task/activity codes** on the matter
(Counseling or Litigation; edit or add sets under `codes` in
`~/.deck-time/config.json`). Codes fill in **instantly, with no AI model**:

- **Keyword rules** from day one: the entry's opening verb sets the activity
  ("Reviewed…" A104, "Drafted…" A103, "Researched…" A102; calls by who's on
  them: client A106, outside counsel A107, others A108), and topic words set
  the task (interrogatories L310, privilege L320, research C200…).
- **Your history** takes over as it builds. Every export appends its narratives
  and codes to `code-memory.jsonl` in your data folder, and deck-time relearns a
  small word-frequency table from that log (weighted toward the same matter).
  Give it a head start in Settings → *Import past time from Intapp*: `.TIM`
  exports already carry each narrative with its codes.

Codes appear when a narrative is drafted, typed or dictated on a coded matter
(never overwriting codes you set), and **Suggest codes** re-picks them. Export
refuses a coded matter with missing codes. This works in the office edition too.

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
| `ss` | `888888` + `am` zero-padded to 6 | computed (prefix constant across billable and non-billable samples) |
| `u1` | jurisdiction code | copied from your export (e.g. `007`) |
| `u5` / `u6` | UTBMS task / activity code | only on matters that use codes |
| `ar` `shortref` | Intapp-assigned record ids | **omitted** |
| everything else | constant metadata | copied from your export |

Teach it your firm's constants and timekeeper ID from any export:

```bash
npm run tim:inspect -- ~/Downloads/export.TIM   # summarize
npm run tim:learn   -- ~/Downloads/export.TIM   # save to ~/.deck-time/config.json
```

(or Settings → *Learn format from an Intapp export*).

**Still to verify on a real import:** that Intapp accepts entries without
`ar`/`shortref`. (`ar` changes when an entry is edited in Intapp, so it's an
internal record id.) Test with one entry on a
non-billable matter first.

## Layout

```
companion/src/     main.js (CLI entry), host.js (startup, editions, demo day),
                   server.js (HTTP + SSE), store.js (SQLite), export.js (.TIM/CSV),
                   ai.js (Ollama), dictation.js (sox + whisper), demo-seed.js,
                   codes.js, time.js, config.js
companion/public/  review UI (vanilla JS), includes a clickable virtual deck
plugin/            Stream Deck plugin (TypeScript, @elgato/streamdeck v3); hosts the
                   office edition. `node plugin/scripts/simulate.mjs` exercises the
                   built plugin without hardware.
demo/              hosted demo (in-browser mock of the API); `npm run build:demo`
scripts/           tim-inspect.js, seed-demo.js
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free to use, modify and share
for noncommercial purposes, including personal use and use by noncommercial
organizations. Commercial use needs separate permission from the author.

Required Notice: Copyright 2026 Benjamin Sovocool (https://github.com/bsovocool16)
