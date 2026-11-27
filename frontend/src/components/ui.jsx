import { useEffect } from 'react';
import { STATUS, label, money, tone, initials, fDT } from '../lib/format';
import { S, go, seatsLeft } from '../lib/store';
import { priceFor } from '../lib/rules';

export const Chip = ({ s }) => <span className={`chip ${STATUS[s] ?? ''}`}>{label(s)}</span>;

export const Avatar = ({ u }) => (
  <span className="av" style={{ background: tone(u.id) }} aria-hidden="true">{initials(u.name)}</span>
);

export function Field({ id, label: text, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{text}</label>
      {children}
      {hint && <p className="tiny muted">{hint}</p>}
      {error && <p className="err" id={`${id}-err`}>{error}</p>}
    </div>
  );
}

/** An <input> that wires up aria-invalid / aria-describedby when it has an error. */
export function Input({ id, error, ...rest }) {
  return <input id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-err` : undefined} {...rest} />;
}

/** Focus the first invalid field whenever `errors` changes. */
export function useFocusInvalid(errors) {
  useEffect(() => { document.querySelector('[aria-invalid=true]')?.focus(); }, [errors]);
}

export const Kpi = ({ l, v, s }) => (
  <div className="card kpi"><span className="small muted">{l}</span><b>{v}</b>{s && <span className="small muted">{s}</span>}</div>
);

export const Empty = ({ children }) => <p className="empty">{children}</p>;

export function Head({ title, children, actions }) {
  return (
    <div className="head">
      <div><h1>{title}</h1>{children && <p>{children}</p>}</div>
      {actions}
    </div>
  );
}

export function Price({ e, u }) {
  if (!e.price) return <b>Free</b>;
  const p = priceFor(S, e, u, 1);
  const best = S.plans.filter(x => x.active && x.price).reduce((m, pl) => Math.min(m, Math.round(e.price * (1 - pl.discount)), e.member ?? Infinity), e.price);
  if (p.final < p.orig) return <><b>{money(p.final)}</b> <span className="strike">{money(p.orig)}</span> <span className="tiny muted">{p.how}</span></>;
  return <><b>{money(p.final)}</b>{best < e.price && <> <span className="tiny muted">Members from {money(best)}</span></>}</>;
}

export const gradient = (color, mix = 60) => `linear-gradient(135deg,${color},color-mix(in oklab,${color} ${mix}%,#fff))`;

export function EventCard({ e, u }) {
  return (
    <button type="button" className="card ev" onClick={() => go('event', e.id)}>
      <div className="art" style={{ background: gradient(e.color) }}><b>{e.type}</b></div>
      <div className="body">
        <span className="tiny muted">{e.cat} · {e.city}</span>
        <h3>{e.title}</h3>
        <span className="small">{fDT(e.start)}</span>
        <span className="row">
          {e.status === 'FULL' ? <span className="chip acc">Full · waitlist</span> : <span className="chip plain">{seatsLeft(e)} seats left</span>}
          {e.eligible && <span className="chip plain">Members only</span>}
        </span>
        <span className="price"><Price e={e} u={u} /></span>
      </div>
    </button>
  );
}

export function Tabs({ value, onChange, tabs }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>{text}</button>)}
    </div>
  );
}
