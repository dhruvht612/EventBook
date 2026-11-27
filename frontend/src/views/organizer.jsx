// Organizer screens: my events, manage one event, check-in (EVT-*, CHK-*, WL).
import { useState } from 'react';
import { S, ev, me, user, planOf, go, toast, commit, openModal, closeModal, owns, isAdmin } from '../lib/store';
import { API } from '../lib/server';
import { startWizard } from '../lib/rules';
import { fDT, fDate, fTime, dollars, money } from '../lib/format';
import { Avatar, Chip, Empty, Head } from '../components/ui';
import { Confirm } from '../components/modals';
import { confirmCancelBooking, editEvent, exportCsv, manage, newEvent } from '../actions';
import { Wizard } from './Wizard';
import { ReportsView } from './Reports';

export function EventRows({ list, admin }) {
  if (!list.length) return <Empty>No events yet.</Empty>;
  const u = me();
  return (
    <div className="card scroll">
      <table className="stack">
        <thead><tr><th>Event</th><th>When</th>{admin && <th>Organizer</th>}<th className="num">Booked</th><th className="num">Waitlist</th><th>Status</th><th /></tr></thead>
        <tbody>{list.map(e => (
          <tr key={e.id}>
            <td data-l="Event"><b>{e.title}</b><br /><span className="tiny muted">{e.type} · {e.city}{(e.coorgs || []).includes(u.id) && ' · co-organizer'}</span></td>
            <td data-l="When">{fDT(e.start)}</td>
            {admin && <td data-l="Organizer">{user(e.org).name}</td>}
            <td data-l="Booked" className="num">{e.reserved} / {e.cap}</td>
            <td data-l="Waitlist" className="num">{S.waitlist.filter(w => w.eid === e.id && w.status === 'WAITING').length}</td>
            <td data-l="Status"><Chip s={e.status} /></td>
            <td><button className="btn sm" type="button" onClick={() => manage(e.id)}>{e.status === 'DRAFT' ? 'Edit draft' : 'Manage'}</button></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function MyEvents() {
  const u = me();
  const list = S.events.filter(e => e.org === u.id || (e.coorgs || []).includes(u.id)).sort((a, b) => a.start - b.start);
  return (
    <>
      <Head title="My events" actions={<button className="btn pri" type="button" onClick={newEvent}>New event</button>}>You see and change only the events you organize or co-organize.</Head>
      <EventRows list={list} />
    </>
  );
}

const ticketsOf = list => list.reduce((a, b) => a + b.qty, 0);

export function Manage() {
  const e = ev(S.param), u = me();
  const [cap, setCap] = useState(e ? String(e.cap) : '');
  if (!e) return <MyEvents />;
  if (e.status === 'DRAFT') { startWizard(e); return <Wizard />; } // idempotent for the same draft

  const regs = S.bookings.filter(b => b.eid === e.id).sort((a, b) => a.created - b.created);
  const wls = S.waitlist.filter(w => w.eid === e.id).sort((a, b) => a.pos - b.pos);
  const can = owns(u, e), live = !['CANCELLED', 'COMPLETED'].includes(e.status), owner = isAdmin(u) || e.org === u.id;
  const others = S.users.filter(x => x.roles.includes('organizer') && x.id !== e.org && !(e.coorgs || []).includes(x.id));

  const duplicate = () => { const r = API.duplicate(e.id); if (r.ok) { toast('Draft copy made: finish it in the wizard.'); manage(r.id); } };
  const cancelEvent = () => openModal(
    <Confirm title={`Cancel ${e.title}?`} yes="Cancel the event" onYes={() => { const r = API.cancelEvent(e.id); closeModal(); if (r.ok) toast(r.msg); }}>
      Everyone booked or waiting is told by email and in the app, and every paid booking is refunded in full. This cannot be undone.
    </Confirm>,
  );
  const revenue = regs.filter(b => ['CONFIRMED', 'COMPLETED', 'NO_SHOW'].includes(b.status)).reduce((a, b) => a + b.final, 0);

  return (
    <>
      <button className="btn ghost sm" type="button" onClick={() => go(S.role === 'admin' ? 'events' : 'myevents')}>← Events</button>
      <div className="head" style={{ marginTop: 12 }}>
        <div><span className="row"><Chip s={e.status} /><span className="small muted">{fDT(e.start)} · {e.venue}</span></span><h1 style={{ marginTop: 8 }}>{e.title}</h1></div>
        {can && (
          <div className="row">
            {live && <><button className="btn" type="button" onClick={() => editEvent(e.id)}>Edit details</button><button className="btn" type="button" onClick={() => go('checkin', e.id)}>Check-in</button></>}
            <button className="btn" type="button" onClick={() => exportCsv('registrations', { eid: e.id }, 'Registrations: ' + e.title)}>Export CSV</button>
            <button className="btn" type="button" onClick={duplicate}>Duplicate</button>
            {live && <button className="btn ghost danger" type="button" onClick={cancelEvent}>Cancel event</button>}
          </div>
        )}
      </div>
      <div className="grid kpis" style={{ marginBottom: 20 }}>
        <div className="card kpi"><span className="small muted">Seats taken</span><b>{e.reserved} / {e.cap}</b><div className="meter"><i style={{ width: `${Math.min(100, e.reserved / e.cap * 100)}%` }} /></div></div>
        <div className="card kpi"><span className="small muted">Waiting</span><b>{wls.filter(w => w.status === 'WAITING').length}</b></div>
        <div className="card kpi"><span className="small muted">Checked in</span><b>{ticketsOf(regs.filter(b => b.checkin === 'CHECKED_IN'))}</b></div>
        <div className="card kpi"><span className="small muted">No-shows</span><b>{ticketsOf(regs.filter(b => b.status === 'NO_SHOW'))}</b></div>
        <div className="card kpi"><span className="small muted">Revenue</span><b>{dollars(revenue)}</b></div>
      </div>
      {can && live && (
        <div className="card row" style={{ marginBottom: 20 }}>
          <div className="field" style={{ width: 160 }}><label htmlFor="cap">Capacity</label><input id="cap" type="number" inputMode="numeric" min="1" value={cap} onChange={x => setCap(x.target.value)} /></div>
          <button className="btn" type="button" style={{ alignSelf: 'end' }} onClick={() => { if (API.capacity(e.id, +cap).ok) toast('Capacity saved'); }}>Save capacity</button>
          <p className="small muted" style={{ flex: 1, minWidth: 200, alignSelf: 'end' }}>Raise it any time and the waitlist moves up. Lower it only to the seats already booked.</p>
          {owner && (
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor="coorg">Co-organizers</label>
              <select id="coorg" value="" onChange={x => { if (x.target.value && API.coorg(e.id, x.target.value, true).ok) toast('Co-organizer added: they can now manage this event'); }}>
                <option value="">Add an organizer</option>
                {others.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <span className="row">{(e.coorgs || []).map(id => (
                <span key={id} className="chip plain">{user(id).name} <button type="button" className="linkbtn" aria-label={`Remove ${user(id).name}`} onClick={() => { if (API.coorg(e.id, id, false).ok) toast('Co-organizer removed'); }}>×</button></span>
              ))}</span>
            </div>
          )}
        </div>
      )}
      <div className="split">
        <div className="card scroll">
          <h2 style={{ marginBottom: 12 }}>Registrations</h2>
          <table className="stack">
            <thead><tr><th>Member</th><th className="num">Tickets</th><th className="num">Paid</th><th>Status</th><th>Check-in</th><th /></tr></thead>
            <tbody>
              {regs.length ? regs.map(b => { const m = user(b.uid); return (
                <tr key={b.id}>
                  <td data-l="Member"><span className="who"><Avatar u={m} /><span>{m.name}<br /><span className="tiny muted">{b.num} · {planOf(b.plan)?.name}</span></span></span></td>
                  <td data-l="Tickets" className="num">{b.qty}</td><td data-l="Paid" className="num">{money(b.final)}</td>
                  <td data-l="Status"><Chip s={b.status} /></td>
                  <td data-l="Check-in">{b.checkin === 'CHECKED_IN' ? <Chip s="CHECKED_IN" /> : '—'}</td>
                  <td>{can && ['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status) && e.start > S.now && <button className="btn sm ghost danger" type="button" onClick={() => confirmCancelBooking(b.id)}>Cancel</button>}</td>
                </tr>); }) : <tr><td className="muted">No registrations yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Waitlist</h2>
          {wls.length ? (
            <div className="list">{wls.map(w => { const m = user(w.uid); return (
              <div key={w.id}>
                <span className="who" style={{ flex: 1 }}><Avatar u={m} /><span>{w.pos}. {m.name}<br /><span className="tiny muted">Joined {fDate(w.joined)}</span></span></span>
                <span className="grid" style={{ justifyItems: 'end', gap: 6 }}>
                  <Chip s={w.status} />
                  {w.status === 'OFFERED' && <span className="tiny muted">until {fDT(w.offerUntil)}</span>}
                  {can && ['WAITING', 'OFFERED'].includes(w.status) && <button className="btn sm ghost" type="button" onClick={() => { if (API.removeWait(w.id).ok) toast('Removed from the waitlist'); }}>Remove</button>}
                </span>
              </div>); })}</div>
          ) : <p className="muted small">Nobody is waiting.</p>}
          <p className="tiny muted" style={{ marginTop: 12 }}>Members see only their own place in line. A freed seat goes to the first person still eligible, for {S.settings.offerH} hours; move the demo clock to see an offer expire.</p>
        </div>
      </div>
    </>
  );
}

function ScanCard({ e, regs }) {
  const [pick, setPick] = useState(''), [code, setCode] = useState(''), [res, setRes] = useState(null);
  const scan = () => {
    const tok = code.trim() || pick;
    if (!tok) { setRes({ ok: false, local: true, message: 'Choose a ticket or type its code.' }); return; }
    setRes(API.scan(tok, e.id));
  };
  const b = res?.ok ? S.bookings.find(x => x.id === res.bid) : null;
  return (
    <div className="card grid">
      <h2>Scan a ticket</h2>
      <p className="small muted">On a phone this opens the camera. In this preview, pick a ticket to stand in for the scan, or type its code.</p>
      <div className="field">
        <label htmlFor="scanpick">Ticket in front of the camera</label>
        <select id="scanpick" value={pick} onChange={x => setPick(x.target.value)}>
          <option value="">Choose a ticket</option>
          {regs.map(r => <option key={r.id} value={r.token}>{user(r.uid).name} · {r.num}</option>)}
          <option value="ZZZ999WRONG">A ticket for another event</option>
        </select>
      </div>
      <div className="field"><label htmlFor="scancode">Or type the code</label><input id="scancode" className="mono" autoComplete="off" value={code} onChange={x => setCode(x.target.value)} /></div>
      <button className="btn pri" type="button" onClick={scan}>Scan</button>
      {res && (res.local ? <p className="err">{res.message}</p> : res.ok && b ? (
        <div className={`notice${b.checkin === 'CHECKED_IN' ? '' : ' ok'}`} style={{ marginTop: 12 }}>
          <b style={{ fontSize: 22 }}>{res.show}</b> · {res.qty} ticket{res.qty > 1 ? 's' : ''}<br />
          {b.checkin === 'CHECKED_IN' ? `Already checked in at ${fTime(b.checkedAt)}` : <button className="btn pri" type="button" style={{ marginTop: 10 }} onClick={() => { if (API.checkin(b.id).ok) toast('Checked in'); }}>Check in</button>}
        </div>
      ) : <div className="notice bad" style={{ marginTop: 12 }}>{res.message}</div>)}
    </div>
  );
}

export function Checkin() {
  const u = me();
  const mine = S.events
    .filter(e => owns(u, e) && (S.role === 'admin' || !isAdmin(u) || e.org === u.id || (e.coorgs || []).includes(u.id)) && ['PUBLISHED', 'FULL'].includes(e.status))
    .sort((a, b) => a.start - b.start);
  const picked = ev(S.param);
  const e = picked && mine.includes(picked) ? picked : mine[0];
  if (!e) return <><Head title="Check-in" /><Empty>No open events to check in.</Empty></>;
  const regs = S.bookings.filter(b => b.eid === e.id && b.status === 'CONFIRMED');
  const q = (S.ciq || '').toLowerCase();
  const shown = regs.filter(b => !q || user(b.uid).name.toLowerCase().includes(q) || b.num.toLowerCase().includes(q));
  const inCount = ticketsOf(regs.filter(b => b.checkin === 'CHECKED_IN')), total = ticketsOf(regs);
  return (
    <>
      <Head title="Check-in" actions={
        <div className="field" style={{ minWidth: 260 }}>
          <label htmlFor="cievent">Event</label>
          <select id="cievent" value={e.id} onChange={x => { S.param = x.target.value; commit(); }}>
            {mine.map(x => <option key={x.id} value={x.id}>{x.title} · {fDate(x.start)}</option>)}
          </select>
        </div>}>
        Scan the QR on each ticket, or search by name or booking number. Only the first name, last initial and ticket count show.
      </Head>
      <div className="split">
        <ScanCard key={e.id} e={e} regs={regs} />
        <div className="card scroll">
          <span className="row" style={{ justifyContent: 'space-between' }}><h2>{inCount} of {total} in</h2><span className="meter" style={{ width: 140 }}><i style={{ width: `${total ? inCount / total * 100 : 0}%` }} /></span></span>
          <input type="search" placeholder="Search by name or EB-number" aria-label="Search attendees" value={S.ciq || ''} onChange={x => { S.ciq = x.target.value; commit(); }} style={{ margin: '12px 0' }} />
          <table className="stack">
            <tbody>
              {shown.length ? shown.map(b => { const n = user(b.uid).name.split(' '); return (
                <tr key={b.id}>
                  <td data-l="Name"><b>{n[0]} {(n[1] || ' ')[0]}.</b> <span className="tiny muted">{b.num}</span></td>
                  <td data-l="Tickets" className="num">{b.qty} ticket{b.qty > 1 ? 's' : ''}</td>
                  <td>{b.checkin === 'CHECKED_IN'
                    ? <span className="row"><Chip s="CHECKED_IN" /><button className="btn sm ghost" type="button" onClick={() => { if (API.checkin(b.id, true).ok) toast('Check-in undone'); }}>Undo</button></span>
                    : <button className="btn sm" type="button" onClick={() => { if (API.checkin(b.id).ok) toast('Checked in'); }}>Check in</button>}</td>
                </tr>); }) : <tr><td className="muted">Nobody matches.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export const OrgReports = () => <ReportsView events={S.events.filter(e => owns(me(), e))} />;
