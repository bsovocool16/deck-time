import { action, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { companion } from "../companion";
import { messageKey, stopKey } from "../render";

/** Stops whatever is running; shows today's billable total. */
@action({ UUID: "com.bsovocool.decktime.stop" })
export class StopTimer extends SingletonAction {
	#last = "";

	constructor() {
		super();
		companion.on("state", () => this.#renderAll());
	}

	override onWillAppear(_ev: WillAppearEvent): void {
		companion.start();
		this.#last = "";
		this.#renderAll();
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		if (!companion.online) return ev.action.showAlert();
		await companion.post("/api/timer/stop");
		await ev.action.showOk();
	}

	#renderAll(): void {
		const s = companion.state;
		const image = companion.online && s ? stopKey(!!s.running, s.total_hours) : messageKey("deck-time", "offline");
		if (image === this.#last) return;
		this.#last = image;
		for (const a of this.actions) if (a.isKey()) void a.setImage(image);
	}
}
