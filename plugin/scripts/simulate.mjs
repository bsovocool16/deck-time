// Stands in for the Stream Deck app so the built plugin can be exercised
// without hardware: launches bin/plugin.js the way Stream Deck does, puts
// "deck-time Key" actions on a 4x2 Neo, presses keys, and saves the key images
// the plugin draws.
//
//   node scripts/simulate.mjs [outDir]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..", "com.bsovocool.decktime.sdPlugin");
const outDir = process.argv[2] ?? path.join(here, "..", "sim-out");
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wss = new WebSocketServer({ port: 0 });
const port = wss.address().port;
const images = new Map();
const logs = [];

const device = { id: "NEO1", name: "Stream Deck Neo", size: { columns: 4, rows: 2 }, type: 9 };
const info = {
  application: { font: "", language: "en", platform: "mac", platformVersion: "15.0", version: "7.6.0.0" },
  plugin: { uuid: "com.bsovocool.decktime", version: "0.1.0.0" },
  devicePixelRatio: 2,
  colors: {},
  devices: [device],
};

const connected = new Promise((resolve) => {
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.event === "registerPlugin") return resolve(ws);
      if (msg.event === "setImage") images.set(msg.context, msg.payload.image);
      if (msg.event === "logMessage") logs.push(msg.payload.message);
      if (msg.event === "openUrl") logs.push(`openUrl ${msg.payload.url}`);
    });
  });
});

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/plugin.js", "-port", String(port), "-pluginUUID", "sim-plugin", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
  cwd: pluginDir,
  stdio: ["ignore", "inherit", "inherit"],
});

const ws = await connected;
const send = (o) => ws.send(JSON.stringify(o));
const keys = Array.from({ length: 8 }, (_, i) => ({ context: `key${i}`, coordinates: { column: i % 4, row: Math.floor(i / 4) } }));
const keyEvent = (event, k) => ({
  event,
  action: "com.bsovocool.decktime.key",
  context: k.context,
  device: device.id,
  payload: { controller: "Keypad", coordinates: k.coordinates, isInMultiAction: false, settings: {} },
});

await sleep(1500); // companion starting inside the plugin
for (const k of keys) send(keyEvent("willAppear", k));
await sleep(1500);
save("1-appeared");

const api = (p, body) =>
  fetch(`http://127.0.0.1:7331${p}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const cfg = await api("/api/config");
console.log("companion features:", JSON.stringify(cfg.features));

// Demo day, then press key 1 (a matter) and watch it go live.
await api("/api/workspace", { workspace: "demo" });
await sleep(1200);
save("2-demo-day");
send(keyEvent("keyDown", keys[0]));
send(keyEvent("keyUp", keys[0]));
await sleep(2500);
save("3-key1-running");
const state = await api("/api/state");
console.log("running:", state.running?.matter?.name ?? "none", "| deck:", state.deck.map((s) => s.kind).join(","));

send(keyEvent("keyDown", keys[7])); // Stop
send(keyEvent("keyUp", keys[7]));
await sleep(800);
await api("/api/workspace", { workspace: "real" });
await sleep(800);
console.log("after stop:", (await api("/api/state")).running ? "still running" : "stopped");
console.log("plugin log lines:", logs.filter((l) => /deck-time/.test(l)).join(" | "));

child.kill();
wss.close();

function save(label) {
  const html = keys
    .map((k) => `<img width="96" height="96" style="border-radius:10px" src="${images.get(k.context) ?? ""}">`)
    .join("");
  fs.writeFileSync(path.join(outDir, `${label}.html`), `<body style="background:#222;margin:20px"><div style="display:grid;grid-template-columns:repeat(4,96px);gap:10px">${html}</div></body>`);
  console.log(`${label}: ${[...images.keys()].length} key images`);
}
