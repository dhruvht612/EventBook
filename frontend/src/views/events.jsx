// Find events (SRCH-1 to 3) and the event page with booking and waitlist (BKG-1 to 6, WL-1).
import { useState } from 'react';
import { S, ev, me, user, planOf, go, toast, commit, seatsLeft } from '../lib/store';
import { API } from '../lib/server';
import { checkBook, opensFor, priceFor } from '../lib/rules';
import { D, fDT, fTime, money, toTs } from '../lib/format';
import { Chip, EventCard, Empty, Price, gradient } from '../components/ui';
import { book, confirmCancelBooking, openTicket, startCheckout } from '../actions';

const EMPTY_FILTERS = { q: '', cat: '', type: '', city: '', paid: '', avail: '', elig: '', from: '', to: '', sort: 'date' };
const LIVE = ['PUBLISHED', 'FULL'];

export function Discover() {
  const f = S.filters, u = me();
  const pub = S.events.filter(e => LIVE.includes(e.status));
  let list = pub;
  if (f.q) list = list.filter(e => `${e.title} ${e.desc} ${e.city} ${e.cat} ${e.venue}`.toLowerCase().includes(f.q.toLowerCase()));
  if (f.cat) list = list.filter(e => e.cat === f.cat);
  if (f.type) list = list.filter(e => e.type === f.type);
  if (f.city) list = list.filter(e => e.city === f.city);
  if (f.paid) list = list.filter(e => (f.paid === 'free' ? !e.price : e.price > 0));
  if (f.avail) list = list.filter(e => (f.avail === 'open' ? seatsLeft(e) > 0 : seatsLeft(e) === 0));
  if (f.elig) list = list.filter(e => {
    if (f.elig === 'all') return !e.eligible;
    if (f.elig === 'members') return !!e.eligible;
    const c = checkBook(S, e, u, 1); return c.ok || c.code === 'EVENT_FULL';
  });
  if (f.from) list = list.filter(e => e.start >= toTs(f.from, '00:00'));
  if (f.to) list = list.filter(e => e.start < toTs(f.to, '00:00') + D);
  const pop = e => S.bookings.filter(b => b.eid === e.id && b.status === 'CONFIRMED').length;
  list = [...list].sort({ date: (a, b) => a.start - b.start, popular: (a, b) => pop(b) - pop(a), price: (a, b) => a.price - b.price, new: (a, b) => b.opens - a.opens }[f.sort]);

  const set = (k, v) => { S.filters[k] = v; commit(); };
  const sel = (k, text, opts) => (
    <select aria-label={text} value={f[k]} onChange={e => set(k, e.target.value)}>
      {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
    </select>
  );
  const anyFilter = Object.entries(f).some(([k, v]) => k !== 'sort' && v);
  return (
    <>
      <div className="head">
        <div><h1>Find an event</h1><p>{u && S.role === 'member' ? `Prices shown are yours on the ${planOf(u.membership.plan).name} plan.` : 'Sign in to see your member price.'}</p></div>
        {anyFilter && <button className="btn ghost sm" type="button" onClick={() => { S.filters = { ...EMPTY_FILTERS }; commit(); }}>Clear filters</button>}
      </div>
      <div className="filters">
        <input type="search" placeholder="Search events, places" aria-label="Search" value={f.q} onChange={e => set('q', e.target.value)} className="span2" />
        {sel('cat', 'Category', [['', 'All categories'], ...[...new Set(pub.map(e => e.cat))].map(c => [c, c])])}
        {sel('city', 'City', [['', 'All cities'], ...[...new Set(pub.map(e => e.city))].map(c => [c, c])])}
        {sel('type', 'Type', [['', 'All types'], ['In person', 'In person'], ['Virtual', 'Virtual'], ['Hybrid', 'Hybrid']])}
        {sel('paid', 'Price', [['', 'Free and paid'], ['free', 'Free'], ['paid', 'Paid']])}
        {sel('avail', 'Availability', [['', 'Any availability'], ['open', 'Seats left'], ['full', 'Full (waitlist)']])}
        {sel('elig', 'Eligibility', [['', 'Any eligibility'], ['all', 'Open to all'], ['members', 'Members only'], ...(u ? [['mine', 'I can book']] : [])])}
        <input type="date" aria-label="From date" value={f.from} onChange={e => set('from', e.target.value)} />
        <input type="date" aria-label="To date" value={f.to} onChange={e => set('to', e.target.value)} />
        {sel('sort', 'Sort', [['date', 'Sort by date'], ['popular', 'Most booked'], ['price', 'Lowest price'], ['new', 'Recently added']])}
      </div>
      {list.length ? <div className="grid cards">{list.map(e => <EventCard key={e.id} e={e} u={u} />)}</div> : <Empty>No events match. Clear a filter to see more.</Empty>}
    </>
  );
}

function BuyBox({ e, u }) {
  const [qty, setQty] = useState(1);
  const offerH = S.settings.offerH;
  if (!u) return (
    <>
      <p className="small">Sign in to book{e.waitlist && e.status === 'FULL' ? ' or join the waitlist' : ''}.</p>
      <div className="row"><button className="btn pri" type="button" onClick={() => go('login')}>Sign in</button><button className="btn" type="button" onClick={() => go('signup')}>Create an account</button></div>
    </>
  );
  if (S.role !== 'member') return <p className="small muted">Switch to the member view to book.</p>;

  const mine = S.bookings.find(b => b.eid === e.id && b.uid === u.id && ['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status));
  if (mine) {
    if (mine.status === 'PENDING_PAYMENT') return <button className="btn pri" type="button" onClick={() => startCheckout(mine.id)}>Finish payment</button>;
    return (
      <>
        <div className="notice ok">You are booked: {mine.qty} ticket{mine.qty > 1 ? 's' : ''}.</div>
        <div className="row"><button className="btn" type="button" onClick={() => openTicket(mine.id)}>Show ticket</button><button className="btn ghost danger" type="button" onClick={() => confirmCancelBooking(mine.id)}>Cancel booking</button></div>
      </>
    );
  }

  const leave = id => { const r = API.leaveWait(id); if (r.ok) toast(r.msg); };
  const wl = S.waitlist.find(w => w.eid === e.id && w.uid === u.id && ['WAITING', 'OFFERED'].includes(w.status));
  if (wl && wl.status === 'OFFERED') return (
    <>
      <div className="notice acc"><b>A seat is free for you.</b> Accept by {fDT(wl.offerUntil)}.</div>
      <div className="row"><button className="btn pri" type="button" onClick={() => book(e.id, 1, wl.id)}>Accept the seat · {money(priceFor(S, e, u, 1).final)}</button><button className="btn" type="button" onClick={() => leave(wl.id)}>Decline</button></div>
    </>
  );
  if (wl) {
    const ahead = S.waitlist.filter(w => w.eid === e.id && w.status === 'WAITING' && w.pos < wl.pos).length;
    return (
      <>
        <div className="notice">You are <b>number {ahead + 1}</b> on the waitlist. When a seat frees up it is offered to you for {offerH} hours.</div>
        <button className="btn" type="button" onClick={() => leave(wl.id)}>Leave the waitlist</button>
      </>
    );
  }

  const chk = checkBook(S, e, u, 1);
  if (!chk.ok && chk.code === 'EVENT_FULL') return (
    <>
      <div className="notice">This event is full.{e.waitlist && ` Join the waitlist and you get the next free seat for ${offerH} hours.`}</div>
      {e.waitlist && <button className="btn pri" type="button" onClick={() => { if (API.joinWait(e.id).ok) toast('You are on the waitlist.'); }}>Join the waitlist</button>}
    </>
  );
  if (!chk.ok) {
    const plansLink = ['NOT_ELIGIBLE', 'MEMBERSHIP_INACTIVE'].includes(chk.code) || (chk.code === 'REGISTRATION_CLOSED' && chk.details.opensAt);
    return (
      <>
        <div className="notice bad">{chk.message} <span className="mono">{chk.code}</span></div>
        {plansLink && <button className="btn" type="button" onClick={() => go('membership')}>See membership plans</button>}
        {chk.code === 'EMAIL_NOT_VERIFIED' && <button className="btn" type="button" onClick={() => { if (API.resend(u.id).ok) toast('A new link is in the mailbox'); }}>Send a new link</button>}
      </>
    );
  }

  const p = priceFor(S, e, u, qty);
  return (
    <>
      <div className="field" style={{ width: 120 }}>
        <label htmlFor="qty">Tickets</label>
        <select id="qty" value={qty} onChange={ev2 => setQty(+ev2.target.value)}>
          {Array.from({ length: Math.min(e.max, seatsLeft(e)) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
        </select>
      </div>
      <p className="small">{p.how}: <b>{money(p.final)}</b> {qty === 1 ? 'a ticket' : `for ${qty}`}</p>
      <button className="btn pri" type="button" onClick={() => book(e.id, qty)}>{e.price ? 'Book and pay' : 'Book'}</button>
      {e.price > 0 && <p className="tiny muted">Your seats are held for {S.settings.holdMin} minutes while you pay.</p>}
    </>
  );
}

export function EventDetail() {
  const e = ev(S.param), u = me();
  if (!e) return <Discover />;
  const mine = u && S.bookings.find(b => b.eid === e.id && b.uid === u.id && b.status === 'CONFIRMED');
  const canSeeUrl = mine && e.url;
  const early = u && opensFor(S, e, u) < e.opens;
  return (
    <>
      <button className="btn ghost sm" type="button" onClick={() => go('discover')}>← All events</button>
      <div className="split" style={{ marginTop: 16 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ height: 180, background: gradient(e.color, 55) }} />
          <div style={{ padding: 24 }} className="grid">
            <span className="row">
              <Chip s={e.status} /><span className="chip plain">{e.type}</span><span className="chip plain">{e.cat}</span>
              {e.eligible && <span className="chip plain">{e.eligible.map(id => planOf(id)?.name).join(' + ')} only</span>}
            </span>
            <h1>{e.title}</h1>
            <p>{e.desc}</p>
            <dl className="kv">
              <dt>When</dt><dd>{fDT(e.start)} to {fTime(e.end)} (Toronto time)</dd>
              <dt>Where</dt><dd>{e.venue}{e.type !== 'In person' && (canSeeUrl ? <> · <a href={e.url}>{e.url}</a></> : ' · the online link shows once you are booked')}</dd>
              <dt>Seats</dt><dd>{seatsLeft(e)} of {e.cap} left</dd>
              <dt>Registration</dt><dd>Opens {fDT(e.opens)}{early && ` (for you: ${fDT(opensFor(S, e, u))})`}, closes {fDT(e.closes)}</dd>
              <dt>Tickets</dt><dd>Up to {e.max} per member</dd>
              <dt>Cancellation</dt><dd>Free until {e.cutoffH} hours before the start, full refund</dd>
              <dt>Organizer</dt><dd>{user(e.org).name}</dd>
            </dl>
          </div>
        </div>
        <div className="card grid buybox" style={{ position: 'sticky', top: 90 }}>
          <h2>{e.price ? (u ? 'Your price' : 'Price') : 'Free event'}</h2>
          <p><Price e={e} u={u} /></p>
          <BuyBox e={e} u={u} />
        </div>
      </div>
    </>
  );
}
