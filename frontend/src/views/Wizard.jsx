// The 8-step event wizard (EVT-1 to 5). The draft lives in S.wizard so it survives reloads.
import { S, ev, planOf, go, toast, commit } from '../lib/store';
import { API } from '../lib/server';
import { STEP_KEYS, WSTEPS, startWizard, wizardErrors } from '../lib/rules';
import { fDT, toTs } from '../lib/format';
import { Chip, useFocusInvalid } from '../components/ui';
import { manage } from '../actions';

function wizardSave(next, publish) {
  const w = S.wizard;
  const er = wizardErrors(w, publish ? 7 : w.step);
  const mine = publish ? er : Object.fromEntries(Object.entries(er).filter(([k]) => STEP_KEYS[w.step].includes(k)));
  w.errors = mine;
  if (Object.keys(mine).length) { commit(); return; }
  if (!w.live || publish) {
    const r = API.saveEvent({ ...w, step: publish ? 7 : w.step }, publish);
    if (!r.ok) {
      w.errors = r.details || {};
      const st = STEP_KEYS.findIndex(ks => ks.includes(Object.keys(w.errors)[0]));
      if (st >= 0) w.step = st;
      commit(); return;
    }
    w.id = r.id; w.version = r.version;
  }
  if (!w.done.includes(w.step)) w.done.push(w.step);
  if (publish) {
    toast(w.live ? 'Changes saved.' : 'Published: members can now find it.');
    const id = w.id; S.wizard = null; go('manage', id); return;
  }
  if (!w.live) toast('Draft saved');
  w.step = Math.min(7, w.step + next); commit();
}

