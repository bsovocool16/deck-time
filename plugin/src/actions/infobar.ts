import { action, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { companion } from "../companion";
import { clock } from "../render";

/** Stream Deck Neo info bar: running matter, its elapsed time and today's total; or today's total (or a nudge to answer the overnight check). */
@action({ UUID: "com.bsovocool.decktime.infobar" })
export class Infobar extends SingletonAction {
	#last = "";

	constructor() {
		super();
		companion.on("state", () => this.#renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		companion.start();
		if (ev.action.isNeoInfobar()) await ev.action.setFeedbackLayout("layouts/infobar.json");
		this.#last = "";
		this.#renderAll();
	}

	#renderAll(): void {
		const s = companion.state;
		let feedback: { title: string; value: string };
		if (!companion.online || !s) feedback = { title: "deck-time", value: "offline" };
		else if (s.overnight) feedback = { title: "Overnight timer?", value: "check app" };
		// The Neo's two touch points beside the info bar are reserved for page switching (plugins
		// can't use them), so the running timer and the day's total share the bar instead of toggling.
		else if (s.running) feedback = { title: s.running.matter.label || s.running.matter.name, value: `${clock(s.now - s.running.start_ms)} · ${s.total_hours.toFixed(1)}h` };
		else feedback = { title: "No timer running", value: `${s.total_hours.toFixed(1)}h today` };
		const key = JSON.stringify(feedback);
		if (key === this.#last) return;
		this.#last = key;
		for (const a of this.actions) if (a.isNeoInfobar()) void a.setFeedback(feedback);
	}
}
