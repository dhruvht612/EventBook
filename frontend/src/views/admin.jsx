// Administrator screens (ADM-1, ADM-2, DASH-3, DASH-4).
import { useState } from 'react';
import { S, ev, user, planOf, go, toast, commit, openModal, closeModal, seatsLeft } from '../lib/store';
import { API, fill } from '../lib/server';
import { D, dollars, fDT, fDate, fDay, fmt, label, money } from '../lib/format';
import { Avatar, Chip, Field, Head, Input, Kpi } from '../components/ui';
import { Confirm } from '../components/modals';
import { confirmCancelBooking, exportCsv, newEvent, openMailbox } from '../actions';
import { EventRows } from './organizer';
import { ReportsView } from './Reports';

const HBar = ({ name, pct, value }) => (
  <div className="hbar"><span>{name}</span><span className="meter"><i style={{ width: `${pct}%` }} /></span><span className="num">{value}</span></div>
);
const Bars = ({ items }) => (
  <div className="bars">{items.map((x, i) => <div key={i} style={{ height: `${x.pct}%` }} title={x.title}><span>{x.text}</span></div>)}</div>
);

export function Dash() {
  const up = S.events.filter(e => ['PUBLISHED', 'FULL'].includes(e.status) && e.start > S.now);
  const active = S.users.filter(u => u.membership.status === 'ACTIVE' && u.membership.plan !== 'free').length;
  const days = Array.from({ length: 14 }, (_, i) => { const d0 = S.now - (13 - i) * D; return { d: d0, n: S.bookings.filter(b => b.created > d0 - D && b.created <= d0).length }; });
  const max = Math.max(1, ...days.map(x => x.n));
  const months = Array.from({ length: 6 }, (_, i) => { const end = S.now - (5 - i) * 30 * D; return { end, n: S.payments.filter(p => p.status === 'SUCCEEDED' && p.at > end - 30 * D && p.at <= end).reduce((a, p) => a + p.amount, 0) }; });
  const mmax = Math.max(1, ...months.map(m => m.n));
  const rev = S.payments.filter(p => p.status === 'SUCCEEDED').reduce((a, p) => a + p.amount, 0);
  const cats = [...new Set(S.events.map(e => e.cat))];
  return (
    <>
      <Head title="Dashboard">Bookings, members, seats and money for {S.settings.org}.</Head>
      <div className="grid kpis" style={{ marginBottom: 20 }}>
        <Kpi l="Users" v={S.users.length} />
        <Kpi l="Active paid members" v={active} />
        <Kpi l="Upcoming events" v={up.length} />
        <Kpi l="Confirmed bookings" v={S.bookings.filter(b => b.status === 'CONFIRMED').length} />
        <Kpi l="Open seats" v={up.reduce((a, e) => a + seatsLeft(e), 0)} s="across upcoming events" />
        <Kpi l="Waitlisted" v={S.waitlist.filter(w => w.status === 'WAITING').length} />
        <Kpi l="Revenue" v={dollars(rev)} s="payments received" />
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="card"><h2>Bookings, last 14 days</h2><Bars items={days.map(x => ({ pct: x.n / max * 100, title: `${fDate(x.d)}: ${x.n}`, text: x.n || '' }))} /><div className="axis"><span>{fDate(days[0].d)}</span><span>Today</span></div></div>
        <div className="card"><h2>Revenue, last 6 months</h2><Bars items={months.map(x => ({ pct: x.n / mmax * 100, title: dollars(x.n), text: x.n ? '$' + Math.round(x.n / 100) : '' }))} /><div className="axis"><span>{fmt(months[0].end, { month: 'short' })}</span><span>{fmt(months[5].end, { month: 'short' })}</span></div></div>
        <div className="card"><h2>Membership mix</h2>
          {S.plans.map(p => { const n = S.users.filter(u => u.membership.plan === p.id && u.membership.status === 'ACTIVE').length; return <HBar key={p.id} name={p.name} pct={n / S.users.length * 100} value={n} />; })}
          <p className="tiny muted" style={{ marginTop: 8 }}>Active memberships. Suspended: {S.users.filter(u => u.membership.status === 'SUSPENDED').length}.</p>
        </div>
        <div className="card"><h2>Seats used</h2>{up.length ? up.map(e => <HBar key={e.id} name={e.title} pct={e.reserved / e.cap * 100} value={`${Math.round(e.reserved / e.cap * 100)}%`} />) : <p className="muted small">No upcoming events.</p>}</div>
        <div className="card"><h2>Events by category</h2>{cats.map(c => { const n = S.events.filter(e => e.cat === c).length; return <HBar key={c} name={c} pct={n / S.events.length * 100} value={n} />; })}</div>
      </div>
    </>
  );
}

