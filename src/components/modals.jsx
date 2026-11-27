import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { S, ev, user, planOf, closeModal, toast } from '../lib/store';
import { API, api } from '../lib/server';
import { totp } from '../lib/rules';
import { money, fDT, fDay, D, pad, downloadFile } from '../lib/format';
import { Chip } from './ui';
import { handleLink, openTicket, signedIn, textModal } from '../actions';

export function Confirm({ title, children, yes, no = 'Keep it', onYes }) {
  return (
    <>
      <h2>{title}</h2>
      <p>{children}</p>
      <div className="row"><button className="btn pri" type="button" onClick={onYes}>{yes}</button><button className="btn" type="button" onClick={closeModal}>{no}</button></div>
    </>
  );
}

/* ---- checkout: booking hold or membership (BKG-3, MEM-2) */
export function PayModal({ kind, id }) {
  const isB = kind === 'booking';
  const b = isB ? S.bookings.find(x => x.id === id) : null;
  const u = isB ? null : user(id);
  const p = u ? planOf(u.membership.plan) : null;
  const [card, setCard] = useState('4111 1111 1111 1111');
  const [error, setError] = useState('');
  const [left, setLeft] = useState(() => (b?.holdUntil ? Math.max(0, b.holdUntil - Date.now()) : 0));

  useEffect(() => {
    if (!isB) return undefined;
    const t = setInterval(() => {
      const bk = S.bookings.find(x => x.id === id);
      if (!bk || bk.status !== 'PENDING_PAYMENT' || !bk.holdUntil) return;
      const l = Math.max(0, bk.holdUntil - Date.now());
      setLeft(l);
      if (!l) {
        clearInterval(t);
        API.expireHold(id); closeModal();
        toast('The hold ran out, so the seats went back on sale.');
      }
    }, 500);
    return () => clearInterval(t);
  }, [id, isB]);

  if (isB && !b) return null;
  if (!isB && !p) return null;

  const pay = () => {
    const r = API.pay(kind, id, card);
    if (r.ok) {
      closeModal();
      if (isB) { toast('Paid. Booking confirmed and ticket sent.'); openTicket(id); } else toast('Paid. Your membership is active.');
    } else if (r.code === 'VALIDATION_FAILED') setError(r.message);
    else closeModal();
  };
  const abandon = () => { if (isB) API.abandonCheckout(id); else API.abandonPlan(); closeModal(); };
  const expireNow = () => { b.holdUntil = Date.now(); };

  return (
    <>
      <h2>Pay for {isB ? ev(b.eid).title : `${p.name} membership`}</h2>
      {isB ? (
        <>
          <div className="notice">Seats held for <span className="hold">{Math.floor(left / 60e3)}:{pad(Math.floor(left / 1e3) % 60)}</span>. If the time runs out they go back on sale.</div>
          <dl className="kv">
            <dt>Tickets</dt><dd>{b.qty}</dd>
            <dt>Price</dt><dd>{money(b.orig)}</dd>
            <dt>Discount</dt><dd>{b.discount ? `−${money(b.discount)} · ${b.how}` : 'None'}</dd>
            <dt>Total</dt><dd><b>{money(b.final)}</b></dd>
          </dl>
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Plan</dt><dd>{p.name}, one year</dd>
            <dt>Runs</dt><dd>{fDay(S.now)} to {fDay(S.now + 365 * D)}</dd>
            <dt>Total</dt><dd><b>{money(p.price)}</b></dd>
          </dl>
          <p className="small muted">No auto-renew: we remind you 14 and 3 days before it ends.</p>
        </>
      )}
      <div className="field">
        <label htmlFor="card">Card number (Square sandbox)</label>
        <input id="card" inputMode="numeric" autoComplete="off" value={card} onChange={e => setCard(e.target.value)} aria-invalid={error ? 'true' : undefined} />
        <p className="tiny muted">Test cards: 4111 1111 1111 1111 pays; 4000 0000 0000 0002 is declined. No real card is charged.</p>
        {error && <p className="err">{error}</p>}
      </div>
      <div className="row">
        <button className="btn pri" type="button" onClick={pay}>Pay {money(isB ? b.final : p.price)}</button>
        <button className="btn" type="button" onClick={abandon}>{isB ? 'Cancel and release seats' : 'Not now'}</button>
        {isB && <button className="btn ghost sm" type="button" onClick={expireNow}>Let the hold run out</button>}
      </div>
    </>
  );
}

