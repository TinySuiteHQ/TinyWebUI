/**
 * Where a stored message came from, when it was not typed by the user. The
 * server stamps it (src/automations/scheduler.js) and the page draws such a
 * message as what it is (chat/transcript.js), not as a user bubble.
 */
export const ORIGIN = Object.freeze({
  AUTOMATION: 'automation'          // a scheduled or manually triggered automation run
});
