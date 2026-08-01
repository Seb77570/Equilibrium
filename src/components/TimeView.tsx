'use client';
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Trash2, Clock, X, Plus, Volume2, VolumeX, Download } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { TimeEntry, useTimeStore, entryDurationMs, formatMinutes, useNow } from '@/app/store/timeStore';

interface Project {
  name: string;
  path: string;
}

// Mirrors the dashboard's section config (dashboard.json) so the Add Record
// dropdown can group projects the same way, with the same section colors.
interface ProjectSection {
  id: string;
  title: string;
  color: string;
  project_paths: string[];
}

// Day boundaries (local time) for "all entries that overlap this day".
function dayBounds(d: Date): { start: number; end: number } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

// "YYYY-MM-DD" in local time, for the native date input.
function fmtDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Pretty human label for the header.
function fmtDateHuman(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// "datetime-local" input wants "YYYY-MM-DDTHH:mm" in LOCAL time, not UTC,
// so we hand-build it from the components instead of using toISOString().
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocal(s: string): number | null {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// ── Custom date-time picker ────────────────────────────────────────────────
// Replaces the native datetime-local inputs with inline split-flap rows
// (hours, minutes | day, month-name, year — 24h, no AM/PM). The value stays
// in the same "YYYY-MM-DDTHH:mm" local string the rest of the file already
// parses, so callers don't change.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();

interface DateTimeParts { y: number; m0: number; d: number; hh: number; mm: number }

function splitLocal(s: string): DateTimeParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) {
    const now = new Date();
    return { y: now.getFullYear(), m0: now.getMonth(), d: now.getDate(), hh: now.getHours(), mm: now.getMinutes() };
  }
  return { y: +m[1], m0: +m[2] - 1, d: +m[3], hh: +m[4], mm: +m[5] };
}

const joinLocal = (p: DateTimeParts) => `${p.y}-${pad2(p.m0 + 1)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}`;

// Split-flap concept (SNCF departure board, modernized): five columns left
// to right — hours, minutes, then day / month-name / year. Arrows above and
// below each column step the value (wrapping around); the mouse wheel works
// too. Value changes play a small flap animation (.flip-up / .flip-down in
// globals.css) under a seam line across the middle of each tile.

function FlipColumn({
  label, display, onStep, onInput, widthClass, textClass = 'text-2xl tabular-nums',
}: {
  label: string;
  display: string;
  onStep: (dir: 1 | -1) => void;
  // Parses a typed value and applies it if valid; invalid input is ignored.
  onInput: (raw: string) => void;
  widthClass: string;
  textClass?: string;
}) {
  // Remember the last step direction so the flap animates the way it "rolls".
  const [dir, setDir] = useState<1 | -1>(1);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const step = (d: 1 | -1) => { setDir(d); onStep(d); };
  const commit = () => { setEditing(false); onInput(draft.trim()); };
  return (
    <div className={`flex flex-col items-center gap-1 ${widthClass}`}>
      <button
        type="button"
        onClick={() => step(1)}
        aria-label={`${label} up`}
        className="w-full h-6 flex items-center justify-center rounded-md text-white/30 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
      >
        <ChevronUp size={14} />
      </button>
      <div
        onWheel={(e) => { if (!editing) step(e.deltaY > 0 ? 1 : -1); }}
        onClick={() => { if (!editing) { setDraft(display); setEditing(true); } }}
        title={editing ? undefined : 'Click to type'}
        className={`relative w-full h-12 flex items-center justify-center bg-white/5 border rounded-lg overflow-hidden ${
          editing ? 'border-brand/50' : 'border-white/10 cursor-text'
        }`}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setEditing(false);
            }}
            aria-label={label}
            className={`w-full bg-transparent text-center font-bold text-white ${textClass} focus:outline-none`}
          />
        ) : (
          <span key={display} className={`block font-bold text-white ${textClass} ${dir === 1 ? 'flip-up' : 'flip-down'}`}>
            {display}
          </span>
        )}
        {/* Flap seam — the split line across the middle of the tile. */}
        {!editing && <div className="absolute left-0 right-0 top-1/2 h-px bg-black/50 pointer-events-none" />}
      </div>
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label={`${label} down`}
        className="w-full h-6 flex items-center justify-center rounded-md text-white/30 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  );
}

