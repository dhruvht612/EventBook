// Member screens: dashboard (DASH-1, DASH-2), bookings, membership (MEM-*), inbox, profile and security.
import { Children, useEffect, useState } from 'react';
import { S, ev, me, planOf, go, toast, commit, openModal, isAdmin } from '../lib/store';
import { API } from '../lib/server';
import { fDT, fDay, money, label } from '../lib/format';
import { Chip, Empty, Field, Head, Input, Tabs } from '../components/ui';
import { MfaSetupModal } from '../components/modals';
import { buyPlan, cancelPlan, confirmCancelBooking, openTicket, startCheckout } from '../actions';

const OPEN = ['CONFIRMED', 'PENDING_PAYMENT'];
const placeInLine = w => S.waitlist.filter(x => x.eid === w.eid && x.status === 'WAITING' && x.pos < w.pos).length + 1;
const tickets = n => `${n} ticket${n > 1 ? 's' : ''}`;
const resend = id => { if (API.resend(id).ok) toast('A new link is in the mailbox'); };

function myBookings(u) {
  const mine = S.bookings.filter(b => b.uid === u.id);
  const up = mine.filter(b => OPEN.includes(b.status) && ev(b.eid).start > S.now).sort((a, b) => ev(a.eid).start - ev(b.eid).start);
  const rest = mine.filter(b => !up.includes(b));
  const wls = S.waitlist.filter(w => w.uid === u.id && ['WAITING', 'OFFERED'].includes(w.status));
  return { mine, up, rest, wls };
}

function ListCard({ title, note, empty, children }) {
  const items = Children.toArray(children);
  return (
    <div className="card">
      <h2 style={{ marginBottom: 8 }}>{title}</h2>
      {note && <p className="small muted">{note}</p>}
      <div className="list">{items.length ? items : <p className="muted small" style={{ padding: '12px 0' }}>{empty}</p>}</div>
    </div>
  );
}
const Line = ({ title, sub, children }) => (
  <div><div className="grid" style={{ gap: 2, flex: 1 }}><b>{title}</b><span className="small muted">{sub}</span></div>{children}</div>
);

export function Home() {
  const u = me(), m = u.membership, p = planOf(m.plan);
  const { mine, up, rest, wls } = myBookings(u);
  const hist = [...rest].sort((a, b) => (b.cancelled || ev(b.eid).start) - (a.cancelled || ev(a.eid).start)).slice(0, 4);
  const cats = new Set(mine.map(b => ev(b.eid).cat));
  const open = S.events.filter(e => ['PUBLISHED', 'FULL'].includes(e.status) && e.start > S.now && !mine.some(b => b.eid === e.id && b.status !== 'CANCELLED'));
  const recCat = open.filter(e => cats.has(e.cat));
  const rec = (recCat.length ? recCat : open).slice(0, 3);
  return (
    <>
      <Head title={`Hello, ${u.name.split(' ')[0]}`} actions={
        <div className="row">
          <button className="btn pri" type="button" onClick={() => go('discover')}>Find events</button>
          <button className="btn" type="button" onClick={() => go('bookings')}>My bookings</button>
          <button className="btn" type="button" onClick={() => go('membership')}>Membership</button>
        </div>}>Your membership, bookings and waitlists in one place.</Head>
      {!u.verified && <div className="notice bad" style={{ marginBottom: 20 }}>Verify your email to book. <button type="button" className="linkbtn" onClick={() => resend(u.id)}>Send a new link</button></div>}
      {wls.filter(w => w.status === 'OFFERED').map(w => (
        <div key={w.id} className="notice acc row" style={{ marginBottom: 20, justifyContent: 'space-between' }}>
          <span><b>A seat is free for you</b> at {ev(w.eid).title}. Accept by {fDT(w.offerUntil)}.</span>
          <button className="btn pri sm" type="button" onClick={() => go('event', w.eid)}>Accept the seat</button>
        </div>
      ))}
      <div className="grid kpis" style={{ marginBottom: 20 }}>
        <div className="card kpi"><span className="small muted">Membership</span><b>{p.name}</b><span className="small"><Chip s={m.status} /> {m.expiry ? (m.cancelAtEnd ? 'ends ' : 'until ') + fDay(m.expiry) : ''}</span></div>
        <div className="card kpi"><span className="small muted">Upcoming</span><b>{up.length}</b><span className="small muted">bookings</span></div>
        <div className="card kpi"><span className="small muted">Waitlists</span><b>{wls.length}</b></div>
        <div className="card kpi"><span className="small muted">Attended</span><b>{mine.filter(b => b.status === 'COMPLETED').length}</b></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <ListCard title="Upcoming" empty="Nothing booked yet.">
          {up.map(b => { const e = ev(b.eid); return (
            <Line key={b.id} title={e.title} sub={`${fDT(e.start)} · ${tickets(b.qty)}`}>
              {b.status === 'PENDING_PAYMENT' ? <button className="btn sm pri" type="button" onClick={() => startCheckout(b.id)}>Pay</button> : <button className="btn sm" type="button" onClick={() => openTicket(b.id)}>Ticket</button>}
            </Line>); })}
        </ListCard>
        <ListCard title="Waitlists" empty="You are on no waitlists.">
          {wls.map(w => <Line key={w.id} title={ev(w.eid).title} sub={w.status === 'OFFERED' ? 'Seat offered' : `Number ${placeInLine(w)} in line`}><button className="btn sm" type="button" onClick={() => go('event', w.eid)}>View</button></Line>)}
        </ListCard>
        <ListCard title="Recent history" empty="No history yet.">
          {hist.map(b => <Line key={b.id} title={ev(b.eid).title} sub={fDay(ev(b.eid).start)}><Chip s={b.status} /></Line>)}
        </ListCard>
        <ListCard title="Recommended for you" note={recCat.length ? 'From the categories you book.' : 'Coming up soon, not yet booked.'} empty="Book an event and we suggest more like it.">
          {rec.map(e => <Line key={e.id} title={e.title} sub={`${e.cat} · ${fDT(e.start)}`}><button className="btn sm" type="button" onClick={() => go('event', e.id)}>View</button></Line>)}
        </ListCard>
      </div>
    </>
  );
}

