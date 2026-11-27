#!/usr/bin/env node
import { BubaiClient } from '@buzz-botmux/chat-client';
import { version } from '../package.json';
import { loadCliConfig, saveCliConfig } from './config';
import { startBotmuxBridge } from './bridge-botmux';

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : undefined;
}

function resolveConnection(flags: Record<string, string | boolean>) {
  const saved = loadCliConfig();
  const serverUrl =
    getStringFlag(flags, 'server') ||
    process.env.BUBAI_URL ||
    saved.serverUrl ||
    'https://bubai.app/';
  const token =
    getStringFlag(flags, 'token') ||
    process.env.BUBAI_TOKEN ||
    process.env.BUBAI_BOT_TOKEN ||
    process.env.BUZZ_BOT_TOKEN ||
    saved.token;
  return { serverUrl, token };
}

function printHelp() {
  console.log(`BubaiCLI — Unified BubAI client & Agent Adapter bridge

Usage:
  bub --version
  bub login [--server <url>] [--client-id <id>] [--json]
  bub config set --server <url> [--token <token>]
  bub status [--server <url>] [--token <token>]
  bub agent create --name <name> [--id <id>] [--external-id <ext>] [--channel <name|id>] [--auto-reply] [--issue-key]
  bub agent list [--server <url>]
  bub agent join --agent <id> --channel <name|id> [--auto-reply]
  bub bridge botmux [--server <url>] [--token <token>] [--botmux <url>] [--bots <id,id>] [--channel <name|id>] [--auto-reply]
  bub chat send --channel <name|id> --text <text> [--bot <agentId>] [--thread <threadId>]
`);
}

