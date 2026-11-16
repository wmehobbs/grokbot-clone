/**
 * Provider-neutral model interface.
 *
 * The agent loop used to speak xAI's Responses API directly. It now talks to this
 * interface instead, so a Bot can run on Grok, MiniMax, Anthropic, or any
 * OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenRouter) without the rest
 * of the app knowing which one it is.
 *
 * The canonical transcript format stays the Responses-style item list that the
 * database already holds (`llm_items`), so existing conversations keep working
 * and switching a Bot's provider mid-conversation does not lose history.
 */

/** Which API shape a provider speaks. */
export type ProviderKind = 'anthropic' | 'openai' | 'xai' | 'mock';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

/** A function tool, in the flat shape the app already uses internally. */
export interface ToolSpec {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ProviderCall {
  model: string;
  /** The system prompt, already assembled by the app. */
  system: string;
  /** Canonical (Responses-style) conversation items, oldest first. */
  items: any[];
  tools: ToolSpec[];
  /** 'low' | 'medium' | 'high' - mapped to whatever the provider calls it. */
  effort?: string;
  /** Provider-specific caching hints (xAI prompt cache key). */
  promptCacheKey?: string;
  /** Provider-specific safety identifier (xAI). */
  safetyIdentifier?: string;
  signal: AbortSignal;
}

export type ProviderEvent =
  /** A piece of assistant text. */
  | { kind: 'text'; delta: string }
  /** A tool the model wants to run. */
  | { kind: 'tool_call'; callId: string; name: string; argsJson: string }
  /** Token accounting, when the provider reports it. */
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  /** The model started searching the web / another surface. */
  | { kind: 'activity'; activity: string; detail?: string }
  /** The turn is over; `items` are canonical items to append to the transcript. */
  | { kind: 'finished'; items: any[] };

export interface LLMProvider {
  id: string;
  label: string;
  /** Models this provider can serve, for the settings UI. */
  models: string[];
  /** True when the provider has the credentials it needs. */
  available(): boolean;
  /** Stream one assistant turn. */
  stream(call: ProviderCall): AsyncGenerator<ProviderEvent>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
