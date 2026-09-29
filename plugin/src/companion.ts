import { EventEmitter } from "node:events";
import streamDeck from "@elgato/streamdeck";

export const COMPANION_URL = "http://127.0.0.1:7331";

export type Matter = {
	id: number;
	name: string;
	label: string;
	color: string;
	client_no: string;
	matter_no: string;
	today_ms: number;
};

export type State = {
	now: number;
	today: string;
	total_hours: number;
	running: { id: number; matter_id: number; start_ms: number; task: number; tasks_today: number; matter: Matter } | null;
	matters: Matter[];
	dictation: { status: "idle" | "recording" | "transcribing"; error: string | null; started_at: number | null } | null;
};

/**
 * Live connection to the deck-time companion app. The companion owns all timer
 * state; the plugin just renders it and forwards key presses.
 */
class Companion extends EventEmitter {
	state: State | null = null;
	online = false;
	#started = false;

	start(): void {
		if (this.#started) return;
		this.#started = true;
		void this.#loop();
	}

	async #loop(): Promise<void> {
		let delay = 1000;
		for (;;) {
			try {
				const res = await fetch(`${COMPANION_URL}/api/events`);
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				delay = 1000;
				await this.#read(res.body);
			} catch (e) {
				streamDeck.logger.debug(`companion connection: ${(e as Error).message}`);
			}
			this.#setOffline();
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(delay * 2, 10_000);
		}
	}

	async #read(body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let idx;
			while ((idx = buffer.indexOf("\n\n")) >= 0) {
				const event = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = event
					.split("\n")
					.filter((l) => l.startsWith("data: "))
					.map((l) => l.slice(6))
					.join("\n");
				if (!data) continue;
				this.state = JSON.parse(data) as State;
				this.online = true;
				this.emit("state", this.state);
			}
		}
	}

	#setOffline(): void {
		if (this.online || this.state === null) {
			this.online = false;
			this.emit("state", this.state);
		}
	}

	async post(path: string, body: object = {}): Promise<unknown> {
		const res = await fetch(`${COMPANION_URL}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json()) as { error?: string };
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		return data;
	}

	async matters(): Promise<Matter[]> {
		const res = await fetch(`${COMPANION_URL}/api/matters`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as Matter[];
	}
}

export const companion = new Companion();
