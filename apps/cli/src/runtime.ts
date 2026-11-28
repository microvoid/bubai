import { TurnLimiter } from '@bubx/agent/process';
import { startBotmuxBridge, type BotmuxBridgeOptions } from './bridge-botmux';
import { startDirectBridge } from './bridge-direct';
import { configuredAgents, type RuntimeMode } from './direct-config';

export async function startRuntime(
  options: BotmuxBridgeOptions & {includePi?:boolean},
  mode: RuntimeMode,
  concurrency?: number,
  selectedAgents?: string[],
) {
  const localOptions = { ...options, limiter: new TurnLimiter(concurrency ?? 3) };
  const instances: Awaited<ReturnType<typeof startBotmuxBridge>>[] = [];
  let directIds: string[] = [];
  let piIds: string[] = [];
  try {
    if (mode === 'pi' || options.includePi) {
      const { startPiBridge } = await import('./bridge-pi');
      const pi = await startPiBridge(localOptions, concurrency, options.turnTimeoutMs);
      piIds = pi.agentIds;
      instances.push(pi);
    }
    if (mode === 'botmux' || mode === 'hybrid') instances.push(await startBotmuxBridge(options));
    if (mode === 'direct' || mode === 'hybrid') {
      const direct = await startDirectBridge(
        localOptions,
        configuredAgents(selectedAgents),
        concurrency,
        options.turnTimeoutMs,
      );
      directIds = direct.agentIds;
      instances.push(direct);
    }
    return {
      agentIds: instances.flatMap((instance) => instance.agentIds),
      directIds,
      piIds,
      stop: () => instances.forEach((instance) => instance.stop()),
    };
  } catch (err) {
    for (const instance of instances) instance.stop();
    throw err;
  }
}
