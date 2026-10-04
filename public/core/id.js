/**
 * A random id for things the page names before the server has seen them (a
 * new chat, a queued message). randomUUID needs a secure context (https or
 * localhost); getRandomValues works on plain-http LAN installs too.
 */
export const newId = () => crypto.randomUUID?.()
  ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
