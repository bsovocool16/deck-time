import streamDeck, { action, type KeyDownEvent, type KeyUpEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { companion } from "../companion";
import { dictateKey, messageKey } from "../render";

const HOLD_MS = 450;

/**
 * Dictate a note into the running timer. Hold to talk (release to stop), or
 * tap once to start and tap again to stop. Transcription happens locally.
 */
@action({ UUID: "com.bsovocool.decktime.dictate" })
export class Dictate extends SingletonAction {
	#last = "";
	#pressedAt = 0;
	#startedThisPress = false;

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
		const d = companion.state?.dictation;
		if (!companion.online || !d) return ev.action.showAlert();
		this.#pressedAt = Date.now();
		this.#startedThisPress = false;
		try {
			if (d.status === "recording") {
				await companion.post("/api/dictation/stop");
			} else if (d.status === "idle") {
				await companion.post("/api/dictation/start");
				this.#startedThisPress = true;
			}
		} catch (e) {
			streamDeck.logger.warn(`dictation: ${(e as Error).message}`);
			await ev.action.showAlert();
		}
	}

	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		// Held down = push-to-talk: releasing stops. A quick tap leaves it recording.
		if (this.#startedThisPress && Date.now() - this.#pressedAt >= HOLD_MS) {
			try {
				await companion.post("/api/dictation/stop");
			} catch {
				await ev.action.showAlert();
			}
		}
		this.#startedThisPress = false;
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
