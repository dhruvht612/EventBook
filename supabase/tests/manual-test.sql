-- =====================================================================================
-- EventBook: hands-on database test, one step at a time in the Supabase SQL Editor
--
-- Before you start
--   1. Run supabase/migrations/20261126000000_eventbook_schema.sql once.
--   2. Authentication → Users → Add user → Create new user, tick "Auto Confirm User", for:
--        organizer@test.dev   alice@test.dev   bob@test.dev     (any password)
--
-- How to run a step
--   Copy one step (between the ===== lines) into a new SQL Editor query.
--   Each step says who to run it as. Set that with the role picker next to the Run button:
--     postgres       → the default ("postgres"), sees and can do everything
--     anon           → "anon" (a visitor who is not signed in)
--     <email>        → "authenticated", then pick that user
--   The editor shows the result of the last statement. Each step says what you should see.
-- =====================================================================================


-- ===== STEP 1 · as postgres · sign-up trigger worked
-- Expect: 3 rows, each with role member, plan free, membership active, status active.
select p.email, p.status, r.role, pl.slug as plan, m.status as membership
  from public.profiles p
  join public.user_roles r on r.user_id = p.id
  join public.memberships m on m.user_id = p.id
  join public.membership_plans pl on pl.id = m.plan_id
 where p.email like '%@test.dev'
 order by p.email;


-- ===== STEP 2 · as postgres · make organizer@test.dev an organizer
-- Expect: organizer@test.dev now has two roles, member and organizer.
insert into public.user_roles (user_id, role)
select id, 'organizer' from public.profiles where email = 'organizer@test.dev';
select p.email, array_agg(r.role order by r.role) as roles
  from public.profiles p join public.user_roles r on r.user_id = p.id
 where p.email = 'organizer@test.dev' group by p.email;


-- ===== STEP 3 · as organizer@test.dev · create two draft events
-- "Test night" is free with 1 seat (to test full + waitlist); "Test workshop" is paid.
-- Expect: 2 rows, status draft, registration_closes_at 2 hours before starts_at.
insert into public.events (organizer_id, title, category, description, venue, city, starts_at, ends_at, registration_opens_at, capacity, price_cents, member_price_cents, max_tickets_per_member)
values (auth.uid(), 'Test night', 'Social', 'A free test event with one seat.', 'Community hall', 'Toronto',
        now() + interval '10 days', now() + interval '10 days 2 hours', now() - interval '1 day', 1, 0, null, 1),
       (auth.uid(), 'Test workshop', 'Workshop', 'A paid test event.', 'The Clay Room', 'Toronto',
        now() + interval '12 days', now() + interval '12 days 3 hours', now() - interval '1 day', 5, 3600, 3000, 2)
returning title, status, starts_at, registration_closes_at;


-- ===== STEP 4 · as anon · drafts are private
-- Expect: 0 rows.
select title from public.events where title like 'Test %';


-- ===== STEP 5 · as alice@test.dev · members cannot create events
-- Expect: ERROR  new row violates row-level security policy for table "events"
insert into public.events (organizer_id, title, starts_at, ends_at, registration_opens_at, capacity)
values (auth.uid(), 'Sneaky event', now() + interval '5 days', now() + interval '5 days 1 hour', now(), 10);


-- ===== STEP 6 · as organizer@test.dev · publish both events
-- Expect: Test night published, Test workshop published.
select public.publish_event(id) from public.events where title in ('Test night', 'Test workshop');
select title, status from public.events where title like 'Test %' order by title;


-- ===== STEP 7 · as anon · published events are public
-- Expect: 2 rows.
select title, status, capacity, reserved, price_cents from public.events where title like 'Test %' order by title;


-- ===== STEP 8 · as alice@test.dev · book the free event
-- Expect: 1 row, status confirmed, a booking number like EB-20400 and a 64-character ticket_token.
-- Copy the ticket_token: you need it in step 17.
select * from public.book_event((select id from public.events where title = 'Test night'), 1);


-- ===== STEP 9 · as anon · the event is now full
-- Expect: Test night  full  1  1
select title, status, capacity, reserved from public.events where title = 'Test night';


-- ===== STEP 10 · as bob@test.dev · booking a full event fails
-- Expect: ERROR  EVENT_FULL: This event has reached its booking capacity.
select * from public.book_event((select id from public.events where title = 'Test night'), 1);


-- ===== STEP 11 · as bob@test.dev · join the waitlist
-- Run both lines together. Expect: place = 1
select public.join_waitlist((select id from public.events where title = 'Test night'));
select public.waitlist_place(id) as place from public.waitlist_entries where status = 'waiting';


-- ===== STEP 12 · as alice@test.dev · cancel, which offers the seat to Bob
-- Expect: (no error)
select public.cancel_booking((select id from public.bookings where status = 'confirmed'
                               and event_id = (select id from public.events where title = 'Test night')));


-- ===== STEP 13 · as bob@test.dev · Bob has an offer waiting
-- Expect: 1 row, status offered, offer_expires_at about 24 hours from now. Also a "Seat available" notice.
select status, offer_expires_at from public.waitlist_entries;
-- (run this line too, on its own, to see the in-app notices)
-- select title, body from public.notifications order by created_at desc;


-- ===== STEP 14 · as bob@test.dev · accept the offered seat
-- Expect: 1 row, status confirmed. Copy Bob's ticket_token too.
select * from public.book_event((select id from public.events where title = 'Test night'), 1,
                                (select id from public.waitlist_entries where status = 'offered'));


