-- =====================================================================================
-- EventBook database schema for Supabase (Postgres 15+)
--
-- Run once: Supabase dashboard → SQL Editor → New query → paste this file → Run.
-- (Or with the Supabase CLI: `supabase db push`.)
--
-- What is here
--   1. Types           enums for every status in the app
--   2. Tables          settings, profiles, roles, plans, memberships, events, bookings,
--                      waitlist, payments, notifications, email outbox, audit log
--   3. Helpers         role checks used by the security policies, pricing, templates
--   4. Triggers        new-user setup, event bookkeeping, audit trail
--   5. App functions   book, cancel, waitlist, check-in, publish, memberships, admin, reports
--   6. Server-only     payment webhooks and the scheduled jobs (service_role)
--   7. Security        row-level security policies and grants
--   8. Seed data       plans, notification templates, settings
--
-- Conventions
--   * Money is in cents (integer). Times are timestamptz (UTC); the UI shows America/Toronto.
--   * Functions raise errors as 'CODE: message', e.g. 'EVENT_FULL: This event has reached its
--     booking capacity.' The frontend splits on the first ': ' to get the code the UI expects.
--   * Sign-up, email verification, password reset and two-step sign-in are Supabase Auth.
--     A trigger creates the profile, the member role and the Free membership for each new user.
--   * Ticket QR codes hold a random token; only its SHA-256 hash is stored.
-- =====================================================================================


-- =====================================================================================
-- 1. Types
-- =====================================================================================
create type public.app_role          as enum ('member', 'organizer', 'admin');
create type public.account_status    as enum ('pending_verification', 'active', 'inactive');
create type public.membership_status as enum ('pending', 'active', 'suspended', 'expired', 'cancelled');
create type public.event_status      as enum ('draft', 'published', 'full', 'cancelled', 'completed');
create type public.event_type        as enum ('in_person', 'virtual', 'hybrid');
create type public.booking_status    as enum ('pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show');
create type public.checkin_status    as enum ('not_checked_in', 'checked_in');
create type public.waitlist_status   as enum ('waiting', 'offered', 'accepted', 'left', 'expired');
create type public.payment_kind      as enum ('booking', 'membership');
create type public.payment_status    as enum ('pending', 'succeeded', 'failed', 'refund_pending', 'refunded');


-- =====================================================================================
-- 2. Tables
-- =====================================================================================

-- One row of organization-wide settings (ADM-2).
create table public.org_settings (
  id                       boolean primary key default true check (id),
  org_name                 text    not null default 'Clay Collective' check (length(trim(org_name)) > 0),
  currency                 char(3) not null default 'CAD',
  hold_minutes             int     not null default 15 check (hold_minutes between 5 and 30),
  offer_hours              int     not null default 24 check (offer_hours between 1 and 72),
  cutoff_hours             int     not null default 24 check (cutoff_hours between 0 and 168),
  mfa_required_for_admins  boolean not null default true,
  sso_enabled              boolean not null default false,
  sso_issuer               text    check (sso_issuer is null or sso_issuer ~ '^https://'),
  sso_client_id            text,
  updated_at               timestamptz not null default now(),
  constraint sso_complete check (not sso_enabled or (sso_issuer is not null and sso_client_id is not null))
);

-- One profile per Supabase Auth user.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null check (length(trim(full_name)) > 0),
  email       text not null unique,
  phone       text check (phone is null or phone ~ '^[+\d][\d\s().-]{6,}$'),
  status      public.account_status not null default 'pending_verification',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Every user has 'member'; organizer and admin are granted on top.
