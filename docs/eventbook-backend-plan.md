# EventBook Full Backend Plan

Status: plan only. No backend implementation has been performed.  
Date: 2026-11-27

## Assumptions

Based on the current repository:

- **Supabase** is the backend: the project already has a 1,407-line SQL schema with 16 tables, 50 functions, RLS policies, and a manual test script.
- **Square** is the payment provider: the schema and simulated API already use Square terminology.
- **Resend** or Postmark sends email from `email_outbox`.
- The current browser simulation stays as a **demo mode** for the landing page/demo experience, but real sign-in uses Supabase Auth.

If a custom Node/Express backend is preferred instead, the plan changes substantially and the existing Supabase SQL would need to be reworked. Staying with Supabase is recommended.

---

## Where the project is now

The frontend is still entirely simulated:

- `src/main.jsx:8` loads state from `loadSaved()` or `fresh()`.
- `src/lib/store.js` keeps one `S` object in `localStorage`.
- `src/lib/server.js` implements every `API.*` method against that in-memory `S`.
- `src/lib/supabase.js` exists but is **imported nowhere**.
- Demo clock, role switcher, server log, mailbox, and reset are all client-only.

The database layer is largely designed but not runnable end-to-end:

- SQL schema: `supabase/migrations/20261126000000_eventbook_schema.sql`
- Manual database test: `supabase/tests/manual-test.sql`
- Missing: `supabase/functions/`, `supabase/config.toml`, `supabase/seed.sql`, secrets, Auth config, cron installation, automated tests, and frontend wiring.

---

## Target architecture

```text
React app (/app/)
  └─ src/lib/backend/index.js        chooses demo or supabase adapter
      ├─ local.js                    wraps existing src/lib/server.js + seed.js
      └─ remote.js                   supabase-js client adapter
          ├─ Supabase Auth            signup, login, verify, reset, MFA, sessions
          ├─ PostgREST tables         profiles, events, bookings, plans, settings…
          └─ Supabase RPCs            book_event, cancel_booking, check_in, reports…

Supabase Postgres
  ├─ RLS + grants                     authorization source of truth
  ├─ triggers                         profiles, event status, audit, waitlist
  └─ RPCs                             booking, waitlist, memberships, admin, reports

Supabase Edge Functions (service role only)
  ├─ square-checkout                 create payment
  ├─ square-webhook                  verify signature, confirm payments, dedupe
  ├─ square-refunds                  process refund_pending
  ├─ send-emails                     drain email_outbox
  ├─ run-jobs                        call run_jobs()
  └─ auth-admin                      session revoke, ban/unban, MFA enforcement

External
  ├─ Square sandbox → production
  └─ Resend / Postmark
```

---

## Phase 1 — Set up Supabase project and config

1. **Add Supabase CLI tooling**
   - Supabase CLI is not installed locally.
   - Add it as a dev dependency and scripts in `package.json`:
     - `supabase:start`, `supabase:stop`, `db:reset`, `db:push`, `functions:serve`, `test:db`.
   - Create `supabase/config.toml` with `supabase init`, then link the project with `supabase link --project-ref <ref>`.

2. **Apply the schema**
   - Use `supabase db push` so migration tracking is recorded.
   - Do **not** paste the migration into the SQL editor twice: it is not idempotent and fails at `create type public.app_role`.
   - After this migration, all further changes go into **new migration files**, not edits to this one.

3. **Configure Auth**
   - Site URL and redirect allow-list for localhost, Vercel preview, and production.
   - Email confirmation template for `verify_email`.
   - Password reset template for `password_reset`.
   - Email change confirmation.
   - MFA enabled.
   - SSO/OIDC only if the `sso_*` settings in `org_settings` should really be supported.
   - Password breach protection and rate limits.

4. **Install cron**
   - Enable `pg_cron` and `pg_net`.
   - Schedule:
     - `run_jobs()` every 5 minutes.
     - `send-emails` every 1 minute, either through `pg_net` or a separate cron job.
   - Currently this is only a comment at SQL lines 1400–1407.

5. **Make the first admin**
   - Sign up once in the app, then insert the admin row into `user_roles` as documented at SQL lines 1402–1405.