-- ===== STEP 15 · as alice@test.dev · book 2 seats of the paid event
-- Expect: status pending_payment, final_cents 7200 (Alice is on Free: full price), hold_expires_at in 15 minutes.
select * from public.quote_price((select id from public.events where title = 'Test workshop'), 2);
select * from public.book_event((select id from public.events where title = 'Test workshop'), 2);


-- ===== STEP 16 · as postgres · pretend Square's webhook says Alice paid
-- Run it twice: the second run changes nothing (each payment is processed once).
-- Expect: confirmed, and exactly 1 payment row.
select public.confirm_booking_payment(
  (select b.id from public.bookings b join public.profiles p on p.id = b.user_id
    where p.email = 'alice@test.dev' and b.status = 'pending_payment'),
  'sq_test_payment_1', 7200);
select b.booking_number, b.status, pay.amount_cents, pay.status as payment
  from public.bookings b join public.payments pay on pay.booking_id = b.id
 where pay.provider_payment_id = 'sq_test_payment_1';


-- ===== STEP 17 · as organizer@test.dev · scan Bob's ticket and check him in
-- Paste Bob's ticket_token from step 14 in place of PASTE_TOKEN_HERE.
-- Expect: display_name "bob" (first name + last initial; dashboard-made users have no full name,
-- so it falls back to the part of the email before the @), checkin_status not_checked_in.
-- Then run the check_in line below on its own and scan again: checked_in.
select * from public.scan_ticket((select id from public.events where title = 'Test night'), 'PASTE_TOKEN_HERE');
-- then, on its own:
-- select public.check_in((select booking_id from public.scan_ticket((select id from public.events where title = 'Test night'), 'PASTE_TOKEN_HERE')));


-- ===== STEP 18 · as organizer@test.dev · registrations list shows names, never emails
-- Expect: rows with member_name, quantity, status; no email column.
select * from public.event_registrations((select id from public.events where title = 'Test night'));


-- ===== STEP 19 · as bob@test.dev · privacy checks (then run each commented line on its own, as the person named)
-- as bob@test.dev        → 1   (only his own profile)
select count(*) from public.profiles;
-- as bob@test.dev        → only Bob's bookings
-- select booking_number, status from public.bookings;
-- as organizer@test.dev  → 1   (organizers cannot read member emails)
-- select count(*) from public.profiles;
-- as bob@test.dev        → ERROR permission denied (members cannot run the payment webhook)
-- select public.confirm_booking_payment(gen_random_uuid(), 'x', 0);
-- as bob@test.dev        → ERROR permission denied (members cannot change their own account status)
-- update public.profiles set status = 'inactive' where id = auth.uid();


-- ===== STEP 20 · as bob@test.dev · upgrade to Standard
-- Expect: a membership id (status pending until paid).
select public.start_membership_checkout((select id from public.membership_plans where slug = 'standard'));


-- ===== STEP 21 · as postgres · pretend Bob's membership payment went through
-- Expect: bob@test.dev  standard  active  expires in a year.
select public.confirm_membership_payment(
  (select m.id from public.memberships m join public.profiles p on p.id = m.user_id where p.email = 'bob@test.dev' and m.status = 'pending'),
  'sq_test_membership_1', 6000);
select p.email, pl.slug, m.status, m.expires_at
  from public.memberships m join public.profiles p on p.id = m.user_id join public.membership_plans pl on pl.id = m.plan_id
 where p.email = 'bob@test.dev' and m.status = 'active';


-- ===== STEP 22 · as bob@test.dev · member price now applies
-- Expect: final_cents 3000, note "Member price" (beats Standard's 10% off of 3600).
select * from public.quote_price((select id from public.events where title = 'Test workshop'), 1);


-- ===== STEP 23 · as bob@test.dev, then postgres · a seat hold runs out
-- as bob@test.dev: book 1 seat (pending_payment):
select * from public.book_event((select id from public.events where title = 'Test workshop'), 1);
-- then as postgres, run these two lines together. Expect holds_released 1, and reserved back to 2:
-- update public.bookings set hold_expires_at = now() - interval '1 minute' where status = 'pending_payment';
-- select public.run_jobs();


-- ===== STEP 24 · as organizer@test.dev · cancel the paid event
-- Expect: {"bookings": 1, "refunds": 1}  (bookings is 2 if you skipped expiring Bob's hold in step 23)
select public.cancel_event((select id from public.events where title = 'Test workshop'));


-- ===== STEP 25 · as postgres · look at what the system recorded
-- Expect: emails queued for each notice, Alice's payment now refund_pending, and an audit trail.
select to_email, subject from public.email_outbox order by created_at;
-- select provider_payment_id, amount_cents, status from public.payments;
-- select actor_id, action, detail from public.audit_log order by created_at;


-- ===== CLEAN UP · as postgres · remove all test data (then delete the 3 test users under Authentication → Users)
-- delete from public.audit_log;
-- delete from public.email_outbox where to_email like '%@test.dev';
-- delete from public.payments where user_id in (select id from public.profiles where email like '%@test.dev');
-- delete from public.bookings where event_id in (select id from public.events where title like 'Test %');
-- delete from public.events where title like 'Test %';
-- update public.memberships set status = 'cancelled' where user_id in (select id from public.profiles where email like '%@test.dev') and status = 'pending';
