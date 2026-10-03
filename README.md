# deck-time

Physical matter timers on a Stream Deck, instant billing narratives and codes
(rules plus what it learns from your edits, no AI model), local dictation, and
a one-click export to **Intapp Time** (`.TIM`).

```
 Stream Deck Neo                       deck-time companion (localhost:7331)
 ┌──────┬──────┬──────┬──────┐         ┌──────────────────────────────────┐
 │Acme  │Init. │Umbr. │Stark │  tap →  │ timers · notes · entries (SQLite) │
 │12:34 │ 1.5h │      │      │ ← state │ rules + phrasebook → narratives   │
 ├──────┼──────┼──────┼──────┤   SSE   │ browser mic + whisper.cpp → notes │
 │Wayne │ 🎙   │ ■    │Review│         │ export → deck-time-YYYY-MM-DD.TIM │
 └──────┴──────┴──────┴──────┘         └──────────────────────────────────┘
 [ Acme M&A   ● 12:34 ]  ← info bar                  ↓ import in Intapp Time
```

- **Tap a matter key** to start its timer. Tapping another matter switches (only
  one runs at a time); tapping the running one stops it. The live key shows the
  elapsed clock, idle keys show today's hours, and the Neo info bar shows what's running.
- **Dictate** (tap to start, tap again to stop) into the running matter's notes. It is
  transcribed locally with Whisper (full edition).
- **Review** brings up the day in the deck-time window you have open: **Draft narrative** turns shorthand or dictation into
  a narrative instantly (rules plus your phrasebook; no AI model), adjust hours,
  then **Export .TIM**.
- Time is summed per matter per day, then rounded (default: up to the next 0.1h).
  Midnight-spanning timers split across days.

**Privacy:** everything runs on this computer. No AI service or model, audio is deleted after
transcription, and the server only listens on `127.0.0.1` and rejects cross-site
requests. Matters, time, and config live in `~/.deck-time/`, **never in this repo**.

## Try it

