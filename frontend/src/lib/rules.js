// Business rules: pricing (BR-6), booking checks (BR-1 to 7), passwords, wizard validation, reports.
import { S, me, ev, user, planOf, isAdmin, owns } from './store';
import { D, H, BREACHED, fDT, fDay, toTs, tsParts } from './format';

export function audit(S, actor, action, type, entity, detail, at = S.now) { S.audit.unshift({ actor, action, type, entity, detail, at }); }
export function err(code, http, message, details = {}) { return { ok: false, code, http, message, details }; }

export function activePaid(S, u) { const m = u.membership, p = S.plans.find(x => x.id === m.plan); return m.status === 'ACTIVE' && p && p.price > 0 ? p : null; }
export function priceFor(S, e, u, qty) {
  const orig = e.price * qty; if (!e.price) return { orig: 0, discount: 0, final: 0, how: 'Free event' };
  const p = u && activePaid(S, u); if (!p) return { orig, discount: 0, final: orig, how: 'Full price' };
  const opts = [{ v: Math.round(e.price * (1 - p.discount)), how: `${p.name} plan, ${Math.round(p.discount * 100)}% off` }];
  if (e.member != null) opts.push({ v: e.member, how: 'Member price' });
  const best = opts.sort((a, b) => a.v - b.v)[0];
  return { orig, discount: orig - best.v * qty, final: best.v * qty, how: best.how };
}
export function opensFor(S, e, u) { const p = u && activePaid(S, u); return e.opens - (p ? p.early : 0) * D; }

