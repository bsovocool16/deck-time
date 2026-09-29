import streamDeck, { action, type KeyAction, type KeyDownEvent, type SendToPluginEvent, SingletonAction, type WillAppearEvent, type DidReceiveSettingsEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { companion, type State } from "../companion";
import { matterKey, messageKey } from "../render";

type Settings = { matterId?: string };

/** One key = one matter. Press to start; press again to stop. */
@action({ UUID: "com.bsovocool.decktime.matter" })
export class MatterTimer extends SingletonAction<Settings> {
	#settings = new Map<string, Settings>();
	#lastImage = new Map<string, string>();

	constructor() {
		super();
		companion.on("state", () => this.#renderAll());
	}

	override onWillAppear(ev: WillAppearEvent<Settings>): void {
		companion.start();
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#lastImage.delete(ev.action.id);
		this.#renderAll();
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		this.#settings.delete(ev.action.id);
		this.#lastImage.delete(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#renderAll();
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const id = Number(ev.payload.settings.matterId);
		if (!id || !companion.online) return ev.action.showAlert();
		try {
			await companion.post("/api/timer/toggle", { matter_id: id });
		} catch (e) {
			streamDeck.logger.error(`toggle failed: ${(e as Error).message}`);
			await ev.action.showAlert();
		}
	}

	/** Property inspector asks for the matter list to fill its dropdown. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
		const payload = ev.payload as { event?: string };
		if (payload?.event !== "getMatters") return;
		let items: { label: string; value: string }[];
		try {
			items = (await companion.matters()).map((m) => ({ label: m.name, value: String(m.id) }));
		} catch {
			items = [{ label: "deck-time app is not running", value: "", disabled: true } as never];
		}
		await streamDeck.ui.sendToPropertyInspector({ event: "getMatters", items });
	}

	#renderAll(): void {
		const state = companion.state;
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			void this.#render(a, state);
		}
	}

	async #render(a: KeyAction<Settings>, state: State | null): Promise<void> {
		const image = this.#image(this.#settings.get(a.id) ?? {}, state);
		if (this.#lastImage.get(a.id) === image) return;
		this.#lastImage.set(a.id, image);
		await a.setImage(image);
	}

	#image(settings: Settings, state: State | null): string {
		if (!companion.online || !state) return messageKey("deck-time", "offline");
		const id = Number(settings.matterId);
		if (!id) return messageKey("Pick a matter");
		const matter = state.matters.find((m) => m.id === id);
		if (!matter) return messageKey("Matter missing");
		const live = state.running?.matter_id === id;
		return matterKey({
			label: matter.label || matter.name,
			color: matter.color,
			live,
			elapsedMs: live ? state.now - state.running!.start_ms : 0,
			todayMs: matter.today_ms,
		});
	}
}
