import OpenAI from 'openai';
import { ProviderError, type LLMProvider, type ProviderCall, type ProviderEvent, type ToolSpec } from './types.js';

export interface XaiConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /** xAI's hosted web search / X search, used as built-in tools. */
  builtInSearch: boolean;
}

/**
 * Grok through xAI's Responses API. This is the provider the app originally used,
 * kept intact: it carries reasoning effort, encrypted reasoning items, prompt
 * caching and the hosted search tools that only xAI offers.
 */
export function xaiProvider(cfg: XaiConfig): LLMProvider {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, timeout: 360_000 });

  return {
    id: 'xai',
    label: 'Grok (xAI)',
    models: [cfg.defaultModel],
    available: () => !!cfg.apiKey,

    async *stream(call: ProviderCall): AsyncGenerator<ProviderEvent> {
      const tools: any[] = call.tools.map((t: ToolSpec) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
      if (cfg.builtInSearch) tools.push({ type: 'web_search' }, { type: 'x_search' });

      const body: any = {
        model: call.model || cfg.defaultModel,
        input: [{ role: 'system', content: call.system }, ...call.items],
        tools,
        reasoning: { effort: call.effort ?? 'medium' },
        store: false,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: call.promptCacheKey,
        safety_identifier: call.safetyIdentifier,
        stream: true,
      };

      let stream: any;
      try {
        stream = await client.responses.create(body, { signal: call.signal });
      } catch (e: any) {
        throw new ProviderError(e?.message ?? 'xAI request failed', e?.status);
      }

      let final: any = null;
      for await (const ev of stream as AsyncIterable<any>) {
        switch (ev.type) {
          case 'response.output_text.delta':
            yield { kind: 'text', delta: ev.delta };
            break;
          case 'response.output_item.added':
            if (ev.item?.type === 'web_search_call') yield { kind: 'activity', activity: 'searching_web' };
            else if (ev.item?.type === 'x_search_call') yield { kind: 'activity', activity: 'searching_web', detail: 'X' };
            else if (ev.item?.type === 'message') yield { kind: 'activity', activity: 'working' };
            break;
          case 'response.output_item.done':
            if (ev.item?.type === 'function_call') {
              yield { kind: 'tool_call', callId: ev.item.call_id, name: ev.item.name, argsJson: ev.item.arguments ?? '{}' };
            }
            break;
          case 'response.completed':
          case 'response.incomplete':
            final = ev.response;
            break;
          case 'response.failed':
          case 'error':
            throw new ProviderError(ev.response?.error?.message ?? ev.message ?? 'model error');
        }
      }

      if (!final) throw new ProviderError('model stream ended without a response');
      if (final.usage?.input_tokens) yield { kind: 'usage', inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens ?? 0 };
      yield { kind: 'finished', items: final.output ?? [] };
    },
  };
}
