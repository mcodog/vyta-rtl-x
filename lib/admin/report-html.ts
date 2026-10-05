/**
 * Shared printable-report renderer.
 *
 * Every admin report in the app is a self-contained HTML document served as
 * `text/html`, opened in a new tab and auto-printed — the admin "downloads a
 * PDF" by choosing *Save as PDF* in the browser's print dialog. There is no
 * PDF renderer in this path (the only real PDF is the Stock Report email
 * attachment, see lib/admin/stock-report-pdf.ts).
 *
 * Two variants share one stylesheet:
 *   • branded   — the STEALTH HEALTH wordmark, gold rule, black table header and
 *                 cream zebra rows used by the /admin/products reports.
 *   • unbranded — the plainer heading used by the customers / orders /
 *                 invoices / audit-log reports.
 *
 * Everything here is a pure string function with no framework, Supabase or
 * Next.js imports, so the same code runs from a route handler, a scheduled
 * job or a build script.
 */

import { formatAppDate } from '@/lib/datetime';

export type StockUnit = 'boxes' | 'vials';

export interface Stat {
  label: string;
  value: string;
  meta?: string;
  tone?: 'default' | 'pending' | 'paid' | 'danger';
}

export interface Column {
  header: string;
  /** Right-align + tabular numerals. */
  num?: boolean;
}