export function checkBook(S, e, u, qty) {
  if (!u) return err('UNAUTHENTICATED', 401, 'Sign in to book.');
  if (!u.verified) return err('EMAIL_NOT_VERIFIED', 403, 'Verify your email before booking. The link is in your inbox.');
  if (['DRAFT', 'CANCELLED', 'COMPLETED'].includes(e.status)) return err('EVENT_NOT_BOOKABLE', 409, 'This event is not open for booking.');
  const o = opensFor(S, e, u);
  if (S.now < o) return err('REGISTRATION_CLOSED', 409, `Registration opens for you on ${fDT(o)}.`, { opensAt: o });
  if (S.now > e.closes) return err('REGISTRATION_CLOSED', 409, 'Registration has closed.');
  if (e.eligible) {
    const m = u.membership;
    if (m.status !== 'ACTIVE') return err('MEMBERSHIP_INACTIVE', 403, 'Your membership is ' + m.status.toLowerCase() + '. Renew it to book this event.');
    if (!e.eligible.includes(m.plan)) return err('NOT_ELIGIBLE', 403, `Only ${e.eligible.map(id => S.plans.find(p => p.id === id)?.name).join(' and ')} members can book this event.`);
  }
  if (S.bookings.some(b => b.eid === e.id && b.uid === u.id && ['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status))) return err('DUPLICATE_BOOKING', 409, 'You already have a booking for this event.');
  if (!Number.isInteger(qty) || qty < 1 || qty > e.max) return err('VALIDATION_FAILED', 422, `Choose 1 to ${e.max} ticket${e.max > 1 ? 's' : ''}.`, { field: 'quantity' });
  if (e.reserved + qty > e.cap) return err('EVENT_FULL', 409, 'This event has reached its booking capacity.', { waitlistAvailable: e.waitlist });
  return { ok: true };
}
export function setFull(e) { if (['PUBLISHED', 'FULL'].includes(e.status)) e.status = e.reserved >= e.cap ? 'FULL' : 'PUBLISHED'; }

export function pwProblem(pw, email) {
  if (!pw || pw.length < 12) return 'Use at least 12 characters.';
  if (BREACHED.includes(pw.toLowerCase())) return 'This password appears in known data breaches. Choose another.';
  if (email && pw.toLowerCase().includes(email.split('@')[0])) return 'Leave your email name out of the password.';
  return null;
}
export const totp = () => String((Math.floor(S.now / 30000) * 7919) % 1000000).padStart(6, '0');

/* ---- the 8-step event wizard (EVT-1 to 5) */
export const WSTEPS = ['Info', 'Date and time', 'Location', 'Capacity', 'Pricing', 'Eligibility', 'Registration rules', 'Review'];
export const STEP_KEYS = [['title', 'desc'], ['date', 'time', 'dur'], ['venue', 'city', 'url'], ['cap', 'max'], ['price', 'member'], ['plans'], ['opensDate', 'cutoffH'], []];

export function startWizard(e) {
  if (S.wizard && e && S.wizard.id === e.id) return;
  const st = tsParts(e ? e.start : S.now + 21 * D), op = tsParts(e ? e.opens : S.now + 2 * D);
  S.wizard = e
    ? { id: e.id, version: e.version, live: e.status !== 'DRAFT', step: e.status !== 'DRAFT' ? 7 : 0, title: e.title, cat: e.cat, desc: e.desc, date: st.date, time: st.time, dur: String(e.dur), type: e.type, venue: e.venue, city: e.city, url: e.url || '', cap: String(e.cap), max: String(e.max), price: (e.price / 100).toFixed(2), member: e.member == null ? '' : (e.member / 100).toFixed(2), elig: e.eligible ? 'plans' : 'all', plans: e.eligible ? e.eligible.slice() : [], opensDate: op.date, waitlist: e.waitlist, cutoffH: String(e.cutoffH), errors: {}, done: e.status !== 'DRAFT' ? [0, 1, 2, 3, 4, 5, 6] : [] }
    : { id: null, version: 0, live: false, step: 0, title: '', cat: 'Workshop', desc: '', date: st.date, time: '18:30', dur: '2', type: 'In person', venue: '', city: 'Toronto', url: '', cap: '20', max: '1', price: '0.00', member: '', elig: 'all', plans: [], opensDate: op.date, waitlist: true, cutoffH: String(S.settings.cutoffH), errors: {}, done: [] };
}

export function wizardErrors(w, upto) {
  const e = {}; const need = (k, m) => { if (!String(w[k] ?? '').trim()) e[k] = m; };
  if (upto >= 0) { need('title', 'Write the event’s name.'); if (w.title.length > 80) e.title = 'Keep the name under 80 characters.'; need('desc', 'Write one or two lines on what happens.'); }
  if (upto >= 1) { need('date', 'Pick a date.'); need('time', 'Pick a start time.'); if (!e.date && toTs(w.date, w.time) < S.now) e.date = 'The event must start in the future.'; if (!(+w.dur > 0 && +w.dur <= 24)) e.dur = 'Length in hours, 1 to 24.'; }
  if (upto >= 2) { if (w.type !== 'Virtual') { need('venue', 'Write the venue.'); need('city', 'Write the city.'); } if (w.type !== 'In person' && !/^https:\/\//.test(w.url)) e.url = 'Paste the meeting link, starting https://'; }
  if (upto >= 3) { if (!(Number.isInteger(+w.cap) && +w.cap >= 1)) e.cap = 'Capacity is a whole number above 0.'; if (!(Number.isInteger(+w.max) && +w.max >= 1 && +w.max <= 10)) e.max = 'Tickets per member: 1 to 10.'; }
  if (upto >= 4) { if (!(+w.price >= 0)) e.price = 'Price is 0 or more; 0 makes it free.'; if (w.member !== '' && !(+w.member >= 0 && +w.member <= +w.price)) e.member = 'The member price is at most the full price.'; }
  if (upto >= 5) { if (w.elig === 'plans' && !w.plans.length) e.plans = 'Pick at least one plan.'; }
  if (upto >= 6) { need('opensDate', 'Pick the day registration opens.'); if (!e.opensDate && !e.date && toTs(w.opensDate, '09:00') >= toTs(w.date, w.time)) e.opensDate = 'Registration must open before the event starts.'; if (!(Number.isInteger(+w.cutoffH) && +w.cutoffH >= 0 && +w.cutoffH <= 168)) e.cutoffH = 'Cut-off in hours, 0 to 168.'; }
  return e;
}

/* ---- reports (RPT-1, RPT-2): columns follow the viewer's role */
export function reportRows(kind, f) {
  const u = me(), admin = isAdmin(u) && S.role === 'admin';
  const inRange = t => (!f.from || t >= toTs(f.from, '00:00')) && (!f.to || t < toTs(f.to, '00:00') + D);
  const evOk = e => (!f.eid || e.id === f.eid) && (admin || owns(u, e));
  const booking = id => S.bookings.find(b => b.id === id);
  if (kind === 'registrations') return [['booking', 'event', 'event_date', 'name', ...(admin ? ['email'] : []), 'tickets', 'status', 'paid', 'checked_in', 'booked_at'], ...S.bookings.filter(b => evOk(ev(b.eid)) && inRange(b.created)).map(b => [b.num, ev(b.eid).title, fDay(ev(b.eid).start), user(b.uid).name, ...(admin ? [user(b.uid).email] : []), b.qty, b.status, (b.final / 100).toFixed(2), b.checkin === 'CHECKED_IN' ? 'yes' : 'no', fDT(b.created)])];
  if (kind === 'attendance') return [['event', 'date', 'booked', 'checked_in', 'no_show', 'rate'], ...S.events.filter(e => evOk(e) && inRange(e.start) && e.status !== 'DRAFT').map(e => {
    const bs = S.bookings.filter(b => b.eid === e.id && ['CONFIRMED', 'COMPLETED', 'NO_SHOW'].includes(b.status));
    const ci = bs.filter(b => b.checkin === 'CHECKED_IN').reduce((a, b) => a + b.qty, 0), all = bs.reduce((a, b) => a + b.qty, 0);
    return [e.title, fDay(e.start), all, ci, bs.filter(b => b.status === 'NO_SHOW').reduce((a, b) => a + b.qty, 0), all ? Math.round(ci / all * 100) + '%' : ''];
  })];
  if (kind === 'revenue') return [['payment', 'name', 'for', 'amount', 'status', 'date', 'transaction'], ...S.payments.filter(p => inRange(p.at) && (!f.eid || (p.bid && booking(p.bid).eid === f.eid)) && (admin || (p.bid && owns(u, ev(booking(p.bid).eid))))).map(p => [p.id, user(p.uid).name, p.kind === 'membership' ? 'Membership' : ev(booking(p.bid).eid).title, (p.amount / 100).toFixed(2), p.status, fDT(p.at), p.txn])];
  if (kind === 'membership') return [['name', ...(admin ? ['email'] : []), 'plan', 'status', 'started', 'expiry', 'renews'], ...S.users.map(x => [x.name, ...(admin ? [x.email] : []), planOf(x.membership.plan).name, x.membership.status, fDay(x.membership.start), x.membership.expiry ? fDay(x.membership.expiry) : '', x.membership.cancelAtEnd ? 'no' : (x.membership.plan === 'free' ? '' : 'reminders only')])];
  if (kind === 'waitlist') return [['event', 'position', 'name', 'status', 'joined', 'offer_until'], ...S.waitlist.filter(w => evOk(ev(w.eid)) && inRange(w.joined)).sort((a, b) => a.eid.localeCompare(b.eid) || a.pos - b.pos).map(w => [ev(w.eid).title, w.pos, user(w.uid).name, w.status, fDT(w.joined), w.offerUntil ? fDT(w.offerUntil) : ''])];
  return [[]];
}