create table public.user_roles (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.app_role not null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.membership_plans (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text not null unique check (length(trim(name)) > 0),
  price_cents        int  not null default 0 check (price_cents >= 0),
  billing_cycle      text not null default 'year' check (billing_cycle in ('none', 'year')),
  discount           numeric(3, 2) not null default 0 check (discount between 0 and 0.90),
  early_access_days  int  not null default 0 check (early_access_days between 0 and 30),
  benefits           text[] not null default '{}',
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Membership history: one current (active/suspended) row per user, plus at most one pending checkout.
create table public.memberships (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  plan_id               uuid not null references public.membership_plans (id),
  status                public.membership_status not null default 'pending',
  starts_at             timestamptz not null default now(),
  expires_at            timestamptz,                       -- null for the Free plan
  cancel_at_period_end  boolean not null default false,
  reminded_14d          boolean not null default false,
  reminded_3d           boolean not null default false,
  created_at            timestamptz not null default now(),
  constraint membership_dates check (expires_at is null or expires_at >= starts_at)
);
create unique index memberships_one_current on public.memberships (user_id) where status in ('active', 'suspended');
create unique index memberships_one_pending on public.memberships (user_id) where status = 'pending';
create index memberships_expiry on public.memberships (expires_at) where status in ('active', 'suspended');

create table public.events (
  id                         uuid primary key default gen_random_uuid(),
  organizer_id               uuid not null references public.profiles (id),
  title                      text not null check (length(trim(title)) between 1 and 80),
  category                   text not null default 'Workshop',
  description                text not null default '',
  type                       public.event_type not null default 'in_person',
  venue                      text,
  city                       text,
  starts_at                  timestamptz not null,
  ends_at                    timestamptz not null,
  registration_opens_at      timestamptz not null,
  registration_closes_at     timestamptz not null,              -- set by trigger: 2 hours before the start
  capacity                   int  not null check (capacity > 0),
  reserved                   int  not null default 0 check (reserved >= 0),   -- confirmed + held + offered seats
  max_tickets_per_member     int  not null default 1 check (max_tickets_per_member between 1 and 10),
  price_cents                int  not null default 0 check (price_cents >= 0),
  member_price_cents         int  check (member_price_cents is null or member_price_cents between 0 and price_cents),
  eligible_plan_ids          uuid[],                            -- null = everyone with an account
  waitlist_enabled           boolean not null default true,
  cancellation_cutoff_hours  int  not null default 24 check (cancellation_cutoff_hours between 0 and 168),
  status                     public.event_status not null default 'draft',
  color                      text not null default '#d7e3c3',
  version                    int  not null default 1,           -- optimistic locking for edits
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint events_seats      check (reserved <= capacity),
  constraint events_times      check (ends_at > starts_at and registration_opens_at < starts_at),
  constraint events_location   check (status = 'draft' or type = 'virtual' or (venue is not null and city is not null)),
  constraint events_plans      check (eligible_plan_ids is null or cardinality(eligible_plan_ids) > 0)
);
create index events_listing on public.events (status, starts_at);
create index events_organizer on public.events (organizer_id);

-- The meeting link is shown only to managers and confirmed attendees, so it lives apart from events.
create table public.event_private (
  event_id     uuid primary key references public.events (id) on delete cascade,
  meeting_url  text check (meeting_url is null or meeting_url ~ '^https://')
);

-- Co-organizers can manage an event like its owner.
create table public.event_organizers (
  event_id  uuid not null references public.events (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);

create sequence public.booking_number_seq start 20400;

create table public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  booking_number      text not null unique default ('EB-' || nextval('public.booking_number_seq')),
  event_id            uuid not null references public.events (id),
  user_id             uuid not null references public.profiles (id),
  quantity            int  not null check (quantity between 1 and 10),
  original_cents      int  not null check (original_cents >= 0),
  discount_cents      int  not null default 0 check (discount_cents >= 0),
  final_cents         int  not null check (final_cents >= 0),
  pricing_note        text not null,
  plan_id             uuid references public.membership_plans (id),    -- the plan at booking time
  status              public.booking_status not null,
  checkin_status      public.checkin_status not null default 'not_checked_in',
  checked_in_at       timestamptz,
  checked_in_by       uuid references public.profiles (id),
  hold_expires_at     timestamptz,
  ticket_token_hash   bytea not null unique,
  cancelled_at        timestamptz,
  cancel_reason       text,
  reminded_24h        boolean not null default false,
  reminded_2h         boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint bookings_price check (final_cents = original_cents - discount_cents),
  constraint bookings_hold  check (status <> 'pending_payment' or hold_expires_at is not null)
);
create unique index bookings_one_open_per_member on public.bookings (event_id, user_id) where status in ('pending_payment', 'confirmed');
create index bookings_by_user on public.bookings (user_id);
create index bookings_by_event on public.bookings (event_id, status);
create index bookings_holds on public.bookings (hold_expires_at) where status = 'pending_payment';

create table public.waitlist_entries (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  position          int  not null check (position > 0),
  status            public.waitlist_status not null default 'waiting',
  offer_expires_at  timestamptz,
  joined_at         timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (event_id, position),
  constraint waitlist_offer check (status <> 'offered' or offer_expires_at is not null)
);
create unique index waitlist_one_open_per_member on public.waitlist_entries (event_id, user_id) where status in ('waiting', 'offered');
create index waitlist_offers on public.waitlist_entries (offer_expires_at) where status = 'offered';

create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  kind                 public.payment_kind not null,
  booking_id           uuid references public.bookings (id),
  membership_id        uuid references public.memberships (id),
  user_id              uuid not null references public.profiles (id),
  amount_cents         int  not null check (amount_cents >= 0),
  currency             char(3) not null default 'CAD',
  status               public.payment_status not null default 'pending',
  provider             text not null default 'square',
  provider_payment_id  text unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint payments_target check (
    (kind = 'booking'    and booking_id is not null and membership_id is null) or
    (kind = 'membership' and membership_id is not null and booking_id is null))
);
create index payments_by_user on public.payments (user_id);
create index payments_by_booking on public.payments (booking_id);

-- Webhook deliveries already handled, so each provider event is processed once.
create table public.payment_webhook_events (
  provider_event_id  text primary key,
  provider           text not null default 'square',
  payload            jsonb not null,
  received_at        timestamptz not null default now()
);

create table public.notification_templates (
  id          text primary key,
  name        text not null,
  subject     text not null check (length(trim(subject)) > 0),
  body        text not null check (length(trim(body)) > 0),
  updated_at  timestamptz not null default now()
);

-- In-app inbox.
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  template_id  text references public.notification_templates (id),
  title        text not null,
  body         text not null,
  link         jsonb,                    -- e.g. {"label":"Show my ticket","act":"ticketlink","id":"<booking id>"}
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_inbox on public.notifications (user_id, created_at desc);

-- Emails waiting to be sent by an Edge Function (Resend, Postmark, ...).
create table public.email_outbox (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles (id) on delete set null,
  to_email     text not null,
  template_id  text references public.notification_templates (id),
  subject      text not null,
  body         text not null,
  status       text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts     int  not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index email_outbox_queue on public.email_outbox (created_at) where status = 'queued';

-- Insert-only audit trail. actor_id null = a system job.
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.profiles (id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  detail       text not null,
  data         jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_recent on public.audit_log (created_at desc);
create index audit_log_entity on public.audit_log (entity_type, entity_id);


-- =====================================================================================
-- 3. Helpers
-- =====================================================================================

create function public.has_role(p_role public.app_role, p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = p_user and role = p_role);
$$;

create function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('admin');
$$;

-- Owner, co-organizer or admin.
create function public.can_manage_event(p_event_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from public.events where id = p_event_id and organizer_id = auth.uid())
      or exists (select 1 from public.event_organizers where event_id = p_event_id and user_id = auth.uid());
$$;

create function public.has_confirmed_booking(p_event_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.bookings where event_id = p_event_id and user_id = auth.uid() and status = 'confirmed');
$$;

-- The user's active paid plan, or a row of nulls.
create function public.active_paid_plan(p_user uuid)
returns public.membership_plans language sql stable security definer set search_path = public as $$
  select p.*
    from public.memberships m
    join public.membership_plans p on p.id = m.plan_id
   where m.user_id = p_user and m.status = 'active' and p.price_cents > 0
     and (m.expires_at is null or m.expires_at > now())
   limit 1;
$$;

create function public.fmt_when(p_ts timestamptz)
returns text language sql stable as $$
  select to_char(p_ts at time zone 'America/Toronto', 'Dy DD Mon, HH24:MI');
$$;

create function public.fmt_day(p_ts timestamptz)
returns text language sql stable as $$
  select to_char(p_ts at time zone 'America/Toronto', 'DD Mon YYYY');
$$;

create function public.fmt_money(p_cents int)
returns text language sql immutable as $$
  select case when p_cents = 0 then 'Free' else '$' || to_char(p_cents / 100.0, 'FM999999990.00') end;
$$;

create function public.event_vars(p_event public.events)
returns jsonb language sql stable as $$
  select jsonb_build_object('event', p_event.title, 'when', public.fmt_when(p_event.starts_at), 'where', coalesce(p_event.venue, 'Online'));
$$;

-- BR-6: the lower of the plan discount and the member price; free events cost nothing.
create function public.price_for(p_event public.events, p_user uuid, p_quantity int,
  out original_cents int, out discount_cents int, out final_cents int, out note text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_plan public.membership_plans;
  v_unit int;
begin
  original_cents := p_event.price_cents * p_quantity;
  if p_event.price_cents = 0 then
    discount_cents := 0; final_cents := 0; note := 'Free event'; return;
  end if;
  v_plan := public.active_paid_plan(p_user);
  if v_plan.id is null then
    discount_cents := 0; final_cents := original_cents; note := 'Full price'; return;
  end if;
  v_unit := round(p_event.price_cents * (1 - v_plan.discount));
  note := format('%s plan, %s%% off', v_plan.name, round(v_plan.discount * 100));
  if p_event.member_price_cents is not null and p_event.member_price_cents < v_unit then
    v_unit := p_event.member_price_cents; note := 'Member price';
  end if;
  final_cents := v_unit * p_quantity;
  discount_cents := original_cents - final_cents;
end $$;

-- Price quote for the signed-in user (or full price when signed out).
create function public.quote_price(p_event_id uuid, p_quantity int default 1)
returns table (original_cents int, discount_cents int, final_cents int, note text)
language sql stable security definer set search_path = public as $$
  select q.* from public.events e, lateral public.price_for(e, auth.uid(), p_quantity) q
   where e.id = p_event_id and (e.status <> 'draft' or public.can_manage_event(e.id));
$$;

create function public.render_template(p_text text, p_vars jsonb)
returns text language plpgsql immutable as $$
declare
  k text; v text; r text := p_text;
begin
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    r := replace(r, '{{' || k || '}}', coalesce(v, ''));
  end loop;
  return regexp_replace(r, '\{\{\w+\}\}', '', 'g');
end $$;

create function public.write_audit(p_actor uuid, p_action text, p_entity_type text, p_entity_id text, p_detail text, p_data jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor_id, action, entity_type, entity_id, detail, data)
  values (p_actor, p_action, p_entity_type, p_entity_id, p_detail, p_data);
$$;

-- NOTIF-1: one in-app notice and one queued email from a template.
create function public.notify_user(p_user uuid, p_template text, p_vars jsonb default '{}', p_link jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.notification_templates;
  p public.profiles;
  vars jsonb;
  v_subject text; v_body text;
begin
  select * into t from public.notification_templates where id = p_template;
  if not found then raise exception 'NOT_FOUND: Unknown notification template %.', p_template; end if;
  select * into p from public.profiles where id = p_user;
  vars := jsonb_build_object('org', (select org_name from public.org_settings), 'name', split_part(p.full_name, ' ', 1)) || coalesce(p_vars, '{}');
  v_subject := public.render_template(t.subject, vars);
  v_body := public.render_template(t.body, vars);
  insert into public.notifications (user_id, template_id, title, body, link) values (p_user, p_template, v_subject, v_body, p_link);
  insert into public.email_outbox (user_id, to_email, template_id, subject, body) values (p_user, p.email, p_template, v_subject, v_body);
end $$;

create function public.notify_booking_confirmed(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  b public.bookings; e public.events;
begin
  select * into b from public.bookings where id = p_booking_id;
  select * into e from public.events where id = b.event_id;
  perform public.notify_user(b.user_id, 'booking_confirmed',
    public.event_vars(e) || jsonb_build_object('tickets', b.quantity || ' ticket' || case when b.quantity > 1 then 's' else '' end, 'amount', public.fmt_money(b.final_cents)),
    jsonb_build_object('label', 'Show my ticket', 'act', 'ticketlink', 'id', b.id));
end $$;

-- PUBLISHED <-> FULL as seats come and go.
create function public.set_event_fullness(p_event_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.events
     set status = case when reserved >= capacity then 'full'::public.event_status else 'published'::public.event_status end
   where id = p_event_id and status in ('published', 'full');
$$;

-- WL-2: offer one freed seat to the first eligible person waiting. Returns false when nobody can take it.
create function public.promote_waitlist(p_event_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  e public.events;
  w public.waitlist_entries;
  v_until timestamptz;
begin
  select * into e from public.events where id = p_event_id for update;
  if not e.waitlist_enabled or e.reserved >= e.capacity or e.status not in ('published', 'full') then return false; end if;
  select we.* into w
    from public.waitlist_entries we
    join public.profiles p on p.id = we.user_id
   where we.event_id = p_event_id and we.status = 'waiting' and p.status <> 'inactive'
     and (e.eligible_plan_ids is null or exists (
           select 1 from public.memberships m
            where m.user_id = we.user_id and m.status = 'active' and m.plan_id = any (e.eligible_plan_ids)))
   order by we.position
   limit 1
   for update of we skip locked;
  if not found then return false; end if;
  v_until := now() + make_interval(hours => (select offer_hours from public.org_settings));
  update public.waitlist_entries set status = 'offered', offer_expires_at = v_until, updated_at = now() where id = w.id;
  update public.events set reserved = reserved + 1 where id = p_event_id;
  perform public.set_event_fullness(p_event_id);
  perform public.notify_user(w.user_id, 'seat_offered', public.event_vars(e) || jsonb_build_object('until', public.fmt_when(v_until)),
    jsonb_build_object('label', 'Accept the seat', 'act', 'openevent', 'id', p_event_id));
  return true;
end $$;

-- Free a booking's seats, mark its payment for refund, and (unless told not to) move the waitlist up.
create function public.release_booking(p_booking_id uuid, p_reason text, p_promote boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare
  b public.bookings;
begin
  select * into b from public.bookings where id = p_booking_id for update;
  if not found or b.status not in ('pending_payment', 'confirmed') then return; end if;
  update public.bookings
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, hold_expires_at = null, updated_at = now()
   where id = b.id;
  update public.events set reserved = reserved - b.quantity where id = b.event_id;
  perform public.set_event_fullness(b.event_id);
  if b.status = 'confirmed' and b.final_cents > 0 then
    update public.payments set status = 'refund_pending', updated_at = now() where booking_id = b.id and status = 'succeeded';
  end if;
  if p_promote then
    for i in 1 .. b.quantity loop
      exit when not public.promote_waitlist(b.event_id);
    end loop;
  end if;
end $$;


-- =====================================================================================
-- 4. Triggers
-- =====================================================================================

create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger plans_touch before update on public.membership_plans for each row execute function public.touch_updated_at();
create trigger bookings_touch before update on public.bookings for each row execute function public.touch_updated_at();
create trigger waitlist_touch before update on public.waitlist_entries for each row execute function public.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function public.touch_updated_at();
create trigger templates_touch before update on public.notification_templates for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.org_settings for each row execute function public.touch_updated_at();

-- New Auth user → profile, member role, Free membership.
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, status)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
          lower(new.email),
          case when new.email_confirmed_at is null then 'pending_verification'::public.account_status else 'active'::public.account_status end);
  insert into public.user_roles (user_id, role) values (new.id, 'member');
  insert into public.memberships (user_id, plan_id, status)
  select new.id, id, 'active' from public.membership_plans where slug = 'free';
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Email confirmed or changed in Auth → profile follows.
create function public.handle_user_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set email = lower(new.email),
         status = case when status = 'pending_verification' and new.email_confirmed_at is not null then 'active'::public.account_status else status end
   where id = new.id;
  return new;
end $$;
create trigger on_auth_user_updated after update of email, email_confirmed_at on auth.users for each row execute function public.handle_user_updated();

-- Events: registration closes 2 hours before the start; edits by people bump the version.
create function public.events_before_write()
returns trigger language plpgsql as $$
begin
  new.registration_closes_at := new.starts_at - interval '2 hours';
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['reserved', 'status', 'updated_at', 'version'])
       is distinct from (to_jsonb(old) - array['reserved', 'status', 'updated_at', 'version']) then
      new.version := old.version + 1;
    end if;
  end if;
  return new;
end $$;
create trigger events_before_write before insert or update on public.events for each row execute function public.events_before_write();

-- More capacity → the waitlist moves up at once.
create function public.events_after_capacity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.capacity > old.capacity and new.status in ('published', 'full') then
    perform public.set_event_fullness(new.id);
    for i in 1 .. (new.capacity - old.capacity) loop
      exit when not public.promote_waitlist(new.id);
    end loop;
  end if;
  return null;
end $$;
create trigger events_after_capacity after update of capacity on public.events for each row execute function public.events_after_capacity();

-- Audit trail for admin-edited tables.
create function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_log (actor_id, action, entity_type, entity_id, detail, data)
  values (auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name,
          coalesce(v_row ->> 'id', v_row ->> 'user_id'),
          initcap(lower(tg_op)) || ' on ' || tg_table_name, v_row);
  return null;
end $$;
create trigger audit_roles after insert or delete on public.user_roles for each row execute function public.audit_row_change();
create trigger audit_plans after insert or update on public.membership_plans for each row execute function public.audit_row_change();
create trigger audit_templates after update on public.notification_templates for each row execute function public.audit_row_change();
create trigger audit_settings after update on public.org_settings for each row execute function public.audit_row_change();
create trigger audit_coorgs after insert or delete on public.event_organizers for each row execute function public.audit_row_change();

-- Admins cannot remove their own admin role.
create function public.guard_own_admin_role()
returns trigger language plpgsql as $$
begin
  if old.role = 'admin' and old.user_id = auth.uid() then
    raise exception 'CONFLICT: You cannot remove your own admin role.';
  end if;
  return old;
end $$;
create trigger guard_own_admin_role before delete on public.user_roles for each row execute function public.guard_own_admin_role();


-- =====================================================================================
-- 5. App functions (called from the frontend with supabase.rpc)
-- =====================================================================================

-- BKG-1..4, BR-1..7: book seats, or accept an offered waitlist seat (p_offer_id).
-- Free bookings are confirmed at once; paid ones are held for org_settings.hold_minutes.
-- The plain ticket token is returned once, here; only its hash is stored.
create function public.book_event(p_event_id uuid, p_quantity int default 1, p_offer_id uuid default null)
returns table (booking_id uuid, booking_number text, status public.booking_status, final_cents int, hold_expires_at timestamptz, ticket_token text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_uid    uuid := auth.uid();
  v_prof   public.profiles;
  v_event  public.events;
  v_plan   public.membership_plans;
  v_mem    public.memberships;
  v_offer  public.waitlist_entries;
  v_price  record;
  v_token  text;
  v_opens  timestamptz;
  v_b      public.bookings;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED: Sign in to book.'; end if;
  select * into v_prof from public.profiles where id = v_uid;
  if v_prof.status = 'inactive' then raise exception 'FORBIDDEN: This account is deactivated.'; end if;
  if v_prof.status <> 'active' then raise exception 'EMAIL_NOT_VERIFIED: Verify your email before booking. The link is in your inbox.'; end if;

  if p_offer_id is not null then
    select * into v_offer from public.waitlist_entries where id = p_offer_id for update;
    if not found or v_offer.user_id <> v_uid or v_offer.event_id <> p_event_id or v_offer.status <> 'offered' then
      raise exception 'CONFLICT: This offer is no longer open.';
    end if;
    if v_offer.offer_expires_at < now() then raise exception 'CONFLICT: This offer expired.'; end if;
    p_quantity := 1;
  end if;

  select * into v_event from public.events where id = p_event_id for update;   -- serialises bookings for this event
  if not found or v_event.status in ('draft', 'cancelled', 'completed') then
    raise exception 'EVENT_NOT_BOOKABLE: This event is not open for booking.';
  end if;

  v_plan := public.active_paid_plan(v_uid);
  v_opens := v_event.registration_opens_at - make_interval(days => coalesce(v_plan.early_access_days, 0));
  if now() < v_opens then raise exception 'REGISTRATION_CLOSED: Registration opens for you on %.', public.fmt_when(v_opens); end if;
  if now() > v_event.registration_closes_at then raise exception 'REGISTRATION_CLOSED: Registration has closed.'; end if;

  if v_event.eligible_plan_ids is not null then
    select * into v_mem from public.memberships where user_id = v_uid and status in ('active', 'suspended');
    if v_mem.id is null or v_mem.status <> 'active' then
      raise exception 'MEMBERSHIP_INACTIVE: Your membership is not active. Renew it to book this event.';
    end if;
    if not (v_mem.plan_id = any (v_event.eligible_plan_ids)) then
      raise exception 'NOT_ELIGIBLE: Only % members can book this event.',
        (select string_agg(name, ' and ' order by price_cents) from public.membership_plans where id = any (v_event.eligible_plan_ids));
    end if;
  end if;

  if exists (select 1 from public.bookings b where b.event_id = p_event_id and b.user_id = v_uid and b.status in ('pending_payment', 'confirmed')) then
    raise exception 'DUPLICATE_BOOKING: You already have a booking for this event.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > v_event.max_tickets_per_member then
    raise exception 'VALIDATION_FAILED: Choose 1 to % tickets.', v_event.max_tickets_per_member;
  end if;

  if p_offer_id is null then   -- an offered seat is already counted in reserved
    if v_event.reserved + p_quantity > v_event.capacity then
      raise exception 'EVENT_FULL: This event has reached its booking capacity.';
    end if;
    update public.events set reserved = reserved + p_quantity where id = p_event_id;
  end if;

  select * into v_price from public.price_for(v_event, v_uid, p_quantity);
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.bookings (event_id, user_id, quantity, original_cents, discount_cents, final_cents, pricing_note, plan_id, status, hold_expires_at, ticket_token_hash)
  values (p_event_id, v_uid, p_quantity, v_price.original_cents, v_price.discount_cents, v_price.final_cents, v_price.note,
          (select plan_id from public.memberships where user_id = v_uid and status in ('active', 'suspended')),
          case when v_price.final_cents > 0 then 'pending_payment'::public.booking_status else 'confirmed'::public.booking_status end,
          case when v_price.final_cents > 0 then now() + make_interval(mins => (select hold_minutes from public.org_settings)) end,
          sha256(convert_to(v_token, 'UTF8')))
  returning * into v_b;

  perform public.set_event_fullness(p_event_id);
  if p_offer_id is not null then
    update public.waitlist_entries set status = 'accepted' where id = p_offer_id;
  end if;
  if v_b.status = 'confirmed' then perform public.notify_booking_confirmed(v_b.id); end if;

  return query select v_b.id, v_b.booking_number, v_b.status, v_b.final_cents, v_b.hold_expires_at, v_token;
end $$;

-- BKG-6: cancel a booking (the member before the cut-off; a manager any time). Paid bookings are refunded.
-- Also used to abandon a checkout and release held seats.
create function public.cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  b public.bookings; e public.events;
  v_own boolean; v_mgr boolean; v_refund boolean;
begin
  select * into b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'NOT_FOUND: No such booking.'; end if;
  select * into e from public.events where id = b.event_id;
  v_own := b.user_id = v_uid;
  v_mgr := public.can_manage_event(e.id);
  if not v_own and not v_mgr then raise exception 'FORBIDDEN: You can only cancel your own bookings.'; end if;
  if b.status not in ('pending_payment', 'confirmed') then raise exception 'CONFLICT: This booking is already closed.'; end if;
  if b.status = 'confirmed' and not v_mgr and now() > e.starts_at - make_interval(hours => e.cancellation_cutoff_hours) then
    raise exception 'CANCELLATION_WINDOW_CLOSED: Cancellations close % hours before the start.', e.cancellation_cutoff_hours;
  end if;

  v_refund := b.status = 'confirmed' and b.final_cents > 0;
  perform public.release_booking(b.id, case when b.status = 'pending_payment' and v_own then 'Checkout cancelled'
                                            when v_own and not v_mgr then 'Cancelled by member'
                                            else 'Cancelled by organizer' end);
  if b.status = 'confirmed' then
    perform public.notify_user(b.user_id, 'booking_cancelled', public.event_vars(e) || jsonb_build_object('detail',
      case when v_refund then format('A full refund of %s is on its way to your card.', public.fmt_money(b.final_cents))
           when v_own then '' else 'The organizer cancelled it.' end));
  end if;
  if not v_own then
    perform public.write_audit(v_uid, 'booking.cancel', 'booking', b.booking_number,
      format('Cancelled %s''s booking for %s', (select full_name from public.profiles where id = b.user_id), e.title));
  end if;
end $$;

-- WL-1: join the waitlist of a full event.
create function public.join_waitlist(p_event_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  e public.events;
  v_id uuid;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED: Sign in first.'; end if;
  if (select status from public.profiles where id = v_uid) <> 'active' then raise exception 'EMAIL_NOT_VERIFIED: Verify your email first.'; end if;
  select * into e from public.events where id = p_event_id for update;
  if not found or e.status not in ('published', 'full') then raise exception 'EVENT_NOT_BOOKABLE: This event is not open for booking.'; end if;
  if not e.waitlist_enabled then raise exception 'CONFLICT: This event has no waitlist.'; end if;
  if e.reserved < e.capacity then raise exception 'CONFLICT: Seats are free: book instead.'; end if;
  if e.eligible_plan_ids is not null and not exists (
       select 1 from public.memberships where user_id = v_uid and status = 'active' and plan_id = any (e.eligible_plan_ids)) then
    raise exception 'NOT_ELIGIBLE: Your plan cannot book this event.';
  end if;
  if exists (select 1 from public.waitlist_entries where event_id = p_event_id and user_id = v_uid and status in ('waiting', 'offered')) then
    raise exception 'DUPLICATE_BOOKING: You are already on this waitlist.';
  end if;
  insert into public.waitlist_entries (event_id, user_id, position)
  values (p_event_id, v_uid, coalesce((select max(position) from public.waitlist_entries where event_id = p_event_id), 0) + 1)
  returning id into v_id;
  perform public.notify_user(v_uid, 'waitlist_joined', public.event_vars(e));
  return v_id;
end $$;

-- Leave a waitlist (or decline an offer). Managers can remove anyone.
create function public.leave_waitlist(p_entry_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  w public.waitlist_entries;
  v_mgr boolean;
begin
  select * into w from public.waitlist_entries where id = p_entry_id for update;
  if not found then raise exception 'NOT_FOUND: No such waitlist entry.'; end if;
  v_mgr := public.can_manage_event(w.event_id);
  if w.user_id <> auth.uid() and not v_mgr then raise exception 'FORBIDDEN: Not your waitlist entry.'; end if;
  if w.status not in ('waiting', 'offered') then raise exception 'CONFLICT: This entry is already closed.'; end if;
  update public.waitlist_entries set status = 'left' where id = w.id;
  if w.status = 'offered' then
    update public.events set reserved = reserved - 1 where id = w.event_id;
    perform public.set_event_fullness(w.event_id);
    perform public.promote_waitlist(w.event_id);
  end if;
  if w.user_id <> auth.uid() then
    perform public.write_audit(auth.uid(), 'waitlist.remove', 'event', w.event_id::text,
      format('Removed %s from the %s waitlist', (select full_name from public.profiles where id = w.user_id), (select title from public.events where id = w.event_id)));
  end if;
end $$;

-- "Number N in line" for the member's own entry; members never see the rest of the list.
create function public.waitlist_place(p_entry_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select (select count(*) from public.waitlist_entries o
           where o.event_id = w.event_id and o.status = 'waiting' and o.position < w.position)::int + 1
    from public.waitlist_entries w
   where w.id = p_entry_id and w.user_id = auth.uid();
$$;

-- Meeting link for managers and confirmed attendees.
create function public.event_meeting_url(p_event_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select meeting_url from public.event_private
   where event_id = p_event_id and (public.can_manage_event(p_event_id) or public.has_confirmed_booking(p_event_id));
$$;

-- EVT-*: publish a draft after checking it is complete.
create function public.publish_event(p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then raise exception 'NOT_FOUND: No such event.'; end if;
  if not public.can_manage_event(p_event_id) then raise exception 'FORBIDDEN: Not your event.'; end if;
  if e.status <> 'draft' then raise exception 'CONFLICT: Only drafts can be published.'; end if;
  if e.starts_at <= now() then raise exception 'VALIDATION_FAILED: The event must start in the future.'; end if;
  if trim(e.description) = '' then raise exception 'VALIDATION_FAILED: Write one or two lines on what happens.'; end if;
  if e.type <> 'virtual' and (coalesce(trim(e.venue), '') = '' or coalesce(trim(e.city), '') = '') then
    raise exception 'VALIDATION_FAILED: Write the venue and city.';
  end if;
  if e.type <> 'in_person' and coalesce((select meeting_url from public.event_private where event_id = p_event_id), '') = '' then
    raise exception 'VALIDATION_FAILED: Paste the meeting link, starting https://';
  end if;
  update public.events set status = 'published' where id = p_event_id;
  perform public.set_event_fullness(p_event_id);
  perform public.write_audit(auth.uid(), 'event.publish', 'event', p_event_id::text, 'Published ' || e.title);
end $$;

-- Cancel an event: every booking released and refunded, everyone booked or waiting told.
create function public.cancel_event(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e public.events; b public.bookings; w public.waitlist_entries;
  v_n int := 0; v_refunds int := 0; v_paid boolean;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then raise exception 'NOT_FOUND: No such event.'; end if;
  if not public.can_manage_event(p_event_id) then raise exception 'FORBIDDEN: Not your event.'; end if;
  if e.status in ('cancelled', 'completed') then raise exception 'CONFLICT: This event is already closed.'; end if;
  for b in select * from public.bookings where event_id = p_event_id and status in ('pending_payment', 'confirmed') loop
    v_paid := b.status = 'confirmed' and b.final_cents > 0;
    if v_paid then v_refunds := v_refunds + 1; end if;
    perform public.release_booking(b.id, 'Event cancelled', false);
    if b.status = 'confirmed' then
      perform public.notify_user(b.user_id, 'event_cancelled', public.event_vars(e) || jsonb_build_object('detail',
        case when v_paid then format('A full refund of %s is on its way.', public.fmt_money(b.final_cents)) else '' end));
    end if;
    v_n := v_n + 1;
  end loop;
  for w in update public.waitlist_entries set status = 'left' where event_id = p_event_id and status in ('waiting', 'offered') returning * loop
    perform public.notify_user(w.user_id, 'event_cancelled', public.event_vars(e) || jsonb_build_object('detail', 'You are off its waitlist.'));
  end loop;
  update public.events set status = 'cancelled', reserved = 0 where id = p_event_id;
  perform public.write_audit(auth.uid(), 'event.cancel', 'event', p_event_id::text, format('Cancelled %s: %s bookings, %s refunds queued', e.title, v_n, v_refunds));
  return jsonb_build_object('bookings', v_n, 'refunds', v_refunds);
end $$;

-- Copy an event as a new draft owned by the caller.
create function public.duplicate_event(p_event_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.can_manage_event(p_event_id) then raise exception 'FORBIDDEN: Not your event.'; end if;
  insert into public.events (organizer_id, title, category, description, type, venue, city, starts_at, ends_at, registration_opens_at,
                             registration_closes_at, capacity, max_tickets_per_member, price_cents, member_price_cents, eligible_plan_ids,
                             waitlist_enabled, cancellation_cutoff_hours, color)
  select auth.uid(), left(title || ' (copy)', 80), category, description, type, venue, city, starts_at, ends_at, registration_opens_at,
         registration_closes_at, capacity, max_tickets_per_member, price_cents, member_price_cents, eligible_plan_ids,
         waitlist_enabled, cancellation_cutoff_hours, color
    from public.events where id = p_event_id
  returning id into v_id;
  insert into public.event_private (event_id, meeting_url) select v_id, meeting_url from public.event_private where event_id = p_event_id;
  perform public.write_audit(auth.uid(), 'event.duplicate', 'event', v_id::text, 'Duplicated ' || (select title from public.events where id = p_event_id));
  return v_id;
end $$;

-- Registrations for a managed event: names only, no email or phone (organizer privacy rule).
create function public.event_registrations(p_event_id uuid)
returns table (booking_id uuid, booking_number text, member_name text, quantity int, final_cents int, status public.booking_status,
               checkin_status public.checkin_status, checked_in_at timestamptz, plan_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_manage_event(p_event_id) then raise exception 'FORBIDDEN: Not your event.'; end if;
  return query
    select b.id, b.booking_number, p.full_name, b.quantity, b.final_cents, b.status, b.checkin_status, b.checked_in_at, mp.name, b.created_at
      from public.bookings b
      join public.profiles p on p.id = b.user_id
      left join public.membership_plans mp on mp.id = b.plan_id
     where b.event_id = p_event_id
     order by b.created_at;
end $$;

create function public.event_waitlist(p_event_id uuid)
returns table (entry_id uuid, "position" int, member_name text, status public.waitlist_status, joined_at timestamptz, offer_expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_manage_event(p_event_id) then raise exception 'FORBIDDEN: Not your event.'; end if;
  return query
    select w.id, w.position, p.full_name, w.status, w.joined_at, w.offer_expires_at
      from public.waitlist_entries w join public.profiles p on p.id = w.user_id
     where w.event_id = p_event_id
     order by w.position;
end $$;

-- CHK-1: check in (or undo) a confirmed booking.
create function public.check_in(p_booking_id uuid, p_undo boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  b public.bookings;
begin
  select * into b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'NOT_FOUND: No such booking.'; end if;
  if not public.can_manage_event(b.event_id) then raise exception 'FORBIDDEN: Only this event''s organizer can check people in.'; end if;
  if b.status <> 'confirmed' then raise exception 'CONFLICT: Only confirmed bookings can be checked in.'; end if;
  update public.bookings
     set checkin_status = case when p_undo then 'not_checked_in'::public.checkin_status else 'checked_in'::public.checkin_status end,
         checked_in_at = case when p_undo then null else now() end,
         checked_in_by = auth.uid()
   where id = b.id;
  perform public.write_audit(auth.uid(), case when p_undo then 'checkin.undo' else 'checkin' end, 'booking', b.booking_number,
    format('%s %s (%s ticket%s)', case when p_undo then 'Undid check-in for' else 'Checked in' end,
           (select full_name from public.profiles where id = b.user_id), b.quantity, case when b.quantity > 1 then 's' else '' end));
end $$;

-- CHK-2: look up a scanned QR token. Shows only first name, last initial and ticket count.
create function public.scan_ticket(p_event_id uuid, p_token text)
returns table (booking_id uuid, display_name text, quantity int, checkin_status public.checkin_status, checked_in_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  b public.bookings; v_name text;
begin
  if not public.can_manage_event(p_event_id) then raise exception 'FORBIDDEN: Not your event.'; end if;
  select * into b from public.bookings
   where ticket_token_hash = sha256(convert_to(lower(trim(regexp_replace(p_token, '^EVENTBOOK:', '', 'i'))), 'UTF8'));
  if not found or b.event_id <> p_event_id then raise exception 'NOT_FOUND: No ticket for this event matches that code.'; end if;
  if b.status <> 'confirmed' then raise exception 'CONFLICT: This ticket is not confirmed.'; end if;
  select full_name into v_name from public.profiles where id = b.user_id;
  return query select b.id, trim(split_part(v_name, ' ', 1) || ' ' || coalesce(left(nullif(split_part(v_name, ' ', 2), ''), 1) || '.', '')),
                      b.quantity, b.checkin_status, b.checked_in_at;
end $$;

-- MEM-2: start a plan change. Paid plans create a PENDING membership that the payment webhook
-- activates; moving to Free takes effect at once. Returns the new membership id.
create function public.start_membership_checkout(p_plan_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  p public.membership_plans; cur public.memberships;
  v_id uuid;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED: Sign in first.'; end if;
  select * into p from public.membership_plans where id = p_plan_id;
  if not found or not p.active then raise exception 'VALIDATION_FAILED: This plan is not on offer.'; end if;
  select * into cur from public.memberships where user_id = v_uid and status in ('active', 'suspended') for update;
  if cur.status = 'suspended' then raise exception 'FORBIDDEN: Your membership is suspended. Contact the organization.'; end if;
  if cur.plan_id = p_plan_id then raise exception 'CONFLICT: You are already on this plan.'; end if;
  update public.memberships set status = 'cancelled' where user_id = v_uid and status = 'pending';   -- an earlier checkout left open

  if p.price_cents = 0 then
    update public.memberships set status = 'cancelled', expires_at = now() where id = cur.id;
    insert into public.memberships (user_id, plan_id, status) values (v_uid, p_plan_id, 'active') returning id into v_id;
    perform public.notify_user(v_uid, 'membership_update', jsonb_build_object('plan', p.name,
      'detail', 'You are on the Free plan. Member prices and members-only events have stopped.'));
    perform public.write_audit(v_uid, 'membership.change', 'membership', v_uid::text, 'Moved to ' || p.name);
    return v_id;
  end if;

  insert into public.memberships (user_id, plan_id, status, starts_at, expires_at)
  values (v_uid, p_plan_id, 'pending', now(), now() + interval '1 year')
  returning id into v_id;
  return v_id;
end $$;

-- Close an unpaid checkout; the plan stays as it was.
create function public.abandon_membership_checkout()
returns void language sql security definer set search_path = public as $$
  update public.memberships set status = 'cancelled' where user_id = auth.uid() and status = 'pending';
$$;

-- MEM-4: cancel at the end of the period (or undo that). No auto-renew either way.
create function public.set_membership_cancel(p_cancel boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.memberships; v_plan text;
begin
  select * into m from public.memberships where user_id = auth.uid() and status = 'active' for update;
  if not found or m.expires_at is null then raise exception 'CONFLICT: The Free plan has nothing to cancel.'; end if;
  update public.memberships set cancel_at_period_end = p_cancel where id = m.id;
  select name into v_plan from public.membership_plans where id = m.plan_id;
  perform public.notify_user(m.user_id, 'membership_update', jsonb_build_object('plan', v_plan, 'detail',
    case when p_cancel then format('You cancelled. Your %s membership stays active until %s, then you move to Free.', v_plan, public.fmt_day(m.expires_at))
         else format('Your %s membership continues.', v_plan) end));
  perform public.write_audit(m.user_id, case when p_cancel then 'membership.cancel' else 'membership.resume' end, 'membership', m.user_id::text,
    case when p_cancel then format('Cancelled %s, ends %s', v_plan, public.fmt_day(m.expires_at)) else 'Kept ' || v_plan end);
end $$;

-- ---- admin (ADM-1, MEM-6)

create function public.admin_set_account_status(p_user_id uuid, p_status public.account_status)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Admins only.'; end if;
  if p_user_id = auth.uid() then raise exception 'CONFLICT: You cannot deactivate yourself.'; end if;
  update public.profiles set status = p_status where id = p_user_id;
  if not found then raise exception 'NOT_FOUND: No such user.'; end if;
  perform public.write_audit(auth.uid(), 'user.' || case when p_status = 'inactive' then 'deactivate' else 'activate' end, 'user', p_user_id::text,
    (select full_name from public.profiles where id = p_user_id) || ': account ' || p_status::text);
  -- To also end their sessions, call auth.admin.updateUserById(id, { ban_duration }) from an Edge Function.
end $$;

create function public.admin_toggle_suspension(p_user_id uuid)
returns public.membership_status language plpgsql security definer set search_path = public as $$
declare
  m public.memberships; v_plan public.membership_plans; v_new public.membership_status;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Admins only.'; end if;
  select * into m from public.memberships where user_id = p_user_id and status in ('active', 'suspended') for update;
  if not found then raise exception 'NOT_FOUND: No current membership.'; end if;
  select * into v_plan from public.membership_plans where id = m.plan_id;
  if v_plan.price_cents = 0 then raise exception 'CONFLICT: Free memberships cannot be suspended.'; end if;
  v_new := case when m.status = 'suspended' then 'active'::public.membership_status else 'suspended'::public.membership_status end;
  update public.memberships set status = v_new where id = m.id;
  perform public.notify_user(p_user_id, 'membership_update', jsonb_build_object('plan', v_plan.name, 'detail',
    case when v_new = 'suspended' then 'Your membership is suspended: no member prices or members-only events until it is reinstated.'
         else 'Your membership is active again.' end));
  perform public.write_audit(auth.uid(), 'membership.' || case when v_new = 'suspended' then 'suspend' else 'reinstate' end, 'membership', p_user_id::text,
    format('%s: %s %s', (select full_name from public.profiles where id = p_user_id), v_plan.name, v_new));
  return v_new;
end $$;

-- Marks a payment for refund; the payments Edge Function issues it through Square and sets 'refunded'.
create function public.admin_refund_payment(p_payment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.payments;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Admins only.'; end if;
  select * into p from public.payments where id = p_payment_id for update;
  if not found or p.status <> 'succeeded' then raise exception 'CONFLICT: Only a succeeded payment can be refunded.'; end if;
  update public.payments set status = 'refund_pending' where id = p.id;
  perform public.write_audit(auth.uid(), 'payment.refund', 'payment', p.id::text,
    format('Refund of %s to %s requested', public.fmt_money(p.amount_cents), (select full_name from public.profiles where id = p.user_id)));
end $$;

-- ---- reports (RPT-1, RPT-2): admins see everything, organizers their own events

create function public.report_attendance(p_from date default null, p_to date default null, p_event_id uuid default null)
returns table (event_id uuid, title text, starts_at timestamptz, booked int, checked_in int, no_show int, rate_pct int)
language sql stable security definer set search_path = public as $$
  select e.id, e.title, e.starts_at,
         coalesce(sum(b.quantity), 0)::int,
         coalesce(sum(b.quantity) filter (where b.checkin_status = 'checked_in'), 0)::int,
         coalesce(sum(b.quantity) filter (where b.status = 'no_show'), 0)::int,
         case when coalesce(sum(b.quantity), 0) = 0 then null
              else round(100.0 * coalesce(sum(b.quantity) filter (where b.checkin_status = 'checked_in'), 0) / sum(b.quantity))::int end
    from public.events e
    left join public.bookings b on b.event_id = e.id and b.status in ('confirmed', 'completed', 'no_show')
   where e.status <> 'draft' and public.can_manage_event(e.id)
     and (p_event_id is null or e.id = p_event_id)
     and (p_from is null or e.starts_at >= p_from::timestamptz)
     and (p_to is null or e.starts_at < (p_to + 1)::timestamptz)
   group by e.id
   order by e.starts_at;
$$;

create function public.report_revenue(p_from date default null, p_to date default null, p_event_id uuid default null)
returns table (payment_id uuid, member_name text, item text, amount_cents int, status public.payment_status, paid_at timestamptz, provider_payment_id text)
language sql stable security definer set search_path = public as $$
  select pay.id, p.full_name, coalesce(e.title, 'Membership'), pay.amount_cents, pay.status, pay.created_at, pay.provider_payment_id
    from public.payments pay
    join public.profiles p on p.id = pay.user_id
    left join public.bookings b on b.id = pay.booking_id
    left join public.events e on e.id = b.event_id
   where (public.is_admin() or (e.id is not null and public.can_manage_event(e.id)))
     and (p_event_id is null or e.id = p_event_id)
     and (p_from is null or pay.created_at >= p_from::timestamptz)
     and (p_to is null or pay.created_at < (p_to + 1)::timestamptz)
   order by pay.created_at desc;
$$;


-- =====================================================================================
-- 6. Server-only functions (service_role: Edge Functions and pg_cron)
-- =====================================================================================

-- Square webhook: a booking payment went through. Safe to call twice with the same payment id.
create function public.confirm_booking_payment(p_booking_id uuid, p_provider_payment_id text, p_amount_cents int)
returns public.booking_status language plpgsql security definer set search_path = public as $$
declare
  b public.bookings;
begin
  if exists (select 1 from public.payments where provider_payment_id = p_provider_payment_id) then
    return (select status from public.bookings where id = p_booking_id);
  end if;
  select * into b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'NOT_FOUND: No such booking.'; end if;
  if b.status <> 'pending_payment' then
    -- the hold ran out first: record the charge so the Edge Function refunds it
    insert into public.payments (kind, booking_id, user_id, amount_cents, status, provider_payment_id)
    values ('booking', b.id, b.user_id, p_amount_cents, 'refund_pending', p_provider_payment_id);
    raise exception 'CONFLICT: This booking is no longer waiting for payment.';
  end if;
  if p_amount_cents <> b.final_cents then raise exception 'VALIDATION_FAILED: Paid % but the booking costs %.', p_amount_cents, b.final_cents; end if;
  insert into public.payments (kind, booking_id, user_id, amount_cents, status, provider_payment_id)
  values ('booking', b.id, b.user_id, p_amount_cents, 'succeeded', p_provider_payment_id);
  update public.bookings set status = 'confirmed', hold_expires_at = null where id = b.id;
  perform public.notify_booking_confirmed(b.id);
  return 'confirmed';
end $$;

-- Square webhook: a membership payment went through. PENDING → ACTIVE for one year.
create function public.confirm_membership_payment(p_membership_id uuid, p_provider_payment_id text, p_amount_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.memberships; p public.membership_plans; v_expires timestamptz := now() + interval '1 year';
begin
  if exists (select 1 from public.payments where provider_payment_id = p_provider_payment_id) then return; end if;
  select * into m from public.memberships where id = p_membership_id for update;
  if not found or m.status <> 'pending' then raise exception 'CONFLICT: Nothing to pay.'; end if;
  select * into p from public.membership_plans where id = m.plan_id;
  if p_amount_cents <> p.price_cents then raise exception 'VALIDATION_FAILED: Paid % but the plan costs %.', p_amount_cents, p.price_cents; end if;
  insert into public.payments (kind, membership_id, user_id, amount_cents, status, provider_payment_id)
  values ('membership', m.id, m.user_id, p_amount_cents, 'succeeded', p_provider_payment_id);
  update public.memberships set status = 'cancelled', expires_at = now() where user_id = m.user_id and status = 'active';
  update public.memberships set status = 'active', starts_at = now(), expires_at = v_expires where id = m.id;
  perform public.notify_user(m.user_id, 'membership_update', jsonb_build_object('plan', p.name,
    'detail', format('Your %s membership is active until %s. Member prices apply from your next booking.', p.name, public.fmt_day(v_expires))));
  perform public.write_audit(m.user_id, 'membership.change', 'membership', m.user_id::text, 'Now ' || p.name);
end $$;

-- Square webhook: a payment was declined. Booking seats go back; a pending plan change is dropped.
create function public.record_failed_payment(p_kind public.payment_kind, p_target_id uuid, p_provider_payment_id text, p_amount_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
begin
  if exists (select 1 from public.payments where provider_payment_id = p_provider_payment_id) then return; end if;
  if p_kind = 'booking' then
    select user_id into v_user from public.bookings where id = p_target_id;
    insert into public.payments (kind, booking_id, user_id, amount_cents, status, provider_payment_id)
    values ('booking', p_target_id, v_user, p_amount_cents, 'failed', p_provider_payment_id);
    perform public.release_booking(p_target_id, 'Payment failed');
  else
    select user_id into v_user from public.memberships where id = p_target_id;
    insert into public.payments (kind, membership_id, user_id, amount_cents, status, provider_payment_id)
    values ('membership', p_target_id, v_user, p_amount_cents, 'failed', p_provider_payment_id);
    update public.memberships set status = 'cancelled' where id = p_target_id and status = 'pending';
  end if;
end $$;

-- The background worker. Safe to run as often as you like (every 5 minutes is plenty).
--   holds past their time → seats released     (BKG-3)
--   waitlist offers past their window → next    (WL-2)
--   reminders 24 h and 2 h before               (NOTIF-2)
--   events past their end → completed, no-shows (EVT-6, CHK-3)
--   memberships: reminders 14 and 3 days before, expiry → Free (MEM-5)
create function public.run_jobs()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; e public.events;
  v_free uuid := (select id from public.membership_plans where slug = 'free');
  n_holds int := 0; n_offers int := 0; n_rem int := 0; n_done int := 0; n_exp int := 0; n_mrem int := 0;
begin
  for r in select id from public.bookings where status = 'pending_payment' and hold_expires_at < now() for update skip locked loop
    perform public.release_booking(r.id, 'Hold expired');
    n_holds := n_holds + 1;
  end loop;

  for r in select * from public.waitlist_entries where status = 'offered' and offer_expires_at <= now() for update skip locked loop
    update public.waitlist_entries set status = 'expired' where id = r.id;
    update public.events set reserved = reserved - 1 where id = r.event_id;
    perform public.set_event_fullness(r.event_id);
    select * into e from public.events where id = r.event_id;
    perform public.notify_user(r.user_id, 'offer_expired', public.event_vars(e));
    perform public.promote_waitlist(r.event_id);
    n_offers := n_offers + 1;
  end loop;

  for r in update public.bookings b set reminded_24h = true
             from public.events ev
            where ev.id = b.event_id and b.status = 'confirmed' and not b.reminded_24h and ev.status in ('published', 'full')
              and now() >= ev.starts_at - interval '24 hours' and now() < ev.starts_at - interval '2 hours'
        returning b.user_id, b.event_id loop
    select * into e from public.events where id = r.event_id;
    perform public.notify_user(r.user_id, 'event_reminder', public.event_vars(e) || jsonb_build_object('lead', 'tomorrow'));
    n_rem := n_rem + 1;
  end loop;
  for r in update public.bookings b set reminded_2h = true, reminded_24h = true
             from public.events ev
            where ev.id = b.event_id and b.status = 'confirmed' and not b.reminded_2h and ev.status in ('published', 'full')
              and now() >= ev.starts_at - interval '2 hours' and now() < ev.starts_at
        returning b.user_id, b.event_id loop
    select * into e from public.events where id = r.event_id;
    perform public.notify_user(r.user_id, 'event_reminder', public.event_vars(e) || jsonb_build_object('lead', 'in 2 hours'));
    n_rem := n_rem + 1;
  end loop;

  for e in update public.events set status = 'completed' where status in ('published', 'full') and ends_at <= now() returning * loop
    perform public.release_booking(b.id, 'Hold expired', false) from public.bookings b where b.event_id = e.id and b.status = 'pending_payment';
    update public.bookings
       set status = case when checkin_status = 'checked_in' then 'completed'::public.booking_status else 'no_show'::public.booking_status end
     where event_id = e.id and status = 'confirmed';
    update public.waitlist_entries set status = 'expired' where event_id = e.id and status in ('waiting', 'offered');
    perform public.write_audit(null, 'event.complete', 'event', e.id::text,
      format('%s completed; %s no-shows marked', e.title, (select coalesce(sum(quantity), 0) from public.bookings where event_id = e.id and status = 'no_show')));
    n_done := n_done + 1;
  end loop;

  for r in select m.id, m.user_id, m.expires_at, p.name as plan_name
             from public.memberships m join public.membership_plans p on p.id = m.plan_id
            where m.status in ('active', 'suspended') and m.expires_at is not null and m.expires_at <= now()
              for update of m skip locked loop
    update public.memberships set status = 'expired' where id = r.id;
    insert into public.memberships (user_id, plan_id, status) values (r.user_id, v_free, 'active');
    perform public.notify_user(r.user_id, 'membership_update', jsonb_build_object('plan', 'Free', 'detail',
      format('Your %s membership ended on %s. You are on the Free plan now; renew from Membership any time.', r.plan_name, public.fmt_day(r.expires_at))));
    perform public.write_audit(null, 'membership.expire', 'membership', r.user_id::text, format('%s expired, moved to Free', r.plan_name));
    n_exp := n_exp + 1;
  end loop;

  for r in update public.memberships m set reminded_3d = true, reminded_14d = true
             from public.membership_plans p
            where p.id = m.plan_id and m.status = 'active' and m.expires_at is not null and not m.reminded_3d
              and m.expires_at - now() <= interval '3 days'
        returning m.user_id, m.cancel_at_period_end, m.expires_at, p.name loop
    if not r.cancel_at_period_end then
      perform public.notify_user(r.user_id, 'membership_reminder', jsonb_build_object('plan', r.name,
        'days', ceil(extract(epoch from r.expires_at - now()) / 86400)::int, 'until', public.fmt_day(r.expires_at)));
    end if;
    n_mrem := n_mrem + 1;
  end loop;
  for r in update public.memberships m set reminded_14d = true
             from public.membership_plans p
            where p.id = m.plan_id and m.status = 'active' and m.expires_at is not null and not m.reminded_14d
              and m.expires_at - now() <= interval '14 days'
        returning m.user_id, m.cancel_at_period_end, m.expires_at, p.name loop
    if not r.cancel_at_period_end then
      perform public.notify_user(r.user_id, 'membership_reminder', jsonb_build_object('plan', r.name,
        'days', ceil(extract(epoch from r.expires_at - now()) / 86400)::int, 'until', public.fmt_day(r.expires_at)));
    end if;
    n_mrem := n_mrem + 1;
  end loop;

  return jsonb_build_object('holds_released', n_holds, 'offers_expired', n_offers, 'event_reminders', n_rem,
                            'events_completed', n_done, 'memberships_expired', n_exp, 'membership_reminders', n_mrem);
end $$;


-- =====================================================================================
-- 7. Security: row-level security and grants
-- =====================================================================================

alter table public.org_settings           enable row level security;
alter table public.profiles               enable row level security;
alter table public.user_roles             enable row level security;
alter table public.membership_plans       enable row level security;
alter table public.memberships            enable row level security;
alter table public.events                 enable row level security;
alter table public.event_private          enable row level security;
alter table public.event_organizers       enable row level security;
alter table public.bookings               enable row level security;
alter table public.waitlist_entries       enable row level security;
alter table public.payments               enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.notification_templates enable row level security;
alter table public.notifications          enable row level security;
alter table public.email_outbox           enable row level security;
alter table public.audit_log              enable row level security;

-- settings: everyone reads (the UI needs hold and offer times); admins edit
create policy settings_read  on public.org_settings for select using (true);
create policy settings_admin on public.org_settings for update using (public.is_admin()) with check (public.is_admin());

-- profiles: yourself and admins (organizers get names through event_registrations, never emails)
create policy profiles_read on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_edit on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- roles: read your own; admins grant and revoke
create policy roles_read   on public.user_roles for select using (user_id = auth.uid() or public.is_admin());
create policy roles_grant  on public.user_roles for insert with check (public.is_admin());
create policy roles_revoke on public.user_roles for delete using (public.is_admin());

-- plans: everyone sees plans on offer; admins see and edit all
create policy plans_read  on public.membership_plans for select using (active or public.is_admin());
create policy plans_add   on public.membership_plans for insert with check (public.is_admin());
create policy plans_edit  on public.membership_plans for update using (public.is_admin()) with check (public.is_admin());

-- memberships: your own and admins; changes only through functions
create policy memberships_read on public.memberships for select using (user_id = auth.uid() or public.is_admin());

-- events: published ones are public; managers also see their drafts
-- (organizer_id = auth.uid() is checked on the row itself so a new event is readable in INSERT ... RETURNING)
create policy events_read on public.events for select
  using (status <> 'draft' or organizer_id = auth.uid() or public.can_manage_event(id));
create policy events_create on public.events for insert
  with check (organizer_id = auth.uid() and (public.has_role('organizer') or public.is_admin()));
create policy events_edit on public.events for update
  using (public.can_manage_event(id) and status not in ('cancelled', 'completed'))
  with check (public.can_manage_event(id));
create policy events_delete_draft on public.events for delete
  using (public.can_manage_event(id) and status = 'draft');

create policy private_read on public.event_private for select
  using (public.can_manage_event(event_id) or public.has_confirmed_booking(event_id));
create policy private_write on public.event_private for insert with check (public.can_manage_event(event_id));
create policy private_edit on public.event_private for update using (public.can_manage_event(event_id)) with check (public.can_manage_event(event_id));

create policy coorgs_read on public.event_organizers for select
  using (user_id = auth.uid() or public.can_manage_event(event_id));
create policy coorgs_add on public.event_organizers for insert
  with check (public.is_admin() or exists (select 1 from public.events where id = event_id and organizer_id = auth.uid()));
create policy coorgs_remove on public.event_organizers for delete
  using (public.is_admin() or exists (select 1 from public.events where id = event_id and organizer_id = auth.uid()));

-- bookings and waitlist: your own, plus the event's managers; changes only through functions
create policy bookings_read on public.bookings for select
  using (user_id = auth.uid() or public.can_manage_event(event_id));
create policy waitlist_read on public.waitlist_entries for select
  using (user_id = auth.uid() or public.can_manage_event(event_id));

-- payments: your own and admins (organizers use report_revenue)
create policy payments_read on public.payments for select using (user_id = auth.uid() or public.is_admin());

-- inbox: your own; you can mark read and delete
create policy notes_read   on public.notifications for select using (user_id = auth.uid());
create policy notes_mark   on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notes_delete on public.notifications for delete using (user_id = auth.uid());

-- admin-only tables
create policy templates_read on public.notification_templates for select using (public.is_admin());
create policy templates_edit on public.notification_templates for update using (public.is_admin()) with check (public.is_admin());
create policy outbox_read    on public.email_outbox for select using (public.is_admin());
create policy audit_read     on public.audit_log for select using (public.is_admin());
-- payment_webhook_events: no policies; only service_role touches it.

-- Table privileges. Supabase grants everything to anon/authenticated by default; narrow it so
-- clients can change only the columns they own. Everything else goes through the functions above.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.events, public.membership_plans, public.org_settings to anon;
grant select on all tables in schema public to authenticated;
revoke select on public.payment_webhook_events from authenticated;

grant update (full_name, phone) on public.profiles to authenticated;
grant insert, delete on public.user_roles to authenticated;
grant insert (slug, name, price_cents, billing_cycle, discount, early_access_days, benefits, active) on public.membership_plans to authenticated;
grant update (name, price_cents, discount, early_access_days, benefits, active) on public.membership_plans to authenticated;
grant insert (organizer_id, title, category, description, type, venue, city, starts_at, ends_at, registration_opens_at,
              capacity, max_tickets_per_member, price_cents, member_price_cents, eligible_plan_ids, waitlist_enabled,
              cancellation_cutoff_hours, color) on public.events to authenticated;
grant update (title, category, description, type, venue, city, starts_at, ends_at, registration_opens_at,
              capacity, max_tickets_per_member, price_cents, member_price_cents, eligible_plan_ids, waitlist_enabled,
              cancellation_cutoff_hours, color) on public.events to authenticated;
grant delete on public.events to authenticated;
grant insert, update (meeting_url) on public.event_private to authenticated;
grant insert, delete on public.event_organizers to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;
grant update (subject, body) on public.notification_templates to authenticated;
grant update (org_name, hold_minutes, offer_hours, cutoff_hours, mfa_required_for_admins, sso_enabled, sso_issuer, sso_client_id)
  on public.org_settings to authenticated;

-- Function privileges. New functions are executable by everyone by default; lock them all, then open
-- only what the app calls. Internal helpers stay callable from inside the security-definer functions.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.has_role(public.app_role, uuid), public.is_admin(), public.can_manage_event(uuid),
                          public.has_confirmed_booking(uuid) to anon, authenticated;   -- used by the policies
grant execute on function public.quote_price(uuid, int) to anon, authenticated;
grant execute on function
  public.book_event(uuid, int, uuid), public.cancel_booking(uuid),
  public.join_waitlist(uuid), public.leave_waitlist(uuid), public.waitlist_place(uuid), public.event_meeting_url(uuid),
  public.publish_event(uuid), public.cancel_event(uuid), public.duplicate_event(uuid),
  public.event_registrations(uuid), public.event_waitlist(uuid), public.check_in(uuid, boolean), public.scan_ticket(uuid, text),
  public.start_membership_checkout(uuid), public.abandon_membership_checkout(), public.set_membership_cancel(boolean),
  public.admin_set_account_status(uuid, public.account_status), public.admin_toggle_suspension(uuid), public.admin_refund_payment(uuid),
  public.report_attendance(date, date, uuid), public.report_revenue(date, date, uuid)
  to authenticated;
grant execute on function
  public.confirm_booking_payment(uuid, text, int), public.confirm_membership_payment(uuid, text, int),
  public.record_failed_payment(public.payment_kind, uuid, text, int), public.run_jobs()
  to service_role;


-- =====================================================================================
-- 8. Seed data
-- =====================================================================================

insert into public.org_settings default values;

insert into public.membership_plans (slug, name, price_cents, billing_cycle, discount, early_access_days, benefits) values
  ('free',     'Free',     0,     'none', 0.00, 0, array['Book open events', 'Join waitlists']),
  ('standard', 'Standard', 6000,  'year', 0.10, 0, array['10% off paid events', 'Member prices', 'Members-only events']),
  ('premium',  'Premium',  12000, 'year', 0.20, 3, array['20% off paid events', 'Member prices', 'Members-only and Premium events', 'Book 3 days before everyone else']);

-- Account emails (verify, reset) come from Supabase Auth: Authentication → Email Templates.
insert into public.notification_templates (id, name, subject, body) values
  ('booking_confirmed',   'Booking confirmed',   'Booked: {{event}}',                                '{{event}}, {{when}}. {{tickets}}, {{amount}}. Your QR ticket is in My bookings.'),
  ('booking_cancelled',   'Booking cancelled',   'Cancelled: {{event}}',                             'Your booking for {{event}} on {{when}} is cancelled. {{detail}}'),
  ('waitlist_joined',     'Waitlist joined',     'You are on the waitlist for {{event}}',            '{{event}}, {{when}}. We tell you when a seat opens.'),
  ('seat_offered',        'Seat available',      'A seat is free for you: {{event}}',                '{{event}}, {{when}}. Accept by {{until}} or it goes to the next person.'),
  ('offer_expired',       'Seat offer expired',  'Your seat offer for {{event}} expired',            'You did not accept in time, so the seat went to the next person. You are off this waitlist.'),
  ('event_reminder',      'Event reminder',      'Starting {{lead}}: {{event}}',                     '{{event}} starts {{when}} at {{where}}. Bring your QR ticket.'),
  ('event_cancelled',     'Event cancelled',     '{{event}} is cancelled',                           '{{event}} on {{when}} will not go ahead. {{detail}}'),
  ('membership_reminder', 'Membership reminder', 'Your {{plan}} membership ends in {{days}} days',    'It ends on {{until}}. Renew from Membership to keep member prices.'),
  ('membership_update',   'Membership update',   'Your membership: {{plan}}',                        '{{detail}}');


-- =====================================================================================
-- After running: two one-time steps
-- =====================================================================================
-- 1. Make yourself admin (sign up in the app first, then run with your email):
--      insert into public.user_roles (user_id, role)
--      select id, 'admin' from public.profiles where email = 'you@example.com';
--
-- 2. Schedule the background jobs (Dashboard → Integrations → Cron → enable, then run):
--      select cron.schedule('eventbook-jobs', '*/5 * * * *', $$select public.run_jobs()$$);
