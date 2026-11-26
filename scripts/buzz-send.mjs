#!/usr/bin/env node
/**
 * Thin local CLI wrapper for Buzz × Botmux outbound bot messaging.
 * Wraps POST /api/bot/messages so CLI agents (Codex / Claude Code) and
 * automated cron/webhook scripts share one controlled channel into Buzz.
 *
 * Usage:
 *   node scripts/buzz-send.mjs --bot <botId|botName> --channel <channelId|channelName> --text "Hello"
 *   echo "Daily summary" | node scripts/buzz-send.mjs --bot 研发负责人 --channel general
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function printUsage() {
  console.log(`Usage:
  node scripts/buzz-send.mjs --bot <botId|botName> --channel <channelId|channelName> --text <message> [options]

Options:
  --bot <id|name>       Bot ID (larkAppId) or display name (env: BUZZ_BOT_ID)
  --channel <id|name>   Target channel UUID or channel name, e.g. general (env: BUZZ_CHANNEL_ID)
  --text <message>      Message content (reads from stdin if omitted)
  --thread <rootId>     Optional thread root message ID (omit to post to main timeline)
  --reply-to <msgId>    Optional parent reply ID inside a thread
  --message-id <id>     Optional running placeholder message ID to settle in place
  --session <sid>       Optional Botmux session ID
  --server <url>        Buzz server URL (default: env BUZZ_SERVER_URL or http://127.0.0.1:4000)
  --token <token>       Optional Bearer token (env: BUZZ_BOT_TOKEN)
  -h, --help            Show this help`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const server = (args.server || process.env.BUZZ_SERVER_URL || 'http://127.0.0.1:4000').replace(
    /\/+$/,
    '',
  );
  const token = args.token || process.env.BUZZ_BOT_TOKEN || '';
  const botRef = (args.bot || process.env.BUZZ_BOT_ID || '').trim();
  const channelRef = (args.channel || process.env.BUZZ_CHANNEL_ID || '').trim();
  const text = (args.text !== undefined ? args.text : await readStdin()).trim();

  if (!botRef) {
    console.error('Error: --bot (or BUZZ_BOT_ID) is required.');
    process.exit(2);
  }
  if (!channelRef) {
    console.error('Error: --channel (or BUZZ_CHANNEL_ID) is required.');
    process.exit(2);
  }
  if (!text) {
    console.error('Error: --text (or stdin content) is required.');
    process.exit(2);
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelRef);

  const payload = {
    botId: botRef,
    ...(isUuid ? { channelId: channelRef } : { channelName: channelRef.replace(/^#/, '') }),
    content: text,
    ...(args.thread ? { threadId: args.thread } : {}),
    ...(args['reply-to'] ? { replyToId: args['reply-to'] } : {}),
    ...(args['message-id'] ? { messageId: args['message-id'] } : {}),
    ...(args.session ? { botmuxSessionId: args.session } : {}),
  };

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${server}/api/bot/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = { raw: bodyText };
  }

  if (!res.ok) {
    console.error(`buzz-send failed (HTTP ${res.status}):`, JSON.stringify(data));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ok: true,
      id: data.message?.id,
      channelId: data.message?.channelId,
      threadId: data.message?.threadId ?? null,
    }),
  );
}

main().catch((err) => {
  console.error('buzz-send error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
