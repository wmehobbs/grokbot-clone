import { assistantMessageItem, functionCallItem, toAnthropicMessages, toIr } from './translate.js';
import { sseEvents } from './sse.js';
import { ProviderError, type LLMProvider, type ProviderCall, type ProviderEvent } from './types.js';

export interface AnthropicConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  maxTokens: number;
}

/**
 * Any server that speaks the Anthropic Messages API: Anthropic itself, MiniMax's
 * Anthropic-compatible endpoint, or a self-hosted gateway.
 */
export function anthropicProvider(cfg: AnthropicConfig): LLMProvider {
  return {
    id: cfg.id,
    label: cfg.label,
    models: cfg.models,
    available: () => !!cfg.apiKey,

    async *stream(call: ProviderCall): AsyncGenerator<ProviderEvent> {
      const ir = toIr(call.items);
      const messages = toAnthropicMessages(ir);
      const body: any = {
        model: call.model || cfg.defaultModel,
        max_tokens: cfg.maxTokens,
        system: call.system,
        messages,
        stream: true,
      };
      if (call.tools.length) {
        body.tools = call.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters ?? { type: 'object', properties: {} },
        }));
      }

      const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          authorization: `Bearer ${cfg.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: call.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(`${cfg.label} returned ${res.status}: ${text.slice(0, 400)}`, res.status, text);
      }

      let text = '';
      const blocks = new Map<number, { id: string; name: string; args: string }>();
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const { data } of sseEvents(res)) {
        if (!data || data === '[DONE]') continue;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case 'message_start':
            inputTokens = ev.message?.usage?.input_tokens ?? 0;
            break;
          case 'content_block_start': {
            const cb = ev.content_block;
            if (cb?.type === 'tool_use') blocks.set(ev.index, { id: cb.id ?? '', name: cb.name ?? '', args: '' });
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta;
            if (d?.type === 'text_delta' && typeof d.text === 'string') {
              text += d.text;
              yield { kind: 'text', delta: d.text };
            } else if (d?.type === 'input_json_delta') {
              const b = blocks.get(ev.index);
              if (b) b.args += d.partial_json ?? '';
            }
            break;
          }
          case 'message_delta':
            outputTokens = ev.usage?.output_tokens ?? outputTokens;
            break;
          case 'error':
            throw new ProviderError(ev.error?.message ?? 'provider error');
        }
      }

      const items: any[] = [];
      if (text.trim()) items.push(assistantMessageItem(text));
      for (const b of blocks.values()) items.push(functionCallItem(b.id, b.name, b.args || '{}'));
      if (inputTokens || outputTokens) yield { kind: 'usage', inputTokens, outputTokens };
      yield { kind: 'finished', items };
    },
  };
}
