/** Result sent for a call the transcript has no answer to. */
export const UNKNOWN_OUTCOME = 'Error: no result was recorded for this call (the run ended while it was'
  + ' pending). Whether it ran is unknown; check the current state before repeating anything that writes.';

/**
 * Makes stored history valid for a provider: every tool call answered right
 * after the assistant turn that made it, and no result without its call. A run
 * killed mid-batch (crash, restart) leaves calls unanswered, and most providers
 * reject the whole request over one. Missing answers say the outcome is unknown,
 * never that the call failed, since a write may have gone through. Results
 * whose call is not there (an old window cut, a hand-edited row) are dropped
 * rather than failing every later turn of the chat.
 *
 * Returns the input array itself when nothing needed changing, so callers can
 * tell a repair happened and the common path allocates nothing.
 */
export function repairToolHistory(messages) {
  let out = null;
  let pending = [];
  const close = (i) => {
    if (!pending.length) return;
    out ??= messages.slice(0, i);
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: UNKNOWN_OUTCOME });
    pending = [];
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      const at = pending.indexOf(m.tool_call_id);
      if (at === -1) { out ??= messages.slice(0, i); continue; }
      pending.splice(at, 1);
    } else {
      close(i);
      pending = (m.tool_calls || []).map((c) => c.id);
    }
    out?.push(m);
  }
  close(messages.length);
  return out ?? messages;
}
