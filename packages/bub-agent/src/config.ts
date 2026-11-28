export interface PiModelConfig {
  auth?: 'byok' | 'bub-login';
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}
export function resolveModel(
  config: { piModel?: PiModelConfig; serverUrl?: string; token?: string } = {},
  env = process.env,
): PiModelConfig {
  const stored = config.piModel;
  const provider =
    env.BUBAI_LLM_PROVIDER ||
    stored?.provider ||
    (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY
      ? 'anthropic'
      : env.GEMINI_API_KEY && !env.OPENAI_API_KEY
        ? 'google'
        : 'openai');
  const keys: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    google: env.GEMINI_API_KEY,
  };
  const defaults: Record<string, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-5',
    google: 'gemini-2.5-flash',
  };
  const previous = stored?.provider === provider ? stored : undefined;
  const baseUrl = env.BUBAI_LLM_BASE_URL || previous?.baseUrl;
  const sameEndpoint = baseUrl === previous?.baseUrl;
  const hosted = previous?.auth === 'bub-login';
  if (
    hosted &&
    (!config.serverUrl || !baseUrl || new URL(baseUrl).origin !== new URL(config.serverUrl).origin)
  ) {
    throw new Error('A hosted model must use the logged-in BubAI server origin');
  }
  const apiKey =
    (hosted && config.token) ||
    env.BUBAI_LLM_API_KEY ||
    (sameEndpoint && previous?.apiKey) ||
    (!baseUrl && keys[provider]);
  if (!apiKey)
    throw new Error(
      'Set BUBAI_LLM_API_KEY or run bub config set --llm-provider <provider> --llm-model <model> --llm-api-key <key>',
    );
  const model = env.BUBAI_LLM_MODEL || previous?.model || defaults[provider];
  if (!model) throw new Error('Set BUBAI_LLM_MODEL for this provider');
  return { provider, model, baseUrl, apiKey };
}

export interface PiAgentConfig {
  externalId: string;
  name: string;
  profile: string;
  workingDir?: string;
  bin?: string;
  skill?: string;
  timeoutMs?: number;
}