6. **Environment variables**

   Client-side, safe to expose:

   ```env
   VITE_BACKEND_MODE=supabase
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_PUBLISHABLE_KEY=...
   VITE_SQUARE_APPLICATION_ID=...
   VITE_SQUARE_LOCATION_ID=...
   ```

   Server-only, set with `supabase secrets set` — never prefix with `VITE_`:

   ```env
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   SQUARE_ACCESS_TOKEN
   SQUARE_LOCATION_ID
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_WEBHOOK_SIGNATURE_KEY
   RESEND_API_KEY
   EMAIL_FROM_ADDRESS
   CRON_SECRET
   ```

   `.env.local` currently only contains `VERCEL_OIDC_TOKEN`, so no backend wiring can work yet.

---

## Phase 2 — Fix the SQL before building on it

Create a new migration, e.g. `supabase/migrations/20261127000000_backend_runtime.sql`, containing:

1. **Fix the refund bug**
   - `confirm_booking_payment` lines 1086–1091 insert a `refund_pending` payment and then raise an exception. The exception rolls back the insert, so the charge is never recorded.
   - Split that case into a proper branch that records the payment and audit entry without aborting the transaction.

2. **Real webhook idempotency**
   - `payment_webhook_events` exists but is never written.
   - Add an RPC such as `record_webhook_event(provider, event_id, payload)` using `insert ... on conflict do nothing`.
   - The webhook Edge Function should call this first; if it returns “already seen”, return 2xx without re-processing.

3. **Consistent lock order**
   - `book_event` locks offer then event; `promote_waitlist` locks event then offer; `release_booking` locks booking then calls `promote_waitlist`.
   - Standardize on event → booking → offer ordering to avoid deadlocks under concurrent cancellation/booking.

4. **Make `run_jobs()` robust**
   - Lines 1202–1203 can abort the whole job if a Free membership cannot be inserted.
   - Handle missing/deleted Free plan and existing current membership explicitly.

5. **Add runtime helper RPCs**
   - `mark_email_sent(id, provider_id)`
   - `mark_email_failed(id, error, attempts)`
   - `list_due_refunds()`
   - `mark_refund_succeeded(id, provider_refund_id)`
   - `organizer_candidates()` — organizers currently cannot read all profiles under RLS, but the UI needs a candidate list for co-organizers.

6. **Tighten reports**
   - Date filters currently depend on session timezone; use `America/Toronto` explicitly.
   - Decide whether to add a real `paid_at` column; `report_revenue` currently uses `payments.created_at`.
   - Validate `eligible_plan_ids` elements against `membership_plans` with a trigger or FK-backed join table.

7. **Verify grants**
   - Confirm `service_role` still has execute on the four server-only functions after the broad `revoke execute`.
   - Confirm `anon` cannot execute anything except `quote_price` and helpers it needs.
   - Re-run the RLS matrix from `manual-test.sql`.

---

## Phase 3 — Build the Edge Functions

Create `supabase/functions/` with a shared CORS/Supabase-client module and these functions:

| Function | Responsibility |
| --- | --- |
| `square-checkout` | Accept booking/membership id, load authoritative amount from DB, create Square payment/order with idempotency key, return checkout token to client. Never trust a client-submitted amount. |
| `square-webhook` | Verify `X-Square-Signature`, record the event in `payment_webhook_events`, dispatch to `confirm_booking_payment`, `confirm_membership_payment`, or `record_failed_payment`. Return 2xx for duplicates. |
| `square-refunds` | Drain `payments.status = 'refund_pending'`, call Square Refunds API, mark `refunded`/`failed`, write audit. |
| `send-emails` | Claim queued `email_outbox` rows, send through Resend/Postmark, update `status`, `attempts`, `last_error`, `sent_at`; retry with backoff. |
| `run-jobs` | Thin authenticated wrapper around `run_jobs()`. Called by cron with `CRON_SECRET`. |
| `auth-admin` | Per-session revoke/list, ban/unban via Auth admin API, resend verification/reset, enforce admin MFA requirement. Require an admin JWT. |

Also add CSV export support. Either:

