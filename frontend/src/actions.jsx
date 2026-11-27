// UI actions shared across screens: navigation helpers, modal launchers, link handling.
import { S, setS, ui, ev, me, user, planOf, go, toast, openModal, closeModal, NAV } from './lib/store';
import { API } from './lib/server';
import { startWizard } from './lib/rules';
import { fresh } from './lib/seed';
import { fDT, fDay, money } from './lib/format';
import { Confirm, Mailbox, PayModal, TextModal, TicketModal } from './components/modals';

export function switchRole(id) {
  S.role = id; S.wizard = null; S.param = null;
  const u = me();
  S.view = u ? NAV[id][0][0] : (id === 'guest' ? 'discover' : 'login');
  if (!u && id !== 'guest') S.role = 'guest';
  go(S.view);
  toast(me() ? `Now viewing as ${me().name}` : 'Signed out: sign in to use the member view');
}
export function navTo(id, param) {
  if (id === 'wizard') { S.wizard = null; startWizard(null); }
  go(id, param);
}
export const newEvent = () => navTo('wizard');
export function manage(id) { S.wizard = null; go('manage', id); }
export function editEvent(id) { S.wizard = null; startWizard(ev(id)); go('wizard'); }

export function signedIn(r, seat = 'member') {
  S.current[seat] = r.uid; S.sid[seat] = r.sid; S.role = seat; S.loginEmail = '';
  toast(`Signed in as ${user(r.uid).name}`);
  go('home');
}
export function logout() { API.logout(); S.role = 'guest'; toast('Signed out'); go('discover'); }

export function handleLink(l) {
  closeModal();
  if (l.act === 'verify') {
    const r = API.verify(l.tok);
    if (!r.ok) return;
    toast(r.msg === 'Email verified' ? 'Email verified. You can book now.' : 'New email confirmed.');
    if (S.current.member === r.uid) { S.role = 'member'; go('home'); } else { S.loginEmail = user(r.uid).email; S.role = 'guest'; go('login'); }
  }
  if (l.act === 'resetlink') { S.resetTok = l.tok; S.role = 'guest'; go('reset'); }
  if (l.act === 'openevent') { S.role = 'member'; go('event', l.id); }
  if (l.act === 'ticketlink') { S.role = 'member'; go('bookings'); openTicket(l.id); }
}

export const startCheckout = bid => openModal(<PayModal kind="booking" id={bid} />);
export const openTicket = bid => openModal(<TicketModal bid={bid} />);
export const textModal = (title, text, opts = {}) => openModal(<TextModal title={title} text={text} {...opts} />, { wide: true });

export function openMailbox() {
  const list = S.mail.slice(0, 60).map(m => ({ ...m }));
  S.mail.slice(0, 60).forEach(m => { m.read = true; });
  openModal(<Mailbox list={list} />, { wide: true });
}

/** Book (or accept an offered seat); paid bookings go straight to checkout. */
export function book(eid, qty, fromOffer) {
  const r = API.book(eid, qty, fromOffer);
  if (!r.ok) return;
  if (r.booking.status === 'PENDING_PAYMENT') startCheckout(r.booking.id);
  else toast(fromOffer ? 'The seat is yours.' : 'Booked. Your ticket is ready.');
}

export function confirmCancelBooking(id) {
  const b = S.bookings.find(x => x.id === id), e = ev(b.eid);
  const onYes = () => {
    const mark = S.log[0];
    const r = API.cancel(id);
    closeModal();
    if (!r.ok) return;
    const added = []; for (const l of S.log) { if (l === mark) break; added.push(l); }
    const job = added.find(l => l.method === 'JOB');
    toast('Cancelled. ' + (job ? job.msg + '.' : 'Seats released.'));
  };
  openModal(
    <Confirm title={`Cancel ${b.uid === me().id ? 'your' : user(b.uid).name + '’s'} booking?`} yes="Cancel booking" onYes={onYes}>
      {e.title}, {fDT(e.start)}. {b.status === 'CONFIRMED' && b.final ? `The ${money(b.final)} goes back to the card in full. ` : ''}The seat{b.qty > 1 ? 's go' : ' goes'} to the waitlist.
    </Confirm>,
  );
}

export function buyPlan(id) {
  const p = planOf(id);
  if (!p.price) {
    openModal(
      <Confirm title="Move to Free?" yes="Move to Free" no="Not now" onYes={() => { const r = API.buyPlan(id); closeModal(); if (r.ok) toast(r.msg); }}>
        Member prices and members-only events stop at once. Your paid plan ends today.
      </Confirm>,
    );
    return;
  }
  if (API.buyPlan(id).ok) openModal(<PayModal kind="membership" id={me().id} />, { onDismiss: () => API.abandonPlan() });
}

export function cancelPlan(undo) {
  if (undo) { if (API.cancelPlan(true).ok) toast('Your membership continues.'); return; }
  const m = me().membership;
  openModal(
    <Confirm title={`Cancel your ${planOf(m.plan).name} membership?`} yes="Cancel membership" onYes={() => { const r = API.cancelPlan(false); closeModal(); if (r.ok) toast('Cancelled. Active until it ends.'); }}>
      It stays active until {fDay(m.expiry)}: member prices and bookings keep working. Then you move to Free. No refund for the time left.
    </Confirm>,
  );
}

export function exportCsv(kind, f, title) {
  const r = API.exportCsv(kind, f);
  if (r.ok) textModal(title, r.csv, { filename: `${kind}${f.eid ? '-' + f.eid : ''}.csv`, mime: 'text/csv' });
}

export function resetDemo() {
  setS(fresh()); ui.modal = null; ui.navSeq++;
  toast('Demo reset to its starting data');
}
