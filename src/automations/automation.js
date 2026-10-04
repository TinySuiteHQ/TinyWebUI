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
      description: [
        'Manage scheduled automations: a prompt that runs on its own, on a cron schedule, in this chat.',
        'Use it when the user wants something done repeatedly or later without them ("every morning',
        'summarise...", "check X each Friday"). For steps of the current request use manage_tasks instead.',
        '',
        'Each run starts fresh: it sees only its own prompt and the previous run\'s result, not this',
        'conversation, and nobody is there to answer questions. Write `prompt` so it stands alone:',
        'what to do, where, and what to report.',
        '',
        'Actions and what each needs:',
        '- list: nothing. Returns every automation with its id, schedule and last result.',
        '- create: name, prompt, cron, timezone. Starts running on schedule immediately.',
        '- update: id, plus only the fields to change. cron and timezone are checked together.',
        '- delete: id. Permanent.',
        '- trigger: id. Runs it once now; queued if the chat is busy.',
        '',
        'An automation keeps running until someone stops it, so before create or delete, make sure',
        'the user asked for exactly that (schedule, timezone, what it does). If any of those is unclear,',
        'ask first. Pausing is update with enabled=false.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'trigger'] },
          id: { type: 'string', description: 'The automation\'s id, from list or create. For update, delete and trigger.' },
          name: { type: 'string', description: 'Short label shown to the user, e.g. "Morning inbox summary". Up to 120 characters.' },
          prompt: { type: 'string', description: 'The instruction each run carries out, written to stand alone (see above). Up to 12000 characters.' },
          cron: { type: 'string', description: 'Five fields: minute hour day-of-month month day-of-week. "0 9 * * 1-5" is 09:00 on weekdays; "*/30 * * * *" is every 30 minutes.' },
          timezone: { type: 'string', description: 'IANA timezone the cron is read in, e.g. "Europe/Vienna". Required with cron; use the user\'s timezone, and ask if you do not know it.' },
          enabled: { type: 'boolean', description: 'false pauses the automation without deleting it; true resumes it. New automations are enabled.' }
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
  const chat = chatId ? store.chats.byId(chatId) : null;
  const userId = chat?.user_id ?? null;
  if (action === 'list') return JSON.stringify(store.automations.list(userId));
  if (action === 'create') {
    if (!chat) throw new Error('automation creation requires a current chat');
    const fields = cleanFields(args, { requireAll: true });
    const row = store.automations.create({ ...fields, chatId, source: 'model' }, userId);
    return JSON.stringify(row);
  }
  if (!args?.id) throw new Error('id is required');
  if (action === 'delete') return store.automations.delete(args.id, userId)
    ? `Deleted automation ${args.id}.` : 'Error: no such automation';
  if (action === 'trigger') {
    const automation = store.automations.get(args.id, userId);
    if (!automation) throw new Error('no such automation');
    if (!triggerAutomation) throw new Error('manual triggering is unavailable');
    return JSON.stringify(await triggerAutomation(automation, userId));
  }
  if (action === 'update') {
    const current = store.automations.get(args.id, userId);
    if (!current) throw new Error('no such automation');
    const fields = cleanFields(args);
    if (args.cron !== undefined || args.timezone !== undefined) {
      Object.assign(fields, validateSchedule(fields.cron ?? current.cron, fields.timezone ?? current.timezone));
    }
    const row = store.automations.update(args.id, fields, userId);
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
