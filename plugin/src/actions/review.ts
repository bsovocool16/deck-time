import streamDeck, { action, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { COMPANION_URL } from "../companion";
import { reviewKey } from "../render";

/** Opens the day's entries in the browser for notes, narratives, and export. */
@action({ UUID: "com.bsovocool.decktime.review" })
export class Review extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		if (ev.action.isKey()) await ev.action.setImage(reviewKey());
	}

	override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
		await streamDeck.system.openUrl(COMPANION_URL);
	}
}
