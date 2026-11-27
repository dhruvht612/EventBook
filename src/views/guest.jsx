// Signed-out screens: sign in, sign up, email check, password reset, public plans (AUTH-1 to 4).
import { useState } from 'react';
import { S, user, go, toast, openModal } from '../lib/store';
import { API } from '../lib/server';
import { DEMO_PW, money } from '../lib/format';
import { Field, Input, useFocusInvalid, Head } from '../components/ui';
import { MfaLoginModal } from '../components/modals';
import { openMailbox, signedIn } from '../actions';

const formData = e => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget)); };

export function Login() {
  const submit = e => {
    const f = formData(e);
    S.loginEmail = f.email;
    const r = API.login(f.email || '', f.pw || '', f.remember === 'on');
    if (!r.ok) return;
    if (r.mfa) { S.pendingLogin = r; openModal(<MfaLoginModal />); } else signedIn(r);
  };
  return (
    <div className="narrow">
      <h1>Sign in</h1>
      <p className="muted" style={{ margin: '8px 0 24px' }}>Demo accounts use the password <span className="mono">{DEMO_PW}</span>, for example margot@members.example.</p>
      <form className="card grid" onSubmit={submit} noValidate>
        <Field id="l-email" label="Email"><input id="l-email" name="email" type="email" defaultValue={S.loginEmail || ''} autoComplete="email" /></Field>
        <Field id="l-pw" label="Password"><input id="l-pw" name="pw" type="password" autoComplete="current-password" /></Field>
        <label className="check"><input type="checkbox" name="remember" defaultChecked /> Keep me signed in for 30 days</label>
        <div className="row"><button className="btn pri" type="submit">Sign in</button><button type="button" className="btn ghost" onClick={() => go('forgot')}>Forgot password?</button></div>
        <p className="tiny muted">Five wrong passwords lock the account for 15 minutes.</p>
      </form>
      <p style={{ marginTop: 16 }} className="small">New here? <button type="button" className="linkbtn" onClick={() => go('signup')}>Create an account</button></p>
    </div>
  );
}

export function Signup() {
  const [fe, setFe] = useState({});
  useFocusInvalid(fe);
  const submit = e => {
    const f = formData(e);
    const r = API.register({ name: f.name, email: f.email, pw: f.pw, pw2: f.pw2 });
    if (!r.ok) { setFe(r.details || {}); return; }
    const l = API.login(f.email, f.pw, false);
    S.current.member = l.uid; S.sid.member = l.sid; S.role = 'member';
    toast('Account created. Check your email to verify it.');
    go('checkemail', r.id);
  };
  return (
    <div className="narrow">
      <h1>Create an account</h1>
      <p className="muted" style={{ margin: '8px 0 24px' }}>Every new account starts on the Free plan. Verify your email to book.</p>
      <form className="card grid" onSubmit={submit} noValidate>
        <Field id="s-name" label="Full name" error={fe.name}><Input id="s-name" name="name" autoComplete="name" error={fe.name} /></Field>
        <Field id="s-email" label="Email" error={fe.email}><Input id="s-email" name="email" type="email" autoComplete="email" error={fe.email} /></Field>
        <Field id="s-pw" label="Password" error={fe.pw} hint="At least 12 characters, checked against known breached passwords."><Input id="s-pw" name="pw" type="password" autoComplete="new-password" error={fe.pw} /></Field>
        <Field id="s-pw2" label="Password again" error={fe.pw2}><Input id="s-pw2" name="pw2" type="password" autoComplete="new-password" error={fe.pw2} /></Field>
        <button className="btn pri" type="submit">Create account</button>
      </form>
    </div>
  );
}

export function CheckEmail() {
  const u = user(S.param);
  return (
    <div className="narrow">
      <h1>Check your email</h1>
      <div className="card grid" style={{ marginTop: 20 }}>
        <p>We sent a link to <b>{u?.email}</b>. It works once and for 24 hours.</p>
        <p className="small muted">In this demo the email lands in the Mailbox at the top.</p>
        <div className="row">
          <button className="btn pri" type="button" onClick={openMailbox}>Open the mailbox</button>
          {u && <button className="btn" type="button" onClick={() => { if (API.resend(u.id).ok) toast('A new link is in the mailbox'); }}>Send a new link</button>}
        </div>
      </div>
    </div>
  );
}

export function Forgot() {
  const [sent, setSent] = useState(false);
  const submit = e => { const f = formData(e); API.forgot(f.email || ''); setSent(true); };
  return (
    <div className="narrow">
      <h1>Reset your password</h1>
      <p className="muted" style={{ margin: '8px 0 24px' }}>We email a link that works once and for one hour.</p>
      <form className="card grid" onSubmit={submit} noValidate>
        <Field id="f-email" label="Email"><input id="f-email" name="email" type="email" autoComplete="email" /></Field>
        <button className="btn pri" type="submit">Send the link</button>
        {sent && <p className="notice ok">If an account uses that email, the link is on its way. Look in the Mailbox.</p>}
      </form>
    </div>
  );
}

export function Reset() {
  const [fe, setFe] = useState({});
  const submit = e => {
    const f = formData(e);
    const r = API.reset(S.resetTok, f.pw || '');
    if (r.ok) { toast('Password changed. Sign in with it.'); S.role = 'guest'; go('login'); } else setFe(r.details || {});
  };
  return (
    <div className="narrow">
      <h1>Choose a new password</h1>
      <p className="muted" style={{ margin: '8px 0 24px' }}>Every signed-in session ends when you save it.</p>
      <form className="card grid" onSubmit={submit} noValidate>
        <Field id="r-pw" label="New password" error={fe.pw} hint="At least 12 characters."><Input id="r-pw" name="pw" type="password" autoComplete="new-password" error={fe.pw} /></Field>
        <button className="btn pri" type="submit">Save password</button>
      </form>
    </div>
  );
}

export function PlanCards({ plans }) {
  return (
    <div className="grid plans">
      {plans.map(p => (
        <div key={p.id} className="card plan">
          <h2>{p.name}</h2>
          <b>{p.price ? <>{money(p.price)}<span className="small muted"> a year</span></> : 'Free'}</b>
          <ul>{p.benefits.map(x => <li key={x}>{x}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

export function PlansPublic() {
  return (
    <>
      <Head title="Membership plans" actions={<button className="btn pri" type="button" onClick={() => go('signup')}>Create an account</button>}>
        Members get lower prices, members-only events and, on Premium, early booking.
      </Head>
      <PlanCards plans={S.plans.filter(p => p.active)} />
    </>
  );
}
