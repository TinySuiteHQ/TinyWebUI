import { CronExpressionParser } from 'cron-parser';

export function validateSchedule(cron, timezone, now = Date.now()) {
  const tz = String(timezone || '').trim();
  if (!tz) throw new Error('timezone is required');
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
  catch { throw new Error(`invalid IANA timezone: ${tz}`); }
  let nextRunAt;
  try {
    nextRunAt = CronExpressionParser.parse(String(cron || ''), {
      currentDate: new Date(now), tz
    }).next().getTime();
  } catch (err) {
    throw new Error(`invalid cron schedule: ${err.message}`);
  }
  return { cron: String(cron).trim(), timezone: tz, nextRunAt };
}

function cleanFields(input, { requireAll = false } = {}) {
  const fields = {};
  for (const key of ['name', 'prompt']) {
    if (input[key] === undefined && !requireAll) continue;
    const val = String(input[key] ?? '').trim();
    if (!val) throw new Error(`${key} is required`);
    if (val.length > (key === 'prompt' ? 12000 : 120)) throw new Error(`${key} is too long`);
    fields[key] = val;
  }
  if (requireAll || (input.cron !== undefined && input.timezone !== undefined)) {
    const cron = input.cron ?? '';
    const timezone = input.timezone ?? '';
    Object.assign(fields, validateSchedule(cron, timezone));
  }
  if (input.enabled !== undefined) fields.enabled = Boolean(input.enabled);
  return fields;
}

export function automationToolDef() {
  return {
    type: 'function',
    function: {
      name: 'manage_automation',
      description: 'List, create, update, delete, or trigger scheduled automations. Create binds to the current chat and activates immediately. Trigger runs one workflow now; if its target chat is busy, it queues until that chat is free.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'trigger'] },
          id: { type: 'string', description: 'Automation id for update/delete/trigger.' },
          name: { type: 'string' }, prompt: { type: 'string' },
          cron: { type: 'string', description: 'Five-field cron expression.' },
          timezone: { type: 'string', description: 'IANA timezone, such as Europe/Berlin.' },
          enabled: { type: 'boolean' }
        },
        required: ['action']
      }
    }
  };
}

export async function manageAutomation(args, { store, chatId, triggerAutomation, unattended = false } = {}) {
  const action = String(args?.action || '');
  // A scheduled run has nobody watching it. Letting it start more runs is how
  // one trigger becomes an endless self-requeueing loop, and how text injected
  // through a tool result turns into a standing schedule. Adjusting or removing
  // an existing automation stays allowed -- "stop once X is done" is legitimate.
  if (unattended && (action === 'create' || action === 'trigger')) {
    return `Error: "${action}" is not available inside a scheduled run. Tell the user in your result if a new automation or run is needed.`;
  }
  const chat = chatId ? store.getChat(chatId) : null;
  const userId = chat?.user_id ?? null;
  if (action === 'list') return JSON.stringify(store.listAutomations(userId));
  if (action === 'create') {
    if (!chat) throw new Error('automation creation requires a current chat');
    const fields = cleanFields(args, { requireAll: true });
    const row = store.createAutomation({ ...fields, chatId, source: 'model' }, userId);
    return JSON.stringify(row);
  }
  if (!args?.id) throw new Error('id is required');
  if (action === 'delete') return store.deleteAutomation(args.id, userId)
    ? `Deleted automation ${args.id}.` : 'Error: no such automation';
  if (action === 'trigger') {
    const automation = store.getAutomation(args.id, userId);
    if (!automation) throw new Error('no such automation');
    if (!triggerAutomation) throw new Error('manual triggering is unavailable');
    return JSON.stringify(await triggerAutomation(automation, userId));
  }
  if (action === 'update') {
    const current = store.getAutomation(args.id, userId);
    if (!current) throw new Error('no such automation');
    const fields = cleanFields(args);
    if (args.cron !== undefined || args.timezone !== undefined) {
      Object.assign(fields, validateSchedule(fields.cron ?? current.cron, fields.timezone ?? current.timezone));
    }
    const row = store.updateAutomation(args.id, fields, userId);
    return row ? JSON.stringify(row) : 'Error: no such automation';
  }
  throw new Error('action must be list, create, update, delete, or trigger');
}

export function nextSchedule(cron, timezone, now = Date.now()) {
  return validateSchedule(cron, timezone, now).nextRunAt;
}

export function runMessage(automation) {
  const previous = automation.lastResult
    ? `\n\nPrevious run result (truncated):\n${automation.lastResult.slice(0, 2000)}` : '';
  return [
    `[Scheduled automation: ${automation.name}]`,
    `Schedule: ${automation.cron} (${automation.timezone})`,
    // Without this the model reads an ordinary user turn and may stop to ask a
    // clarifying question that nobody will ever answer.
    'This is an unattended run: no one is present to answer questions. Complete the task'
      + ' with sensible assumptions and state them, or report exactly what blocked it.',
    '',
    automation.prompt
  ].join('\n') + previous;
}