export function Bookings() {
  const u = me(), tab = S.tab;
  const { up, rest, wls } = myBookings(u);
  const past = [...rest].sort((a, b) => ev(b.eid).start - ev(a.eid).start);
  const rows = tab === 'past' ? past : up;
  let body;
  if (tab === 'waitlist') {
    body = wls.length ? (
      <table className="stack">
        <thead><tr><th>Event</th><th>When</th><th>Your place</th><th /></tr></thead>
        <tbody>{wls.map(w => { const e = ev(w.eid); return (
          <tr key={w.id}>
            <td data-l="Event"><b>{e.title}</b></td><td data-l="When">{fDT(e.start)}</td>
            <td data-l="Place">{w.status === 'OFFERED' ? <span className="chip acc">Seat offered until {fDT(w.offerUntil)}</span> : `Number ${placeInLine(w)}`}</td>
            <td><button className={`btn sm${w.status === 'OFFERED' ? ' pri' : ''}`} type="button" onClick={() => go('event', e.id)}>{w.status === 'OFFERED' ? 'Accept the seat' : 'View event'}</button></td>
          </tr>); })}</tbody>
      </table>
    ) : <Empty>You are on no waitlists.</Empty>;
  } else {
    body = rows.length ? (
      <table className="stack">
        <thead><tr><th>Event</th><th>When</th><th className="num">Tickets</th><th className="num">Paid</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map(b => { const e = ev(b.eid); return (
          <tr key={b.id}>
            <td data-l="Event"><b>{e.title}</b><br /><span className="tiny muted">{b.num}</span></td>
            <td data-l="When">{fDT(e.start)}</td><td data-l="Tickets" className="num">{b.qty}</td><td data-l="Paid" className="num">{money(b.final)}</td>
            <td data-l="Status"><Chip s={b.status} /></td>
            <td data-l="">
              {b.status === 'CONFIRMED' && e.start > S.now && <span className="row"><button className="btn sm" type="button" onClick={() => openTicket(b.id)}>Ticket</button><button className="btn sm ghost danger" type="button" onClick={() => confirmCancelBooking(b.id)}>Cancel</button></span>}
              {b.status === 'PENDING_PAYMENT' && <button className="btn sm pri" type="button" onClick={() => startCheckout(b.id)}>Pay</button>}
            </td>
          </tr>); })}</tbody>
      </table>
    ) : <Empty>{tab === 'past' ? 'No past bookings yet.' : 'Nothing booked. Find an event to go to.'}</Empty>;
  }
  return (
    <>
      <Head title="My bookings" actions={<button className="btn" type="button" onClick={() => go('discover')}>Find events</button>}>
        Cancel free until the event's cut-off (24 hours before the start by default); paid bookings are refunded in full.
      </Head>
      <Tabs value={tab} onChange={id => { S.tab = id; commit(); }} tabs={[['upcoming', `Upcoming (${up.length})`], ['waitlist', `Waitlist (${wls.length})`], ['past', `Past and cancelled (${past.length})`]]} />
      <div className="card scroll">{body}</div>
    </>
  );
}