- add RPCs for admin `registrations`, `membership`, `waitlist` reports and serialize CSV in the client, or
- add a `reports-export` Edge Function that runs the same RPCs and returns CSV.

Use the same row source for preview and export; today `src/lib/rules.js:reportRows` computes a local preview that can diverge from `API.exportCsv`.

---

## Phase 4 — Wire the React app to the backend

Introduce an adapter boundary so the UI keeps calling the same conceptual API:

```text
src/lib/backend/index.js   selects local or remote
src/lib/backend/local.js   current demo server + seed
src/lib/backend/remote.js  Supabase implementation
src/lib/mappers.js         snake_case ↔ camelCase, enum case, money/date mapping
src/lib/auth.js            signUp/signIn/signOut/reset/MFA/session helpers
src/lib/state.js            hydrate S from Supabase read model
```

Every remote method should return the existing shape:

```js
{ ok: true, http, msg, ... }
{ ok: false, code, http, message, details }
```

Supabase errors arrive as `"CODE: message"`. Split on `": "` so `r.code`, `r.message`, and `r.msg` all work with existing callers.

### API mapping summary

| Existing API group | Supabase implementation |
| --- | --- |
| `register`, `verify`, `resend`, `login`, `logout`, `forgot`, `reset`, `changePw`, `revoke`, `mfa` | Supabase Auth + `auth-admin` Edge Function. No SQL RPC. |
| `book` | `rpc('book_event')` plus `quote_price` for price breakdown. Persist the one-time `ticket_token` locally. |
| `pay` | Square checkout Edge Function + webhook RPCs. Client must not send raw card details. |
| `abandonCheckout`, `expireHold`, `cancel` | `cancel_booking` / `run_jobs`. Synthesize `msg`. Remove the toast that depends on the demo server log. |
| `joinWait`, `leaveWait`, `removeWait` | `join_waitlist`, `leave_waitlist`, `waitlist_place`. |
| `checkin`, `scan` | `check_in`, `scan_ticket`. Use RPC fields directly instead of looking up `res.bid` in local `S.bookings`. |
| `capacity`, `saveEvent`, `coorg` | Table writes with field mapping and optimistic lock on `events.version`. |
| `cancelEvent`, `duplicate` | `cancel_event`, `duplicate_event`. |
| `buyPlan`, `abandonPlan`, `cancelPlan` | `start_membership_checkout`, `abandon_membership_checkout`, `set_membership_cancel`. Plan ids become UUIDs/slugs. |
| `role`, `userStatus`, `suspend`, `plan`, `refund`, `template`, `settings` | Admin table writes and RPCs; map uppercase UI enums to lowercase SQL enums. |
| `exportCsv` | New report RPCs or `reports-export` Edge Function. |

### Read-model hydration

Most views can stay unchanged if `S` is hydrated into the same camelCase shape. Add mappers for:

- `events`: `starts_at → start`, `price_cents → price`, `organizer_id → org`, `event_private.meeting_url → url`, etc.
- `bookings`: `booking_number → num`, `final_cents → final`, `checkin_status → checkin`, etc.
- `waitlist`, `payments`, `notifications`, `audit_log`, `profiles`, `membership_plans`, `org_settings`.
- Enum values: uppercase UI status ↔ lowercase SQL enum.

### Auth and role changes

- Replace `S.current = {guest, member, organizer, admin}` with one real Supabase session.
- `me()` derives from `auth.getUser()` plus `profiles` and `user_roles`.
- `S.role` becomes a **UI view selector** among roles the user actually has, never an authorization source.
- Remove or demo-gate:
  - `switchRole()` in `src/actions.jsx`
  - demo clock in `src/components/Chrome.jsx`
  - server log drawer
  - reset demo
  - demo mailbox
- Replace hardcoded TOTP in `src/components/modals.jsx` with `supabase.auth.mfa.enroll/challenge/verify`.
- Replace session list in `src/views/member.jsx` with Auth admin data; use `signOut({ scope: 'others' })` where possible.

### Payment modal

Replace raw card fields in `src/components/modals.jsx` with Square Web Payments SDK. Flow:

1. `book_event` or `start_membership_checkout` creates the pending record and hold.
2. Client calls `square-checkout`.
3. Square confirms payment with the Web Payments SDK.
4. Square webhook calls the service-role RPCs.
5. Client refreshes booking/membership status.

