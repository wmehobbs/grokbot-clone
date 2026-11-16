/** Minimal Server-Sent Events reader shared by the streaming providers. */
export async function* sseEvents(response: Response): AsyncGenerator<{ data: string; event: string }> {
  const body = response.body;
  if (!body) throw new Error('provider returned no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line === '') {
        eventName = '';
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        yield { data: line.slice(5).replace(/^ /, ''), event: eventName };
      }
    }
  }
}
