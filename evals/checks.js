/**
 * The checks a task can make on one run. Deterministic wherever the question
 * allows it -- a regex on the answer, a count of calls -- because a check that
 * is itself noisy makes a pass rate meaningless. `judge` is the exception, for
 * the questions no regex can answer ("did it admit what it could not find?"),
 * and it asks the configured model for a strict PASS/FAIL.
 *
 * Every check returns { ok, detail }.
 */

const re = (p) => new RegExp(p, 'is');

function argsMatch(call, want = {}) {
  return Object.entries(want).every(([key, pattern]) => {
    const v = call.args?.[key];
    return re(pattern).test(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  });
}

/** Today's date in the forms a model is likely to write it. */
function todayPatterns(timeZone) {
  const now = new Date();
  const part = (opts) => new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(now);
  const year = part({ year: 'numeric' });
  const month = part({ month: 'long' });
  const mm = part({ month: '2-digit' });
  const day = String(Number(part({ day: 'numeric' })));
  const dd = part({ day: '2-digit' });
  return [
    `${year}-${mm}-${dd}`,
    `${month}\\s+${day}(st|nd|rd|th)?,?\\s+${year}`,
    `${day}(st|nd|rd|th)?\\s+(of\\s+)?${month},?\\s+${year}`,
    `${dd}[./]${mm}[./]${year}`,
    `${mm}/${dd}/${year}`
  ];
}

async function judge(rubric, run, cfg) {
  const transcript = [
    `Tool calls made: ${run.calls.length ? run.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join('; ') : 'none'}`,
    '',
    'Final answer:',
    run.answer || '(empty)'
  ].join('\n');
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: cfg.judgeModel || cfg.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You grade an AI assistant\'s behaviour against one criterion. Be strict and literal.'
            + ' Reply with PASS or FAIL on the first line, then one sentence of reason.'
        },
        { role: 'user', content: `Criterion: ${rubric}\n\n${transcript}` }
      ]
    })
  });
  if (!res.ok) return { ok: false, detail: `judge request failed: ${res.status}` };
  const text = (await res.json()).choices?.[0]?.message?.content?.trim() || '';
  return { ok: /^\**PASS/i.test(text), detail: text.split('\n').slice(0, 2).join(' ') };
}

export async function check(c, run, cfg) {
  const calls = c.tool && c.tool !== '*' ? run.calls.filter((x) => x.name === c.tool) : run.calls;
  switch (c.type) {
    case 'answer_matches':
      return { ok: re(c.pattern).test(run.answer), detail: `/${c.pattern}/ not in answer` };
    case 'answer_not_matches':
      return { ok: !re(c.pattern).test(run.answer), detail: `/${c.pattern}/ found in answer` };
    case 'mentions_today': {
      const tz = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const ok = todayPatterns(tz).some((p) => re(p).test(run.answer));
      return { ok, detail: 'today\'s date not in answer' };
    }
    case 'called': {
      const hits = calls.filter((x) => argsMatch(x, c.args));
      const min = c.min ?? 1;
      const max = c.max ?? Infinity;
      return {
        ok: hits.length >= min && hits.length <= max,
        detail: `${c.tool}${c.args ? ` ${JSON.stringify(c.args)}` : ''} called ${hits.length}×, wanted ${min}${max === Infinity ? '+' : `–${max}`}`
      };
    }
    case 'not_called':
      return { ok: calls.length === 0, detail: `${c.tool} called ${calls.length}×` };
    case 'max_rounds':
      return { ok: run.rounds <= c.value, detail: `${run.rounds} rounds > ${c.value}` };
    case 'max_calls':
      return { ok: calls.length <= c.value, detail: `${calls.length} calls > ${c.value}` };
    case 'asked':
      return { ok: run.asked.includes(c.tool), detail: `no approval asked for ${c.tool}` };
    case 'not_asked':
      return { ok: !run.asked.includes(c.tool), detail: `approval asked for ${c.tool}` };
    case 'judge':
      return judge(c.rubric, run, cfg);
    default:
      return { ok: false, detail: `unknown check type "${c.type}"` };
  }
}
