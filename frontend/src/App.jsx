import { useEffect, useRef } from 'react';
import { S, ui, useStore, fixView } from './lib/store';
import { TopBar, Sidebar, ServerLog, Toasts, ModalHost } from './components/Chrome';
import { Login, Signup, CheckEmail, Forgot, Reset, PlansPublic } from './views/guest';
import { Discover, EventDetail } from './views/events';
import { Home, Bookings, Membership, Inbox, Profile } from './views/member';
import { MyEvents, Manage, Checkin, OrgReports } from './views/organizer';
import { Wizard } from './views/Wizard';
import { Dash, Events, Registrations, Members, Users, UserDetail, Plans, Payments, Reports, Notifications, Audit, Settings } from './views/admin';

const VIEWS = {
  discover: Discover, event: EventDetail, login: Login, signup: Signup, checkemail: CheckEmail, forgot: Forgot, reset: Reset, 'plans-public': PlansPublic,
  home: Home, bookings: Bookings, membership: Membership, inbox: Inbox, profile: Profile,
  myevents: MyEvents, manage: Manage, wizard: Wizard, checkin: Checkin, orgreports: OrgReports,
  dash: Dash, events: Events, registrations: Registrations, members: Members, users: Users, userdetail: UserDetail, plans: Plans, payments: Payments, reports: Reports, notifications: Notifications, audit: Audit, settings: Settings,
};

export default function App() {
  useStore();
  fixView(); // keeps role and view consistent; idempotent
  const View = VIEWS[S.view] || Discover;
  const mainRef = useRef(null);
  useEffect(() => {
    if (!ui.navSeq) return;
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [ui.navSeq]);
  return (
    <>
      <TopBar />
      <div className="shell">
        <Sidebar />
        <main id="view" tabIndex={-1} ref={mainRef}>
          <View key={`${S.role}:${S.view}:${S.param ?? ''}`} />
        </main>
      </div>
      <ModalHost />
      <Toasts />
      <ServerLog />
    </>
  );
}
