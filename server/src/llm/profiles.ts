import { env } from '../env.js';
import type { ProviderKind } from './types.js';

/**
 * A provider profile is one API you can point a Bot at: an id, the keys, and
 * the models it serves. Profiles come from the environment, so a Bot only ever
 * stores a profile id and a model name - never a key.
 */
export interface ProviderProfile {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  maxTokens?: number;
  /** xAI-only: hosted web search and X search. */
  builtInSearch?: boolean;
}

/** Extra profiles the user defined as JSON in .env (PROVIDERS_JSON). */
function extraProfiles(): ProviderProfile[] {
  const raw = env.providerProfilesJson;
  if (!raw) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[llm] PROVIDERS_JSON is not valid JSON; ignoring it');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProviderProfile[] = [];
  for (const p of parsed) {
    if (!p?.id || !p?.baseUrl) continue;
    const kind: ProviderKind = p.kind === 'anthropic' ? 'anthropic' : p.kind === 'xai' ? 'xai' : 'openai';
    const models: string[] = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
    out.push({
      id: String(p.id),
      label: String(p.label ?? p.id),
      kind,
      baseUrl: String(p.baseUrl),
      apiKey: String(p.apiKey ?? ''),
      models: models.length ? models : [String(p.defaultModel ?? 'default')],
      defaultModel: String(p.defaultModel ?? models[0] ?? 'default'),
      maxTokens: Number(p.maxTokens) || undefined,
    });
  }
  return out;
}

export function profiles(): ProviderProfile[] {
  const list: ProviderProfile[] = [];

  if (env.minimaxKey) {
    list.push({
      id: 'minimax',
      label: 'MiniMax',
      kind: 'anthropic',
      baseUrl: env.minimaxBaseUrl,
      apiKey: env.minimaxKey,
      models: env.minimaxModels,
      defaultModel: env.minimaxModel,
      maxTokens: env.minimaxMaxTokens,
    });
  }

  if (env.anthropicKey) {
    list.push({
      id: 'anthropic',
      label: 'Anthropic',
      kind: 'anthropic',
      baseUrl: env.anthropicBaseUrl,
      apiKey: env.anthropicKey,
      models: env.anthropicModels,
      defaultModel: env.anthropicModel,
      maxTokens: env.anthropicMaxTokens,
    });
  }

  if (env.deepseekKey) {
    list.push({
      id: 'deepseek',
      label: 'DeepSeek',
      kind: 'openai',
      baseUrl: env.deepseekBaseUrl,
      apiKey: env.deepseekKey,
      models: env.deepseekModels,
      defaultModel: env.deepseekModel,
    });
  }

  if (env.openrouterKey) {
    list.push({
      id: 'openrouter',
      label: 'OpenRouter',
      kind: 'openai',
      baseUrl: env.openrouterBaseUrl,
      apiKey: env.openrouterKey,
      models: env.openrouterModels,
      defaultModel: env.openrouterModel,
    });
  }

  if (env.openAiCompatBaseUrl) {
    list.push({
      id: env.openAiCompatId,
      label: env.openAiCompatLabel,
      kind: 'openai',
      baseUrl: env.openAiCompatBaseUrl,
      apiKey: env.openAiCompatKey,
      models: env.openAiCompatModels,
      defaultModel: env.openAiCompatModel,
    });
  }

  if (env.xaiKey) {
    list.push({
      id: 'xai',
      label: 'Grok (xAI)',
      kind: 'xai',
      baseUrl: env.xaiBaseUrl,
      apiKey: env.xaiKey,
      models: [env.xaiModel],
      defaultModel: env.xaiModel,
      builtInSearch: env.xaiBuiltInSearch,
    });
  }

  // Anything the user added by hand wins over a built-in with the same id.
  const extras = extraProfiles();
  for (const p of extras) {
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p;
    else list.push(p);
  }

  return list;
}

export function profileById(id: string): ProviderProfile | undefined {
  return profiles().find((p) => p.id === id);
}
