// Loose by nature: each frame is whatever JSON the server sent.
export type Frame = { type: string, [field: string]: any };

/** The `data:` frames of a server-sent event stream, parsed. */
export async function* events(res: Response): AsyncGenerator<Frame> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith('data:')) yield JSON.parse(line.slice(5));
    }
  }
}
