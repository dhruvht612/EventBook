// The simulated EventBook server. Every action goes through api(), which re-checks the
// rules, logs the request to the server-log drawer and returns { ok, ... } or an error.
// Swap these functions for fetch() calls when a real backend exists.
import { S, me, ev, user, planOf, isAdmin, owns, toast, commit } from './store';
import { MIN, H, D, money, fDT, fTime, fDay, rid, hashPw, toTs } from './format';
import { audit, err, checkBook, priceFor, setFull, pwProblem, totp, wizardErrors, reportRows } from './rules';

/* ---- templates and notifications (NOTIF-1) */
export const fill = (str, vars) => str.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? '');
export function notify(uid, type, vars = {}, link = null, opts = {}) {
  const u = user(uid), t = S.templates.find(x => x.id === type);
  const v = { org: S.settings.org, name: u.name.split(' ')[0], ...vars };
  const subject = fill(t.subject, v), body = fill(t.body, v);
  if (!opts.emailOnly) S.notes.unshift({ id: 'n' + rid(), uid, title: subject, body, at: S.now, read: false, link });
  S.mail.unshift({ id: 'm' + rid(), to: opts.to || u.email, uid, type, subject, body, at: S.now, link, read: false });
}
export const evVars = e => ({ event: e.title, when: fDT(e.start), where: e.venue });

