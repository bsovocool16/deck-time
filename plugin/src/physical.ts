import streamDeck from "@elgato/streamdeck";
import { companion } from "./companion";

// Tells the deck-time app what's actually on each Stream Deck key, so its
// on-screen deck mirrors the device: deck-time Keys follow the app's layout,
// while keys set to a specific action in the Stream Deck app show as fixed.

const KIND_BY_ACTION: Record<string, string> = {
	"com.bsovocool.decktime.key": "key",
	"com.bsovocool.decktime.dictate": "dictate",
	"com.bsovocool.decktime.next-task": "next-task",
	"com.bsovocool.decktime.stop": "stop",
	"com.bsovocool.decktime.review": "review",
	"com.bsovocool.decktime.matter": "matter",
};

type Placed = { slot: number; kind: string; matter_id: number | null; columns: number; rows: number };
const present = new Map<string, Placed>();
let timer: NodeJS.Timeout | undefined;

export function trackPhysicalLayout(): void {
	streamDeck.actions.onWillAppear((ev) => {
		const kind = KIND_BY_ACTION[ev.action.manifestId];
		const p = ev.payload as { coordinates?: { column: number; row: number }; controller?: string; settings?: { matterId?: string } };
		if (!kind || p.controller !== "Keypad" || !p.coordinates) return; // skip the info bar and multi-actions
		const { columns, rows } = ev.action.device.size;
		present.set(ev.action.id, {
			slot: p.coordinates.row * columns + p.coordinates.column,
			kind,
			matter_id: kind === "matter" ? Number(p.settings?.matterId) || null : null,
			columns,
			rows,
		});
		schedule();
	});
	streamDeck.actions.onWillDisappear((ev) => {
		if (present.delete(ev.action.id)) schedule();
	});
	// Re-send whenever the app (re)connects, e.g. after `npm start` restarts.
	companion.on("online", () => schedule());
}

/** A Matter Timer key's matter changed in its settings. */
export function updatePhysicalMatter(actionId: string, matterId: string | undefined): void {
	const placed = present.get(actionId);
	if (!placed) return;
	placed.matter_id = Number(matterId) || null;
	schedule();
}

function schedule(): void {
	clearTimeout(timer);
	timer = setTimeout(report, 300);
}

async function report(): Promise<void> {
	// Switching to a profile without deck-time keys leaves nothing visible; keep
	// the last layout rather than telling the app the deck went blank.
	if (!present.size || !companion.online) return;
	const any = present.values().next().value as Placed;
	const slots = [...present.values()].map(({ slot, kind, matter_id }) => ({ slot, kind, matter_id }));
	try {
		await companion.post("/api/deck/physical", { columns: any.columns, rows: any.rows, slots });
	} catch (e) {
		streamDeck.logger.debug(`physical layout report failed: ${(e as Error).message}`);
	}
}
