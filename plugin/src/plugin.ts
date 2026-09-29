import streamDeck from "@elgato/streamdeck";
import { Dictate } from "./actions/dictate";
import { Infobar } from "./actions/infobar";
import { MatterTimer } from "./actions/matter-timer";
import { NextTask } from "./actions/next-task";
import { Review } from "./actions/review";
import { StopTimer } from "./actions/stop-timer";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MatterTimer());
streamDeck.actions.registerAction(new NextTask());
streamDeck.actions.registerAction(new StopTimer());
streamDeck.actions.registerAction(new Review());
streamDeck.actions.registerAction(new Dictate());
streamDeck.actions.registerAction(new Infobar());

streamDeck.connect();