// Aligns colon / group divider with the value tiles: same arrow-row heights
// as FlipColumn, content only at tile height.
function FlipSpacer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="h-6" />
      <div className="h-12 flex items-center">{children}</div>
      <div className="h-6" />
    </div>
  );
}

// Inline field: label + one always-visible flap row. No sub-popup — both
// Start and End rows live directly in the modal, edited in place.
function DateTimeFlipField({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const parts = splitLocal(value);
  const set = (patch: Partial<DateTimeParts>) => {
    const next = { ...parts, ...patch };
    // Changing month/year can invalidate the day (e.g. 31 → February).
    next.d = Math.min(next.d, daysInMonth(next.y, next.m0));
    onChange(joinLocal(next));
  };

  const stepHours = (d: 1 | -1) => set({ hh: (parts.hh + d + 24) % 24 });
  const stepMinutes = (d: 1 | -1) => set({ mm: (parts.mm + d + 60) % 60 });
  const stepDay = (d: 1 | -1) => {
    const n = daysInMonth(parts.y, parts.m0);
    set({ d: ((parts.d - 1 + d + n) % n) + 1 });
  };
  const stepMonth = (d: 1 | -1) => set({ m0: (parts.m0 + d + 12) % 12 });
  const stepYear = (d: 1 | -1) => set({ y: parts.y + d });

  // Typed-input parsers (one per column). Invalid input leaves the value
  // unchanged. Month accepts a number (1-12) or a name prefix ("ju", "dec").
  const inRange = (raw: string, min: number, max: number): number | null => {
    if (!/^\d+$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    return n >= min && n <= max ? n : null;
  };
  const inputHours = (raw: string) => { const n = inRange(raw, 0, 23); if (n !== null) set({ hh: n }); };
  const inputMinutes = (raw: string) => { const n = inRange(raw, 0, 59); if (n !== null) set({ mm: n }); };
  const inputDay = (raw: string) => { const n = inRange(raw, 1, 31); if (n !== null) set({ d: n }); };
  const inputMonth = (raw: string) => {
    const n = inRange(raw, 1, 12);
    if (n !== null) { set({ m0: n - 1 }); return; }
    const t = raw.toLowerCase();
    const idx = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(t));
    if (t && idx >= 0) set({ m0: idx });
  };
  const inputYear = (raw: string) => { const n = inRange(raw, 1970, 2100); if (n !== null) set({ y: n }); };

  return (
    <div className="mb-4">
      <label className="block text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <FlipColumn label={`${label} hours`} display={pad2(parts.hh)} onStep={stepHours} onInput={inputHours} widthClass="w-14" />
        <FlipSpacer>
          <span className="text-2xl font-bold text-white/30">:</span>
        </FlipSpacer>
        <FlipColumn label={`${label} minutes`} display={pad2(parts.mm)} onStep={stepMinutes} onInput={inputMinutes} widthClass="w-14" />
        <FlipSpacer>
          <div className="h-12 w-px bg-white/10 mx-2" />
        </FlipSpacer>
        <FlipColumn label={`${label} day`} display={pad2(parts.d)} onStep={stepDay} onInput={inputDay} widthClass="w-14" />
        <FlipColumn
          label={`${label} month`}
          display={MONTH_NAMES[parts.m0]}
          onStep={stepMonth}
          onInput={inputMonth}
          widthClass="w-28"
          textClass="text-sm uppercase tracking-wider"
        />
        <FlipColumn label={`${label} year`} display={String(parts.y)} onStep={stepYear} onInput={inputYear} widthClass="w-[4.5rem]" />
      </div>
    </div>
  );
}

// Same color used for the workspace's "active running" badge — visual link
// between the running toggle on a card and the live block in this view.
const RUNNING_BLOCK_CLASS = 'bg-amber-500/70 hover:bg-amber-500/85';
const FINISHED_BLOCK_CLASS = 'bg-emerald-500/60 hover:bg-emerald-500/80';

export default function TimeView() {
  const entries = useTimeStore((s) => s.entries);
  const load = useTimeStore((s) => s.load);
  const updateEntry = useTimeStore((s) => s.updateEntry);
  const deleteEntry = useTimeStore((s) => s.deleteEntry);

  // Rerender once per minute so live (running) blocks grow visibly.
  const now = useNow(30_000);

  const [date, setDate] = useState<Date>(() => new Date());
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    invoke<Project[]>('get_projects').then(setProjects).catch(() => {});
  }, []);

  const { start: dayStart, end: dayEnd } = dayBounds(date);
  const isToday = useMemo(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return t.getTime() === dayStart;
  }, [dayStart]);

  // Entries that overlap [dayStart, dayEnd). Running entries use `now` as
  // their effective end, so an in-progress session shows up live.
  const dayEntries = useMemo(() => {
    return entries.filter((e) => {
      const eEnd = e.running ? now : e.end_ms;
      return e.start_ms < dayEnd && eEnd > dayStart;
    });
  }, [entries, dayStart, dayEnd, now]);

  // Group by project path, preserving insertion order via Map.
  const byProject = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of dayEntries) {
      const list = m.get(e.project_path);
      if (list) list.push(e); else m.set(e.project_path, [e]);
    }
    return m;
  }, [dayEntries]);

  // Project name lookup (path → name). Fallback: last path segment.
  const projectName = (path: string): string => {
    const found = projects.find((p) => p.path === path);
    if (found) return found.name;
    const seg = path.split(/[\\/]/).filter(Boolean).pop();
    return seg || path;
  };

  // Sum of *clipped* duration within the day (an entry that straddles
  // midnight should only count its share of THIS day).
  const projectTotal = (list: TimeEntry[]): number => {
    return list.reduce((acc, e) => {
      const eEnd = e.running ? now : e.end_ms;
      const s = Math.max(e.start_ms, dayStart);
      const en = Math.min(eEnd, dayEnd);
      return acc + Math.max(0, en - s);
    }, 0);
  };

  const grandTotalMs = useMemo(() => {
    let total = 0;
    Array.from(byProject.values()).forEach((list) => { total += projectTotal(list); });
    return total;
  }, [byProject, now, dayStart, dayEnd]);

  // ── Monthly average ─────────────────────────────────────────────────────
  // Average working time per CALENDAR day over the displayed day's month
  // (days with no entries count too — this matches declarations and the CSV
  // export). For the current month, only the days elapsed so far divide the
  // total; for past months, the full month length. The hover tooltip breaks
  // the same calculation down per project.
  const monthlyAvg = useMemo(() => {
    const mStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    const mEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
    let total = 0;
    const perProject = new Map<string, number>();
    for (const e of entries) {
      const eEnd = e.running ? now : e.end_ms;
      const s = Math.max(e.start_ms, mStart);
      const en = Math.min(eEnd, mEnd);
      if (en <= s) continue;
      const dur = en - s;
      total += dur;
      perProject.set(e.project_path, (perProject.get(e.project_path) ?? 0) + dur);
    }
    const today = new Date(now);
    const sameMonth = today.getFullYear() === date.getFullYear() && today.getMonth() === date.getMonth();
    const days = sameMonth ? today.getDate() : daysInMonth(date.getFullYear(), date.getMonth());
    const rows = Array.from(perProject.entries())
      .map(([path, t]) => ({ path, avg: t / days, total: t }))
      .sort((a, b) => b.avg - a.avg);
    return { avg: days > 0 && total > 0 ? total / days : 0, days, hasData: total > 0, rows };
  }, [entries, date, now]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    // No max-width: the timeline benefits hugely from horizontal space (more
    // pixels per hour → easier to read short blocks). Outer p-8 in page.tsx
    // already keeps a sane breathing margin from the window edges.
    <div className="w-full">
      {/* Header */}
      <div className="mb-8 flex items-end justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-4xl font-bold gradient-text tracking-tight">Time</h1>
          </div>
          <p className="text-white/40 font-medium tracking-wide flex items-center gap-2">
            <Clock size={14} />
            Track minutes per project, edit anything afterwards.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDate(d => addDays(d, -1))}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            title="Previous day"
          >
            <ChevronLeft size={18} />
          </button>
          <input
            type="date"
            value={fmtDateInput(date)}
            onChange={(e) => {
              const parsed = new Date(e.target.value);
              if (!Number.isNaN(parsed.getTime())) setDate(parsed);
            }}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-brand/40"
          />
          <button
            onClick={() => setDate(d => addDays(d, 1))}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            title="Next day"
          >
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => setDate(new Date())}
            disabled={isToday}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors ${
              isToday ? 'bg-white/5 text-white/20 cursor-default' : 'bg-brand/20 text-brand-light hover:bg-brand/30'
            }`}
          >
            Today
          </button>
          <button
            onClick={() => setExporting(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg transition-colors text-xs font-bold uppercase tracking-wider"
            title="Export a date range to CSV (projects × days)"
          >
            <Download size={14} />
            Export
          </button>
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 px-4 py-1.5 bg-brand hover:bg-brand-light text-white rounded-lg transition-colors shadow-lg shadow-brand/20 text-xs font-bold uppercase tracking-wider"
            title="Add a time record manually"
          >
            <Plus size={14} />
            Add Record
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div className="text-sm text-white/40 capitalize">{fmtDateHuman(date)}</div>
        <SettingsStrip />
      </div>

      {/* Hour ruler. Spans the whole timeline width — same 24-col grid the
          project rows use, so labels line up with the bar gridlines. */}
      <div
        className="grid text-[9px] text-white/25 font-mono mb-2"
        style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="border-l border-white/5 pl-1 py-0.5">
            {h.toString().padStart(2, '0')}h
          </div>
        ))}
      </div>

      {/* Project rows */}
      {byProject.size === 0 ? (
        <div className="py-20 text-center text-white/30 italic">
          No tracked time on this day. Click the ⏱ icon on a project to start.
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(byProject.entries()).map(([path, list]) => {
            const totalMs = projectTotal(list);
            return (
              <div key={path}>
                {/* Header line: project name on the left, day total on the
                    right. Kept compact so the bar gets the next full row. */}
                <div className="flex items-baseline justify-between mb-1 px-0.5">
                  <span className="text-sm font-semibold text-white/80 truncate" title={path}>
                    {projectName(path)}
                  </span>
                  <span className="text-sm font-mono tabular-nums text-white/70 shrink-0 ml-3">
                    {formatMinutes(totalMs)}
                  </span>
                </div>

                {/* Track — full row width. NOT overflow-hidden so the hover
                    tooltip can extend above the row without being clipped. */}
                <div className="relative h-8 bg-white/[0.03] border border-white/5 rounded">
                  {/* Faint hour grid for visual alignment with the ruler. */}
                  {Array.from({ length: 23 }, (_, i) => (
                    <div
                      key={i}
                      aria-hidden
                      className="absolute top-0 bottom-0 border-l border-white/[0.04]"
                      style={{ left: `${((i + 1) / 24) * 100}%` }}
                    />
                  ))}
                  {list.map((e) => {
                    const eEnd = e.running ? now : e.end_ms;
                    const sClip = Math.max(e.start_ms, dayStart);
                    const enClip = Math.min(eEnd, dayEnd);
                    const dayMs = dayEnd - dayStart;
                    const left = ((sClip - dayStart) / dayMs) * 100;
                    const width = Math.max(0.3, ((enClip - sClip) / dayMs) * 100);
                    return (
                      <button
                        key={e.id}
                        onClick={() => setEditing(e)}
                        className={`group/block absolute top-0 bottom-0 rounded-sm transition-colors cursor-pointer ${e.running ? RUNNING_BLOCK_CLASS : FINISHED_BLOCK_CLASS}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        <BlockTooltip
                          name={projectName(e.project_path)}
                          startMs={e.start_ms}
                          endMs={eEnd}
                          running={e.running}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Day total + monthly average */}
      {(byProject.size > 0 || monthlyAvg.hasData) && (
        <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-end gap-3 text-sm">
          {monthlyAvg.hasData && (
            <>
              {/* Hover the value for the per-project breakdown. */}
              <div className="relative group flex items-center gap-2 cursor-default">
                <span className="text-white/40 uppercase tracking-widest text-[10px] font-bold">
                  Average working time for {MONTH_NAMES[date.getMonth()]}
                </span>
                <span className="font-mono tabular-nums text-brand text-base font-bold">
                  {formatMinutes(monthlyAvg.avg)}
                  <span className="text-white/40 text-xs font-normal"> /day</span>
                </span>
                <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-72 bg-[#18181b] border border-white/10 rounded-xl shadow-2xl p-3 z-50">
                  <div className="text-[10px] uppercase tracking-widest text-white/40 font-bold mb-2">
                    Daily average by project — {MONTH_NAMES[date.getMonth()]}
                  </div>
                  {monthlyAvg.rows.map((r) => (
                    <div key={r.path} className="flex items-center justify-between gap-3 py-0.5 text-xs">
                      <span className="text-white/70 truncate">{projectName(r.path)}</span>
                      <span className="font-mono tabular-nums text-white shrink-0">
                        {formatMinutes(r.avg)}
                        <span className="text-white/30"> /day</span>
                        <span className="text-white/30"> · {formatMinutes(r.total)}</span>
                      </span>
                    </div>
                  ))}
                  <div className="mt-2 pt-2 border-t border-white/10 flex items-center justify-between text-xs">
                    <span className="text-white/40">Days counted</span>
                    <span className="font-mono tabular-nums text-white">{monthlyAvg.days}</span>
                  </div>
                </div>
              </div>
              <span className="text-white/10 select-none">|</span>
            </>
          )}
          {byProject.size > 0 && (
            <>
              <span className="text-white/40 uppercase tracking-widest text-[10px] font-bold">Total</span>
              <span className="font-mono tabular-nums text-white text-base font-bold">{formatMinutes(grandTotalMs)}</span>
            </>
          )}
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <EditEntryModal
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={async (next) => { await updateEntry(next); setEditing(null); }}
          onDelete={async () => { await deleteEntry(editing.id); setEditing(null); }}
          projectName={projectName(editing.project_path)}
        />
      )}

      {/* Add manual record modal */}
      {adding && (
        <AddEntryModal
          projects={projects}
          onClose={() => setAdding(false)}
        />
      )}

      {/* CSV export modal */}
      {exporting && (
        <ExportModal
          projects={projects}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}

// ── CSV export ──────────────────────────────────────────────────────────────
// Exports a date range as a project × day matrix (projects in rows, days in
// columns, hours in decimal). Days are split on LOCAL midnight, and a session
// spanning midnight is divided between the days it touches (so each column
// shows the hours actually worked that day). Only projects with > 0h in the
// range are included.
function ExportModal({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const entries = useTimeStore((s) => s.entries);
  const now = Date.now();
  const today = new Date();
  const weekAgo = addDays(today, -6);

  const [from, setFrom] = useState<string>(() => fmtDateInput(weekAgo));
  const [to, setTo] = useState<string>(() => fmtDateInput(today));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projName = (path: string) =>
    projects.find((p) => p.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;

  const buildCsv = (): { csv: string; days: Date[] } | null => {
    const start = new Date(from); start.setHours(0, 0, 0, 0);
    const endDay = new Date(to); endDay.setHours(0, 0, 0, 0);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endDay.getTime())) { setError('Dates invalides'); return null; }
    if (endDay < start) { setError('La date de fin doit être après le début'); return null; }

    // List of days in the range (inclusive).
    const days: Date[] = [];
    for (let d = new Date(start); d <= endDay; d = addDays(d, 1)) days.push(new Date(d));

    // matrix[projectPath][dayIndex] = hours
    const matrix = new Map<string, number[]>();
    for (const e of entries) {
      const s = e.start_ms;
      const en = e.running ? now : e.end_ms;
      for (let i = 0; i < days.length; i++) {
        const { start: ds, end: de } = dayBounds(days[i]);
        const ov = Math.max(0, Math.min(en, de) - Math.max(s, ds));
        if (ov <= 0) continue;
        if (!matrix.has(e.project_path)) matrix.set(e.project_path, new Array(days.length).fill(0));
        matrix.get(e.project_path)![i] += ov;
      }
    }
    if (matrix.size === 0) { setError('Aucune donnée dans cette plage'); return null; }

    const h = (ms: number) => (ms / 36e5).toFixed(2);
    const esc = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const dayCol = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

    const header = ['Projet', ...days.map(dayCol), 'Total'];
    const rows: string[][] = [];
    const colTotals = new Array(days.length).fill(0);
    let grand = 0;

    // Stable order: by project name.
    const paths = Array.from(matrix.keys()).sort((a, b) => projName(a).localeCompare(projName(b)));
    for (const p of paths) {
      const arr = matrix.get(p)!;
      const rowTotal = arr.reduce((x, y) => x + y, 0);
      grand += rowTotal;
      arr.forEach((v, i) => (colTotals[i] += v));
      rows.push([projName(p), ...arr.map(h), h(rowTotal)]);
    }
    const totalRow = ['Total', ...colTotals.map(h), h(grand)];

    const lines = [header, ...rows, totalRow].map((r) => r.map(esc).join(','));
    // BOM so Excel reads accents (é…) correctly.
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    return { csv, days };
  };

  const doExport = async () => {
    setError(null);
    const res = buildCsv();
    if (!res) return;
    setBusy(true);
    try {
      const suggested = `temps_${from}_a_${to}.csv`;
      const path = await save({
        defaultPath: suggested,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!path) { setBusy(false); return; } // user cancelled
      await invoke('write_text_file', { path, content: res.csv });
      onClose();
    } catch (e) {
      console.error('export failed:', e);
      setError('Échec de l\'export : ' + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[#18181b] border border-white/10 rounded-2xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold text-white uppercase tracking-[0.2em]">Export CSV</h3>
          <button onClick={onClose} className="p-1 text-white/30 hover:text-white"><X size={14} /></button>
        </div>
        <p className="text-xs text-white/40 mb-5">
          Projets en lignes, jours en colonnes, heures en décimal. Tous les projets travaillés sur la période.
        </p>

        <div className="flex gap-3 mb-4">
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">Du</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand/40" />
          </div>
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">Au</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand/40" />
          </div>
        </div>

        {error && <div className="text-xs text-rose-400 mb-3">{error}</div>}

        <div className="flex justify-end gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-white/50 hover:text-white hover:bg-white/5">Annuler</button>
          <button onClick={doExport} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand-light disabled:opacity-50 text-white rounded-lg text-xs font-bold uppercase tracking-wider">
            <Download size={14} />
            {busy ? 'Export…' : 'Exporter'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Block hover tooltip ────────────────────────────────────────────────────
// Custom (not native `title`) because the browser tooltip waits ~1s before
// showing and we want immediate feedback while scanning the timeline.
// Positioned above the block, centered. `pointer-events-none` so it never
// blocks clicks on adjacent blocks; the parent button keeps full hover area.
function BlockTooltip({ name, startMs, endMs, running }: { name: string; startMs: number; endMs: number; running: boolean }) {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-3 py-1.5 bg-black/95 border border-white/10 rounded-lg whitespace-nowrap opacity-0 group-hover/block:opacity-100 pointer-events-none transition-opacity z-50 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
      <div className="text-[12px] font-semibold text-white">{name}</div>
      <div className="text-[10px] text-white/50 mt-0.5 flex items-center gap-2">
        <span>{fmt(startMs)} → {fmt(endMs)}</span>
        <span className={`font-bold ${running ? 'text-amber-300' : 'text-emerald-300'}`}>
          {formatMinutes(endMs - startMs)}{running ? ' · live' : ''}
        </span>
      </div>
    </div>
  );
}

// ── Edit modal ──────────────────────────────────────────────────────────────

function EditEntryModal({
  entry, onClose, onSave, onDelete, projectName,
}: {
  entry: TimeEntry;
  onClose: () => void;
  onSave: (next: TimeEntry) => Promise<void>;
  onDelete: () => Promise<void>;
  projectName: string;
}) {
  const [start, setStart] = useState(() => toDatetimeLocal(entry.start_ms));
  const [end, setEnd] = useState(() => toDatetimeLocal(entry.end_ms));
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    const sMs = parseDatetimeLocal(start);
    const eMs = parseDatetimeLocal(end);
    if (sMs === null || eMs === null) { setError('Invalid date/time'); return; }
    if (eMs <= sMs) { setError('End must be after start'); return; }
    // Editing a running entry implicitly stops it — once the user is
    // hand-correcting the bounds, "still running" no longer makes sense.
    await onSave({ ...entry, start_ms: sMs, end_ms: eMs, running: false });
  };

  return (
    <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#18181b] border border-white/10 rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold text-white uppercase tracking-[0.2em]">Edit entry</h3>
          <button onClick={onClose} className="p-1 text-white/30 hover:text-white"><X size={14} /></button>
        </div>
        <p className="text-xs text-white/40 mb-5">{projectName}{entry.running ? ' · currently running' : ''}</p>

        <DateTimeFlipField label="Start" value={start} onChange={setStart} />

        <DateTimeFlipField label="End" value={end} onChange={setEnd} />

        {error && <div className="text-xs text-rose-400 mb-3">{error}</div>}

        <div className="flex items-center justify-between gap-2 mt-5">
          <button
            onClick={onDelete}
            className="px-3 py-2 rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5"
          >
            <Trash2 size={13} /> Delete
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 text-xs font-bold uppercase tracking-wider transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={commit}
              className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark text-xs font-bold uppercase tracking-wider transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Inline settings strip ──────────────────────────────────────────────────
// Always visible (no popover) so the user can see at a glance what the idle
// threshold is set to and whether the sound is on. The two controls write
// straight through to disk via updateSettings.
function SettingsStrip() {
  const settings = useTimeStore((s) => s.settings);
  const updateSettings = useTimeStore((s) => s.updateSettings);
  const minutes = Math.max(1, Math.round(settings.idle_threshold_ms / 60_000));

  return (
    <div className="flex items-center gap-4 text-xs">
      <label className="flex items-center gap-2 text-white/50">
        <span>Idle auto-stop</span>
        <input
          type="number"
          min={1}
          max={180}
          value={minutes}
          onChange={(e) => {
            const v = Math.max(1, Math.min(180, parseInt(e.target.value, 10) || 15));
            updateSettings({ idle_threshold_ms: v * 60_000 });
          }}
          className="w-14 bg-white/5 border border-white/10 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-brand/40 font-mono tabular-nums"
        />
        <span className="text-white/40">min</span>
      </label>
      <button
        onClick={() => updateSettings({ idle_sound: !settings.idle_sound })}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
          settings.idle_sound
            ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white'
        }`}
        title={settings.idle_sound ? 'Idle beep enabled — click to mute' : 'Idle beep muted — click to enable'}
      >
        {settings.idle_sound ? <Volume2 size={12} /> : <VolumeX size={12} />}
        <span className="font-bold uppercase tracking-wider text-[10px]">
          {settings.idle_sound ? 'Sound' : 'Muted'}
        </span>
      </button>
    </div>
  );
}

// ── Add manual record modal ────────────────────────────────────────────────
// Free-form entry: pick any project, any date, any times. Default window is
// "the last 10 minutes" because that's the most common case (forgot to start
// the chrono before launching into work). All fields are editable.
function AddEntryModal({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const addManualEntry = useTimeStore((s) => s.addManualEntry);
  // Seed defaults on first render so the modal opens ready-to-save for the
  // happy path (forgot to start a chrono 10 min ago).
  const [projectPath, setProjectPath] = useState<string>(() => projects[0]?.path ?? '');
  const [start, setStart] = useState<string>(() => toDatetimeLocal(Date.now() - 10 * 60_000));
  const [end, setEnd] = useState<string>(() => toDatetimeLocal(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sections, setSections] = useState<ProjectSection[]>([]);

  useEffect(() => {
    invoke<{ sections: ProjectSection[] }>('get_dashboard_config')
      .then((cfg) => setSections(cfg.sections ?? []))
      .catch(() => {});
  }, []);

  // Same grouping as the dashboard: sections in order (each listing its
  // projects in section order), then everything not in a section.
  const { grouped, rest } = useMemo(() => {
    const byPath = new Map(projects.map((p) => [p.path, p]));
    const used = new Set<string>();
    const grouped = sections
      .map((s) => ({
        section: s,
        items: s.project_paths
          .map((path) => {
            const p = byPath.get(path);
            if (p) used.add(path);
            return p;
          })
          .filter((p): p is Project => !!p),
      }))
      .filter((g) => g.items.length > 0);
    const rest = projects.filter((p) => !used.has(p.path));
    return { grouped, rest };
  }, [projects, sections]);

  const commit = async () => {
    setError(null);
    if (!projectPath) { setError('Pick a project'); return; }
    const sMs = parseDatetimeLocal(start);
    const eMs = parseDatetimeLocal(end);
    if (sMs === null || eMs === null) { setError('Invalid date/time'); return; }
    if (eMs <= sMs) { setError('End must be after start'); return; }
    setSaving(true);
    try {
      await addManualEntry({ projectPath, startMs: sMs, endMs: eMs });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#18181b] border border-white/10 rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold text-white uppercase tracking-[0.2em]">Add record</h3>
          <button onClick={onClose} className="p-1 text-white/30 hover:text-white"><X size={14} /></button>
        </div>
        <p className="text-xs text-white/40 mb-5">Manual time entry — useful when you forgot to start the chrono.</p>

        <label className="block text-[10px] uppercase tracking-widest text-white/40 font-bold mb-1">Project</label>
        <select
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand/40 mb-4"
        >
          {projects.length === 0 && <option value="" className="bg-[#18181b] text-white">No projects available</option>}
          {grouped.map(({ section, items }) => (
            <optgroup
              key={section.id}
              label={`● ${section.title}`}
              className="bg-[#18181b] not-italic"
              style={{ color: section.color }}
            >
              {items.map((p) => (
                <option key={p.path} value={p.path} className="bg-[#18181b] text-white">{p.name}</option>
              ))}
            </optgroup>
          ))}
          {rest.length > 0 && (grouped.length > 0 ? (
            <optgroup label="● Uncategorized" className="bg-[#18181b] not-italic text-white/50">
              {rest.map((p) => (
                <option key={p.path} value={p.path} className="bg-[#18181b] text-white">{p.name}</option>
              ))}
            </optgroup>
          ) : (
            rest.map((p) => (
              <option key={p.path} value={p.path} className="bg-[#18181b] text-white">{p.name}</option>
            ))
          ))}
        </select>

        <DateTimeFlipField label="Start" value={start} onChange={setStart} />

        <DateTimeFlipField label="End" value={end} onChange={setEnd} />

        {error && <div className="text-xs text-rose-400 mb-3">{error}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 text-xs font-bold uppercase tracking-wider transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={saving || !projectPath}
            className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold uppercase tracking-wider transition-colors"
          >
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
