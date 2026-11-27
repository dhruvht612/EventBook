# EventBook frontend

React + Vite version of the EventBook demo: a members' event-booking app for a small organization, running on sample data with a simulated server.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

Switch between Visitor, Member, Organizer and Administrator in the top bar. Move the demo clock to run the background jobs: hold expiry, waitlist offers, reminders, event completion and membership expiry. Every request and its answer show in the Server log drawer, and every email lands in the Mailbox. State persists in `localStorage`; **Reset demo** restores the sample data.

Demo password for every sample account: `eventbook-demo-2027` (for example `margot@members.example`).

## Layout

| Path | What it holds |
| --- | --- |
| `src/lib/store.js` | The state object `S`, `commit()`, `useStore()`, toasts, the modal, lookups, navigation |
| `src/lib/server.js` | The simulated API (`API.*`), notifications, waitlist promotion, the clock jobs (`advance`) |
| `src/lib/rules.js` | Pricing, booking checks, password rules, wizard validation, report rows |
| `src/lib/seed.js` | Sample data (`fresh()`) and notification templates |
| `src/lib/format.js` | Dates (America/Toronto), money, small helpers |
| `src/actions.jsx` | UI actions shared between screens (checkout, tickets, confirmations, links) |
| `src/components/` | App chrome, shared UI parts, modals |
| `src/views/` | Screens for each role, the event wizard, reports |

## Connecting a real backend

The UI talks to the server only through `API.*` in `src/lib/server.js`. Each method is named after its REST endpoint (for example `POST /api/events/:id/book`) and returns `{ ok: true, ... }` or `{ ok: false, code, http, message, details }`. To use a real backend, swap those methods for `fetch` calls that return the same shape, and load `S` from the API instead of `seed.js`.
