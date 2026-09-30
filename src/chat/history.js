/**
 * Repair incomplete batches left by a stopped process. Unknown outcomes are
 * never labelled successful (or safe to retry). No tool is re-executed here.
 */
export function repairToolHistory(messages) {
  const out = [];
  let pending = new Set();
  const close = () => {
    for (const id of pending) out.push({
      role: 'tool', tool_call_id: id,
      content: 'Error: no result was recorded for this call. Its execution outcome is unknown; verify external state before retrying a write.'
    });
    pending = new Set();
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.has(message.tool_call_id)) throw new Error('Invalid history: orphan or duplicate tool result.');
      pending.delete(message.tool_call_id);
      out.push(message);
      continue;
    }
    close();
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        if (!call.id || pending.has(call.id)) throw new Error('Invalid history: missing or duplicate tool call ID.');
        pending.add(call.id);
      }
    }
    out.push(message);
  }
  close();
  return out;
}
