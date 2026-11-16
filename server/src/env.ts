import { fileURLToPath } from 'node:url';

function opt(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}

function req(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const v = opt(name);
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const minimaxModels = list('MINIMAX_MODELS', ['MiniMax-M3', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2']);
const anthropicModels = list('ANTHROPIC_MODELS', ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']);
const deepseekModels = list('DEEPSEEK_MODELS', ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash']);
const openrouterModels = list('OPENROUTER_MODELS', ['minimax/minimax-m2', 'deepseek/deepseek-chat', 'xiaomi/mimo-v2-flash']);
const openAiCompatModels = list('OPENAI_COMPATIBLE_MODELS', ['local-model']);

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  sessionSecret: opt('SESSION_SECRET') ?? 'dev-secret-change-me',
  devLogin: process.env.DEV_LOGIN === '1',

  // fileURLToPath, not URL.pathname: on Windows pathname turns /E:/... into a broken path.
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../../data/guild.db', import.meta.url)),

  // ---------- model providers ----------
  /** Which provider a Bot uses when it has no override of its own. */
  llmProvider: opt('LLM_PROVIDER') ?? '',

  minimaxKey: opt('MINIMAX_API_KEY'),
  minimaxBaseUrl: opt('MINIMAX_BASE_URL') ?? 'https://api.minimax.io/anthropic/v1',
  minimaxModels,
  minimaxModel: opt('MINIMAX_MODEL') ?? minimaxModels[0],
  minimaxMaxTokens: num('MINIMAX_MAX_TOKENS', 32_000),

  anthropicKey: opt('ANTHROPIC_API_KEY'),
  anthropicBaseUrl: opt('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1',
  anthropicModels,
  anthropicModel: opt('ANTHROPIC_MODEL') ?? anthropicModels[0],
  anthropicMaxTokens: num('ANTHROPIC_MAX_TOKENS', 16_000),

  openAiCompatId: opt('OPENAI_COMPATIBLE_ID') ?? 'local',
  openAiCompatLabel: opt('OPENAI_COMPATIBLE_LABEL') ?? 'OpenAI-compatible',
  openAiCompatBaseUrl: opt('OPENAI_COMPATIBLE_BASE_URL') ?? '',
  openAiCompatKey: opt('OPENAI_COMPATIBLE_API_KEY') ?? '',
  openAiCompatModels,
  openAiCompatModel: opt('OPENAI_COMPATIBLE_MODEL') ?? openAiCompatModels[0],

  xaiKey: opt('XAI_API_KEY'),
  xaiBaseUrl: opt('XAI_BASE_URL') ?? 'https://api.x.ai/v1',
  xaiModel: opt('XAI_MODEL') ?? 'grok-4.7',
  xaiBuiltInSearch: process.env.XAI_BUILTIN_SEARCH !== '0',

  deepseekKey: opt('DEEPSEEK_API_KEY'),
  deepseekBaseUrl: opt('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1',
  deepseekModels,
  deepseekModel: opt('DEEPSEEK_MODEL') ?? deepseekModels[0],

  openrouterKey: opt('OPENROUTER_API_KEY'),
  openrouterBaseUrl: opt('OPENROUTER_BASE_URL') ?? 'https://openrouter.ai/api/v1',
  openrouterModels,
  openrouterModel: opt('OPENROUTER_MODEL') ?? openrouterModels[0],

  /**
   * Any other API, as JSON. Each entry becomes a profile a Bot can be pointed at:
   *   PROVIDERS_JSON=[{"id":"mimo","label":"MiMo","kind":"openai",
   *     "baseUrl":"https://api.xiaomimimo.com/v1","apiKey":"sk-...",
   *     "models":["mimo-v2-flash"],"defaultModel":"mimo-v2-flash"}]
   */
  providerProfilesJson: opt('PROVIDERS_JSON'),

  /** Allow the offline mock provider even when real ones are configured. */
  allowMock: process.env.HIVE_ALLOW_MOCK === '1',

  // ---------- external services (all optional) ----------
  composioKey: opt('COMPOSIO_API_KEY'),
  orgoKey: opt('ORGO_API_KEY'),
  /** Orgo workspace that holds every user's box. */
  orgoWorkspaceId: process.env.ORGO_WORKSPACE_ID ?? '',
  /** Orgo box size for new users. */
  orgoRamGb: num('ORGO_RAM_GB', 8),
  orgoCpu: num('ORGO_CPU', 2),
  orgoResolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',

  // ---------- local machine ----------
  /** Folders bots may touch on this machine when running locally. */
  localRoots: list('LOCAL_ROOTS', []),
  /** Shared token for remote machines to register with this server. */
  machineToken: opt('MACHINE_TOKEN') ?? '',
  /**
   * A folder that syncs through the cloud (Google Drive for Desktop, OneDrive,
   * Dropbox, Syncthing...). Bots push and pull their workspace through it, which
   * is how work moves from one computer to another.
   */
  cloudRoot: opt('CLOUD_ROOT') ?? '',
};

/** The default model for a provider id. */
export function modelFor(providerId: string): string | undefined {
  switch (providerId) {
    case 'minimax':
      return env.minimaxModel;
    case 'anthropic':
      return env.anthropicModel;
    case 'deepseek':
      return env.deepseekModel;
    case 'openrouter':
      return env.openrouterModel;
    case 'xai':
      return env.xaiModel;
    case env.openAiCompatId:
      return env.openAiCompatModel;
    default:
      return undefined;
  }
}
