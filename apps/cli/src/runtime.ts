import { startBotmuxBridge, type BotmuxBridgeOptions } from './bridge-botmux';
import { startDirectBridge } from './bridge-direct';
import { configuredAgents, type RuntimeMode } from './direct-config';

export async function startRuntime(
  options: BotmuxBridgeOptions & {includePi?:boolean},
  mode: RuntimeMode,
  concurrency?: number,
  selectedAgents?: string[],
) {
  const instances: Awaited<ReturnType<typeof startBotmuxBridge>>[] = [];
  let directIds: string[] = [];
  try {
    if (mode === 'pi' || options.includePi) {
      const { startPiBridge } = await import('./bridge-pi');
      instances.push(await startPiBridge(options, concurrency, options.turnTimeoutMs));
    }
    if (mode === 'botmux' || mode === 'hybrid') instances.push(await startBotmuxBridge(options));
    if (mode === 'direct' || mode === 'hybrid') {
      const direct = await startDirectBridge(
        options,
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
      stop: () => instances.forEach((instance) => instance.stop()),
    };
  } catch (err) {
    for (const instance of instances) instance.stop();
    throw err;
  }
}