**No install:** the [hosted demo](https://claude.ai/artifact/XuRKfpickw4Z45h6o1FyNw)
runs in any browser with fictional matters. It has a clickable Stream Deck,
simulated dictation and a simulated teacher.

**On Windows (no Stream Deck needed):**

1. Install Node.js 24 LTS from [nodejs.org](https://nodejs.org) (or run
   `winget install OpenJS.NodeJS.LTS`). On a managed work PC, ask IT.
2. Get the code: on GitHub, use **Code → Download ZIP** and unzip it, or
   `git clone` it.
3. Open **Command Prompt** (not PowerShell, which may block npm's scripts) in
   the unzipped folder and run:
   ```bat
   npm start
   ```
4. Open <http://127.0.0.1:7331> in Edge or Chrome. For a show-and-tell, go to
   **Settings → Demo day** to swap in fictional matters. Your own data is kept
   apart, in `%APPDATA%\deck-time`.
5. Click the keys on the page's virtual deck (or press 1–8) to run timers, then
   draft, split and export from the entries below. **Ctrl+C** in the Command
   Prompt stops it.

This is the full edition. Dictation works once whisper.cpp and a speech model
are in place (two downloads; see Dictation below). The teacher works if [Ollama for Windows](https://ollama.com) is
installed with `ollama pull gemma3:12b`. To install it as an app, use Edge's
**⋯ → Apps → Install this site as an app**.

**On Windows with a Stream Deck:** install the Stream Deck app (7.6+ for the
Neo), then download
[`com.bsovocool.decktime.streamDeckPlugin`](https://github.com/bsovocool16/deck-time/releases/latest/download/com.bsovocool.decktime.streamDeckPlugin)
from the [latest release](https://github.com/bsovocool16/deck-time/releases/latest)
and double-click it. The plugin runs deck-time itself (the office
edition), so Node isn't needed. If `npm start` is already running, the plugin
uses that instead.

**On a Mac:** the same `npm start`, plus the optional dictation and teacher
setup below.

Windows support is written but not yet tested on a real Windows PC. If
something doesn't work there, the Command Prompt window shows the error.

## Editions

| | Full (`npm start`) | Office (inside the Stream Deck plugin) |
|---|---|---|
| Runs as | `npm start` (Node 22.13+) | inside the Stream Deck plugin; nothing else to install |
| Timers, keys, sidebar, notes, splits, client rules, `.TIM` export | yes | yes |
| Instant narratives, phrasebook, task/activity codes | yes | yes |
| Teacher (proposes drafting rules from your edits) | optional (local Ollama) | off |
| Dictation | optional (whisper.cpp + a 0.5 to 1.6 GB model; macOS or Windows) | off |
| Extra installs | none required | none |
| Data folder | `~/.deck-time` (macOS), `%APPDATA%\deck-time` (Windows) | same |

Neither edition needs an AI model to draft, code or export. The full edition
has two optional downloads: whisper.cpp and a speech model for dictation, and a
local Ollama model for the teacher (see below). Skip either and everything else
works.

**Office edition install:** install the Stream Deck app, then double-click
`com.bsovocool.decktime.streamDeckPlugin` from the
[latest release](https://github.com/bsovocool16/deck-time/releases/latest). To build it yourself (macOS or
Windows): `cd plugin`, `npm install`, `npm run build`, `npm run pack`. It lands
in `dist/`. Put the **deck-time Key** action on
each key, press any key marked *Empty* to open the app, and arrange matters
from the sidebar. For IT review, see [docs/IT-OVERVIEW.md](docs/IT-OVERVIEW.md).

When the plugin starts it runs deck-time itself unless one is already running
on the machine. On a Mac where you use the full edition, set `"embedded": false`
in `~/.deck-time/config.json` so the plugin always uses your `npm start` copy.

**Demo day:** Settings → *Demo day* swaps in fictional matters (kept in a
separate `demo.db`) so you can show deck-time without client names on screen.

## Setup

Requires Node 22.13+ (24 recommended), on macOS or Windows.

```bash
npm start              # full edition → http://127.0.0.1:7331
npm run start:office   # the office edition (what the Stream Deck plugin runs)
npm run demo           # fictional matters in ./data/demo, restarts on code changes
npm test
```

Options for `node companion/src/main.js`: `--edition office|full` and
`--home <data folder>`.

### Dictation (optional, macOS and Windows)

Press **Dictate** (on the deck or the page), talk, and press it again. The
deck-time window records with your browser's microphone permission, and
whisper.cpp transcribes the note on this computer. Audio never leaves it and is
deleted afterward. Keep a deck-time window open (a tab or the installed app; it
can be in the background). The first time, use **Test microphone** on the Today
tab so the browser asks for permission.

You need two things: whisper.cpp and a speech model.

**macOS**

```bash
brew install whisper-cpp
mkdir -p ~/.deck-time/models/whisper
curl -L -o ~/.deck-time/models/whisper/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin   # about 470 MB
```

(Running from a copy of this repo that has a `models/` folder, deck-time looks
in `models/whisper/` there instead.)

**Windows**

1. Download `whisper-bin-x64.zip` from the
   [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases).
   Unzip it and copy the folder that contains `whisper-cli.exe` (with the
   `.dll` files beside it) to `%APPDATA%\deck-time\whisper\`, so that
   `%APPDATA%\deck-time\whisper\whisper-cli.exe` exists.
2. Download
   [`ggml-small.en.bin`](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin)
   (about 470 MB) to `%APPDATA%\deck-time\models\whisper\`.
3. Restart deck-time. Until both are in place, Settings → *Dictation* says
   what's missing, and the Dictate button stays hidden.

For better accuracy, use `ggml-large-v3-turbo.bin` (about 1.6 GB, same source)
and set `dictation.model` to its path in `config.json` in your data folder; it
takes about 1.3 s per note on an M4 Pro. Settings → *Dictation* takes a list of
words to listen for (client names, deal code names). Matter names and common
legal terms are always included.

The browser records from the system's default input. Pick your mic there (on a
Mac, System Settings → Sound → Input; on Windows, Settings → System → Sound).
In Safari, to stop it asking every session: Safari → Settings → Websites →
Microphone → `127.0.0.1` → Allow.

Because the window does the recording, dictation works however deck-time was
started, including inside the Stream Deck plugin. The old way, where the
server records with sox, is still there as Settings → *Dictation* → *Record
with: the server* (macOS, `brew install sox`). macOS only gives the microphone
to the app that launched the server, so that mode needs `npm start` in
Terminal and `"embedded": false`.

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
| Dictate Note | Tap to start, tap again to stop. Adds to the running matter's notes. |
| Next Task | Marks a task boundary on the running timer (shows task # and time in task). |
| Stop Timer | Stops whatever is running. Shows today's total. |
| Review Day | Brings up today in the deck-time window you have open (see Review key). |
| Timer Info Bar | Drag onto the Neo's info bar. Running matter, clock and today's total. |

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
  applies on that matter right away, and everywhere once you've made the same
  change on two different matters. It starts empty and has no opinions of its
  own: if you undo something it learned (it wrote "Analyzed", you put
  "Reviewed" back), the undo cancels it rather than teaching the opposite.
  Corrections fade with a 45-day half-life, so a deal's vocabulary fades after
  it closes. Settings lists what's been learned and where it applies.
- The same learned phrasing feeds Whisper's vocabulary hint, so dictation
  hears your terms better too.

The design principle: no model in the click path. Don't use a dumb model; use
a smart model to write dumb code.

## The teacher (full edition)

The phrasebook learns one edit at a time. The teacher looks for the patterns
behind your edits. In **Settings → Teacher**, *Review my edits* hands your
logged edits (notes, instant draft, what you billed) to the local model once,
through Ollama on this computer. It asks for rules the drafter can follow on
its own:

| Kind | Example | Applied |
|---|---|---|
| Shorthand | `cp` → conditions precedent (on the loan matter) | to notes, before drafting |
| Fix | `board deck` → board presentation | to the finished draft |
| Verb | `redline` → redlined | starts and past-tenses an action |

Nothing the model says is trusted. Plain code replays each proposed rule against
your past edits. A rule is shown only if all of these hold:

- it would have brought at least two drafts closer to what you billed;
- it made none worse;
- every word it writes already appears in your own narratives, so it can't
  invent facts.

A rule seen on one matter only is kept to that matter. You accept or reject
each one, with a before/after example. Accepted rules live in `teacher.json` in
your data folder, apply to the next draft, and can be removed. Rejected rules
aren't proposed again.

Accepted rules keep earning their place. Each later draft where a rule changed
the wording is a vote: you kept it, or you changed it back. Accepting counts as
one keep. Once your undos outnumber your keeps, the rule turns itself off, and
Settings shows the tally. A review takes about a minute (gemma3:12b on an M4 Pro).
The model unloads two minutes later, and drafting never waits on it.

Every export logs each edited entry to `corrections.jsonl` with its notes.
Demo day has its own fictional edits (and its own `demo-teacher.json`), so you
can try the teacher without touching real data. The office edition has no
teacher, because it has no model.

Setup (only for the teacher):

```bash
brew install ollama
scripts/ollama-serve.sh &             # keeps models in ./models/ollama (gitignored)
ollama pull gemma3:12b                # about 8 GB on disk; any chat model works (ai.model in config)
```

## AI use disclosure

For billing rules that require disclosing AI use, such as California's, turn on **Settings → AI use → Record whether AI was used on each time entry**. Then choose the default for new entries: **No AI** or **AI used**. Each entry gets an **AI** checkbox that starts at the default, and split entries inherit the answer from the entry they came from. The CSV export adds an `ai_used` column (Y/N). For .TIM files, enter the Intapp field your firm uses for this (ask your Intapp administrator); deck-time writes Y/N there. Leave it blank and nothing is added to .TIM files.

## Daily target

A bar next to today's total on the page fills toward your daily target (8 hours by default, set in **Settings → Timekeeper**). It turns green when you hit the target. Set the target to 0 to hide the bar. The Neo info bar shows the running timer next to today's total (`0:42:10 · 5.3h`).

## Review key

**Review** brings up the deck-time window you already have open, whether that's an installed web app (Safari's Add to Dock, or Chrome/Edge's Install) or a browser tab, and shows today's entries. It doesn't open a new window in your default browser. Only when no deck-time page is open does it launch one: the installed web app if there is one, otherwise the default browser. On Windows, it raises the window whose title mentions deck-time (not yet tested on a work PC).

## Late nights (midnight rollover)

You don't have to answer anything when you work past midnight. The timer keeps running, and the time is split at midnight: each day gets the hours worked on it, and notes go to the day they were taken. If you'd rather keep late-night time on the day you started, set **Settings → Late nights → Time after midnight** to "Previous day until 2/4/6 AM". The workday then rolls over at that hour.

The one question it asks: if a timer from last night is still running at the check hour (5 AM by default), and nothing was logged on it for two hours before then, deck-time asks once whether you forgot it. You can stop it a minute after your last note, at midnight, or at a time you pick. Or you can keep it all. Until you answer, the Neo info bar reads "Overnight timer?". You can change the hour or turn the check off in the same Settings section.

## Client billing rules & block billing

**Matters → Client billing rules** remembers instructions per client number:
a *No block billing* switch and free-text guidelines (e.g. "separate legal
analysis, the internal email about it, and any call into distinct entries").
Every matter under that client inherits them. A matter can override
(*prohibited* / *allowed*) and add its own guidelines, shown as a badge on
each of that client's entries.

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
the minimum), drafted from the notes taken during it. Without marks, the split
follows the clauses of your notes. Switching to another matter and back within
15 minutes continues the same task.

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
                   drafter.js + phrasebook.js (instant narratives, learned edits),
                   teacher.js + ai.js (offline rule proposals via local Ollama),
                   coder.js + codes.js (task/activity codes), dictation.js (browser or sox capture +
                   whisper), window.js (Review key), demo-seed.js, time.js, config.js
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
