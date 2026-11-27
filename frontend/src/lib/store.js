// The app state `S` is one plain, JSON-serialisable object, mutated in place by the
// simulated server (server.js) and persisted to localStorage. React subscribes to a
// version counter that bumps on every commit().
import { useSyncExternalStore } from 'react';

const KEY = 'eventbook-demo-v2';

export let S = null;
export function setS(next) { S = next; }
export function loadSaved() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); return s && s.events && s.templates ? s : null; } catch { return null; }
}

// UI-only state: never persisted.
export const ui = { toasts: [], modal: null, navSeq: 0 };

let version = 0;
const subs = new Set();
const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
const getVersion = () => version;
export function commit() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage may be blocked */ }
  version++;
  subs.forEach(f => f());
}
export const useStore = () => useSyncExternalStore(subscribe, getVersion, getVersion);

let uid = 0;
export function toast(msg, code, bad = !!code) {
  const t = { id: ++uid, msg, code, bad };
  ui.toasts = [...ui.toasts, t].slice(-3);
  commit();
  setTimeout(() => { ui.toasts = ui.toasts.filter(x => x !== t); commit(); }, 4500);
}
/** Show a React element in the modal. `onDismiss` runs when closed by Escape or the scrim. */
export function openModal(el, opts = {}) { ui.modal = { el, wide: !!opts.wide, onDismiss: opts.onDismiss, key: ++uid }; commit(); }
export function closeModal() { ui.modal = null; commit(); }
export function dismissModal() { const m = ui.modal; closeModal(); m?.onDismiss?.(); }

/* ---- lookups */
export const user = id => S.users.find(u => u.id === id);
export const ev = id => S.events.find(e => e.id === id);
export const planOf = id => S.plans.find(p => p.id === id);
export const me = () => user(S.current[S.role]);
export const isAdmin = u => !!u && u.roles.includes('admin');
export const owns = (u, e) => !!u && (isAdmin(u) || e.org === u.id || (e.coorgs || []).includes(u.id));
export const seatsLeft = e => Math.max(0, e.cap - e.reserved);

/* ---- navigation */
export const ROLES = [['guest', 'Visitor', 'Signed out'], ['member', 'Member', null], ['organizer', 'Organizer', null], ['admin', 'Administrator', null]];
export const NAV = {
  guest: [['discover', 'Find events'], ['plans-public', 'Membership plans'], ['login', 'Sign in'], ['signup', 'Create account']],
  member: [['home', 'Dashboard'], ['discover', 'Find events'], ['bookings', 'My bookings'], ['membership', 'Membership'], ['inbox', 'Inbox'], ['profile', 'Profile and security']],
  organizer: [['myevents', 'My events'], ['wizard', 'New event'], ['checkin', 'Check-in'], ['orgreports', 'Reports'], ['discover', 'Find events']],
  admin: [['dash', 'Dashboard'], ['events', 'Events'], ['registrations', 'Registrations'], ['members', 'Members'], ['users', 'Users'], ['plans', 'Plans'], ['payments', 'Payments'], ['reports', 'Reports'], ['notifications', 'Notifications'], ['audit', 'Audit log'], ['settings', 'Settings']],
};
export const ACTIVE_NAV = { event: 'discover', manage: { organizer: 'myevents', admin: 'events' }, userdetail: 'users', reset: 'login', checkemail: 'signup' };
const GUEST_OK = ['discover', 'event', 'login', 'signup', 'checkemail', 'forgot', 'reset', 'plans-public'];
const ANY_ROLE = ['event', 'manage', 'userdetail', 'checkemail', 'reset', 'forgot', 'wizard', 'checkin'];

/** Keep role and view consistent (signed-out users can't sit on member screens). Idempotent. */
export function fixView() {
  if (!me() && !GUEST_OK.includes(S.view)) { S.role = 'guest'; S.view = 'login'; }
  if (!NAV[S.role].some(n => n[0] === S.view) && !ANY_ROLE.includes(S.view)) S.view = NAV[S.role][0][0];
}
export function go(view, param) { S.view = view; S.param = param ?? null; ui.navSeq++; commit(); }