export interface ReportShellOptions {
  title: string;
  /** Chips rendered in the "Filters" card above the body. */
  filters?: string[];
  /** Pre-rendered HTML for the report body (stats grid, tables, notes). */
  body: string;
  /** Right-hand side of the footer line. */
  footRight?: string;
  /** Append the auto-print script (disabled by `?print=0`). */
  autoPrint?: boolean;
  /** Use the STEALTH HEALTH branded layout. */
  branded?: boolean;
  /** Meta line items rendered under the gold rule (branded layout only). */
  meta?: string[];
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Bare-dollar money. Currency is a *label* on these reports, never a conversion. */
export function money(n: number): string {
  const num = Number(n);
  return `$${(Number.isFinite(num) ? num : 0).toFixed(2)}`;
}

export function formatDate(d: unknown): string {
  if (!d) return '—';
  const date = new Date(String(d));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

/** "July 17, 2026 at 3:45 PM" — the generated-at stamp on every report. */
export function readableDateTime(d: Date = new Date()): string {
  return d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
}

/**
 * The single source of truth for how a vial count is written on a report.
 *
 * In boxes mode a quantity smaller than one box falls back to a plain vial
 * count — printing "0 boxes" for real stock reads as "nothing in stock",
 * which is the opposite of the truth. Output is derived from numbers only,
 * so the result is always safe to embed as raw HTML.
 */
export function formatStockDisplay(
  vials: number,
  vialsPerBox: number,
  unit: StockUnit = 'boxes',
  showRemainder = true,
): string {
  const v = Math.max(0, Math.floor(Number(vials) || 0));
  if (unit === 'vials') return `${v} vial${v === 1 ? '' : 's'}`;

  const per = Number(vialsPerBox) > 0 ? Math.floor(Number(vialsPerBox)) : 10;
  const boxes = Math.floor(v / per);
  const rem = v % per;
  if (boxes === 0) return `${v} vial${v === 1 ? '' : 's'}`;
  const head = `${boxes} box${boxes === 1 ? '' : 'es'}`;
  if (showRemainder && rem > 0) return `${head} (${rem} vial${rem === 1 ? '' : 's'})`;
  return head;
}

/** A row of 1–4 equal-width summary cards. */
export function statsGrid(stats: Stat[]): string {
  if (stats.length === 0) return '';
  const cols = Math.min(Math.max(stats.length, 1), 4);
  const cards = stats
    .map((s) => {
      const tone = s.tone && s.tone !== 'default' ? ` ${s.tone}` : '';
      return `<div class="stat${tone}">` +
        `<div class="label">${escapeHtml(s.label)}</div>` +
        `<div class="value">${escapeHtml(s.value)}</div>` +
        (s.meta ? `<div class="meta">${escapeHtml(s.meta)}</div>` : '') +
        `</div>`;
    })
    .join('');
  return `<div class="stats" style="grid-template-columns: repeat(${cols}, 1fr)">${cards}</div>`;
}

/**
 * A table. NOTE: cells are raw HTML — callers escape their own content, which
 * is what lets a cell carry a pill or a `<strong>`.
 */
export function table(columns: Column[], rows: string[][], emptyText: string): string {
  const head = columns
    .map((c) => `<th${c.num ? ' class="num"' : ''}>${escapeHtml(c.header)}</th>`)
    .join('');
  if (rows.length === 0) {
    return `<table><thead><tr>${head}</tr></thead><tbody>` +
      `<tr><td class="empty" colspan="${columns.length}">${escapeHtml(emptyText)}</td></tr>` +
      `</tbody></table>`;
  }
  const body = rows
    .map((cells) => {
      const tds = cells
        .map((cell, i) => `<td${columns[i]?.num ? ' class="num"' : ''}>${cell}</td>`)
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function pill(text: string, tone = ''): string {
  const cls = tone ? `pill ${tone}` : 'pill';
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

const REPORT_CSS = `
  @page { size: A4; margin: 14mm; }
  /*
    Print the report exactly as designed, with no extra clicks. Browsers strip
    background fills when printing unless the reader ticks "Background graphics"
    (Chrome/Edge) / "Print backgrounds" (Safari, Firefox) in the print dialog —
    which would silently wreck the branded layout: the black table header prints
    white-on-white (the headings vanish), the gold zebra rows go flat, and every
    status pill loses its colour. \`print-color-adjust: exact\` overrides that
    economy mode, so the design survives the trip to paper/PDF on the defaults.
    It is an inherited property, but it's declared on \`*\` so engines that
    implemented only the (non-inherited) prefixed form still honour it. The
    legacy \`color-adjust\` alias covers Firefox 63–96.
  */
  * { box-sizing: border-box;
      -webkit-print-color-adjust: exact; color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #07203A; margin: 0; padding: 28px; background: #fff; }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: 0.02em; }
  .sub { font-size: 12px; color: #56707F; margin: 0 0 18px; }
  .filters { background: #F7FAFB; border-radius: 8px; padding: 12px 16px; font-size: 12px; margin-bottom: 18px; }
  .filters strong { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #56707F; margin-right: 6px; }
  .filters span { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #fff; border: 1px solid #DCE7EB; margin-right: 6px; }
  .stats { display: grid; gap: 12px; margin-bottom: 22px; }
  .stat { padding: 14px; border: 1px solid #DCE7EB; border-radius: 10px; }
  .stat .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #56707F; margin-bottom: 6px; }
  .stat .value { font-size: 18px; font-weight: 700; }
  .stat.pending .value { color: #B45309; }
  .stat.paid .value { color: #047857; }
  .stat.danger .value { color: #B91C1C; }
  .stat .meta { font-size: 11px; color: #56707F; margin-top: 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: #56707F; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #56707F; padding: 8px 6px; border-bottom: 1px solid #DCE7EB; }
  td { padding: 7px 6px; border-bottom: 1px solid #EDF3F5; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { font-size: 10px; color: #56707F; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; background: #EDF3F5; color: #0E3F5F; }
  .pill.green, .pill.active, .pill.paid, .pill.delivered { background: #D1FAE5; color: #065F46; }
  .pill.amber, .pill.pending, .pill.processing { background: #FEF3C7; color: #92400E; }
  .pill.red, .pill.inactive, .pill.cancelled, .pill.out { background: #FEE2E2; color: #991B1B; }
  .pill.blue, .pill.shipped, .pill.confirmed { background: #E1EFF1; color: #0E3F5F; }
  .pill.purple, .pill.admin { background: #EDE9FE; color: #6D28D9; }
  .empty { padding: 24px; text-align: center; color: #56707F; font-size: 12px; }
  .foot { margin-top: 32px; padding-top: 12px; border-top: 1px solid #DCE7EB; font-size: 10px; color: #56707F; display: flex; justify-content: space-between; }

  /* ---- Branded STEALTH HEALTH layout (admin/products reports) ---- */
  body.branded .brandhead { margin-bottom: 18px; }
  body.branded .brandname { font-size: 26px; font-weight: 800; letter-spacing: 0.16em; color: #438B9E; margin: 0 0 2px; }
  body.branded h1 { font-size: 20px; font-weight: 700; color: #07203A; margin: 0 0 10px; }
  body.branded .goldrule { height: 3px; background: #438B9E; border-radius: 2px; margin: 0 0 12px; }
  body.branded .reportmeta { display: flex; flex-wrap: wrap; gap: 5px 16px; font-size: 11.5px; color: #56707F; }
  body.branded .reportmeta span { white-space: nowrap; }
  body.branded .reportmeta span + span { border-left: 1px solid #C4DFE3; padding-left: 16px; }
  body.branded th { background: #07203A; color: #FFFFFF; border-bottom: none; white-space: nowrap; }
  body.branded td { white-space: nowrap; border-bottom: 1px solid #E1EFF1; }
  body.branded tbody tr:nth-child(even) td { background: #E1EFF1; }
  body.branded tbody tr:nth-child(odd) td { background: #FFFFFF; }
  body.branded .foot { border-top: 2px solid #438B9E; color: #56707F; }
  body.branded .foot strong { color: #438B9E; letter-spacing: 0.06em; }
  @media print { body { padding: 0; } }
  /*
    Last-ditch legibility net for engines too old to know \`print-color-adjust\`
    at all: without the black fill, white header text would print invisible, so
    fall back to ink-on-white with a gold rule instead.
  */
  @supports not ((-webkit-print-color-adjust: exact) or (print-color-adjust: exact)) {
    @media print {
      body.branded th { background: transparent; color: #07203A; border-bottom: 2px solid #438B9E; }
    }
  }
`;

const AUTO_PRINT_SCRIPT =
  '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 350); });</script>';

/** Render a complete, self-contained report document. */
export function reportShell(opts: ReportShellOptions): string {
  const {
    title,
    filters = [],
    body,
    footRight = '',
    autoPrint = true,
    branded = false,
    meta = [],
  } = opts;

  const head = branded
    ? `<div class="brandhead">
    <div class="brandname">STEALTH HEALTH</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="goldrule"></div>
    ${meta.length ? `<div class="reportmeta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>` : ''}
  </div>`
    : `<h1>${escapeHtml(title)}</h1>
  <p class="sub">Stealth Health · Generated ${escapeHtml(new Date().toLocaleString())}</p>`;

  const filtersHtml = filters.length
    ? `<div class="filters"><strong>Filters</strong>${filters.map((f) => `<span>${escapeHtml(f)}</span>`).join('')}</div>`
    : '';

  const foot = branded
    ? `<div class="foot">
    <span><strong>Stealth Health</strong>${footRight ? ` · ${escapeHtml(footRight)}` : ''}</span>
    <span>Confidential — internal use only</span>
  </div>`
    : `<div class="foot">
    <span>Stealth Health · ${escapeHtml(title)}</span>
    <span>${escapeHtml(footRight)}</span>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>${REPORT_CSS}</style></head>
<body class="${branded ? 'branded' : ''}">
<div class="wrap">
  ${head}
  ${filtersHtml}
  ${body}
  ${foot}
</div>
${autoPrint ? AUTO_PRINT_SCRIPT : ''}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Legacy shell — kept verbatim for the customers / orders / invoices /
// audit-log reports, which were written against this argument shape and its
// "Print" button. New reports use `reportShell` above. The only change made
// here is the `print-color-adjust` rule, so those reports stop losing their
// header fills in the print dialog too.
// ---------------------------------------------------------------------------

export interface ReportCard {
  label: string;
  value: string;
}

export interface ReportShellArgs {
  title: string;
  subtitle?: string;
  cards?: ReportCard[];
  columns: string[];
  rows: string[][]; // Cells are PRE-RENDERED HTML — caller escapes.
  generated?: string;
  /** Optional column alignment by index: 'num' (right + tabular). */
  columnAlign?: Record<number, 'num' | 'mono'>;
  /** Optional row classes by index. */
  rowClasses?: Array<string | undefined>;
  /** Optional footer note rendered under the table. */
  footer?: string;
}

export function fmtMoney(n: unknown, currency = 'CAD'): string {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(num);
  } catch {
    return `$${num.toFixed(2)}`;
  }
}

export function fmtDate(s: unknown): string {
  if (!s) return '—';
  return formatAppDate(String(s), { year: 'numeric', month: 'short', day: 'numeric' }, 'en-CA');
}

export function legacyReportShell(args: ReportShellArgs): string {
  const generated = args.generated ?? new Date().toLocaleString('en-CA');
  const cardsHtml = (args.cards ?? [])
    .map(
      (c) => `<div class="card"><div class="n">${escapeHtml(c.value)}</div><div class="l">${escapeHtml(c.label)}</div></div>`,
    )
    .join('');

  const headerHtml = args.columns
    .map((c, i) => {
      const align = args.columnAlign?.[i];
      const cls = align === 'num' ? ' class="num"' : '';
      return `<th${cls}>${escapeHtml(c)}</th>`;
    })
    .join('');

  const rowsHtml = args.rows
    .map((cells, r) => {
      const cls = args.rowClasses?.[r];
      const tr = cls ? ` class="${escapeHtml(cls)}"` : '';
      const tds = cells
        .map((cell, i) => {
          const align = args.columnAlign?.[i];
          const tdCls =
            align === 'num' ? ' class="num"' : align === 'mono' ? ' class="mono"' : '';
          return `<td${tdCls}>${cell}</td>`;
        })
        .join('');
      return `<tr${tr}>${tds}</tr>`;
    })
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>${escapeHtml(args.title)}</title>
<style>
  * { box-sizing: border-box;
      -webkit-print-color-adjust: exact; color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #07203A; margin: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #56707F; font-size: 13px; margin: 0 0 20px; }
  .cards { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .card { border: 1px solid #DCE7EB; border-radius: 10px; padding: 14px 18px; min-width: 140px; }
  .card .n { font-size: 22px; font-weight: 700; }
  .card .l { font-size: 12px; color: #56707F; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; background: #F7FAFB; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #56707F; border-bottom: 1px solid #DCE7EB; }
  th.num { text-align: right; }
  td { padding: 8px 10px; border-bottom: 1px solid #DCE7EB; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #56707F; font-size: 12px; }
  tr.overdue td { color: #DC2626; font-weight: 600; }
  tr.muted td { color: #6E8898; }
  .footer { margin-top: 20px; color: #56707F; font-size: 12px; }
  @media print { body { margin: 0; } .noprint { display: none; } }
  .noprint { margin-bottom: 16px; }
  button { padding: 8px 16px; border: 1px solid #DCE7EB; border-radius: 8px; background: #07203A; color: #fff; cursor: pointer; }
</style></head>
<body>
  <div class="noprint"><button onclick="window.print()">Print</button></div>
  <h1>${escapeHtml(args.title)}</h1>
  <p class="sub">${args.subtitle ? `${escapeHtml(args.subtitle)} · ` : ''}Generated ${escapeHtml(generated)}</p>
  ${cardsHtml ? `<div class="cards">${cardsHtml}</div>` : ''}
  <table>
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  ${args.footer ? `<div class="footer">${escapeHtml(args.footer)}</div>` : ''}
</body></html>`;
}
