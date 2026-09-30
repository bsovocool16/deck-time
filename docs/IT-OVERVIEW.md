# deck-time: overview for IT review

deck-time is a timekeeping aid for a Stream Deck (a USB button panel made by
Elgato). Each button starts and stops a timer for one client matter. At the end
of the day the attorney reviews the entries and exports a file that Intapp Time
imports through its standard **Import Time** feature.

This document covers the **office edition**, which runs entirely inside the
Stream Deck software.

## What gets installed

| Item | Source | Notes |
|---|---|---|
| Stream Deck app | Elgato (Corsair), elgato.com | Vendor-signed. Needed for any Stream Deck. |
| deck-time plugin | One file, `com.bsovocool.decktime.streamDeckPlugin` (about 90 KB) | Installed by double-clicking; the Stream Deck app places it in `%APPDATA%\Elgato\StreamDeck\Plugins\`. |

- No administrator rights, drivers, services or scheduled tasks beyond the
  Stream Deck app itself.
- No separate runtime to install: the plugin runs on the Node.js runtime that
  ships inside the Stream Deck app.

## Network

- **No outbound connections.** The plugin contacts no internet services, uses
  no cloud AI and sends no telemetry. (The Stream Deck app itself may check
  Elgato for updates; that is independent of this plugin.)
- It opens one local port, **127.0.0.1:7331**, bound to the loopback interface
  only, so it is not reachable from the network. That serves the review page in
  the user's browser and talks to the Stream Deck app.
- Requests from other websites are rejected (origin check, JSON-only API), so a
  web page cannot drive the timers.

## Data

Everything stays on the computer, in the user's profile:

| Path | Contents |
|---|---|
| `%APPDATA%\deck-time\deck-time.db` | Matters (names, client and matter numbers), timer records, notes, narratives. SQLite. |
| `%APPDATA%\deck-time\demo.db` | Fictional sample matters used for demonstrations. |
| `%APPDATA%\deck-time\config.json` | Settings (timekeeper ID, rounding, key layout). |
| `%APPDATA%\deck-time\exports\` | Exported `.TIM` files for import into Intapp Time. |

These files are covered by the machine's normal disk encryption and backup
policies. Nothing is copied elsewhere.

## Intapp Time

- No integration, API access or stored credentials.
- The user exports a `.TIM` file and imports it into Intapp Time with Intapp's
  own **Import Time** feature, exactly as with any other time file. Entries
  arrive for the user to review and release as usual.

## Removal

1. In the Stream Deck app, remove the deck-time plugin (or delete
   `%APPDATA%\Elgato\StreamDeck\Plugins\com.bsovocool.decktime.sdPlugin`).
2. Delete `%APPDATA%\deck-time\` to remove its data.

## Source

The source code is available for review on request. It is licensed under the
PolyForm Noncommercial License 1.0.0.
