import { assistantMessageItem, functionCallItem, toOpenAIMessages, toIr } from './translate.js';
import { sseEvents } from './sse.js';
import { ProviderError, type LLMProvider, type ProviderCall, type ProviderEvent } from './types.js';

export interface OpenAiCompatConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  /** Some servers reject an Authorization header when there is no key. */
  sendAuth?: boolean;
}

/**
 * Any server that speaks the OpenAI Chat Completions API: OpenAI itself,
 * OpenRouter, MiniMax's native endpoint, Ollama, LM Studio, vLLM, llama.cpp.
 */
export function openAiCompatProvider(cfg: OpenAiCompatConfig): LLMProvider {
  return {
    id: cfg.id,
    label: cfg.label,
    models: cfg.models,
    available: () => !!cfg.baseUrl,

    async *stream(call: ProviderCall): AsyncGenerator<ProviderEvent> {
      const ir = toIr(call.items);
      const messages = toOpenAIMessages(ir);
      const body: any = {
        model: call.model || cfg.defaultModel,
        messages: [{ role: 'system', content: call.system }, ...messages],
        stream: true,
        stream_options: { include_usage: true },
      };
      if (call.tools.length) {
        body.tools = call.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } },
        }));
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey && cfg.sendAuth !== false) headers.authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: call.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(`${cfg.label} returned ${res.status}: ${text.slice(0, 400)}`, res.status, text);
      }

      let text = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
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
        if (ev.usage) {
          inputTokens = ev.usage.prompt_tokens ?? inputTokens;
          outputTokens = ev.usage.completion_tokens ?? outputTokens;
        }
        const delta = ev.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          yield { kind: 'text', delta: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }

      const items: any[] = [];
      if (text.trim()) items.push(assistantMessageItem(text));
      for (const c of calls.values()) items.push(functionCallItem(c.id || `call_${Math.random().toString(36).slice(2, 10)}`, c.name, c.args || '{}'));
      if (inputTokens || outputTokens) yield { kind: 'usage', inputTokens, outputTokens };
      yield { kind: 'finished', items };
    },
  };
}
