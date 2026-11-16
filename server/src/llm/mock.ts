import { assistantMessageItem, functionCallItem, toIr } from './translate.js';
import type { LLMProvider, ProviderCall, ProviderEvent } from './types.js';

/**
 * A local provider that needs no credentials. It answers with a scripted reply
 * and can be told to call one tool, which makes the whole pipeline (thread ->
 * tool -> approval -> response) testable offline and in CI.
 *
 * Set LLM_PROVIDER=mock, or leave it on for a machine without API keys.
 */
export function mockProvider(): LLMProvider {
  return {
    id: 'mock',
    label: 'Mock (offline)',
    models: ['mock'],
    available: () => true,

    async *stream(call: ProviderCall): AsyncGenerator<ProviderEvent> {
      const last = [...toIr(call.items)].reverse().find((i) => i.kind === 'user' || i.kind === 'assistant');
      const prompt = last && (last.kind === 'user' ? last.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('') : last.text);

      // If the model was asked to call a tool, do it once.
      const wantsTool = /call (?:the )?tool/i.test(prompt ?? '') && call.tools.some((t) => t.name === 'echo');
      if (wantsTool) {
        const tool = call.tools.find((t) => t.name === 'echo')!;
        yield { kind: 'tool_call', callId: 'mock_call_1', name: tool.name, argsJson: JSON.stringify({ text: 'hello from the mock provider' }) };
        yield { kind: 'finished', items: [functionCallItem('mock_call_1', tool.name, JSON.stringify({ text: 'hello from the mock provider' }))] };
        return;
      }

      const reply = `Mock provider reply. I received ${(prompt ?? '').length} characters and ${call.items.length} history items.`;
      for (const chunk of reply.match(/.{1,24}/gs) ?? [reply]) {
        yield { kind: 'text', delta: chunk };
        await new Promise((r) => setTimeout(r, 15));
      }
      yield { kind: 'usage', inputTokens: Math.ceil((prompt ?? '').length / 4), outputTokens: 12 };
      yield { kind: 'finished', items: [assistantMessageItem(reply)] };
    },
  };
}
