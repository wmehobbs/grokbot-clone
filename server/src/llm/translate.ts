/**
 * Translation between the canonical transcript (Responses-style items, what the
 * database stores) and the message shapes each provider expects.
 *
 * The canonical format is kept as the single source of truth so a Bot can be
 * switched from Grok to MiniMax (or to a local model) without rewriting history.
 */

export interface ToolCallIr {
  id: string;
  name: string;
  args: string;
}

export type Ir =
  | { kind: 'user'; blocks: ContentBlock[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_calls'; calls: ToolCallIr[] }
  | { kind: 'tool_results'; results: { id: string; blocks: ContentBlock[] }[] };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string };

/** Pull plain text out of a canonical content value (string or content-part array). */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (typeof c === 'string' ? c : (c?.text ?? c?.content ?? '')))
    .filter((t: any) => typeof t === 'string')
    .join('\n');
}

/** Pull text and image blocks out of a canonical content value. */
export function contentToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const c of content as any[]) {
    if (typeof c === 'string') {
      if (c) blocks.push({ type: 'text', text: c });
      continue;
    }
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
      const text = String(c.text ?? '');
      if (text) blocks.push({ type: 'text', text });
    } else if (c.type === 'input_image') {
      const url = typeof c.image_url === 'string' ? c.image_url : (c.image_url?.url ?? c.url ?? '');
      if (url) blocks.push({ type: 'image', url: String(url) });
    }
  }
  return blocks;
}

/**
 * Canonical items -> a provider-neutral conversation.
 * System items are dropped (the caller passes the system prompt separately).
 */
export function toIr(items: any[]): Ir[] {
  const out: Ir[] = [];
  for (const it of items ?? []) {
    if (!it || typeof it !== 'object') continue;

    if (it.type === 'function_call') {
      out.push({ kind: 'tool_calls', calls: [{ id: String(it.call_id ?? ''), name: String(it.name ?? ''), args: String(it.arguments ?? '{}') }] });
      continue;
    }
    if (it.type === 'function_call_output') {
      const blocks = contentToBlocks(it.output);
      out.push({ kind: 'tool_results', results: [{ id: String(it.call_id ?? ''), blocks: blocks.length ? blocks : [{ type: 'text', text: String(it.output ?? '') }] }] });
      continue;
    }
    if (it.type === 'reasoning') continue; // encrypted reasoning is xAI-only
    if (it.type === 'message' || it.role) {
      const role = it.role ?? (it.type === 'message' ? 'assistant' : 'user');
      if (role === 'system') continue;
      if (role === 'assistant') {
        const text = contentToText(it.content);
        if (text) out.push({ kind: 'assistant', text });
      } else {
        const blocks = contentToBlocks(it.content);
        if (blocks.length) out.push({ kind: 'user', blocks });
      }
    }
  }
  return out;
}

/** Group consecutive tool calls / tool results so each provider sees valid turns. */
function group(ir: Ir[]): Ir[] {
  const out: Ir[] = [];
  for (const item of ir) {
    const last = out[out.length - 1];
    if (item.kind === 'tool_calls' && last?.kind === 'tool_calls') {
      last.calls.push(...item.calls);
      continue;
    }
    if (item.kind === 'tool_results' && last?.kind === 'tool_results') {
      last.results.push(...item.results);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Anthropic Messages API shape. */
export function toAnthropicMessages(ir: Ir[]): { role: 'user' | 'assistant'; content: any }[] {
  const messages: { role: 'user' | 'assistant'; content: any }[] = [];
  for (const item of group(ir)) {
    if (item.kind === 'user') {
      messages.push({ role: 'user', content: item.blocks.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image', source: { type: 'url', url: b.url } })) });
    } else if (item.kind === 'assistant') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: item.text }] });
    } else if (item.kind === 'tool_calls') {
      messages.push({
        role: 'assistant',
        content: item.calls.map((c) => ({ type: 'tool_use', id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, input: safeJson(c.args) })),
      });
    } else if (item.kind === 'tool_results') {
      messages.push({
        role: 'user',
        content: item.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.blocks.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image', source: { type: 'url', url: b.url } })),
        })),
      });
    }
  }
  // Anthropic requires the first message to be from the user.
  while (messages.length && messages[0].role === 'assistant') messages.shift();
  return messages;
}

/** OpenAI Chat Completions shape. */
export function toOpenAIMessages(ir: Ir[]): { role: string; content: any; tool_calls?: any[]; tool_call_id?: string }[] {
  const messages: { role: string; content: any; tool_calls?: any[]; tool_call_id?: string }[] = [];
  for (const item of group(ir)) {
    if (item.kind === 'user') {
      messages.push({ role: 'user', content: item.blocks.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image_url', image_url: { url: b.url } })) });
    } else if (item.kind === 'assistant') {
      messages.push({ role: 'assistant', content: item.text });
    } else if (item.kind === 'tool_calls') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: item.calls.map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      });
    } else if (item.kind === 'tool_results') {
      for (const r of item.results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.blocks.map((b) => (b.type === 'text' ? b.text : b.url)).join('\n') });
      }
    }
  }
  return messages;
}

export function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Canonical assistant text item, matching what the xAI path already stored. */
export function assistantMessageItem(text: string) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/** Canonical function call item, matching what the xAI path already stored. */
export function functionCallItem(callId: string, name: string, argsJson: string) {
  return { type: 'function_call', call_id: callId, name, arguments: argsJson };
}
