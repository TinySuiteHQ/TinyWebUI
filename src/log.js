/**
 * Operational log lines: `[tinywebui:<area>] message`, so one area's lines are
 * one search away. The level comes from TINYWEBUI_LOG_LEVEL (debug, info,
 * warn, error, silent; default info). Warnings and errors go to stderr.
 *
 * Audit events are not logging: they go through audit.js and are never
 * filtered by level.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };

const threshold = () => LEVELS[String(process.env.TINYWEBUI_LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;

export function logger(area) {
  const line = (level, write) => (message) => {
    if (LEVELS[level] < threshold()) return;
    write(`[tinywebui:${area}] ${level === 'info' ? '' : `${level}: `}${message}`);
  };
  return {
    debug: line('debug', console.log),
    info: line('info', console.log),
    warn: line('warn', console.error),
    error: line('error', console.error)
  };
}