export function Membership() {
  const u = me(), m = u.membership, cur = planOf(m.plan);
  const pays = S.payments.filter(p => p.uid === u.id && p.kind === 'membership');
  return (
    <>
      <Head title="Membership">Plans set your price and which events you can book. No auto-renew: we remind you 14 and 3 days before it ends.</Head>
      <div className="card row" style={{ marginBottom: 20, justifyContent: 'space-between' }}>
        <div className="grid" style={{ gap: 4 }}>
          <span className="small muted">Your plan</span>
          <span className="row"><h2>{cur.name}</h2><Chip s={m.status} />{m.cancelAtEnd && <span className="chip warn">Cancelled, no renewal</span>}</span>
          <span className="small">{m.expiry ? `${m.cancelAtEnd ? 'Ends' : 'Active until'} ${fDay(m.expiry)}; then the Free plan.` : 'Free, no end date.'}</span>
        </div>
        {m.plan !== 'free' && m.status === 'ACTIVE' && (m.cancelAtEnd
          ? <button className="btn" type="button" onClick={() => cancelPlan(true)}>Keep my membership</button>
          : <button className="btn ghost danger" type="button" onClick={() => cancelPlan(false)}>Cancel membership</button>)}
      </div>
      {m.status === 'SUSPENDED' && <div className="notice bad" style={{ marginBottom: 20 }}>Your membership is suspended: no member prices or members-only events until an administrator reinstates it.</div>}
      <div className="grid plans">
        {S.plans.filter(p => p.active).map(p => {
          const isCur = m.plan === p.id && m.status === 'ACTIVE';
          return (
            <div key={p.id} className={`card plan${isCur ? ' cur' : ''}`}>
              <span className="row"><h2>{p.name}</h2>{isCur && <span className="chip acc">Your plan</span>}</span>
              <b>{p.price ? <>{money(p.price)}<span className="small muted"> a year</span></> : 'Free'}</b>
              <ul>{p.benefits.map(x => <li key={x}>{x}</li>)}</ul>
              {isCur
                ? <p className="small muted">{m.expiry ? 'Until ' + fDay(m.expiry) : 'No end date'}</p>
                : <button className={`btn${p.price > cur.price ? ' pri' : ''}`} type="button" onClick={() => buyPlan(p.id)}>{p.price ? `${p.price > cur.price ? 'Upgrade to ' : 'Switch to '}${p.name}` : 'Move to Free'}</button>}
            </div>
          );
        })}
      </div>
      <div className="card scroll" style={{ marginTop: 20 }}>
        <h2 style={{ marginBottom: 8 }}>History</h2>
        <table className="stack">
          <thead><tr><th>Plan</th><th>Status</th><th>From</th><th>To</th></tr></thead>
          <tbody>
            {[m, ...u.history].map((h, i) => (
              <tr key={i}><td data-l="Plan">{planOf(h.plan)?.name}</td><td data-l="Status"><Chip s={h.status} /></td><td data-l="From">{fDay(h.start)}</td><td data-l="To">{h.expiry ? fDay(h.expiry) : '—'}</td></tr>
            ))}
          </tbody>
        </table>
        {pays.length > 0 && <p className="small muted" style={{ marginTop: 12 }}>Payments: {pays.map(p => `${money(p.amount)} on ${fDay(p.at)} (${label(p.status)})`).join(' · ')}</p>}
      </div>
      <p className="tiny muted" style={{ marginTop: 16 }}>Sample prices in Canadian dollars. Payment runs through Square in sandbox mode.</p>
    </>
  );
}

export function Inbox() {
  const u = me(), list = S.notes.filter(n => n.uid === u.id);
  // remember what was unread when the inbox opened, then mark everything read
  const [unreadAtOpen] = useState(() => new Set(list.filter(n => !n.read).map(n => n.id)));
  useEffect(() => {
    const unread = S.notes.filter(n => n.uid === u.id && !n.read);
    if (unread.length) { unread.forEach(n => { n.read = true; }); commit(); }
  }, [u.id, list.length]);
  const openLink = l => {
    if (l.act === 'openevent') go('event', l.id);
    if (l.act === 'ticketlink') { go('bookings'); openTicket(l.id); }
  };
  return (
    <>
      <Head title="Inbox">Every notice here also goes out by email.</Head>
      <div className="card list">
        {list.length ? list.map(n => (
          <div key={n.id}>
            <span className={`dot${unreadAtOpen.has(n.id) || !n.read ? '' : ' read'}`} />
            <div className="grid" style={{ gap: 2, flex: 1 }}><b>{n.title}</b><span className="small">{n.body}</span><span className="tiny muted">{fDT(n.at)}</span></div>
            {n.link && n.link.act !== 'verify' && <button className="btn sm" type="button" onClick={() => openLink(n.link)}>{n.link.label}</button>}
          </div>
        )) : <Empty>No messages yet.</Empty>}
      </div>
    </>
  );
}