export function Events() {
  return (
    <>
      <Head title="Events" actions={<button className="btn pri" type="button" onClick={newEvent}>New event</button>}>Every event, every organizer. Admins can manage, edit, check in and cancel any of them.</Head>
      <EventRows list={[...S.events].sort((a, b) => a.start - b.start)} admin />
    </>
  );
}

export function Registrations() {
  const f = S.regF || { eid: '', st: '' };
  const set = (k, v) => { S.regF = { ...f, [k]: v }; commit(); };
  const list = S.bookings.filter(b => (!f.eid || b.eid === f.eid) && (!f.st || b.status === f.st)).sort((a, b) => b.created - a.created);
  return (
    <>
      <Head title="Registrations" actions={
        <div className="row">
          <div className="field"><label htmlFor="rf-e">Event</label><select id="rf-e" value={f.eid} onChange={e => set('eid', e.target.value)}><option value="">All events</option>{S.events.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select></div>
          <div className="field"><label htmlFor="rf-s">Status</label><select id="rf-s" value={f.st} onChange={e => set('st', e.target.value)}><option value="">Any status</option>{['CONFIRMED', 'PENDING_PAYMENT', 'CANCELLED', 'COMPLETED', 'NO_SHOW'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></div>
          <button className="btn" type="button" style={{ alignSelf: 'end' }} onClick={() => exportCsv('registrations', { eid: f.eid }, 'Registrations')}>Export CSV</button>
        </div>}>
        Every booking across every event. Cancelling here refunds paid bookings and moves the waitlist.
      </Head>
      <div className="card scroll">
        <table className="stack">
          <thead><tr><th>Booking</th><th>Member</th><th>Event</th><th className="num">Tickets</th><th className="num">Paid</th><th>Status</th><th>Booked</th><th /></tr></thead>
          <tbody>
            {list.length ? list.slice(0, 80).map(b => { const e = ev(b.eid); return (
              <tr key={b.id}>
                <td data-l="Booking" className="mono">{b.num}</td><td data-l="Member">{user(b.uid).name}</td><td data-l="Event">{e.title}</td>
                <td data-l="Tickets" className="num">{b.qty}</td><td data-l="Paid" className="num">{money(b.final)}</td>
                <td data-l="Status"><Chip s={b.status} /></td><td data-l="Booked">{fDT(b.created)}</td>
                <td>{['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status) && e.start > S.now && <button className="btn sm ghost danger" type="button" onClick={() => confirmCancelBooking(b.id)}>Cancel</button>}</td>
              </tr>); }) : <tr><td className="muted">Nothing matches.</td></tr>}
          </tbody>
        </table>
        {list.length > 80 && <p className="tiny muted">Showing 80 of {list.length}. Export for the rest.</p>}
      </div>
    </>
  );
}

const suspend = id => { if (API.suspend(id).ok) toast('Saved, audited and the member told'); };

export function Members() {
  const list = [...S.users].sort((a, b) => (a.membership.expiry || 9e15) - (b.membership.expiry || 9e15));
  return (
    <>
      <Head title="Members">Every membership with its plan, status and end date. Suspensions are audited and the member is told.</Head>
      <div className="card scroll">
        <table className="stack">
          <thead><tr><th>Member</th><th>Plan</th><th>Status</th><th>Started</th><th>Ends</th><th>Renewal</th><th /></tr></thead>
          <tbody>{list.map(u => { const m = u.membership; return (
            <tr key={u.id}>
              <td data-l="Member"><button type="button" className="linkbtn" onClick={() => go('userdetail', u.id)}>{u.name}</button></td>
              <td data-l="Plan">{planOf(m.plan)?.name}</td><td data-l="Status"><Chip s={m.status} /></td>
              <td data-l="Started">{fDay(m.start)}</td><td data-l="Ends">{m.expiry ? fDay(m.expiry) : '—'}</td>
              <td data-l="Renewal">{m.plan === 'free' ? '—' : m.cancelAtEnd ? 'Cancelled' : (m.expiry - S.now < 15 * D ? 'Reminded' : 'Reminders 14 and 3 days')}</td>
              <td>{m.plan !== 'free' && <button className="btn sm ghost" type="button" onClick={() => suspend(u.id)}>{m.status === 'SUSPENDED' ? 'Reinstate' : 'Suspend'}</button>}</td>
            </tr>); })}</tbody>
        </table>
      </div>
    </>
  );
}

export function Users() {
  const q = (S.uq || '').toLowerCase();
  const list = S.users.filter(u => !q || `${u.name} ${u.email}`.toLowerCase().includes(q));
  const toggle = (u, role, on) => { if (API.role(u.id, role, on).ok) toast('Roles saved and audited'); };
  return (
    <>
      <Head title="Users" actions={<input type="search" placeholder="Search name or email" aria-label="Search users" value={S.uq || ''} onChange={e => { S.uq = e.target.value; commit(); }} style={{ maxWidth: 280 }} />}>
        Every account is a member. Grant organizer or admin on top; each change goes to the audit log.
      </Head>
      <div className="card scroll">
        <table className="stack">
          <thead><tr><th>Name</th><th>Account</th><th>Plan</th><th>Organizer</th><th>Admin</th><th className="num">Bookings</th><th /></tr></thead>
          <tbody>{list.map(u => (
            <tr key={u.id}>
              <td data-l="Name"><span className="who"><Avatar u={u} /><span><button type="button" className="linkbtn" onClick={() => go('userdetail', u.id)}>{u.name}</button><br /><span className="tiny muted">{u.email}</span></span></span></td>
              <td data-l="Account"><Chip s={u.status} /></td>
              <td data-l="Plan">{planOf(u.membership.plan)?.name}</td>
              {['organizer', 'admin'].map(role => (
                <td key={role} data-l={label(role.toUpperCase())}><input type="checkbox" className="cb" aria-label={`${label(role.toUpperCase())} role for ${u.name}`} checked={u.roles.includes(role)} onChange={e => toggle(u, role, e.target.checked)} /></td>
              ))}
              <td data-l="Bookings" className="num">{S.bookings.filter(b => b.uid === u.id && b.status !== 'CANCELLED').length}</td>
              <td><button className="btn sm" type="button" onClick={() => go('userdetail', u.id)}>Open</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

export function UserDetail() {
  const u = user(S.param);
  if (!u) return <Users />;
  const bs = S.bookings.filter(b => b.uid === u.id).sort((a, b) => ev(b.eid).start - ev(a.eid).start), m = u.membership;
  const acts = S.audit.filter(a => a.entity === u.id || a.actor === u.id).slice(0, 8);
  return (
    <>
      <button className="btn ghost sm" type="button" onClick={() => go('users')}>← Users</button>
      <div className="head" style={{ marginTop: 12 }}>
        <div className="who"><Avatar u={u} /><div><h1>{u.name}</h1><p style={{ marginTop: 4 }}>{u.email}{u.phone && ' · ' + u.phone}</p></div></div>
        <div className="row">
          <button className={`btn ${u.status === 'INACTIVE' ? 'pri' : 'ghost danger'}`} type="button" onClick={() => { if (API.userStatus(u.id).ok) toast('Saved and audited'); }}>{u.status === 'INACTIVE' ? 'Activate account' : 'Deactivate account'}</button>
          {m.plan !== 'free' && <button className="btn" type="button" onClick={() => suspend(u.id)}>{m.status === 'SUSPENDED' ? 'Reinstate membership' : 'Suspend membership'}</button>}
        </div>
      </div>
      <div className="grid kpis" style={{ marginBottom: 20 }}>
        <div className="card kpi"><span className="small muted">Account</span><b style={{ fontSize: 20, margin: '8px 0' }}><Chip s={u.status} /></b><span className="small muted">{u.verified ? 'Email verified' : 'Not verified'} · two-step {u.mfa ? 'on' : 'off'}</span></div>
        <div className="card kpi"><span className="small muted">Membership</span><b style={{ fontSize: 24 }}>{planOf(m.plan)?.name}</b><span className="small"><Chip s={m.status} /> {m.expiry ? 'until ' + fDay(m.expiry) : ''}</span></div>
        <div className="card kpi"><span className="small muted">Roles</span><b style={{ fontSize: 20 }}>{u.roles.map(r => label(r.toUpperCase())).join(', ')}</b></div>
        <div className="card kpi"><span className="small muted">Sessions</span><b>{S.sessions.filter(s => s.uid === u.id).length}</b><span className="small muted">Last sign-in {u.lastLogin ? fDT(u.lastLogin) : 'never'}</span></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        <div className="card scroll"><h2 style={{ marginBottom: 8 }}>Bookings</h2>
          <table className="stack"><tbody>
            {bs.length ? bs.map(b => (
              <tr key={b.id}><td data-l="Event">{ev(b.eid).title}<br /><span className="tiny muted">{fDay(ev(b.eid).start)} · {b.num}</span></td><td data-l="Paid" className="num">{money(b.final)}</td><td data-l="Status"><Chip s={b.status} /></td></tr>
            )) : <tr><td className="muted">No bookings.</td></tr>}
          </tbody></table>
        </div>
        <div className="card"><h2 style={{ marginBottom: 8 }}>Membership history</h2>
          <div className="list">
            <div><span style={{ flex: 1 }}>{planOf(m.plan)?.name} · since {fDay(m.start)}</span><Chip s={m.status} /></div>
            {u.history.map((h, i) => <div key={i}><span style={{ flex: 1 }}>{planOf(h.plan)?.name} · {fDay(h.start)} to {h.expiry ? fDay(h.expiry) : '—'}</span><Chip s={h.status} /></div>)}
          </div>
          <h2 style={{ margin: '20px 0 8px' }}>Recent activity</h2>
          <div className="list">{acts.length ? acts.map((a, i) => <div key={i}><span className="small" style={{ flex: 1 }}>{a.detail}</span><span className="tiny muted">{fDate(a.at)}</span></div>) : <p className="muted small">Nothing logged.</p>}</div>
        </div>
      </div>
    </>
  );
}

function PlanCard({ p }) {
  const k = p?.id || 'new', isFree = p?.id === 'free';
  const [v, setV] = useState(() => ({
    name: p?.name || '', price: p ? (p.price / 100).toFixed(2) : '90.00', discount: String(p ? Math.round(p.discount * 100) : 15),
    early: String(p ? p.early : 1), benefits: p ? p.benefits.join('\n') : '', active: !p || p.active,
  }));
  const set = key => e => setV({ ...v, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = () => { const r = API.plan(p?.id || null, v); if (r.ok) toast(r.msg + '. Prices follow at once.'); };
  return (
    <div className="card grid">
      <span className="row"><h2>{p ? p.name : 'New plan'}</h2>{p && <Chip s={p.active ? 'ACTIVE' : 'INACTIVE'} />}</span>
      {p && <p className="small muted">{S.users.filter(u => u.membership.plan === p.id).length} members</p>}
      <Field id={`pn-${k}`} label="Name"><Input id={`pn-${k}`} value={v.name} onChange={set('name')} readOnly={isFree} /></Field>
      {!isFree && <Field id={`pp-${k}`} label="Price a year ($)"><Input id={`pp-${k}`} type="number" min="0" step="0.01" value={v.price} onChange={set('price')} /></Field>}
      <Field id={`d-${k}`} label="Event discount (%)"><Input id={`d-${k}`} type="number" min="0" max="90" value={v.discount} onChange={set('discount')} disabled={isFree} /></Field>
      <Field id={`e-${k}`} label="Early access (days)"><Input id={`e-${k}`} type="number" min="0" max="30" value={v.early} onChange={set('early')} disabled={isFree} /></Field>
      <Field id={`b-${k}`} label="Benefits, one a line"><textarea id={`b-${k}`} rows={3} value={v.benefits} onChange={set('benefits')} /></Field>
      <label className="check"><input type="checkbox" checked={v.active} onChange={set('active')} disabled={isFree} /> On offer to members</label>
      <button className={`btn${p ? '' : ' pri'}`} type="button" onClick={save}>{p ? 'Save ' + p.name : 'Create plan'}</button>
    </div>
  );
}

export function Plans() {
  return (
    <>
      <Head title="Membership plans">Change a discount or early access and member prices change at once. An inactive plan keeps its members but is not sold.</Head>
      <div className="grid plans">
        {S.plans.map(p => <PlanCard key={p.id} p={p} />)}
        <PlanCard key={`new-${S.plans.length}`} p={null} />
      </div>
    </>
  );
}

export function Payments() {
  const list = [...S.payments].sort((a, b) => b.at - a.at);
  const sum = st => list.filter(p => p.status === st).reduce((a, p) => a + p.amount, 0);
  const refund = id => openModal(
    <Confirm title="Refund this payment?" yes="Refund" onYes={() => { const r = API.refund(id); closeModal(); if (r.ok) toast(r.msg); }}>
      The money goes back to the member's card through Square. The booking stays as it is.
    </Confirm>,
  );
  return (
    <>
      <Head title="Payments">Every charge through Square (sandbox). Webhooks are signature-checked and processed once; refunds follow each event's policy.</Head>
      <div className="grid kpis" style={{ marginBottom: 20 }}>
        <Kpi l="Received" v={dollars(sum('SUCCEEDED'))} /><Kpi l="Refunded" v={dollars(sum('REFUNDED'))} /><Kpi l="Failed" v={list.filter(p => p.status === 'FAILED').length} />
      </div>
      <div className="card scroll">
        <table className="stack">
          <thead><tr><th>When</th><th>Member</th><th>For</th><th className="num">Amount</th><th>Status</th><th>Transaction</th><th /></tr></thead>
          <tbody>{list.slice(0, 80).map(p => (
            <tr key={p.id}>
              <td data-l="When">{fDT(p.at)}</td><td data-l="Member">{user(p.uid).name}</td>
              <td data-l="For">{p.kind === 'membership' ? 'Membership' : ev(S.bookings.find(b => b.id === p.bid).eid).title}</td>
              <td data-l="Amount" className="num">{money(p.amount)}</td><td data-l="Status"><Chip s={p.status} /></td>
              <td data-l="Txn" className="mono">{p.txn}</td>
              <td>{p.status === 'SUCCEEDED' && <button className="btn sm ghost" type="button" onClick={() => refund(p.id)}>Refund</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

export const Reports = () => <ReportsView events={S.events} />;

function TemplateEditor({ t }) {
  const [subject, setSubject] = useState(t.subject), [body, setBody] = useState(t.body);
  const sample = { org: S.settings.org, name: 'Margot', event: 'Pottery evening', when: fDT(ev('pottery')?.start ?? S.now), where: 'The Clay Room, Ossington Ave', tickets: '2 tickets', amount: '$60.00', until: fDT(S.now + D), detail: 'A full refund of $60.00 is on its way.', lead: 'tomorrow', plan: 'Standard', days: 14 };
  const vars = [...new Set((subject + body).match(/\{\{\w+\}\}/g) || [])];
  return (
    <div className="split">
      <div className="card grid">
        <div className="field"><label htmlFor="tpl">Template</label>
          <select id="tpl" value={t.id} onChange={e => { S.tpl = e.target.value; commit(); }}>{S.templates.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="tpl-s">Subject</label><input id="tpl-s" value={subject} onChange={e => setSubject(e.target.value)} /></div>
        <div className="field"><label htmlFor="tpl-b">Body</label><textarea id="tpl-b" rows={5} value={body} onChange={e => setBody(e.target.value)} /></div>
        <p className="tiny muted">Variables: {vars.length ? vars.map(x => <span key={x} className="mono">{x} </span>) : 'none'}. Also available: {'{{org}} {{name}}'}.</p>
        <div className="row">
          <button className="btn pri" type="button" onClick={() => { if (API.template(t.id, subject, body).ok) toast('Template saved'); }}>Save template</button>
          <button className="btn" type="button" onClick={() => { setSubject(t.subject); setBody(t.body); }}>Discard</button>
        </div>
      </div>
      <div className="card grid">
        <h2>Preview</h2>
        <div className="notice"><b>{fill(subject, sample)}</b><br /><span className="small">{fill(body, sample)}</span></div>
        <h2 style={{ marginTop: 8 }}>Sent</h2>
        <p className="small muted">{S.mail.length} emails so far, {S.mail.filter(m => m.type === t.id).length} from this template. Event reminders go out 24 and 2 hours before each event.</p>
        <button className="btn" type="button" onClick={openMailbox}>Open the demo mailbox</button>
      </div>
    </div>
  );
}

export function Notifications() {
  const t = S.templates.find(x => x.id === (S.tpl || 'booking_confirmed'));
  return (
    <>
      <Head title="Notifications">Each email and in-app notice comes from one of these templates. Edit the words; the variables in double braces fill in.</Head>
      <TemplateEditor key={t.id} t={t} />
    </>
  );
}

export function Audit() {
  const f = S.auditF || '';
  const list = S.audit.filter(a => !f || a.action.startsWith(f));
  return (
    <>
      <Head title="Audit log" actions={
        <div className="field"><label htmlFor="auf">Show</label>
          <select id="auf" value={f} onChange={e => { S.auditF = e.target.value; commit(); }}>
            <option value="">Everything</option>
            {['role', 'user', 'membership', 'event', 'booking', 'checkin', 'waitlist', 'plan', 'payment', 'settings', 'export'].map(x => <option key={x} value={x}>{label(x.toUpperCase())}</option>)}
          </select>
        </div>}>
        Read-only and insert-only. Role, membership, event, cancellation, check-in, plan, payment, settings and export changes.
      </Head>
      <div className="card scroll">
        <table className="stack">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th></tr></thead>
          <tbody>{list.length ? list.map((a, i) => (
            <tr key={i}><td data-l="When">{fDT(a.at)}</td><td data-l="Who">{user(a.actor)?.name || (a.actor === 'system' ? 'System job' : a.actor)}</td><td data-l="Action"><span className="mono">{a.action}</span></td><td data-l="What">{a.detail}</td></tr>
          )) : <tr><td className="muted">Nothing yet.</td></tr>}</tbody>
        </table>
      </div>
    </>
  );
}

export function Settings() {
  const s = S.settings;
  const [fe, setFe] = useState({});
  const submit = e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), v = k => String(f.get(k) ?? '');
    const r = API.settings({ org: v('org'), holdMin: v('holdMin'), offerH: v('offerH'), cutoffH: v('cutoffH'), mfaAdmins: f.get('mfaAdmins') === 'on', ssoEnabled: f.get('sso') === 'on', issuer: v('issuer'), clientId: v('clientId') });
    if (r.ok) { setFe({}); toast('Settings saved'); } else setFe(r.details);
  };
  return (
    <>
      <Head title="Settings">Rules for the whole organization. Changes are audited.</Head>
      <form className="grid" onSubmit={submit} noValidate style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="card grid"><h2>Organization</h2>
          <Field id="st-org" label="Name" error={fe.org} hint="Shown on tickets and emails."><Input id="st-org" name="org" defaultValue={s.org} error={fe.org} /></Field>
          <Field id="st-cur" label="Currency" hint="One currency per deployment."><input id="st-cur" value="CAD" readOnly /></Field>
        </div>
        <div className="card grid"><h2>Booking</h2>
          <Field id="st-hold" label="Seat hold while paying (minutes)" error={fe.holdMin}><Input id="st-hold" name="holdMin" type="number" min="5" max="30" defaultValue={s.holdMin} error={fe.holdMin} /></Field>
          <Field id="st-offer" label="Waitlist offer window (hours)" error={fe.offerH}><Input id="st-offer" name="offerH" type="number" min="1" max="72" defaultValue={s.offerH} error={fe.offerH} /></Field>
          <Field id="st-cut" label="Default cancellation cut-off (hours)" error={fe.cutoffH} hint="New events start with this; each event can change it."><Input id="st-cut" name="cutoffH" type="number" min="0" max="168" defaultValue={s.cutoffH} error={fe.cutoffH} /></Field>
        </div>
        <div className="card grid"><h2>Security</h2>
          <label className="check"><input type="checkbox" name="mfaAdmins" defaultChecked={s.mfaAdmins} /> Require two-step sign-in for administrators</label>
          <p className="small muted">Passwords: Argon2id, 12 characters minimum, breached-password check. Lockout after 5 failed sign-ins for 15 minutes.</p>
          <h3 style={{ marginTop: 8 }}>Single sign-on (OIDC)</h3>
          <label className="check"><input type="checkbox" name="sso" defaultChecked={s.sso.enabled} /> Let members sign in with our identity provider</label>
          <Field id="st-iss" label="Issuer URL" error={fe.issuer}><Input id="st-iss" name="issuer" type="url" placeholder="https://login.example.org" defaultValue={s.sso.issuer} error={fe.issuer} /></Field>
          <Field id="st-cid" label="Client ID" error={fe.clientId}><Input id="st-cid" name="clientId" defaultValue={s.sso.clientId} error={fe.clientId} /></Field>
        </div>
        <div className="row" style={{ gridColumn: '1/-1' }}><button className="btn pri" type="submit">Save settings</button></div>
      </form>
    </>
  );
}
