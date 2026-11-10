/**
 * The tool result a call gets when the person denies it. The model reads it
 * as the result; the page recognises it to draw the step as denied, live and
 * in a stored chat alike (a stored tool result is only its text).
 */
const PREFIX = 'The user declined this call to ';

export function declinedResult(name: string): string {
  return `${PREFIX}"${name}", so it was not run. Do not retry it`
    + ' unless they ask; continue without it, or ask them how they would like to proceed.';
}

export const isDeclined = (result: string): boolean => result.startsWith(PREFIX);