function DetailsForm({ u }) {
  const [fe, setFe] = useState({});
  const submit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const r = API.profile({ name: f.name, phone: f.phone, email: f.email });
    if (r.ok) { setFe({}); toast(r.msg); } else setFe(r.details);
  };
  return (
    <form className="card grid" onSubmit={submit} noValidate>
      <h2>Your details</h2>
      <Field id="p-name" label="Full name" error={fe.name}><Input id="p-name" name="name" defaultValue={u.name} autoComplete="name" error={fe.name} /></Field>
      <Field id="p-phone" label="Phone" error={fe.phone} hint="Optional. Exports leave it out unless a report needs it."><Input id="p-phone" name="phone" type="tel" defaultValue={u.phone} autoComplete="tel" error={fe.phone} /></Field>
      <Field id="p-email" label="Email" error={fe.email} hint={u.pendingEmail ? `Waiting for you to confirm ${u.pendingEmail}; ${u.email} stays in use until then.` : 'Changing it sends a confirmation link to the new address.'}>
        <Input id="p-email" name="email" type="email" defaultValue={u.pendingEmail || u.email} autoComplete="email" error={fe.email} />
      </Field>
      <span className="row">{u.verified ? <span className="chip ok">Email verified</span> : <><span className="chip warn">Not verified</span><button type="button" className="linkbtn" onClick={() => resend(u.id)}>Send a new link</button></>}</span>
      <button className="btn pri" type="submit">Save details</button>
    </form>
  );
}

function PasswordForm() {
  const [fe, setFe] = useState({});
  const submit = e => {
    e.preventDefault();
    const form = e.currentTarget, f = Object.fromEntries(new FormData(form));
    const r = API.changePw(f.cur, f.pw);
    if (r.ok) { setFe({}); form.reset(); toast(r.msg); } else setFe(r.details);
  };
  return (
    <form className="card grid" onSubmit={submit} noValidate>
      <h2>Password</h2>
      <Field id="pw-cur" label="Current password" error={fe.cur}><Input id="pw-cur" name="cur" type="password" autoComplete="current-password" error={fe.cur} /></Field>
      <Field id="pw-new" label="New password" error={fe.pw} hint="At least 12 characters. Your other sessions end when you save."><Input id="pw-new" name="pw" type="password" autoComplete="new-password" error={fe.pw} /></Field>
      <button className="btn" type="submit">Change password</button>
    </form>
  );
}

export function Profile() {
  const u = me(), ss = S.sessions.filter(s => s.uid === u.id);
  const revoke = id => {
    const self = id === S.sid[S.role];
    if (!API.revoke(id).ok) return;
    toast(self ? 'Signed out' : 'Session revoked');
    if (self) { S.role = 'guest'; go('discover'); }
  };
  return (
    <>
      <Head title="Profile and security">Your details, password, two-step sign-in and where you are signed in.</Head>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        <DetailsForm key={u.id} u={u} />
        <PasswordForm key={'pw' + u.id} />
        <div className="card grid">
          <h2>Two-step sign-in</h2>
          {u.mfa ? (
            <><p><span className="chip ok">On</span> Sign-ins ask for a 6-digit code from your authenticator app.</p><button className="btn" type="button" onClick={() => { if (API.mfa(false).ok) toast('Two-step sign-in is off'); }}>Turn off</button></>
          ) : (
            <><p className="small">Add a code from an authenticator app to every sign-in.{isAdmin(u) && S.settings.mfaAdmins && ' Required for administrators.'}</p><button className="btn" type="button" onClick={() => openModal(<MfaSetupModal />)}>Set it up</button></>
          )}
        </div>
        <div className="card grid">
          <h2>Where you are signed in</h2>
          <div className="list">
            {ss.map(s => (
              <div key={s.id}>
                <div className="grid" style={{ gap: 2, flex: 1 }}><b>{s.device}{s.id === S.sid[S.role] && ' · this one'}</b><span className="small muted">Since {fDT(s.created)} · {s.remember ? 'kept 30 days' : 'until the browser closes'}</span></div>
                <button className="btn sm ghost" type="button" onClick={() => revoke(s.id)}>{s.id === S.sid[S.role] ? 'Sign out' : 'Revoke'}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
