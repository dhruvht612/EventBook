// App chrome: top bar with role switch and demo clock, sidebar, server log, toasts, modal host.
import { Fragment, useEffect, useRef, useState } from 'react';
import { S, ui, me, user, ROLES, NAV, ACTIVE_NAV, dismissModal, toast } from '../lib/store';
import { advance } from '../lib/server';
import { H, fDT } from '../lib/format';
import { logout, navTo, openMailbox, resetDemo, switchRole } from '../actions';

export function TopBar() {
  const unreadMail = S.mail.filter(m => !m.read).length;
  const moveClock = e => {
    const hours = +e.target.value; if (!hours) return;
    const done = advance(hours * H);
    toast(`Clock moved to ${fDT(S.now)}. ${done.length ? `${done.length} job${done.length > 1 ? 's' : ''} ran: see the server log.` : 'Nothing was due.'}`);
  };
  return (
    <header className="top">
      <div className="brand">EventBook <i>Demo · sample data</i></div>
      <div className="clockbox">
        <span>Demo clock <b>{fDT(S.now)}</b></span>
        <select aria-label="Move the demo clock" value="" onChange={moveClock}>
          <option value="">Move time ahead</option><option value="1">1 hour</option><option value="24">1 day</option><option value="168">1 week</option><option value="720">30 days</option>
        </select>
      </div>
      <div className="roles" role="group" aria-label="View the app as">
        {ROLES.map(([id, name, note]) => {
          const u = user(S.current[id]);
          return <button key={id} type="button" aria-pressed={S.role === id} onClick={() => switchRole(id)}>{name}<small>{note || (u ? u.name : 'Signed out')}</small></button>;
        })}
      </div>
      <button className="btn sm" type="button" onClick={openMailbox}>Mailbox <span className="badge">{unreadMail}</span></button>
      <button className="btn sm ghost" type="button" onClick={resetDemo}>Reset demo</button>
    </header>
  );
}

export function Sidebar() {
  const u = me();
  const unread = u ? S.notes.filter(n => n.uid === u.id && !n.read).length : 0;
  let active = ACTIVE_NAV[S.view];
  if (active && typeof active === 'object') active = active[S.role];
  active = active || S.view;
  return (
    <nav className="side" aria-label="Sections">
      <p className="lbl">{ROLES.find(r => r[0] === S.role)[1]}</p>
      {NAV[S.role].map(([id, text]) => (
        <button key={id} type="button" onClick={() => navTo(id)} aria-current={active === id ? 'page' : undefined}>
          {text}{id === 'inbox' && unread > 0 && <span className="badge">{unread}</span>}
        </button>
      ))}
      <p className="foot">
        {u ? <>Signed in as {u.name}<br />Roles: {u.roles.join(', ')}{S.role === 'member' && <><br /><button type="button" className="linkbtn" onClick={logout}>Sign out</button></>}</> : 'Not signed in'}
      </p>
    </nav>
  );
}

export function ServerLog() {
  const [open, setOpen] = useState(false);
  return (
    <aside className="log" aria-label="Server log">
      <button className="btn sm" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Server log <span className="badge">{S.log.length}</span></button>
      {open && (
        <div className="panel">
          {S.log.length ? S.log.map((l, i) => (
            <div className="entry" key={l.t + ':' + i}>
              <span className="mono"><b>{l.method}</b> {l.path}</span>
              <span><span className={`mono ${l.http < 400 ? 'c2' : 'c4'}`}>{l.http}{l.code ? ' ' + l.code : ''}</span> · {l.msg}</span>
            </div>
          )) : <p className="entry muted">Every action calls the server, which checks the rules again. Its answers and the background jobs show here.</p>}
        </div>
      )}
    </aside>
  );
}

export function Toasts() {
  return (
    <div id="toasts" aria-live="polite">
      {ui.toasts.map(t => (
        <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>
          <span>{t.msg}{t.code && <><br /><span className="mono">{t.code}</span></>}</span>
        </div>
      ))}
    </div>
  );
}

export function ModalHost() {
  const m = ui.modal;
  const ref = useRef(null);
  useEffect(() => {
    if (!m) return undefined;
    ref.current?.querySelector('input:not([readonly]),button,textarea')?.focus();
    const onKey = e => { if (e.key === 'Escape') dismissModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [m?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return null;
  return (
    <div className="scrim" onClick={e => { if (e.target === e.currentTarget) dismissModal(); }}>
      <div ref={ref} className={`modal${m.wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <Fragment key={m.key}>{m.el}</Fragment>
      </div>
    </div>
  );
}
