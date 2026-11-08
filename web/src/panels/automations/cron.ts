/**
 * Automation schedules: a few presets that read back from the cron they
 * produce, so the editor shows "Weekdays at 09:00" instead of five fields.
 * Anything else stays custom (raw cron).
 */
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first, the way the week reads
const pad = (n: number | string) => String(n).padStart(2, '0');
const isInt = (v: string) => /^\d+$/.test(v);

export type Parsed =
  | { preset: 'hourly', minute: number }
  | { preset: 'daily', time: string }
  | { preset: 'days', time: string, days: number[] }
  | { preset: 'monthly', time: string, dom: number }
  | { preset: 'custom' };

function parseDays(dow: string): number[] | null {
  if (dow === '1-5') return [1, 2, 3, 4, 5];
  if (/^[0-6](,[0-6])*$/.test(dow)) return [...new Set(dow.split(',').map(Number))];
  return null;
}

export function parseCron(cron: string): Parsed {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return { preset: 'custom' };
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (!isInt(m)) return { preset: 'custom' };
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return { preset: 'hourly', minute: +m };
  if (!isInt(h) || mon !== '*') return { preset: 'custom' };
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === '*' && dow === '*') return { preset: 'daily', time };
  const days = dom === '*' ? parseDays(dow) : null;
  if (days) return { preset: 'days', time, days };
  if (isInt(dom) && dow === '*') return { preset: 'monthly', time, dom: +dom };
  return { preset: 'custom' };
}

export function buildCron(preset: string, { time = '09:00', days = [1, 2, 3, 4, 5], dom = 1, minute = 0 } = {}): string | null {
  const [h, m] = time.split(':').map(Number);
  switch (preset) {
    case 'hourly': return `${minute} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'days': {
      const sorted = [...days].sort((a, b) => a - b);
      if (sorted.length === 7) return `${m} ${h} * * *`;
      const dow = sorted.join(',') === '1,2,3,4,5' ? '1-5' : sorted.join(',');
      return `${m} ${h} * * ${dow}`;
    }
    case 'monthly': return `${m} ${h} ${dom} * *`;
    default: return null;
  }
}

function describeDays(days: number[]) {
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (days.length === 1) return `Every ${DAYS[days[0] as number]}`;
  return WEEK.filter((d) => days.includes(d)).map((d) => (DAYS[d] as string).slice(0, 3)).join(', ');
}

export function describeCron(cron: string) {
  const p = parseCron(cron);
  switch (p.preset) {
    case 'hourly': return `Every hour at :${pad(p.minute)}`;
    case 'daily': return `Every day at ${p.time}`;
    case 'days': return `${describeDays(p.days)} at ${p.time}`;
    case 'monthly': return `Monthly on day ${p.dom} at ${p.time}`;
    default: return `Cron ${cron}`;
  }
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function relative(iso: string | number | null | undefined) {
  if (!iso) return null;
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = abs < 60 ? [diff, 'second'] : abs < 3600 ? [diff / 60, 'minute']
    : abs < 86400 ? [diff / 3600, 'hour'] : [diff / 86400, 'day'];
  return rtf.format(Math.round(value), unit);
}
export const absolute = (iso: string | number) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
