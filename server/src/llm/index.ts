import { anthropicProvider } from './anthropic.js';
import { openAiCompatProvider } from './openai.js';
import { xaiProvider } from './xai.js';
import { mockProvider } from './mock.js';
import { profiles, type ProviderProfile } from './profiles.js';
import { env } from '../env.js';
import type { LLMProvider, ProviderCall, ProviderEvent } from './types.js';

export * from './types.js';
export { profiles, type ProviderProfile } from './profiles.js';

let registry: LLMProvider[] | null = null;

function build(): LLMProvider[] {
  const list: LLMProvider[] = [];

  if (env.llmProvider === 'mock' || env.allowMock) list.push(mockProvider());

  for (const p of profiles()) {
    if (p.id === 'mock') continue;
    if (p.kind === 'anthropic') {
      list.push(
        anthropicProvider({
          id: p.id,
          label: p.label,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          models: p.models,
          defaultModel: p.defaultModel,
          maxTokens: p.maxTokens ?? 16_000,
        }),
      );
    } else if (p.kind === 'xai') {
      list.push(xaiProvider({ apiKey: p.apiKey, baseUrl: p.baseUrl, defaultModel: p.defaultModel, builtInSearch: p.builtInSearch !== false }));
    } else {
      list.push(
        openAiCompatProvider({
          id: p.id,
          label: p.label,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          models: p.models,
          defaultModel: p.defaultModel,
        }),
      );
    }
  }

  return list;
}

export function providers(): LLMProvider[] {
  if (!registry) registry = build();
  return registry;
}

export function providerById(id: string): LLMProvider | undefined {
  return providers().find((p) => p.id === id);
}

export interface ProviderChoice {
  provider: LLMProvider;
  model: string;
  profile: ProviderProfile | undefined;
}

/**
 * Pick the provider for a Bot: its own override if it has one, otherwise the
 * account default. Falls back to whichever configured provider is available so a
 * half-configured install still runs.
 */
export function providerFor(bot: { provider?: string | null; model?: string | null } | null, defaultProviderId?: string | null): ProviderChoice {
  const all = providers();
  const preferredId = bot?.provider || defaultProviderId || env.llmProvider;
  const found = all.find((p) => p.id === preferredId) ?? all.find((p) => p.available());
  if (!found) {
    throw new Error(
      'No model provider is configured. Set MINIMAX_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY, or PROVIDERS_JSON in .env.',
    );
  }
  const profile = profiles().find((p) => p.id === found.id);
  const model = bot?.model || profile?.defaultModel || found.models[0] || '';
  return { provider: found, model, profile };
}

/** Providers and models for the settings screen. */
export function providerCatalog() {
  return providers().map((p) => {
    const profile = profiles().find((x) => x.id === p.id);
    return {
      id: p.id,
      label: p.label,
      kind: profile?.kind ?? (p.id === 'mock' ? 'mock' : 'openai'),
      models: p.models.length ? p.models : profile?.models ?? [],
      available: p.available(),
    };
  });
}

/**
 * Run a one-shot prompt and return the text. Used for summaries and other
 * internal chores that do not need tools.
 */
export async function completeText(opts: {
  providerId?: string | null;
  model?: string | null;
  system: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const choice = providerFor({ provider: opts.providerId ?? null, model: opts.model ?? null }, opts.providerId ?? null);
  const ctrl = new AbortController();
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let text = '';
  for await (const ev of resilientStream(choice.provider, {
    model: opts.model || choice.model,
    system: opts.system,
    items: [{ role: 'user', content: opts.prompt }],
    tools: [],
    effort: 'low',
    signal: ctrl.signal,
  })) {
    if (ev.kind === 'text') text += ev.delta;
  }
  return text.trim();
}

/** Statuses worth trying again: the provider is busy or briefly broken. */
function isRetryable(e: any): boolean {
  const status = e?.status ?? e?.response?.status;
  if (status && [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  const message = String(e?.message ?? '').toLowerCase();
  return /overload|temporarily|try again|timeout|rate limit|too many requests|econnreset|socket hang up|fetch failed/.test(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream a turn, retrying when the provider is briefly unavailable.
 *
 * The retry only happens before any text was shown, so the user never sees a
 * half-answer twice.
 */
export async function* resilientStream(provider: LLMProvider, call: ProviderCall, maxAttempts = 3): AsyncGenerator<ProviderEvent> {
  for (let attempt = 1; ; attempt++) {
    let emitted = false;
    try {
      for await (const ev of provider.stream(call)) {
        if (ev.kind === 'text' && ev.delta) emitted = true;
        yield ev;
      }
      return;
    } catch (e: any) {
      if (emitted || attempt >= maxAttempts || !isRetryable(e) || call.signal.aborted) throw e;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(`[llm] ${provider.id} unavailable (${e?.message ?? e}); retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}
