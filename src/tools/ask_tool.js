/**
 * ask_user -- lets the model put one question to the user mid-run and carry
 * on with the answer in the same run.
 *
 * The waiting itself belongs to the server, which owns the run: it persists
 * the question, draws it, runs the timeout and takes the answer. This file
 * only validates the call and turns the outcome into the tool result. A run
 * with nobody to ask (an automation) never waits; it gets the fallback at once.
 */

export const ASK_USER = 'ask_user';

const MAX_QUESTION = 2000;
const MAX_CHOICES = 10;
const MAX_CHOICE = 200;

export function askToolDef() {
  return {
    type: 'function',
    function: {
      name: ASK_USER,
      description: [
        'Ask the user one question and wait for the answer, then continue this same task',
        'with it. The run pauses until they answer; if they do not answer in time, you are',
        'told so and continue on your own assumptions.',
        '',
        'Use it only for information that materially changes the result and that you cannot',
        'infer or safely assume: choosing between materially different files, accounts or',
        'environments; a missing value; a decision with real downstream effects; a manual',
        'step the user must do first.',
        '',
        'Do not use it to ask "should I continue?", for preferences with a sensible default,',
        'to confirm ordinary reversible actions, or because the request is only mildly',
        'ambiguous -- make a reasonable assumption and state it instead. One question per',
        'call; offer `choices` when there are a few valid answers.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, written for the user to read.' },
          choices: {
            type: 'array',
            items: { type: 'string' },
            description: `Optional answers to pick from (up to ${MAX_CHOICES}).`
          },
          allow_free_text: {
            type: 'boolean',
            description: 'Whether the user may type their own answer instead of picking a choice. Default true.'
          }
        },
        required: ['question']
      }
    }
  };
}

/** The result text for each way a question can end. JSON, so it parses and reads. */
export function askResult(outcome) {
  if (outcome.answered) return JSON.stringify({ answered: true, answer: outcome.answer });
  const message = {
    timeout: 'The user did not respond within the configured timeout.',
    skipped: 'The user chose to let you continue without answering.',
    unattended: 'No interactive user is available for this run.'
  }[outcome.reason] || 'The question could not be put to the user.';
  return JSON.stringify({
    answered: false,
    reason: outcome.reason,
    message: `${message} Continue the task using your own reasonable assumptions, and state any`
      + ' important assumptions in your final answer when they materially affect the result.'
  });
}

/**
 * The tool handler. `ctx.askUser({ question, choices, allowFreeText })`
 * resolves to `{ answered: true, answer }` or `{ answered: false, reason }`;
 * without one (an unattended run) the fallback comes back at once.
 */
export async function callAskUser(args, ctx) {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return 'Error: "question" is required and must be a non-empty string.';
  if (question.length > MAX_QUESTION) return `Error: "question" is over ${MAX_QUESTION} characters; ask something shorter.`;
  if (args.choices !== undefined && !(Array.isArray(args.choices) && args.choices.every((c) => typeof c === 'string'))) {
    return 'Error: "choices" must be a list of strings.';
  }
  const choices = [...new Set((args.choices || []).map((c) => c.trim()).filter(Boolean))];
  if (choices.length > MAX_CHOICES) return `Error: at most ${MAX_CHOICES} choices.`;
  if (choices.some((c) => c.length > MAX_CHOICE)) return `Error: each choice must be under ${MAX_CHOICE} characters.`;
  // Nothing to pick and nothing to type would be a question nobody can answer.
  const allowFreeText = args.allow_free_text !== false || choices.length === 0;

  if (ctx.unattended || !ctx.askUser) return askResult({ answered: false, reason: 'unattended' });
  return askResult(await ctx.askUser({ question, choices, allowFreeText }));
}
