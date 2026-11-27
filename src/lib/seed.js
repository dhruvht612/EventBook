// Sample data: a pottery collective with members, organizers, events, bookings and payments.
import { NOW0, H, D, fDT, hashPw, rid, DEMO_PW } from './format';
import { priceFor, audit } from './rules';

export const TEMPLATES = [
  ['verify_email', 'Verify your email', 'Confirm your email for {{org}}', 'Hi {{name}}, confirm this address to start booking events. The link works once and for 24 hours.'],
  ['password_reset', 'Password reset', 'Reset your {{org}} password', 'Hi {{name}}, someone asked to reset your password. The link works once and for 1 hour. If it was not you, ignore this email.'],
  ['booking_confirmed', 'Booking confirmed', 'Booked: {{event}}', '{{event}}, {{when}}. {{tickets}}, {{amount}}. Your QR ticket is in My bookings.'],
  ['booking_cancelled', 'Booking cancelled', 'Cancelled: {{event}}', 'Your booking for {{event}} on {{when}} is cancelled. {{detail}}'],
  ['waitlist_joined', 'Waitlist joined', 'You are on the waitlist for {{event}}', '{{event}}, {{when}}. We tell you when a seat opens.'],
  ['seat_offered', 'Seat available', 'A seat is free for you: {{event}}', '{{event}}, {{when}}. Accept by {{until}} or it goes to the next person.'],
  ['offer_expired', 'Seat offer expired', 'Your seat offer for {{event}} expired', 'You did not accept in time, so the seat went to the next person. You are off this waitlist.'],
  ['event_reminder', 'Event reminder', 'Starting {{lead}}: {{event}}', '{{event}} starts {{when}} at {{where}}. Bring your QR ticket.'],
  ['event_cancelled', 'Event cancelled', '{{event}} is cancelled', '{{event}} on {{when}} will not go ahead. {{detail}}'],
  ['membership_reminder', 'Membership reminder', 'Your {{plan}} membership ends in {{days}} days', 'It ends on {{until}}. Renew from Membership to keep member prices.'],
  ['membership_update', 'Membership update', 'Your membership: {{plan}}', '{{detail}}'],
];

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