export function Wizard() {
  if (!S.wizard) startWizard(null); // idempotent: only fills an empty wizard
  const w = S.wizard, er = w.errors || {};
  useFocusInvalid(w.errors);

  const set = (k, v) => { w[k] = v; commit(); };
  const fld = (k, text, control, hint) => (
    <div className="field">
      <label htmlFor={`w-${k}`}>{text}</label>{control}
      {hint && <p className="tiny muted">{hint}</p>}
      {er[k] && <p className="err">{er[k]}</p>}
    </div>
  );
  const txt = (k, type = 'text', extra = {}) => <input id={`w-${k}`} type={type} value={w[k] ?? ''} onChange={e => set(k, e.target.value)} aria-invalid={er[k] ? 'true' : undefined} {...extra} />;
  const sel = (k, opts) => <select id={`w-${k}`} value={w[k]} onChange={e => set(k, e.target.value)}>{opts.map(o => <option key={o}>{o}</option>)}</select>;
  const cols = min => ({ gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))` });

  const steps = [
    () => <>{fld('title', 'Event name', txt('title'))}{fld('cat', 'Category', sel('cat', ['Workshop', 'Talk', 'Meeting', 'Social', 'Open day']))}{fld('desc', 'What happens', <textarea id="w-desc" value={w.desc} onChange={e => set('desc', e.target.value)} aria-invalid={er.desc ? 'true' : undefined} />)}</>,
    () => <>
      <div className="grid" style={cols(160)}>{fld('date', 'Date', txt('date', 'date'))}{fld('time', 'Starts', txt('time', 'time'))}{fld('dur', 'Length (hours)', txt('dur', 'number', { min: 1, max: 24 }))}</div>
      <p className="small muted">Times are in Toronto time (America/Toronto) and stored in UTC.</p>
    </>,
    () => <>
      {fld('type', 'Type', sel('type', ['In person', 'Virtual', 'Hybrid']))}
      {w.type !== 'Virtual' && <>{fld('venue', 'Venue', txt('venue'))}{fld('city', 'City', txt('city'))}</>}
      {w.type !== 'In person' && fld('url', 'Meeting link', txt('url', 'url'), 'Shown only to confirmed attendees.')}
    </>,
    () => <div className="grid" style={cols(180)}>{fld('cap', 'Capacity', txt('cap', 'number', { min: 1 }), w.live ? 'Lower it only to the seats already booked.' : '')}{fld('max', 'Tickets per member', txt('max', 'number', { min: 1, max: 10 }), 'One is the default.')}</div>,
    () => <>
      <div className="grid" style={cols(180)}>
        {fld('price', 'Full price ($)', txt('price', 'number', { min: 0, step: 0.01 }), '0 makes the event free.')}
        {fld('member', 'Member price ($, optional)', txt('member', 'number', { min: 0, step: 0.01 }), 'Members on a paid plan pay this or their plan discount, whichever is lower.')}
      </div>
      {w.live && <p className="small muted">Price changes apply to new bookings; existing bookings keep the price they paid.</p>}
    </>,
    () => <>
      <div className="field">
        <span style={{ fontSize: 14, fontWeight: 500 }}>Who can book</span>
        <label className="check"><input type="radio" name="elig" checked={w.elig === 'all'} onChange={() => set('elig', 'all')} /> Everyone with an account</label>
        <label className="check"><input type="radio" name="elig" checked={w.elig === 'plans'} onChange={() => set('elig', 'plans')} /> Only members on these plans</label>
      </div>
      {w.elig === 'plans' && (
        <div className="field">
          {S.plans.filter(p => p.price && p.active).map(p => (
            <label key={p.id} className="check"><input type="checkbox" checked={w.plans.includes(p.id)} onChange={e => set('plans', e.target.checked ? [...w.plans, p.id] : w.plans.filter(x => x !== p.id))} /> {p.name}</label>
          ))}
          {er.plans && <p className="err">{er.plans}</p>}
        </div>
      )}
    </>,
    () => <>
      {fld('opensDate', 'Registration opens (9:00)', txt('opensDate', 'date'), `Plans with early access open sooner (Premium: ${planOf('premium')?.early ?? 0} days). Registration closes 2 hours before the start.`)}
      {fld('cutoffH', 'Cancellation cut-off (hours before the start)', txt('cutoffH', 'number', { min: 0, max: 168 }))}
      <label className="check"><input type="checkbox" checked={w.waitlist} onChange={e => set('waitlist', e.target.checked)} /> Waitlist when full (freed seats offered for {S.settings.offerH} hours)</label>
    </>,
    () => {
      const s = toTs(w.date, w.time);
      return <>
        <dl className="kv">
          <dt>Name</dt><dd>{w.title}</dd>
          <dt>When</dt><dd>{Number.isNaN(s) ? '—' : fDT(s)}, {w.dur} h</dd>
          <dt>Where</dt><dd>{w.type}{w.type !== 'Virtual' && ` · ${w.venue}, ${w.city}`}</dd>
          <dt>Seats</dt><dd>{w.cap}, up to {w.max} per member</dd>
          <dt>Price</dt><dd>{+w.price ? `$${(+w.price).toFixed(2)}${w.member !== '' ? `, members $${(+w.member).toFixed(2)}` : ''}` : 'Free'}</dd>
          <dt>Who</dt><dd>{w.elig === 'all' ? 'Everyone' : `${w.plans.map(id => planOf(id)?.name).join(', ')} members`}</dd>
          <dt>Registration</dt><dd>Opens {w.opensDate}, cut-off {w.cutoffH} h, waitlist {w.waitlist ? 'on' : 'off'}</dd>
        </dl>
        {Object.keys(er).length > 0 && <p className="err">Some steps need fixing: {Object.values(er).join(' ')}</p>}
      </>;
    },
  ];

  const toStep = i => { w.step = i; w.errors = {}; commit(); };
  return (
    <>
      <div className="head">
        <div>
          <h1>{w.live ? 'Edit event' : w.id ? 'Finish the draft' : 'New event'}</h1>
          <p>{w.live ? 'Changes go live when you save. Members already booked keep their price.' : 'Eight steps. Each step saves a draft, so you can stop and come back.'}</p>
        </div>
        {w.id && <Chip s={ev(w.id)?.status || 'DRAFT'} />}
      </div>
      <div className="steps">
        {WSTEPS.map((s, i) => <button key={s} type="button" onClick={() => toStep(i)} aria-current={i === w.step ? 'step' : undefined} className={w.done.includes(i) ? 'done' : ''}>{i + 1}. {s}</button>)}
      </div>
      <div className="card grid" style={{ maxWidth: 720, gap: 18 }}>
        <h2>{w.step + 1}. {WSTEPS[w.step]}</h2>
        {steps[w.step]()}
        <div className="row">
          {w.step > 0 && <button className="btn" type="button" onClick={() => toStep(w.step - 1)}>Back</button>}
          {w.step < 7
            ? <button className="btn pri" type="button" onClick={() => wizardSave(1)}>{w.live ? 'Next' : 'Save and continue'}</button>
            : <button className="btn pri" type="button" onClick={() => wizardSave(0, true)}>{w.live ? 'Save changes' : 'Publish event'}</button>}
          {w.id && <button className="btn ghost" type="button" onClick={() => manage(w.id)}>{w.live ? 'Discard changes' : 'Close'}</button>}
        </div>
      </div>
    </>
  );
}
