import path from "node:path";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";
import { defaultHome, loadConfig } from "../../companion/src/config.js";
import { startCompanion } from "../../companion/src/host.js";

/**
 * Office edition: run the deck-time companion inside the plugin, so a work
 * computer needs only the Stream Deck app and this plugin (no Node, no local
 * AI). The review page is served from the plugin's app/ folder.
 */
export async function startEmbeddedCompanion(): Promise<void> {
	const config = loadConfig(defaultHome(), "office");
	if (config.embedded === false) {
		streamDeck.logger.info("deck-time: embedded companion disabled in config; expecting one to be running");
		return;
	}
	const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
	try {
		await startCompanion({ edition: "office", publicDir, log: (m: string) => streamDeck.logger.info(m) });
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "EADDRINUSE") streamDeck.logger.info("deck-time is already running on this computer; using it");
		else streamDeck.logger.error(`deck-time could not start: ${err.message}`);
	}
}
