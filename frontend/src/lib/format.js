// Dates, money and small helpers shared by the engine and the UI.
export const TZ = 'America/Toronto';
export const NOW0 = Date.UTC(2027, 1, 4, 15, 0); // Thu 4 Feb 2027, 10:00 in Toronto: the demo clock starts here
export const MIN = 60e3, H = 3600e3, D = 24 * H;

export const money = c => (c === 0 ? 'Free' : '$' + (c / 100).toFixed(2));
export const dollars = c => '$' + (c / 100).toFixed(2);
export const fmt = (t, o) => new Date(t).toLocaleString('en-CA', { timeZone: TZ, ...o });
export const fDate = t => fmt(t, { weekday: 'short', day: 'numeric', month: 'short' });
export const fTime = t => fmt(t, { hour: '2-digit', minute: '2-digit', hour12: false });
export const fDT = t => fDate(t) + ', ' + fTime(t);
export const fDay = t => fmt(t, { day: 'numeric', month: 'short', year: 'numeric' });
export const pad = n => String(n).padStart(2, '0');
export const initials = n => n.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const TONES = ['#97cef6', '#fed878', '#bbf697', '#6ef8fb', '#f6b8d6', '#d8d2c4'];
export const tone = id => TONES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length];
export const rid = () => Math.random().toString(36).slice(2, 12).toUpperCase();

// demo stand-in for Argon2id: the shape of a stored hash, never the password itself
export const hashPw = pw => 'argon2id$v=19$m=19456,t=2,p=1$' + [...pw].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619)) >>> 0, 2166136261).toString(16);
export const BREACHED = ['password1234', 'qwertyuiop12', 'letmein12345', '123456789012', 'iloveyou1234', 'password12345'];
export const DEMO_PW = 'eventbook-demo-2027';

export const label = s => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export const STATUS = { CONFIRMED: 'ok', PENDING_PAYMENT: 'warn', WAITLISTED: 'info', CANCELLED: '', COMPLETED: 'ok', NO_SHOW: 'bad', PUBLISHED: 'ok', FULL: 'acc', DRAFT: '', ACTIVE: 'ok', EXPIRED: 'bad', SUSPENDED: 'bad', WAITING: 'info', OFFERED: 'acc', ACCEPTED: 'ok', LEFT: '', CHECKED_IN: 'ok', NOT_CHECKED_IN: '', SUCCEEDED: 'ok', REFUNDED: 'info', PENDING: 'warn', FAILED: 'bad', INACTIVE: 'bad', LOCKED: 'bad', PENDING_VERIFICATION: 'warn' };

// Toronto wall-clock <-> timestamp (demo uses a fixed UTC-5 offset)
export function tsParts(t) {
  const d = new Date(t - 5 * H);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}
export function toTs(date, time) {
  const [y, m, d] = (date || '').split('-').map(Number), [h, mi] = (time || '').split(':').map(Number);
  return Date.UTC(y, m - 1, d, h + 5, mi);
}

export function downloadFile(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