### QR tickets

SQL stores only `ticket_token_hash` and returns plaintext once from `book_event`. Decide:

- **Simple:** keep the returned token in local storage, as the current UI already does.
- **Cross-device:** add an encrypted token store or a secure reissue endpoint. This needs a design decision because a hash cannot be reversed.

---

## Phase 5 — Seed and demo data

Keep two separate paths:

1. **Production/staging:** only settings, plans, and notification templates from the migration.
2. **Local development:** `supabase/seed.sql` or `scripts/seed-demo.mjs` that creates demo users through the Auth admin API, then inserts deterministic profiles, roles, memberships, events, bookings, waitlist entries, payments, notifications, and audit rows mirroring `src/lib/seed.js`.

Make it re-runnable with a cleanup step. Do not seed fake users into production.

---

## Phase 6 — Testing

1. **Database**
   - Convert the 25 steps in `supabase/tests/manual-test.sql` into an automated pgTAP or Node test suite.
   - Cover: RLS matrix, booking capacity, waitlist promotion, paid booking, webhook replay, refund, scan/check-in, membership pricing, hold expiry, and `run_jobs()` idempotency.
   - Run with `supabase db reset` against a local database.

2. **Adapter**
   - Unit-test every remote method for the `{ok, msg, code, details}` contract.
   - Unit-test snake_case/enum/money mapping.

3. **End-to-end**
   - Sign up → verify email → book free event → QR ticket.
   - Paid booking → Square sandbox → webhook → confirmed.
   - Full event → waitlist → cancel → offer → accept.
   - Member upgrade → member pricing.
   - Check-in scan.
   - Admin role/plan/settings/refund/audit.
   - MFA enroll and sign-in.
   - Cron jobs and email delivery.

4. **Build/deploy QA**
   - `npm run build`
   - Vercel preview deploy
   - Browser pass against preview with real Supabase project.

---

## Phase 7 — Deployment and operations

1. Add environment variables to Vercel for `VITE_*` only.
2. Deploy Edge Functions with `supabase functions deploy`.
3. Set all server secrets with `supabase secrets set`.
4. Configure Square sandbox webhook URL, then production webhook URL.
5. Verify the Resend sending domain.
6. Install cron schedules.
7. Add GitHub Actions:
   - PR: local `supabase db reset` + tests.
   - Merge: `supabase db push` to staging, run smoke tests, then production.
8. Add monitoring:
   - Edge Function logs
   - failed webhook events
   - email outbox backlog
   - `refund_pending` backlog
   - cron last-run timestamp
9. Add backups and a rollback procedure before going live.

---

## Acceptance criteria

The backend is done when:

- A real user can sign up, verify email, sign in, reset password, and use MFA.
- Roles come only from `user_roles`; no client-side role switch can escalate access.
- Free and paid bookings work through Square sandbox and webhooks.
- Webhook replay does not double-confirm or double-refund.
- Waitlist promotion, holds, reminders, event completion, and membership expiry run automatically.
- Emails are delivered from `email_outbox`, and in-app notifications appear in the inbox.
- Check-in QR scanning works.
- Admin screens read and write real Supabase data with RLS enforced.
- CSV exports use the same data as report previews.
- All 25 manual SQL scenarios pass automatically.
- No service-role, Square, or email-provider secret is present in client code.

---

## Decisions needed

1. **Supabase confirmed?** Recommended, given the existing schema.
2. **Square or Stripe?** Schema says Square; Stripe would change the Edge Functions but mostly not the SQL.
3. **Email provider:** Resend recommended.
4. **Keep demo mode in production?** Recommended only for the landing page marketing demo, not real user data.
5. **QR ticket access:** local-only token, or secure cross-device reissue?
6. **Do you want real SSO enforcement now, or leave `sso_enabled` as future work?**

---

## File location note

Plan mode restricts plan files to `C:\Users\thaka\.opencode\plan`, so this document was written there rather than to the project's `docs/` folder. To place it at `docs/backend-plan.md`, switch to an implementation agent and ask for the file to be copied/moved there.