async function runDeviceLogin(serverUrl: string, flags: Record<string, string | boolean>) {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const clientId = getStringFlag(flags, 'client-id') || 'bubai-cli';
  const jsonMode = Boolean(flags.json);

  const codeRes = await fetch(`${baseUrl}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  const codeBody = (await codeRes.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
    message?: string;
  };
  if (!codeRes.ok || !codeBody.device_code || !codeBody.user_code) {
    throw new Error(
      codeBody.error_description || codeBody.message || `Device authorization failed (HTTP ${codeRes.status})`,
    );
  }

  const verificationUri = codeBody.verification_uri || `${baseUrl}/device`;
  const verificationUriComplete =
    codeBody.verification_uri_complete ||
    `${verificationUri}${verificationUri.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(codeBody.user_code)}`;

  if (jsonMode) {
    console.log(
      JSON.stringify({
        event: 'device_code',
        userCode: codeBody.user_code,
        verificationUri,
        verificationUriComplete,
        expiresIn: codeBody.expires_in ?? 600,
        interval: codeBody.interval ?? 5,
      }),
    );
  } else {
    console.log(`Open this URL in your browser to authorize BubaiCLI:`);
    console.log(`  ${verificationUriComplete}`);
    console.log(`Verification code: ${codeBody.user_code}`);
    console.log(`Waiting for approval...`);
  }

  const deadline = Date.now() + (codeBody.expires_in ?? 600) * 1000;
  let pollMs = Math.max(500, Math.min((codeBody.interval ?? 5) * 1000, 1500));

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const tokenRes = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: codeBody.device_code,
        client_id: clientId,
      }),
    });
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenRes.ok && tokenBody.access_token) {
      const next = saveCliConfig({ serverUrl: baseUrl, token: tokenBody.access_token });
      if (jsonMode) {
        console.log(JSON.stringify({ event: 'authenticated', ok: true, serverUrl: next.serverUrl }));
      } else {
        console.log(`Authenticated with ${next.serverUrl}. Token saved to CLI config.`);
      }
      return;
    }

    if (tokenBody.error === 'authorization_pending') {
      continue;
    }
    if (tokenBody.error === 'slow_down') {
      pollMs = Math.min(pollMs + 2000, 10000);
      continue;
    }
    if (tokenBody.error === 'access_denied') {
      throw new Error('Device authorization was denied by the user');
    }
    if (tokenBody.error === 'expired_token') {
      throw new Error('Device authorization code expired');
    }
    throw new Error(tokenBody.error_description || tokenBody.error || `Token poll failed (HTTP ${tokenRes.status})`);
  }

  throw new Error('Device authorization timed out');
}

async function resolveChannelId(sdk: BubaiClient, channelRef: string): Promise<string> {
  if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(channelRef)) {
    return channelRef;
  }
  const cleanName = channelRef.replace(/^#/, '');
  const boot = await sdk.bootstrap('u-owner');
  const match = boot.channels.find((c) => c.name === cleanName);
  if (!match) {
    throw new Error(`Channel "${channelRef}" not found`);
  }
  return match.id;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub] = positionals;

  if (flags.version || cmd === '-V') {
    console.log(version);
    return;
  }

  if (!cmd || cmd === 'help' || flags.help) {
    printHelp();
    return;
  }

  if (cmd === 'config' && sub === 'set') {
    const serverUrl = getStringFlag(flags, 'server');
    const token = getStringFlag(flags, 'token');
    const next = saveCliConfig(
      {
        ...(serverUrl ? { serverUrl } : {}),
        ...(token ? { token } : {}),
      },
      undefined,
      { clearTokenOnServerChange: true },
    );
    console.log(
      JSON.stringify({
        ok: true,
        config: {
          serverUrl: next.serverUrl,
          tokenSet: Boolean(next.token),
        },
      }),
    );
    return;
  }

  const { serverUrl, token } = resolveConnection(flags);

  if (cmd === 'login') {
    await runDeviceLogin(serverUrl, flags);
    return;
  }

  const sdk = new BubaiClient({ baseUrl: serverUrl, token });

  if (cmd === 'status') {
    const [instance, { agents }] = await Promise.all([sdk.getInstance(), sdk.listAgents()]);
    console.log(JSON.stringify({ ok: true, serverUrl, instance, agents }, null, 2));
    return;
  }

  if (cmd === 'agent' && sub === 'list') {
    const res = await sdk.listAgents();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'agent' && sub === 'create') {
    const name = getStringFlag(flags, 'name');
    if (!name) {
      console.error('Error: --name is required');
      process.exit(1);
    }
    const channelRef = getStringFlag(flags, 'channel');
    const isUuid =
      channelRef && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(channelRef);
    const result = await sdk.provisionAgent({
      agentId: getStringFlag(flags, 'id'),
      externalId: getStringFlag(flags, 'external-id'),
      adapterType: (getStringFlag(flags, 'adapter') as 'gateway' | 'webhook' | 'botmux') || 'gateway',
      name,
      description: getStringFlag(flags, 'description'),
      cliId: getStringFlag(flags, 'cli-id'),
      webhookUrl: getStringFlag(flags, 'webhook-url'),
      webhookSecret: getStringFlag(flags, 'webhook-secret'),
      ...(isUuid ? { channelId: channelRef } : channelRef ? { channelName: channelRef } : {}),
      autoReply: Boolean(flags['auto-reply']),
      issueKey: Boolean(flags['issue-key']),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'agent' && sub === 'join') {
    const agentId = getStringFlag(flags, 'agent');
    const channelRef = getStringFlag(flags, 'channel');
    if (!agentId || !channelRef) {
      console.error('Error: --agent and --channel are required');
      process.exit(1);
    }
    const channelId = await resolveChannelId(sdk, channelRef);
    const res = await sdk.addChannelMember(channelId, {
      agentId,
      autoReply: Boolean(flags['auto-reply']),
    });
    console.log(JSON.stringify({ ok: true, channelId, member: res.member }, null, 2));
    return;
  }

  if (cmd === 'chat' && sub === 'send') {
    const channelRef = getStringFlag(flags, 'channel');
    const text = getStringFlag(flags, 'text');
    const botId = getStringFlag(flags, 'bot');
    const threadId = getStringFlag(flags, 'thread');
    if (!channelRef || !text) {
      console.error('Error: --channel and --text are required');
      process.exit(1);
    }
    if (!botId) {
      console.error('Error: --bot <agentId> is required for CLI bot send');
      process.exit(1);
    }
    const channelId = await resolveChannelId(sdk, channelRef);
    const res = await sdk.sendBotMessage({
      botId,
      channelId,
      threadId: threadId || null,
      content: text,
    });
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    return;
  }

  if (cmd === 'bridge' && sub === 'botmux') {
    const botmuxEndpoint =
      getStringFlag(flags, 'botmux') || process.env.BOTMUX_ENDPOINT || 'http://127.0.0.1:7891';
    const botmuxToken = getStringFlag(flags, 'botmux-token') || process.env.BOTMUX_TOKEN;
    const botToken = getStringFlag(flags, 'bot-token');
    const botIds = getStringFlag(flags, 'bots')?.split(',').map((id) => id.trim());
    if (flags.bots !== undefined && (!botIds || botIds.some((id) => !id))) {
      throw new Error('--bots requires a comma-separated list of Botmux bot IDs');
    }
    const channelRef = getStringFlag(flags, 'channel');
    const pollMsRaw = getStringFlag(flags, 'poll-ms');
    const pollMs = pollMsRaw ? Number(pollMsRaw) : undefined;

    const bridge = await startBotmuxBridge({
      serverUrl,
      token,
      botToken,
      botmuxEndpoint,
      botmuxToken,
      botIds,
      channelRef,
      autoReply: flags['auto-reply'] !== undefined ? Boolean(flags['auto-reply']) : undefined,
      pollMs,
    });

    const shutdown = () => {
      bridge.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  console.error(`Unknown command: ${positionals.join(' ')}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
