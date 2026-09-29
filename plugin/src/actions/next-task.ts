import streamDeck, { action, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { companion } from "../companion";
import { messageKey, nextTaskKey } from "../render";

/**
 * Marks a task boundary on the running timer: closes the current task and
 * starts the next one on the same matter. Splits for no-block-billing clients
 * then use exact task durations. Tip: tap Dictate right after to label it.
 */
@action({ UUID: "com.bsovocool.decktime.next-task" })
export class NextTask extends SingletonAction {
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
		if (!companion.online || !companion.state?.running) return ev.action.showAlert();
		try {
			await companion.post("/api/timer/next-task");
			await ev.action.showOk();
		} catch (e) {
			streamDeck.logger.warn(`next task: ${(e as Error).message}`);
			await ev.action.showAlert();
		}
	}

	#renderAll(): void {
		const s = companion.state;
		let image: string;
		if (!companion.online || !s) image = messageKey("deck-time", "offline");
		else if (!s.running) image = nextTaskKey({ active: false });
		else
			image = nextTaskKey({
				active: true,
				task: s.running.tasks_today,
				elapsedMs: s.now - s.running.start_ms,
				color: s.running.matter.color,
			});
		if (image === this.#last) return;
		this.#last = image;
		for (const a of this.actions) if (a.isKey()) void a.setImage(image);
	}
}