export function fresh() {
  seed = 7;
  const S = {
    now: NOW0, seq: 20400, role: 'member', view: 'home', param: null, tab: 'upcoming', log: [], audit: [], notes: [], mail: [], payments: [], bookings: [], waitlist: [], tokens: [], sessions: [], authFail: {}, wizard: null,
    current: { guest: null, member: 'margot', organizer: 'amira', admin: 'hana' }, sid: {},
    filters: { q: '', cat: '', type: '', city: '', paid: '', avail: '', elig: '', from: '', to: '', sort: 'date' },
    settings: { org: 'Clay Collective', currency: 'CAD', holdMin: 15, offerH: 24, cutoffH: 24, mfaAdmins: true, sso: { enabled: false, issuer: '', clientId: '' } },
    templates: TEMPLATES.map(([id, name, subject, body]) => ({ id, name, subject, body })),
  };
  S.plans = [
    { id: 'free', name: 'Free', price: 0, cycle: 'none', discount: 0, early: 0, active: true, benefits: ['Book open events', 'Join waitlists'] },
    { id: 'standard', name: 'Standard', price: 6000, cycle: 'year', discount: 0.10, early: 0, active: true, benefits: ['10% off paid events', 'Member prices', 'Members-only events'] },
    { id: 'premium', name: 'Premium', price: 12000, cycle: 'year', discount: 0.20, early: 3, active: true, benefits: ['20% off paid events', 'Member prices', 'Members-only and Premium events', 'Book 3 days before everyone else'] },
  ];
  const U = (id, name, plan, roles = ['member'], expDays = 245) => ({
    id, name, email: id + '@members.example', phone: '', pw: hashPw(DEMO_PW), verified: true, status: 'ACTIVE', roles, mfa: false, created: NOW0 - 200 * D, lastLogin: NOW0 - 2 * D,
    membership: { id: 'm' + id, plan, status: 'ACTIVE', start: NOW0 + expDays * D - 365 * D, expiry: plan === 'free' ? null : NOW0 + expDays * D, cancelAtEnd: false }, history: [],
  });
  S.users = [
    U('margot', 'Margot Roussel', 'standard'), U('amira', 'Amira Khoury', 'premium', ['member', 'organizer']), U('jonas', 'Jonas Berg', 'standard', ['member', 'organizer']),
    U('hana', 'Hana Lee', 'premium', ['member', 'admin']), U('tomasz', 'Tomasz Wolny', 'free'), U('rafael', 'Rafael Brito', 'standard'), U('sana', 'Sana Naidu', 'premium'),
    U('ella', 'Ella Moreau', 'standard'), U('lucie', 'Lucie Chen', 'free'), U('daniel', 'Daniel Asante', 'standard'), U('kwame', 'Kwame Boateng', 'free'), U('noor', 'Noor Haddad', 'premium'),
    U('felix', 'Felix Wagner', 'standard', ['member'], 15), U('ana', 'Ana Ribeiro', 'free'), U('ravi', 'Ravi Menon', 'standard'), U('beatriz', 'Beatriz Duarte', 'premium'), U('oskar', 'Oskar Lind', 'free'), U('mei', 'Mei Tanaka', 'standard', ['member'], 4),
  ];
  const usr = id => S.users.find(u => u.id === id);
  usr('hana').mfa = true;
  usr('kwame').history.push({ plan: 'standard', status: 'EXPIRED', start: NOW0 - 400 * D, expiry: NOW0 - 35 * D });
  usr('kwame').membership = { id: 'mkwame2', plan: 'free', status: 'ACTIVE', start: NOW0 - 35 * D, expiry: null, cancelAtEnd: false };
  usr('margot').phone = '416 555 0142';
  S.sessions.push(
    { id: 's1', uid: 'margot', device: 'Chrome on this computer', created: NOW0 - 3 * D, last: NOW0, remember: true },
    { id: 's2', uid: 'margot', device: 'Safari on iPhone', created: NOW0 - 9 * D, last: NOW0 - 1 * D, remember: true },
    { id: 's3', uid: 'amira', device: 'Chrome on this computer', created: NOW0 - D, last: NOW0, remember: false },
    { id: 's4', uid: 'hana', device: 'Firefox on this computer', created: NOW0 - D, last: NOW0, remember: false },
  );
  S.sid = { member: 's1', organizer: 's3', admin: 's4' };
  const at = (days, h, m = 0) => { const d = new Date(NOW0 + days * D); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h + 5, m); };
  const E = o => Object.assign({ status: 'PUBLISHED', type: 'In person', city: 'Toronto', cap: 20, price: 0, member: null, eligible: null, waitlist: true, max: 1, cutoffH: 24, reserved: 0, version: 1, url: null, dur: 2, coorgs: [] }, o);
  S.events = [
    E({ id: 'pottery', title: 'Pottery evening', cat: 'Workshop', venue: 'The Clay Room, Ossington Ave', start: at(10, 19), cap: 12, price: 3600, member: 3000, max: 2, org: 'amira', opens: at(-12, 9), color: '#d9b48f', desc: 'Throw two pieces on the wheel with a studio teacher. Clay, glaze and firing included; pieces are ready to collect two weeks later.' }),
    E({ id: 'glaze', title: 'Glaze workshop', cat: 'Workshop', venue: 'The Clay Room, Ossington Ave', start: at(16, 18, 30), cap: 16, price: 4500, eligible: ['standard', 'premium'], org: 'amira', opens: at(-6, 9), color: '#9fc6d6', desc: 'Mix three glazes and test them on tiles from the last firing. Members only.' }),
    E({ id: 'agm', title: "Members' AGM", cat: 'Meeting', type: 'Hybrid', venue: 'Community hall, Dundas St W', start: at(1, 18), cap: 80, org: 'jonas', opens: at(-20, 9), url: 'https://meet.example/agm-2027', color: '#c9cbb4', desc: 'The annual general meeting: budget, the studio lease and two board seats. Join in the hall or online.' }),
    E({ id: 'talk', title: 'Talk: running a studio', cat: 'Talk', type: 'Virtual', city: 'Online', venue: 'Online', start: at(18, 12), dur: 1, cap: 200, org: 'jonas', opens: at(-10, 9), url: 'https://meet.example/studio-talk', color: '#bcd7a8', desc: 'Three studio owners on rent, kilns and keeping a waiting list. One hour, questions at the end.' }),
    E({ id: 'open', title: 'Open studio day', cat: 'Open day', city: 'Hamilton', venue: 'Cannon Street studios', start: at(23, 11), dur: 5, cap: 60, org: 'jonas', opens: at(-15, 9), color: '#f0d27e', desc: 'Walk through six studios, see work in progress and buy seconds. Bring friends who are thinking of joining.' }),
    E({ id: 'wheel', title: 'Wheel basics', cat: 'Workshop', venue: 'The Clay Room, Ossington Ave', start: at(27, 10), dur: 3, cap: 10, price: 9000, member: 7500, org: 'amira', opens: at(2, 9), color: '#e7a98b', desc: 'Centre, open and pull a cylinder. Premium members can book three days before registration opens to everyone.' }),
    E({ id: 'raku', title: 'Raku firing', cat: 'Workshop', venue: 'Outdoor kiln yard, Leslieville', start: at(32, 13), dur: 4, cap: 10, price: 5500, eligible: ['premium'], org: 'amira', opens: at(-3, 9), color: '#c99d85', desc: 'Pull glowing pots from the kiln and smoke them in sawdust. Premium members only; wear cotton.' }),
    E({ id: 'winter', title: "Winter members' night", cat: 'Social', venue: 'Community hall, Dundas St W', start: at(-10, 18), cap: 40, org: 'jonas', opens: at(-40, 9), status: 'COMPLETED', color: '#c7d2dc', desc: 'Drinks, a show of members’ work and the year ahead.' }),
    E({ id: 'spring', title: "Spring members' night", cat: 'Social', venue: 'Community hall, Dundas St W', start: at(38, 18), cap: 60, org: 'amira', opens: at(8, 9), status: 'DRAFT', color: '#d7e3c3', desc: 'Drinks and a members’ show to open the spring term.' }),
  ];
  S.events.forEach(e => { e.closes = e.start - 2 * H; e.end = e.start + e.dur * H; });
  const ev2 = id => S.events.find(x => x.id === id);
  const mk = (eid, uid, qty, st = 'CONFIRMED', ago = null) => {
    const e = ev2(eid), u = usr(uid), pr = priceFor(S, e, u, qty);
    const b = { id: 'b' + (++S.seq), num: 'EB-' + S.seq, eid, uid, qty, ...pr, status: st, checkin: 'NOT_CHECKED_IN', created: S.now - (ago ?? Math.floor(rnd() * 13 + 1) * D - Math.floor(rnd() * 20) * H), token: rid(), plan: u.membership.plan };
    S.bookings.push(b); if (['CONFIRMED', 'PENDING_PAYMENT'].includes(st)) e.reserved += qty;
    if (b.final > 0 && st !== 'PENDING_PAYMENT') S.payments.push({ id: 'pay_' + S.seq, kind: 'booking', bid: b.id, uid, amount: b.final, status: 'SUCCEEDED', provider: 'square', at: b.created, txn: 'sq_' + rid() });
    return b;
  };
  [['rafael', 1], ['sana', 1], ['ella', 1], ['lucie', 1], ['daniel', 2], ['kwame', 1], ['noor', 1], ['felix', 2], ['ana', 1], ['ravi', 1]].forEach(([u, q]) => mk('pottery', u, q));
  S.waitlist.push({ id: 'w1', eid: 'pottery', uid: 'margot', pos: 1, status: 'WAITING', joined: S.now - 2 * D }, { id: 'w2', eid: 'pottery', uid: 'tomasz', pos: 2, status: 'WAITING', joined: S.now - 1 * D });
  ['sana', 'ella', 'daniel', 'noor', 'felix', 'ravi', 'beatriz', 'mei', 'rafael', 'amira', 'hana', 'jonas'].forEach(u => mk('glaze', u, 1));
  const pool = S.users.map(u => u.id);
  pool.forEach(u => { if (rnd() < .7 || u === 'margot') mk('agm', u, 1); });
  pool.forEach(u => { if (rnd() < .6 || u === 'margot') mk('talk', u, 1); });
  pool.slice(4).forEach(u => { if (rnd() < .5) mk('open', u, 1); });
  mk('wheel', 'amira', 1); mk('wheel', 'noor', 1);
  ['sana', 'noor', 'beatriz', 'amira', 'hana'].forEach(u => mk('raku', u, 1));
  pool.forEach(u => {
    if (rnd() < .65 || u === 'margot') {
      const b = mk('winter', u, 1, 'CONFIRMED', 25 * D); const done = u === 'margot' || rnd() < .8;
      b.status = done ? 'COMPLETED' : 'NO_SHOW'; b.checkin = done ? 'CHECKED_IN' : 'NOT_CHECKED_IN'; ev2('winter').reserved -= 1;
    }
  });
  S.users.filter(u => u.membership.plan !== 'free').forEach(u => S.payments.push({ id: 'pay_m' + u.id, kind: 'membership', mid: u.membership.id, uid: u.id, amount: S.plans.find(p => p.id === u.membership.plan).price, status: 'SUCCEEDED', provider: 'square', at: u.membership.start, txn: 'sq_' + rid() }));
  S.events.forEach(e => { if (e.status === 'PUBLISHED' && e.reserved >= e.cap) e.status = 'FULL'; });
  S.notes.push({ id: 'n0', uid: 'margot', title: 'You are on the waitlist for Pottery evening', body: 'Pottery evening, ' + fDT(ev2('pottery').start) + '. We tell you when a seat opens.', at: S.now - 2 * D, read: true });
  audit(S, 'hana', 'role.grant', 'user', 'jonas', 'Granted organizer to Jonas Berg', S.now - 30 * D);
  audit(S, 'amira', 'event.publish', 'event', 'pottery', 'Published Pottery evening', S.now - 13 * D);
  audit(S, 'jonas', 'event.publish', 'event', 'agm', "Published Members' AGM", S.now - 21 * D);
  audit(S, 'system', 'membership.expire', 'membership', 'kwame', 'Kwame Boateng: Standard expired, moved to Free (nightly job)', S.now - 35 * D);
  return S;
}
