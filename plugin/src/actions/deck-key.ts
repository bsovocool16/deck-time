import streamDeck, { action, type KeyAction, type KeyDownEvent, type KeyUpEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { COMPANION_URL, companion, type State } from "../companion";
import { dictateKey, matterKey, messageKey, nextTaskKey, reviewKey, stopKey } from "../render";

const HOLD_MS = 450;

/**
 * A key that follows the layout set in the deck-time app. Put this action on
 * every key once; each key reads its position (row, column) and shows the
 * matter or function assigned there. Rearranging in the app's sidebar updates
 * the device immediately.
 */
@action({ UUID: "com.bsovocool.decktime.key" })
export class DeckKey extends SingletonAction {
	#slots = new Map<string, number>(); // action id -> slot index
	#lastImage = new Map<string, string>();
	#press = new Map<string, { at: number; startedDictation: boolean }>();

	constructor() {
		super();
		companion.on("state", () => this.#renderAll());
	}

	override onWillAppear(ev: WillAppearEvent): void {
		companion.start();
		if (!ev.action.isKey()) return;
		const c = ev.action.coordinates;
		const columns = ev.action.device.size.columns;
		// Keys inside a multi-action have no position; treat them as unassigned.
		this.#slots.set(ev.action.id, c ? c.row * columns + c.column : -1);
		this.#lastImage.delete(ev.action.id);
		this.#renderAll();
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#slots.delete(ev.action.id);
		this.#lastImage.delete(ev.action.id);
	}

	#assignment(id: string, state: State | null) {
		const slot = this.#slots.get(id) ?? -1;
		return state?.deck?.[slot] ?? null;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const s = companion.state;
		const a = this.#assignment(ev.action.id, s);
		if (!companion.online || !s || !a) return ev.action.showAlert();
		this.#press.set(ev.action.id, { at: Date.now(), startedDictation: false });
		try {
			if (a.kind === "matter" && a.matter_id) await companion.post("/api/timer/toggle", { matter_id: a.matter_id });
			else if (a.kind === "next-task") await companion.post("/api/timer/next-task");
			else if (a.kind === "stop") await companion.post("/api/timer/stop");
			else if (a.kind === "review" || a.kind === "empty") await streamDeck.system.openUrl(COMPANION_URL);
			else if (a.kind === "dictate") {
				const status = s.dictation?.status;
				if (status === "recording") await companion.post("/api/dictation/stop");
				else if (status === "idle") {
					await companion.post("/api/dictation/start");
					this.#press.set(ev.action.id, { at: Date.now(), startedDictation: true });
				}
			}
		} catch (e) {
			streamDeck.logger.warn(`deck key: ${(e as Error).message}`);
			await ev.action.showAlert();
		}
	}

	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		// Dictate supports hold-to-talk: releasing after a hold stops recording.
		const p = this.#press.get(ev.action.id);
		this.#press.delete(ev.action.id);
		if (p?.startedDictation && Date.now() - p.at >= HOLD_MS) {
			await companion.post("/api/dictation/stop").catch(() => ev.action.showAlert());
		}
	}

	#renderAll(): void {
		const state = companion.state;
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			void this.#render(a, state);
		}
	}

	async #render(a: KeyAction<JsonObject>, state: State | null): Promise<void> {
		const image = this.#image(a.id, state);
		if (this.#lastImage.get(a.id) === image) return;
		this.#lastImage.set(a.id, image);
		await a.setImage(image);
	}

	#image(id: string, s: State | null): string {
		if (!companion.online || !s) return messageKey("deck-time", "offline");
		const a = this.#assignment(id, s);
		const run = s.running;
		switch (a?.kind) {
			case "matter": {
				const m = s.matters.find((x) => x.id === a.matter_id);
				if (!m) return messageKey("Empty", "assign in app");
				const live = run?.matter_id === m.id;
				return matterKey({ label: m.label || m.name, color: m.color, live, elapsedMs: live ? s.now - run!.start_ms : 0, todayMs: m.today_ms });
			}
			case "dictate": {
				const d = s.dictation;
				if (d?.status === "recording") return dictateKey("recording", s.now - (d.started_at ?? s.now));
				if (d?.status === "transcribing") return dictateKey("transcribing");
				return dictateKey(run ? "idle" : "disabled");
			}
			case "next-task":
				return run ? nextTaskKey({ active: true, task: run.tasks_today, elapsedMs: s.now - run.start_ms, color: run.matter.color }) : nextTaskKey({ active: false });
			case "stop":
				return stopKey(!!run, s.total_hours);
			case "review":
				return reviewKey();
			default:
				return messageKey("Empty", "assign in app");
		}
	}
}