export function api(method, path, fn, body) {
  const r = fn();
  const res = r.ok === false ? r : { ok: true, http: r.http || 200, ...r };
  S.log.unshift({ t: Date.now(), method, path, body, http: res.http, code: res.ok ? null : res.code, msg: res.ok ? (res.msg || 'OK') : res.message });
  S.log = S.log.slice(0, 80);
  if (!res.ok && !res.quiet) toast(res.message, res.code);
  commit();
  return res;
}
const quiet = e => ({ ...e, quiet: true });
const jobLog = msg => S.log.unshift({ t: Date.now(), method: 'JOB', path: 'worker', http: 200, msg });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const API = {
  /* ---- auth (AUTH-1 to 7) */
  register(f) {
    return api('POST', '/api/auth/register', () => {
      const e = {}; const email = f.email.trim().toLowerCase();
      if (!f.name.trim()) e.name = 'Write your name.';
      if (!EMAIL_RE.test(email)) e.email = 'Write an email address with an @, like name@example.com.';
      else if (S.users.some(u => u.email.toLowerCase() === email)) e.email = 'An account already uses this email. Sign in or reset the password.';
      const pe = pwProblem(f.pw, email); if (pe) e.pw = pe;
      if (f.pw !== f.pw2) e.pw2 = 'The two passwords differ.';
      if (Object.keys(e).length) return quiet(err('VALIDATION_FAILED', 422, 'Some fields need fixing.', e));
      const id = 'u' + (++S.seq);
      S.users.push({ id, name: f.name.trim(), email, phone: '', pw: hashPw(f.pw), verified: false, status: 'PENDING_VERIFICATION', roles: ['member'], mfa: false, created: S.now, lastLogin: null, membership: { id: 'm' + id, plan: 'free', status: 'ACTIVE', start: S.now, expiry: null, cancelAtEnd: false }, history: [] });
      sendToken(id, 'verify', 24 * H);
      audit(S, id, 'user.register', 'user', id, `${f.name.trim()} signed up`);
      return { http: 201, msg: 'Account created; verification email sent', id };
    }, { email: f.email });
  },
  verify(tok) {
    return api('POST', '/api/auth/verify-email', () => {
      const t = S.tokens.find(x => x.tok === tok);
      if (!t || !['verify', 'email-change'].includes(t.type)) return err('NOT_FOUND', 404, 'This link is not valid.');
      if (t.used) return err('CONFLICT', 409, 'This link was already used.');
      if (S.now > t.exp) return err('CONFLICT', 409, 'This link expired. Ask for a new one.');
      t.used = true; const u = user(t.uid);
      if (t.type === 'email-change') { audit(S, u.id, 'user.email', 'user', u.id, `Email changed from ${u.email} to ${t.newEmail}`); u.email = t.newEmail; u.pendingEmail = null; return { msg: 'New email confirmed', uid: u.id }; }
      u.verified = true; if (u.status === 'PENDING_VERIFICATION') u.status = 'ACTIVE';
      return { msg: 'Email verified', uid: u.id };
    }, { token: '••••' + tok.slice(-3) });
  },
  resend(uid) {
    return api('POST', '/api/auth/verify-email/resend', () => {
      const u = user(uid); if (u.verified) return err('CONFLICT', 409, 'Already verified.');
      S.tokens.filter(t => t.uid === uid && t.type === 'verify').forEach(t => { t.used = true; });
      sendToken(uid, 'verify', 24 * H); return { msg: 'New link sent' };
    });
  },
  login(email, pw, remember) {
    return api('POST', '/api/auth/login', () => {
      const key = email.trim().toLowerCase(), a = S.authFail[key] || (S.authFail[key] = { n: 0, until: 0 });
      if (a.until > S.now) return err('RATE_LIMITED', 429, `Too many failed attempts. Try again at ${fTime(a.until)}, or reset your password.`, { retryAfter: Math.ceil((a.until - S.now) / 1000) });
      const u = S.users.find(x => x.email.toLowerCase() === key);
      if (!u || u.pw !== hashPw(pw)) {
        a.n++;
        if (a.n >= 5) { a.until = S.now + 15 * MIN; a.n = 0; if (u) audit(S, 'system', 'user.lock', 'user', u.id, `${u.name}: locked 15 minutes after 5 failed sign-ins`); return err('RATE_LIMITED', 429, 'Five wrong passwords: the account is locked for 15 minutes.'); }
        return err('UNAUTHENTICATED', 401, `Email or password is wrong. ${5 - a.n} tr${5 - a.n === 1 ? 'y' : 'ies'} left before a 15-minute lock.`);
      }
      if (u.status === 'INACTIVE') return err('FORBIDDEN', 403, 'This account is deactivated. Contact the organization.');
      a.n = 0; u.lastLogin = S.now;
      const s = { id: 's' + (++S.seq), uid: u.id, device: 'Chrome on this computer', created: S.now, last: S.now, remember };
      S.sessions.push(s);
      return { msg: `Signed in; session ${remember ? 'kept 30 days' : 'ends when the browser closes'}; cookie rotated`, uid: u.id, sid: s.id, mfa: u.mfa };
    }, { email, remember });
  },
  logout() {
    return api('POST', '/api/auth/logout', () => {
      S.sessions = S.sessions.filter(s => s.id !== S.sid.member); S.sid.member = null; S.current.member = null;
      return { msg: 'Signed out; session cookie cleared' };
    });
  },
  forgot(email) {
    return api('POST', '/api/auth/forgot-password', () => {
      const u = S.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
      if (u) sendToken(u.id, 'reset', H);
      return { msg: 'If the account exists, a reset link was sent' };
    }, { email });
  },
  reset(tok, pw) {
    return api('POST', '/api/auth/reset-password', () => {
      const t = S.tokens.find(x => x.tok === tok && x.type === 'reset');
      if (!t) return err('NOT_FOUND', 404, 'This link is not valid.');
      if (t.used) return err('CONFLICT', 409, 'This link was already used.');
      if (S.now > t.exp) return err('CONFLICT', 409, 'This link expired after an hour. Ask for a new one.');
      const u = user(t.uid), pe = pwProblem(pw, u.email); if (pe) return quiet(err('VALIDATION_FAILED', 422, pe, { pw: pe }));
      t.used = true; u.pw = hashPw(pw); delete S.authFail[u.email];
      const n = S.sessions.filter(s => s.uid === u.id).length; S.sessions = S.sessions.filter(s => s.uid !== u.id);
      Object.keys(S.current).forEach(k => { if (S.current[k] === u.id) { S.current[k] = null; S.sid[k] = null; } });
      audit(S, u.id, 'user.password', 'user', u.id, `${u.name}: password reset, ${n} sessions revoked`);
      return { msg: `Password changed; ${n} session${n === 1 ? '' : 's'} revoked` };
    });
  },
  changePw(cur, pw) {
    return api('POST', '/api/users/me/password', () => {
      const u = me(); if (u.pw !== hashPw(cur)) return quiet(err('VALIDATION_FAILED', 422, 'Your current password is wrong.', { cur: 'Your current password is wrong.' }));
      const pe = pwProblem(pw, u.email); if (pe) return quiet(err('VALIDATION_FAILED', 422, pe, { pw: pe }));
      u.pw = hashPw(pw); const keep = S.sid[S.role]; const n = S.sessions.filter(s => s.uid === u.id && s.id !== keep).length;
      S.sessions = S.sessions.filter(s => s.uid !== u.id || s.id === keep);
      audit(S, u.id, 'user.password', 'user', u.id, `${u.name}: password changed, ${n} other sessions revoked`);
      return { msg: `Password changed; ${n} other session${n === 1 ? '' : 's'} revoked` };
    });
  },
  revoke(sid) {
    return api('DELETE', `/api/users/me/sessions/${sid}`, () => {
      const u = me(); const s = S.sessions.find(x => x.id === sid && x.uid === u.id); if (!s) return err('NOT_FOUND', 404, 'No such session.');
      S.sessions = S.sessions.filter(x => x.id !== sid);
      if (sid === S.sid[S.role]) { S.sid[S.role] = null; S.current[S.role] = null; }
      return { msg: 'Session revoked' };
    });
  },
  profile(f) {
    return api('PATCH', '/api/users/me', () => {
      const u = me(), e = {};
      if (!f.name.trim()) e.name = 'Write your name.';
      if (f.phone && !/^[+\d][\d\s().-]{6,}$/.test(f.phone)) e.phone = 'Write a phone number with digits, like 416 555 0100.';
      const email = f.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) e.email = 'Write an email address with an @.';
      else if (email !== u.email && S.users.some(x => x.email === email)) e.email = 'Another account uses this email.';
      if (Object.keys(e).length) return quiet(err('VALIDATION_FAILED', 422, 'Some fields need fixing.', e));
      u.name = f.name.trim(); u.phone = f.phone.trim();
      let msg = 'Profile saved';
      if (email !== u.email) { u.pendingEmail = email; sendToken(u.id, 'email-change', 24 * H, email); msg = 'Profile saved; confirm the new email from its inbox'; }
      return { msg };
    });
  },
  mfa(on, code) {
    return api('POST', `/api/users/me/mfa/${on ? 'enable' : 'disable'}`, () => {
      const u = me();
      if (on && code !== totp()) return quiet(err('VALIDATION_FAILED', 422, 'That code does not match. Type the 6 digits your app shows now.', { code: 'That code does not match.' }));
      if (!on && isAdmin(u) && S.settings.mfaAdmins) return err('FORBIDDEN', 403, 'Administrators must keep two-step sign-in on.');
      u.mfa = on; audit(S, u.id, 'user.mfa', 'user', u.id, `${u.name}: two-step sign-in ${on ? 'on' : 'off'}`);
      return { msg: on ? 'Two-step sign-in on' : 'Two-step sign-in off' };
    });
  },

  /* ---- bookings, payments, waitlist (BKG-1 to 6, WL-1, WL-2) */
  book(eid, qty, fromOffer) {
    return api('POST', `/api/events/${eid}/book`, () => {
      const e = ev(eid), u = me(); let wl = null;
      if (fromOffer) {
        wl = S.waitlist.find(w => w.id === fromOffer);
        if (!wl || wl.status !== 'OFFERED' || wl.uid !== u.id) return err('CONFLICT', 409, 'This offer is no longer open.');
        if (S.now > wl.offerUntil) return err('CONFLICT', 409, 'This offer expired.');
        qty = 1;
      }
      // an offered seat is already reserved for this member, so check as if it were free
      const chk = fromOffer ? (() => { e.reserved -= 1; const c = checkBook(S, e, u, qty); e.reserved += 1; return c; })() : checkBook(S, e, u, qty);
      if (!chk.ok) return chk;
      if (!fromOffer) e.reserved += qty; // UPDATE events SET reserved = reserved + qty WHERE reserved + qty <= capacity, in one transaction
      const pr = priceFor(S, e, u, qty);
      const b = { id: 'b' + (++S.seq), num: 'EB-' + S.seq, eid, uid: u.id, qty, ...pr, status: pr.final ? 'PENDING_PAYMENT' : 'CONFIRMED', checkin: 'NOT_CHECKED_IN', created: S.now, token: rid(), plan: u.membership.plan, holdUntil: pr.final ? Date.now() + S.settings.holdMin * MIN : null };
      S.bookings.push(b); setFull(e);
      if (wl) wl.status = 'ACCEPTED';
      if (b.status === 'CONFIRMED') confirmed(b);
      return { http: 201, booking: b, msg: b.status === 'CONFIRMED' ? 'Booking confirmed' : `Seats held ${S.settings.holdMin} min` };
    }, { quantity: qty, idempotencyKey: rid() });
  },
  pay(kind, id, card) {
    return api('POST', '/api/webhooks/payments/square', () => {
      const digits = card.replace(/\D/g, '');
      if (digits.length < 15) return quiet(err('VALIDATION_FAILED', 422, 'Enter a full card number.', { field: 'card' }));
      const txn = 'sq_' + rid();
      if (kind === 'booking') {
        const b = S.bookings.find(x => x.id === id); if (!b || b.status !== 'PENDING_PAYMENT') return err('CONFLICT', 409, 'This booking is no longer waiting for payment.');
        if (b.holdUntil < Date.now()) { release(b, 'Hold expired'); return err('CONFLICT', 409, 'The hold ran out, so the seats went back.'); }
        if (digits.endsWith('0002')) { S.payments.push({ id: 'pay_' + rid(), kind, bid: b.id, uid: b.uid, amount: b.final, status: 'FAILED', provider: 'square', at: S.now, txn }); release(b, 'Payment failed'); return err('PAYMENT_FAILED', 402, 'The card was declined, so the seats went back. Try another card.'); }
        S.payments.push({ id: 'pay_' + rid(), kind, bid: b.id, uid: b.uid, amount: b.final, status: 'SUCCEEDED', provider: 'square', at: S.now, txn });
        b.status = 'CONFIRMED'; b.holdUntil = null; confirmed(b);
        return { msg: 'Payment succeeded (webhook verified, processed once); booking confirmed' };
      }
      const u = user(id), m = u.membership; if (m.status !== 'PENDING') return err('CONFLICT', 409, 'Nothing to pay.');
      const p = planOf(m.plan);
      if (digits.endsWith('0002')) { S.payments.push({ id: 'pay_' + rid(), kind, mid: m.id, uid: u.id, amount: p.price, status: 'FAILED', provider: 'square', at: S.now, txn }); u.membership = m.prev; return err('PAYMENT_FAILED', 402, 'The card was declined. Your plan has not changed.'); }
      S.payments.push({ id: 'pay_' + rid(), kind, mid: m.id, uid: u.id, amount: p.price, status: 'SUCCEEDED', provider: 'square', at: S.now, txn });
      if (m.prev && m.prev.plan !== 'free') u.history.unshift({ ...m.prev, status: 'CANCELLED', expiry: S.now, prev: undefined });
      delete m.prev; m.status = 'ACTIVE';
      audit(S, u.id, 'membership.change', 'membership', u.id, `${u.name}: now ${p.name}`);
      notify(u.id, 'membership_update', { plan: p.name, detail: `Your ${p.name} membership is active until ${fDay(m.expiry)}. Member prices apply from your next booking.` });
      return { msg: 'Payment succeeded; membership PENDING → ACTIVE' };
    }, { provider: 'square (sandbox)', kind });
  },
  abandonCheckout(bid) {
    return api('POST', `/api/bookings/${bid}/cancel`, () => {
      const b = S.bookings.find(x => x.id === bid);
      if (b && b.status === 'PENDING_PAYMENT') release(b, 'Checkout cancelled');
      return { msg: 'Hold released' };
    });
  },
  expireHold(bid) {
    return api('POST', '/api/jobs/expire-holds', () => {
      const b = S.bookings.find(x => x.id === bid);
      if (b && b.status === 'PENDING_PAYMENT') release(b, 'Hold expired');
      return { msg: 'Hold expired; seats released' };
    });
  },
  cancel(bid) {
    return api('POST', `/api/bookings/${bid}/cancel`, () => {
      const b = S.bookings.find(x => x.id === bid), e = ev(b.eid), u = me();
      const own = b.uid === u.id, orgOk = owns(u, e) && S.role !== 'member';
      if (!own && !orgOk) return err('FORBIDDEN', 403, 'You can only cancel your own bookings.');
      if (!['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status)) return err('CONFLICT', 409, 'This booking is already closed.');
      if (own && !orgOk && S.now > e.start - e.cutoffH * H) return err('CANCELLATION_WINDOW_CLOSED', 409, `Cancellations close ${e.cutoffH} hours before the start.`);
      const refund = b.status === 'CONFIRMED' && b.final;
      release(b, own && !orgOk ? 'Cancelled by member' : 'Cancelled by ' + (S.role === 'admin' ? 'admin' : 'organizer'));
      notify(b.uid, 'booking_cancelled', { ...evVars(e), detail: refund ? `A full refund of ${money(b.final)} is on its way to your card.` : (own ? '' : 'The organizer cancelled it.') });
      if (!own || orgOk) audit(S, u.id, 'booking.cancel', 'booking', b.num, `Cancelled ${user(b.uid).name}'s booking for ${e.title}`);
      return { msg: 'Cancelled; seats released' + (refund ? '; refund queued' : '') };
    });
  },
  joinWait(eid) {
    return api('POST', `/api/events/${eid}/waitlist`, () => {
      const e = ev(eid), u = me();
      if (!u) return err('UNAUTHENTICATED', 401, 'Sign in first.');
      if (!u.verified) return err('EMAIL_NOT_VERIFIED', 403, 'Verify your email first.');
      if (!e.waitlist) return err('CONFLICT', 409, 'This event has no waitlist.');
      if (e.reserved < e.cap) return err('CONFLICT', 409, 'Seats are free: book instead.');
      if (e.eligible && !(u.membership.status === 'ACTIVE' && e.eligible.includes(u.membership.plan))) return err('NOT_ELIGIBLE', 403, 'Your plan cannot book this event.');
      if (S.waitlist.some(w => w.eid === eid && w.uid === u.id && ['WAITING', 'OFFERED'].includes(w.status))) return err('DUPLICATE_BOOKING', 409, 'You are already on this waitlist.');
      const pos = Math.max(0, ...S.waitlist.filter(w => w.eid === eid).map(w => w.pos)) + 1;
      S.waitlist.push({ id: 'w' + (++S.seq), eid, uid: u.id, pos, status: 'WAITING', joined: S.now });
      notify(u.id, 'waitlist_joined', evVars(e));
      return { http: 201, msg: 'Joined waitlist' };
    });
  },
  leaveWait(wid) {
    return api('DELETE', `/api/events/waitlist/${wid}`, () => {
      const w = S.waitlist.find(x => x.id === wid); const wasOffer = w.status === 'OFFERED'; w.status = 'LEFT';
      if (wasOffer) { ev(w.eid).reserved -= 1; setFull(ev(w.eid)); promote(w.eid); }
      return { msg: wasOffer ? 'Offer declined; next person offered' : 'Left waitlist' };
    });
  },
  removeWait(wid) {
    return api('DELETE', `/api/organizer/waitlist/${wid}`, () => {
      const w = S.waitlist.find(x => x.id === wid), e = ev(w.eid); if (!owns(me(), e)) return err('FORBIDDEN', 403, 'Not your event.');
      const wasOffer = w.status === 'OFFERED'; w.status = 'LEFT';
      if (wasOffer) { e.reserved -= 1; setFull(e); promote(e.id); }
      audit(S, me().id, 'waitlist.remove', 'event', e.id, `Removed ${user(w.uid).name} from the ${e.title} waitlist`);
      return { msg: 'Removed from waitlist' };
    });
  },
  checkin(bid, undo) {
    return api('POST', `/api/checkin/${bid}${undo ? '/undo' : ''}`, () => {
      const b = S.bookings.find(x => x.id === bid), e = ev(b.eid), u = me();
      if (!owns(u, e)) return err('FORBIDDEN', 403, 'Only this event’s organizer can check people in.');
      if (b.status !== 'CONFIRMED') return err('CONFLICT', 409, 'Only confirmed bookings can be checked in.');
      b.checkin = undo ? 'NOT_CHECKED_IN' : 'CHECKED_IN'; b.checkedAt = undo ? null : S.now; b.checkedBy = u.id;
      audit(S, u.id, undo ? 'checkin.undo' : 'checkin', 'booking', b.num, `${undo ? 'Undid check-in for' : 'Checked in'} ${user(b.uid).name} (${b.qty} ticket${b.qty > 1 ? 's' : ''})`);
      return { msg: undo ? 'Check-in undone' : 'Checked in' };
    });
  },
  scan(token, eid) {
    return api('POST', '/api/checkin/scan', () => {
      const b = S.bookings.find(x => x.token === token.trim().toUpperCase());
      if (!b || b.eid !== eid) return err('NOT_FOUND', 404, 'No ticket for this event matches that code.');
      if (b.status !== 'CONFIRMED') return err('CONFLICT', 409, 'This ticket is not confirmed.');
      const n = user(b.uid).name.split(' ');
      return { msg: 'Ticket found', bid: b.id, show: `${n[0]} ${(n[1] || '')[0] || ''}.`, qty: b.qty };
    }, { token: '••••' + token.slice(-3) });
  },

  /* ---- events (EVT-1 to 7) */
  capacity(eid, cap) {
    return api('PATCH', `/api/events/${eid}`, () => {
      const e = ev(eid), u = me(); if (!owns(u, e)) return err('FORBIDDEN', 403, 'Not your event.');
      const booked = S.bookings.filter(b => b.eid === eid && ['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status)).reduce((a, b) => a + b.qty, 0);
      if (!Number.isInteger(cap) || cap < 1) return err('VALIDATION_FAILED', 422, 'Capacity must be a whole number above 0.');
      if (cap < booked) return err('VALIDATION_FAILED', 422, `Capacity can only go down to the ${booked} seats already booked.`);
      const old = e.cap; e.cap = cap; e.version++; setFull(e);
      audit(S, u.id, 'event.update', 'event', e.id, `${e.title}: capacity ${old} → ${cap}`);
      if (cap > old) for (let i = 0; i < cap - old; i++) if (!promote(eid)) break;
      return { msg: 'Capacity saved' };
    }, { capacity: cap });
  },
  saveEvent(draft, publish) {
    return api(draft.id ? 'PATCH' : 'POST', draft.id ? `/api/events/${draft.id}` : '/api/events', () => {
      const u = me(); const e = draft.id ? ev(draft.id) : null;
      if (e && !owns(u, e)) return err('FORBIDDEN', 403, 'Not your event.');
      if (e && draft.version !== e.version) return err('CONFLICT', 409, 'Someone saved this event since you opened it. Reload and try again.');
      const bad = wizardErrors(draft, publish ? 7 : draft.step);
      if (Object.keys(bad).length) return err('VALIDATION_FAILED', 422, 'Some fields need fixing.', bad);
      const start = toStart(draft), opens = toOpens(draft);
      const data = { title: draft.title.trim(), cat: draft.cat, desc: draft.desc.trim(), type: draft.type, venue: draft.type === 'Virtual' ? 'Online' : draft.venue.trim(), city: draft.type === 'Virtual' ? 'Online' : draft.city.trim(), url: draft.type === 'In person' ? null : draft.url.trim(), start, dur: +draft.dur, end: start + draft.dur * H, closes: start - 2 * H, cap: +draft.cap, max: +draft.max, price: Math.round(+draft.price * 100), member: draft.member === '' ? null : Math.round(+draft.member * 100), eligible: draft.elig === 'all' ? null : draft.plans.slice(), opens, waitlist: draft.waitlist, cutoffH: +draft.cutoffH };
      let target = e;
      if (!target) { target = { id: 'ev' + (++S.seq), org: u.id, status: 'DRAFT', reserved: 0, version: 0, color: '#d7e3c3', coorgs: [] }; S.events.push(target); }
      if (target.status !== 'DRAFT' && data.cap < target.reserved) return err('VALIDATION_FAILED', 422, `Capacity can only go down to the ${target.reserved} seats already taken.`, { cap: `Capacity can only go down to the ${target.reserved} seats already taken.` });
      const oldCap = target.cap; Object.assign(target, data); target.version++;
      if (target.status !== 'DRAFT' && target.cap > oldCap) { setFull(target); for (let i = 0; i < target.cap - oldCap; i++) if (!promote(target.id)) break; }
      if (publish && target.status === 'DRAFT') { target.status = 'PUBLISHED'; setFull(target); audit(S, u.id, 'event.publish', 'event', target.id, 'Published ' + target.title); }
      else if (publish) { setFull(target); audit(S, u.id, 'event.update', 'event', target.id, 'Edited ' + target.title); }
      return { http: e ? 200 : 201, msg: publish ? (e && e.status !== 'DRAFT' ? 'Changes saved' : 'Published') : 'Draft saved', id: target.id, version: target.version };
    }, { step: draft.step + 1 });
  },
  cancelEvent(eid) {
    return api('POST', `/api/events/${eid}/cancel`, () => {
      const e = ev(eid), u = me(); if (!owns(u, e)) return err('FORBIDDEN', 403, 'Not your event.');
      let n = 0, refunds = 0;
      S.bookings.filter(b => b.eid === eid && ['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status)).forEach(b => {
        const paid = b.status === 'CONFIRMED' && b.final; if (paid) refunds++;
        release(b, 'Event cancelled', true); n++;
        notify(b.uid, 'event_cancelled', { ...evVars(e), detail: paid ? `A full refund of ${money(b.final)} is on its way.` : '' });
      });
      S.waitlist.filter(w => w.eid === eid && ['WAITING', 'OFFERED'].includes(w.status)).forEach(w => { w.status = 'LEFT'; notify(w.uid, 'event_cancelled', { ...evVars(e), detail: 'You are off its waitlist.' }); });
      e.status = 'CANCELLED'; e.reserved = 0;
      audit(S, u.id, 'event.cancel', 'event', e.id, `Cancelled ${e.title}: ${n} bookings, ${refunds} refunds queued`);
      return { msg: `Cancelled; ${n} people told, ${refunds} refunds queued` };
    });
  },
  duplicate(eid) {
    return api('POST', `/api/events/${eid}/duplicate`, () => {
      const e = ev(eid), u = me();
      const c = { ...e, id: 'ev' + (++S.seq), title: e.title + ' (copy)', status: 'DRAFT', reserved: 0, version: 1, org: u.id, coorgs: [] };
      S.events.push(c); audit(S, u.id, 'event.duplicate', 'event', c.id, 'Duplicated ' + e.title);
      return { http: 201, msg: 'Draft copy made', id: c.id };
    });
  },
  coorg(eid, uid, on) {
    return api('PATCH', `/api/events/${eid}/organizers`, () => {
      const e = ev(eid); if (!(isAdmin(me()) || e.org === me().id)) return err('FORBIDDEN', 403, 'Only the owner can add co-organizers.');
      e.coorgs = on ? [...new Set([...(e.coorgs || []), uid])] : (e.coorgs || []).filter(x => x !== uid);
      audit(S, me().id, 'event.organizers', 'event', eid, `${on ? 'Added' : 'Removed'} ${user(uid).name} as co-organizer of ${e.title}`);
      return { msg: 'Co-organizers saved' };
    });
  },

  /* ---- memberships (MEM-1 to 7) */
  buyPlan(pid) {
    return api('POST', '/api/memberships', () => {
      const u = me(), p = planOf(pid);
      if (!p.active) return err('VALIDATION_FAILED', 422, 'This plan is not on offer.');
      if (u.membership.plan === pid && u.membership.status === 'ACTIVE') return err('CONFLICT', 409, 'You are already on this plan.');
      if (u.membership.status === 'SUSPENDED') return err('FORBIDDEN', 403, 'Your membership is suspended. Contact the organization.');
      if (u.membership.status === 'PENDING') u.membership = u.membership.prev; // an earlier checkout was left open
      const prev = { ...u.membership };
      if (!p.price) {
        if (prev.plan !== 'free') u.history.unshift({ ...prev, status: 'CANCELLED', expiry: S.now });
        u.membership = { id: 'm' + rid(), plan: 'free', status: 'ACTIVE', start: S.now, expiry: null, cancelAtEnd: false };
        audit(S, u.id, 'membership.change', 'membership', u.id, `${u.name}: moved to Free`);
        notify(u.id, 'membership_update', { plan: 'Free', detail: 'You are on the Free plan. Member prices and members-only events have stopped.' });
        return { msg: 'Moved to Free' };
      }
      u.membership = { id: 'm' + rid(), plan: pid, status: 'PENDING', start: S.now, expiry: S.now + 365 * D, cancelAtEnd: false, prev };
      return { http: 201, msg: 'Membership PENDING; waiting for payment', pending: true };
    }, { plan: pid, idempotencyKey: rid() });
  },
  abandonPlan() {
    return api('POST', '/api/memberships/abandon', () => {
      const u = me(); if (u && u.membership.status === 'PENDING') u.membership = u.membership.prev;
      return { msg: 'Checkout closed; plan unchanged' };
    });
  },
  cancelPlan(undo) {
    return api('POST', `/api/memberships/${me().membership.id}/${undo ? 'resume' : 'cancel'}`, () => {
      const u = me(), m = u.membership; if (m.plan === 'free') return err('CONFLICT', 409, 'The Free plan has nothing to cancel.');
      const name = planOf(m.plan).name;
      m.cancelAtEnd = !undo;
      audit(S, u.id, 'membership.' + (undo ? 'resume' : 'cancel'), 'membership', u.id, `${u.name}: ${undo ? 'kept' : 'cancelled, ends'} ${name} ${undo ? '' : 'on ' + fDay(m.expiry)}`);
      notify(u.id, 'membership_update', { plan: name, detail: undo ? `Your ${name} membership continues.` : `You cancelled. Your ${name} membership stays active until ${fDay(m.expiry)}, then you move to Free.` });
      return { msg: undo ? 'Membership kept' : 'Cancelled; active until expiry' };
    });
  },

  /* ---- admin (ADM-1, ADM-2, MEM-1, MEM-6) */
  role(uid, role, on) {
    return api('PATCH', `/api/admin/users/${uid}/roles`, () => {
      const u = user(uid), a = me(); if (!isAdmin(a)) return err('FORBIDDEN', 403, 'Admins only.');
      if (uid === a.id && role === 'admin' && !on) return err('CONFLICT', 409, 'You cannot remove your own admin role.');
      u.roles = on ? [...new Set([...u.roles, role])] : u.roles.filter(r => r !== role);
      audit(S, a.id, on ? 'role.grant' : 'role.revoke', 'user', uid, `${on ? 'Granted' : 'Revoked'} ${role} for ${u.name}`);
      return { msg: 'Roles saved; sessions rotated' };
    }, { role, on });
  },
  userStatus(uid) {
    return api('PATCH', `/api/admin/users/${uid}`, () => {
      const u = user(uid), a = me(); if (uid === a.id) return err('CONFLICT', 409, 'You cannot deactivate yourself.');
      u.status = u.status === 'INACTIVE' ? 'ACTIVE' : 'INACTIVE';
      if (u.status === 'INACTIVE') { S.sessions = S.sessions.filter(s => s.uid !== uid); Object.keys(S.current).forEach(k => { if (S.current[k] === uid) S.current[k] = null; }); }
      audit(S, a.id, 'user.' + (u.status === 'INACTIVE' ? 'deactivate' : 'activate'), 'user', uid, `${u.name}: account ${u.status === 'INACTIVE' ? 'deactivated, sessions revoked' : 'activated'}`);
      return { msg: 'Account ' + u.status.toLowerCase() };
    });
  },
  suspend(uid) {
    return api('POST', `/api/admin/memberships/${uid}/${user(uid).membership.status === 'SUSPENDED' ? 'reinstate' : 'suspend'}`, () => {
      const u = user(uid), m = u.membership; if (m.plan === 'free') return err('CONFLICT', 409, 'Free memberships cannot be suspended.');
      m.status = m.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
      audit(S, me().id, 'membership.' + (m.status === 'SUSPENDED' ? 'suspend' : 'reinstate'), 'membership', uid, `${u.name}: ${planOf(m.plan).name} ${m.status.toLowerCase()}`);
      notify(uid, 'membership_update', { plan: planOf(m.plan).name, detail: m.status === 'SUSPENDED' ? 'Your membership is suspended: no member prices or members-only events until it is reinstated.' : 'Your membership is active again.' });
      return { msg: 'Membership ' + m.status.toLowerCase() };
    });
  },
  plan(pid, vals) {
    return api(pid ? 'PATCH' : 'POST', `/api/admin/membership-plans${pid ? '/' + pid : ''}`, () => {
      const d = +vals.discount, ea = +vals.early, pr = Math.round(+vals.price * 100);
      if (!vals.name.trim()) return err('VALIDATION_FAILED', 422, 'Give the plan a name.');
      if (S.plans.some(p => p.name.toLowerCase() === vals.name.trim().toLowerCase() && p.id !== pid)) return err('VALIDATION_FAILED', 422, 'Another plan has that name.');
      if (!(d >= 0 && d <= 90) || !(ea >= 0 && ea <= 30) || !Number.isInteger(ea) || !(pr >= 0)) return err('VALIDATION_FAILED', 422, 'Price 0 or more, discount 0 to 90%, early access 0 to 30 days.');
      let p = pid && planOf(pid);
      if (!p) { p = { id: 'p' + (++S.seq), cycle: 'year' }; S.plans.push(p); }
      Object.assign(p, { name: vals.name.trim(), price: pid === 'free' ? 0 : pr, discount: d / 100, early: ea, active: pid === 'free' ? true : vals.active, benefits: vals.benefits.split('\n').map(x => x.trim()).filter(Boolean) });
      audit(S, me().id, pid ? 'plan.update' : 'plan.create', 'plan', p.id, `${p.name}: ${money(p.price)}, ${d}% off, ${ea} days early, ${p.active ? 'active' : 'inactive'}`);
      return { http: pid ? 200 : 201, msg: pid ? 'Plan saved' : 'Plan created' };
    }, vals);
  },
  refund(pid) {
    return api('POST', `/api/admin/payments/${pid}/refund`, () => {
      const p = S.payments.find(x => x.id === pid); if (p.status !== 'SUCCEEDED') return err('CONFLICT', 409, 'Only a succeeded payment can be refunded.');
      p.status = 'REFUNDED'; audit(S, me().id, 'payment.refund', 'payment', pid, `Refunded ${money(p.amount)} to ${user(p.uid).name}`);
      return { msg: 'Refund sent through Square' };
    });
  },
  template(id, subject, body) {
    return api('PATCH', `/api/admin/notification-templates/${id}`, () => {
      if (!subject.trim() || !body.trim()) return err('VALIDATION_FAILED', 422, 'Subject and body cannot be empty.');
      const t = S.templates.find(x => x.id === id); t.subject = subject; t.body = body;
      audit(S, me().id, 'settings.template', 'template', id, `Edited the "${t.name}" template`);
      return { msg: 'Template saved' };
    });
  },
  settings(v) {
    return api('PATCH', '/api/admin/settings', () => {
      const e = {};
      if (!v.org.trim()) e.org = 'Write the organization name.';
      if (!(Number.isInteger(+v.holdMin) && +v.holdMin >= 5 && +v.holdMin <= 30)) e.holdMin = 'Between 5 and 30 minutes.';
      if (!(Number.isInteger(+v.offerH) && +v.offerH >= 1 && +v.offerH <= 72)) e.offerH = 'Between 1 and 72 hours.';
      if (!(Number.isInteger(+v.cutoffH) && +v.cutoffH >= 0 && +v.cutoffH <= 168)) e.cutoffH = 'Between 0 and 168 hours.';
      if (v.ssoEnabled && !/^https:\/\//.test(v.issuer)) e.issuer = 'The issuer is an https address.';
      if (v.ssoEnabled && !v.clientId.trim()) e.clientId = 'Paste the client ID from your identity provider.';
      if (Object.keys(e).length) return quiet(err('VALIDATION_FAILED', 422, 'Some settings need fixing.', e));
      Object.assign(S.settings, { org: v.org.trim(), holdMin: +v.holdMin, offerH: +v.offerH, cutoffH: +v.cutoffH, mfaAdmins: v.mfaAdmins, sso: { enabled: v.ssoEnabled, issuer: v.issuer.trim(), clientId: v.clientId.trim() } });
      audit(S, me().id, 'settings.update', 'settings', 'org', `Settings saved: hold ${v.holdMin} min, offers ${v.offerH} h, cut-off ${v.cutoffH} h, SSO ${v.ssoEnabled ? 'on' : 'off'}`);
      return { msg: 'Settings saved' };
    });
  },
  exportCsv(kind, f = {}) {
    return api('GET', f.eid && S.role === 'organizer' ? `/api/organizer/events/${f.eid}/registrations/export` : `/api/admin/reports/${kind}/export`, () => {
      const rows = reportRows(kind, f);
      const csv = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
      audit(S, me().id, 'export', 'report', kind, `Exported ${kind}${f.eid ? ' for ' + ev(f.eid).title : ''} (${rows.length - 1} rows)`);
      return { csv, msg: `${rows.length - 1} rows` };
    });
  },
};

const toStart = d => toTs(d.date, d.time);
const toOpens = d => toTs(d.opensDate, '09:00');

function sendToken(uid, type, ttl, newEmail) {
  const tok = rid() + rid(); S.tokens.push({ tok, type, uid, exp: S.now + ttl, used: false, newEmail });
  const u = user(uid);
  if (type === 'verify' || type === 'email-change') notify(uid, 'verify_email', {}, { label: 'Confirm my email', act: 'verify', tok }, { emailOnly: true, to: newEmail || u.email });
  if (type === 'reset') notify(uid, 'password_reset', {}, { label: 'Choose a new password', act: 'resetlink', tok }, { emailOnly: true });
}
function confirmed(b) {
  const e = ev(b.eid);
  notify(b.uid, 'booking_confirmed', { ...evVars(e), tickets: `${b.qty} ticket${b.qty > 1 ? 's' : ''}`, amount: money(b.final) }, { label: 'Show my ticket', act: 'ticketlink', id: b.id });
}
export function release(b, why, noPromote) {
  const e = ev(b.eid); const was = b.status; b.status = 'CANCELLED'; b.cancelled = S.now; b.why = why; b.holdUntil = null;
  e.reserved -= b.qty; setFull(e);
  if (was === 'CONFIRMED' && b.final) { const p = S.payments.find(x => x.bid === b.id && x.status === 'SUCCEEDED'); if (p) p.status = 'REFUNDED'; }
  if (!noPromote) for (let i = 0; i < b.qty; i++) if (!promote(b.eid)) break;
}
function promote(eid) {
  const e = ev(eid); if (!e.waitlist || e.reserved >= e.cap || !['PUBLISHED', 'FULL'].includes(e.status)) return false;
  const next = S.waitlist.filter(w => w.eid === eid && w.status === 'WAITING').sort((a, b) => a.pos - b.pos)
    .find(w => { const u = user(w.uid); return u.status !== 'INACTIVE' && (!e.eligible || (u.membership.status === 'ACTIVE' && e.eligible.includes(u.membership.plan))); });
  if (!next) return false;
  next.status = 'OFFERED'; next.offerUntil = S.now + S.settings.offerH * H; e.reserved += 1; setFull(e);
  notify(next.uid, 'seat_offered', { ...evVars(e), until: fDT(next.offerUntil) }, { label: 'Accept the seat', act: 'openevent', id: e.id });
  jobLog(`Offered 1 seat of ${e.title} to ${user(next.uid).name} for ${S.settings.offerH} h; email and in-app sent`);
  return true;
}

/* ---- the demo clock and the worker's jobs */
export function advance(ms) {
  const from = S.now; S.now += ms; const done = [];
  // seat holds: paid bookings not paid within the hold
  S.bookings.filter(b => b.status === 'PENDING_PAYMENT').forEach(b => { release(b, 'Hold expired'); done.push(`released the hold on ${b.num}`); });
  // waitlist offers past their window: expire and offer to the next person (WL-2)
  for (let guard = 0; guard < 50; guard++) {
    const w = S.waitlist.find(x => x.status === 'OFFERED' && x.offerUntil <= S.now); if (!w) break;
    w.status = 'EXPIRED'; const e = ev(w.eid); e.reserved -= 1; setFull(e);
    notify(w.uid, 'offer_expired', evVars(e)); done.push(`expired ${user(w.uid).name}'s offer`); promote(w.eid);
  }
  // event reminders 24 h and 2 h before (NOTIF-2)
  S.bookings.filter(b => b.status === 'CONFIRMED').forEach(b => {
    const e = ev(b.eid); if (!['PUBLISHED', 'FULL'].includes(e.status) || S.now >= e.start) return;
    if (!b.r24 && S.now >= e.start - 24 * H) { b.r24 = true; if (S.now < e.start - 2 * H) { notify(b.uid, 'event_reminder', { ...evVars(e), lead: 'tomorrow' }); done.push(`24 h reminder to ${user(b.uid).name}`); } }
    if (!b.r2 && S.now >= e.start - 2 * H) { b.r2 = true; notify(b.uid, 'event_reminder', { ...evVars(e), lead: 'in 2 hours' }); done.push(`2 h reminder to ${user(b.uid).name}`); }
  });
  // events past their end: COMPLETED, no-shows marked (EVT-6, CHK-3)
  S.events.filter(e => ['PUBLISHED', 'FULL'].includes(e.status) && e.end <= S.now).forEach(e => {
    e.status = 'COMPLETED'; let ns = 0;
    S.bookings.filter(b => b.eid === e.id && b.status === 'CONFIRMED').forEach(b => { if (b.checkin === 'CHECKED_IN') b.status = 'COMPLETED'; else { b.status = 'NO_SHOW'; ns++; } });
    S.waitlist.filter(w => w.eid === e.id && ['WAITING', 'OFFERED'].includes(w.status)).forEach(w => { w.status = 'EXPIRED'; });
    audit(S, 'system', 'event.complete', 'event', e.id, `${e.title} completed; ${ns} no-shows marked`); done.push(`${e.title} completed, ${ns} no-shows`);
  });
  // the nightly membership job at 02:00 Toronto (MEM-5): reminders 14 and 3 days before, expiry
  const nights = []; for (let t = from - (from % D) + 7 * H; t <= S.now; t += D) if (t > from) nights.push(t);
  if (nights.length) S.users.forEach(u => {
    const m = u.membership; if (m.plan === 'free' || !m.expiry || !['ACTIVE', 'SUSPENDED'].includes(m.status)) return;
    const days = Math.ceil((m.expiry - S.now) / D), p = planOf(m.plan);
    if (m.expiry <= S.now) {
      u.history.unshift({ ...m, status: 'EXPIRED' });
      u.membership = { id: 'm' + rid(), plan: 'free', status: 'ACTIVE', start: S.now, expiry: null, cancelAtEnd: false };
      notify(u.id, 'membership_update', { plan: 'Free', detail: `Your ${p.name} membership ended on ${fDay(m.expiry)}. You are on the Free plan now; renew from Membership any time.` });
      audit(S, 'system', 'membership.expire', 'membership', u.id, `${u.name}: ${p.name} expired, moved to Free`); done.push(`${u.name}'s ${p.name} expired`); return;
    }
    if (days <= 3 && !m.r3) { m.r3 = m.r14 = true; if (!m.cancelAtEnd) notify(u.id, 'membership_reminder', { plan: p.name, days, until: fDay(m.expiry) }); done.push(`3-day reminder to ${u.name}`); }
    else if (days <= 14 && !m.r14) { m.r14 = true; if (!m.cancelAtEnd) notify(u.id, 'membership_reminder', { plan: p.name, days, until: fDay(m.expiry) }); done.push(`14-day reminder to ${u.name}`); }
  });
  S.log.unshift({ t: Date.now(), method: 'CLOCK', path: `+${Math.round(ms / H)} h → ${fDT(S.now)}`, http: 200, msg: done.length ? 'Jobs ran: ' + done.slice(0, 6).join('; ') + (done.length > 6 ? `; and ${done.length - 6} more` : '') : 'Jobs ran: nothing due' });
  S.log = S.log.slice(0, 80);
  commit();
  return done;
}
