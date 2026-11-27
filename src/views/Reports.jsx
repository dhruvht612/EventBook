// Reports (RPT-1, RPT-2): filter, preview, export. Shared by organizers and admins.
import { S, commit, toast } from '../lib/store';
import { reportRows } from '../lib/rules';
import { label } from '../lib/format';
import { Head } from '../components/ui';
import { exportCsv } from '../actions';

const DEFAULT = { kind: 'registrations', eid: '', from: '', to: '' };

export function ReportsView({ events }) {
  const kinds = S.role === 'admin' ? ['registrations', 'attendance', 'membership', 'revenue', 'waitlist'] : ['registrations', 'attendance', 'revenue', 'waitlist'];
  const saved = S.repF || DEFAULT;
  const f = { ...saved, kind: kinds.includes(saved.kind) ? saved.kind : 'registrations', eid: events.some(e => e.id === saved.eid) ? saved.eid : '' };
  const rows = reportRows(f.kind, f);
  const set = (k, v) => { S.repF = { ...f, [k]: v }; commit(); };
  return (
    <>
      <Head title="Reports">Filter, preview, then export. Columns follow your role: organizers get no email or phone. Every export is audited.</Head>
      <div className="card row" style={{ marginBottom: 20, alignItems: 'end' }}>
        <div className="field"><label htmlFor="rp-k">Report</label>
          <select id="rp-k" value={f.kind} onChange={e => set('kind', e.target.value)}>{kinds.map(k => <option key={k} value={k}>{label(k.toUpperCase())}</option>)}</select>
        </div>
        {f.kind !== 'membership' && <>
          <div className="field"><label htmlFor="rp-e">Event</label>
            <select id="rp-e" value={f.eid} onChange={e => set('eid', e.target.value)}>
              <option value="">All {S.role === 'admin' ? '' : 'my '}events</option>
              {events.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="rp-f">From</label><input type="date" id="rp-f" value={f.from} onChange={e => set('from', e.target.value)} /></div>
          <div className="field"><label htmlFor="rp-t">To</label><input type="date" id="rp-t" value={f.to} onChange={e => set('to', e.target.value)} /></div>
        </>}
        <button className="btn pri" type="button" onClick={() => exportCsv(f.kind, f, `${label(f.kind.toUpperCase())} report (CSV)`)}>Export CSV ({rows.length - 1} rows)</button>
        <button className="btn" type="button" onClick={() => toast('XLSX export ships after launch. CSV has the same columns.')}>Export XLSX</button>
      </div>
      <div className="card scroll">
        <table>
          <thead><tr>{rows[0].map(h => <th key={h}>{h.replace(/_/g, ' ')}</th>)}</tr></thead>
          <tbody>
            {rows.length > 1
              ? rows.slice(1, 13).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)
              : <tr><td colSpan={rows[0].length} className="muted">No rows for these filters.</td></tr>}
          </tbody>
        </table>
        {rows.length > 13 && <p className="tiny muted" style={{ marginTop: 8 }}>Preview of 12 of {rows.length - 1} rows.</p>}
      </div>
    </>
  );
}
