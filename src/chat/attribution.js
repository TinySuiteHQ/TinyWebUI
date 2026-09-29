// Counts only: never retain another copy of prompts, schemas or tool output.
// The char/4 estimator matches compact.js; it is not provider tokenization.
const estimate = (value) => Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / 4);
const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const bucket = (category, tokens, source = 'estimated', capability = null) => ({ category, tokens, source, ...(capability ? { capability } : {}) });
const sum = (buckets) => buckets.reduce((n, b) => n + b.tokens, 0);
const text = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((p) => p.type === 'text').map((p) => p.text || '').join('') : '';

export function attributeRequest(body, { systemParts = [], owner = () => 'built-ins' } = {}) {
  const buckets = [];
  const add = (category, value, capability) => {
    if (value) buckets.push(bucket(category, estimate(value), 'estimated', capability));
  };
  let systemAttributed = false;
  for (const message of body.messages || []) {
    if (message.role === 'system') {
      const actual = text(message.content);
      if (!systemAttributed && actual === systemParts.map((p) => p.text).filter(Boolean).join('\n\n')) {
        for (const part of systemParts) add(part.category, part.text, part.capability);
        systemAttributed = true;
      } else add('system_other', actual);
      continue;
    }
    const category = message.role === 'user' ? 'user_messages'
      : message.role === 'tool' ? 'tool_results' : 'assistant_history';
    add(category, text(message.content));
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'image_url') buckets.push(bucket('image_allowance', 1500));
      else if (part.type !== 'text') add('attachments_other', part);
    }
    if (message.tool_calls) add('tool_history', message.tool_calls);
    if (message.reasoning_details) add('reasoning_history', message.reasoning_details);
    if (message.reasoning_content) add('reasoning_history', message.reasoning_content);
  }
  for (const tool of body.tools || []) add('tool_schemas', tool, owner(tool.function?.name));
  const compact = new Map();
  for (const b of buckets) {
    const key = JSON.stringify([b.category, b.source, b.capability]);
    const entry = compact.get(key) || { ...b, tokens: 0 };
    entry.tokens += b.tokens;
    compact.set(key, entry);
  }
  return { buckets: [...compact.values()], estimatedTotal: sum(buckets) };
}

function reconcile(buckets, total) {
  return { total, source: total === null ? 'unreported' : 'provider', buckets: total === null ? buckets
    : [...buckets, bucket('provider_delta', total - sum(buckets), 'estimated')] };
}

export function completeAttribution(input, usage, { content = '', reasoning = '', toolCalls = [], details = [] } = {}) {
  const output = [];
  const reportedReasoning = count(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens);
  if (reportedReasoning !== null) output.push(bucket('reasoning', reportedReasoning, 'provider'));
  else {
    const visibleReasoning = reasoning || details.map((d) => d.text || d.summary || '').join('');
    if (visibleReasoning) output.push(bucket('reasoning', estimate(visibleReasoning)));
  }
  if (toolCalls.length) output.push(bucket('tool_generation', estimate(toolCalls.map((c) => c.function))));
  if (content) output.push(bucket('intermediate_text', estimate(content)));
  return {
    version: 1, estimator: 'characters/4; images 1500 tokens each',
    input: reconcile(input.buckets, count(usage?.prompt_tokens ?? usage?.input_tokens)),
    output: reconcile(output, count(usage?.completion_tokens ?? usage?.output_tokens)),
    cached: count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? usage?.cached_tokens)
  };
}

export function markFinal(attribution) {
  return { ...attribution, output: { ...attribution.output, buckets: attribution.output.buckets.map((b) =>
    b.category === 'intermediate_text' ? { ...b, category: 'final_text' } : b) } };
}