/* ---- QR ticket (BKG-5) */
export function TicketModal({ bid }) {
  const b = S.bookings.find(x => x.id === bid);
  if (!b) return null;
  const e = ev(b.eid), u = user(b.uid);
  const ics = () => {
    const f = t => new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const text = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//EventBook//EN\nBEGIN:VEVENT\nUID:${b.num}@eventbook.example\nDTSTART:${f(e.start)}\nDTEND:${f(e.end)}\nSUMMARY:${e.title}\nLOCATION:${e.venue}\nEND:VEVENT\nEND:VCALENDAR`;
    textModal('Calendar file (.ics)', text, { filename: `${b.num}.ics`, mime: 'text/calendar' });
  };
  const pdf = () => textModal('Ticket PDF', `${S.settings.org} · ${e.title}\n${fDT(e.start)} · ${e.venue}\n${u.name} · ${b.qty} ticket(s) · ${money(b.final)}\nBooking ${b.num}\n[QR code of the ticket token]`,
    { note: 'The server renders this ticket as a PDF with the QR code. Its contents show here until that endpoint exists.' });
  return (
    <>
      <div className="ticket">
        <div className="grid" style={{ gap: 6 }}>
          <span className="tiny muted">{S.settings.org} · EventBook ticket · {b.num}</span>
          <h2>{e.title}</h2>
          <p>{fDT(e.start)}</p>
          <p className="small">{e.venue}</p>
          <p className="small">{u.name} · {b.qty} ticket{b.qty > 1 ? 's' : ''} · {money(b.final)}</p>
          <span><Chip s={b.status} /></span>
        </div>
        <div className="qr" role="img" aria-label="QR code for this ticket"><QRCodeSVG value={'EVENTBOOK:' + b.token} size={160} level="M" /></div>
      </div>
      <p className="tiny muted">The code is a long random token; the server stores only its hash. Demo code: <span className="mono">{b.token}</span></p>
      <div className="row">
        <button className="btn" type="button" onClick={ics}>Add to calendar (.ics)</button>
        <button className="btn" type="button" onClick={pdf}>Download PDF</button>
        <button className="btn ghost" type="button" onClick={closeModal}>Close</button>
      </div>
    </>
  );
}

export function TextModal({ title, text, note, filename, mime }) {
  const ref = useRef(null);
  const copy = () => {
    ref.current.select();
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => toast('Selected: press Ctrl+C to copy'));
  };
  return (
    <>
      <h2>{title}</h2>
      <p className="small muted">{note || 'Preview of the file. Download it or copy the text.'}</p>
      <textarea ref={ref} rows={10} className="mono" readOnly value={text} />
      <div className="row">
        {filename && <button className="btn pri" type="button" onClick={() => downloadFile(filename, text, mime)}>Download {filename}</button>}
        <button className={`btn${filename ? '' : ' pri'}`} type="button" onClick={copy}>Copy</button>
        <button className="btn ghost" type="button" onClick={closeModal}>Close</button>
      </div>
    </>
  );
}

/* ---- demo mailbox: every email sent, to any address */
export function Mailbox({ list }) {
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>Demo mailbox</h2><button className="btn ghost sm" type="button" onClick={closeModal}>Close</button></div>
      <p className="small muted">Every email EventBook sends, to any address, from its editable templates. Links in them work here.</p>
      <div className="list">
        {list.length ? list.map(m => (
          <div key={m.id}>
            <span className={`dot ${m.read ? 'read' : ''}`} />
            <div className="grid" style={{ gap: 4, flex: 1 }}>
              <span className="tiny muted">To {m.to} · {fDT(m.at)}</span>
              <b>{m.subject}</b>
              <span className="small">{m.body}</span>
              {m.link && <span><button className="btn sm" type="button" onClick={() => handleLink(m.link)}>{m.link.label}</button></span>}
            </div>
          </div>
        )) : <p className="empty">No emails yet.</p>}
      </div>
    </>
  );
}

/* ---- two-step sign-in (AUTH-6) */
function CodeField({ value, onChange, error }) {
  return (
    <>
      <div className="field"><label htmlFor="mfa-code">Code</label><input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={value} onChange={e => onChange(e.target.value)} /></div>
      {error && <p className="err">{error}</p>}
    </>
  );
}

export function MfaSetupModal() {
  const [code, setCode] = useState(''), [error, setError] = useState('');
  const on = e => {
    e.preventDefault();
    const r = API.mfa(true, code.trim());
    if (r.ok) { closeModal(); toast('Two-step sign-in is on'); } else setError(r.message);
  };
  return (
    <form className="grid" onSubmit={on}>
      <h2>Set up two-step sign-in</h2>
      <p className="small">Scan the key with an authenticator app, then type the code it shows.</p>
      <p className="mono" style={{ fontSize: 15 }}>JBSW Y3DP EHPK 3PXP</p>
      <p className="tiny muted">Demo: your app would show <span className="mono">{totp()}</span> right now.</p>
      <CodeField value={code} onChange={setCode} error={error} />
      <div className="row"><button className="btn pri" type="submit">Turn on</button><button className="btn" type="button" onClick={closeModal}>Not now</button></div>
    </form>
  );
}

export function MfaLoginModal() {
  const [code, setCode] = useState(''), [error, setError] = useState('');
  const submit = e => {
    e.preventDefault();
    if (code.trim() !== totp()) { setError('That code does not match. Type the 6 digits your app shows now.'); return; }
    closeModal();
    api('POST', '/api/auth/mfa', () => ({ msg: 'Code accepted' }));
    signedIn(S.pendingLogin);
  };
  return (
    <form className="grid" onSubmit={submit}>
      <h2>Two-step sign-in</h2>
      <p className="small">Type the 6-digit code from your authenticator app. Demo code: <span className="mono">{totp()}</span></p>
      <CodeField value={code} onChange={setCode} error={error} />
      <button className="btn pri" type="submit">Sign in</button>
    </form>
  );
}
