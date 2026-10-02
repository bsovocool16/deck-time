import streamDeck, { action, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { companion } from "../companion";
import { dictateKey, messageKey } from "../render";

/** Dictate a note into the running timer: tap to start, tap again to stop. Transcription happens locally. */
@action({ UUID: "com.bsovocool.decktime.dictate" })
export class Dictate extends SingletonAction {
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
		if (!companion.online || !companion.state?.dictation) return ev.action.showAlert();
		try {
			await companion.post("/api/dictation/toggle");
		} catch (e) {
			streamDeck.logger.warn(`dictation: ${(e as Error).message}`);
			await ev.action.showAlert();
		}
	}

	#renderAll(): void {
		const s = companion.state;
		let image: string;
		if (!companion.online || !s) image = messageKey("deck-time", "offline");
		else if (!s.dictation) image = messageKey("Dictation", "unavailable");
		else if (s.dictation.status === "recording") image = dictateKey("recording", s.now - (s.dictation.started_at ?? s.now));
		else if (s.dictation.status === "transcribing") image = dictateKey("transcribing");
		else image = dictateKey(s.running ? "idle" : "disabled");
		if (image === this.#last) return;
		this.#last = image;
		for (const a of this.actions) if (a.isKey()) void a.setImage(image);
	}
}
