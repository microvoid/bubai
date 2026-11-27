#!/usr/bin/env bun
/**
 * Standalone Botmux -> BubAI Gateway Connector CLI.
 * Connects outbound to BubAI's `/ws/bot` Socket Mode gateway so BubAI can run with
 * `BOTMUX_DISABLED=true` (zero inbound dependency on local Botmux).
 *
 * Usage:
 *   BUBAI_URL=http://127.0.0.1:4000 BUBAI_BOT_TOKEN=bot-server_... bun scripts/botmux-connector.mjs
 */
import { BotmuxBubaiConnector } from '../packages/botmux-client/src/connector.ts';

const bubaiUrl = process.env.BUBAI_URL || 'http://127.0.0.1:4000';
const botToken = process.env.BUBAI_BOT_TOKEN || process.env.BUZZ_BOT_TOKEN;
const botmuxEndpoint = process.env.BOTMUX_ENDPOINT || 'http://127.0.0.1:7891';
const botmuxToken = process.env.BOTMUX_TOKEN;

const connector = new BotmuxBubaiConnector({
  bubaiUrl,
  botToken,
  botmuxEndpoint,
  botmuxToken,
});

connector.start();

process.on('SIGINT', () => {
  connector.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  connector.stop();
  process.exit(0);
});
