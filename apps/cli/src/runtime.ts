import { startBotmuxBridge, type BotmuxBridgeOptions } from './bridge-botmux';
import { startDirectBridge } from './bridge-direct';
import { configuredAgents, type RuntimeMode } from './direct-config';

export async function startRuntime(
  options: BotmuxBridgeOptions,
  mode: RuntimeMode,
  concurrency?: number,
  selectedAgents?: string[],
) {
  const instances: Awaited<ReturnType<typeof startBotmuxBridge>>[] = [];
  let directIds: string[] = [];
  try {
    if (mode !== 'direct') instances.push(await startBotmuxBridge(options));
    if (mode !== 'botmux') {
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
