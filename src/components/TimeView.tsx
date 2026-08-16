'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, Trash2, Clock, X, Plus, Volume2, VolumeX, Download } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { TimeEntry, TimeOp, useTimeStore, entryDurationMs, formatMinutes, useNow } from '@/app/store/timeStore';
import { useWorkspaceStore } from '@/app/store/workspaceStore';
import { DateTimeFlipField, MONTH_NAMES, daysInMonth } from './DateTimeFlip';

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

function addMonths(d: Date, n: number): Date {
  // Land on day 1 — avoids the Jan 31 → Mar 3 skip and month view only
  // cares about which month is displayed anyway.
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

// Drag-to-create selections snap to 5 minutes.
const DRAG_SNAP_MS = 5 * 60_000;
// Seed values for the Add Record modal when opened from a drag selection
// (or {} when opened from the toolbar button → the usual "last 10 min").
interface AddSeed { projectPath?: string; startMs?: number; endMs?: number }

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

// ── Month calendar view ────────────────────────────────────────────────────
// Monday-first grid of the displayed month. Each day cell shows its total
// tracked time; the cell background scales with hours worked (8h = full
// intensity). Clicking a day jumps to its day view.
function MonthGrid({
  entries, date, now, onPickDay,
}: {
  entries: TimeEntry[];
  date: Date;
  now: number;
  onPickDay: (d: Date) => void;
}) {
  const y = date.getFullYear();
  const m0 = date.getMonth();

  const totals = useMemo(() => {
    const mStart = new Date(y, m0, 1).getTime();
    const mEnd = new Date(y, m0 + 1, 1).getTime();
    const per = new Map<number, number>();
    for (const e of entries) {
      const eEnd = e.running ? now : e.end_ms;
      const s = Math.max(e.start_ms, mStart);
      const en = Math.min(eEnd, mEnd);
      if (en <= s) continue;
      const day = new Date(s).getDate();
      per.set(day, (per.get(day) ?? 0) + (en - s));
    }
    return per;
  }, [entries, y, m0, now]);

  const n = daysInMonth(y, m0);
  const lead = (new Date(y, m0, 1).getDay() + 6) % 7;
  const today = new Date(now);
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: n }, (_, i) => i + 1)];

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 mb-1.5 text-[10px] uppercase tracking-widest text-white/30 font-bold">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="px-2">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((day, i) => {
          if (day === null) return <div key={`blank-${i}`} aria-hidden />;
          const ms = totals.get(day) ?? 0;
          const isToday = today.getFullYear() === y && today.getMonth() === m0 && today.getDate() === day;
          // 8h ≈ full intensity — tuned so a normal workday reads clearly.
          const intensity = ms > 0 ? 0.08 + 0.3 * Math.min(1, ms / (8 * 3_600_000)) : 0;
          return (
            <button
              key={day}
              onClick={() => onPickDay(new Date(y, m0, day))}
              title="Open day view"
              className={`h-20 rounded-lg border p-2 flex flex-col items-start justify-between text-left transition-colors cursor-pointer hover:border-brand/50 ${
                isToday ? 'border-brand/60' : 'border-white/10'
              }`}
              style={{ backgroundColor: ms > 0 ? `rgba(14, 165, 233, ${intensity})` : 'rgba(255, 255, 255, 0.02)' }}
            >
              <span className={`text-xs font-bold ${isToday ? 'text-brand-light' : 'text-white/50'}`}>{day}</span>
              {ms > 0 && <span className="font-mono tabular-nums text-sm text-white">{formatMinutes(ms)}</span>}
            </button>
          );
        })}
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
  const undoOp = useTimeStore((s) => s.undo);
  const redoOp = useTimeStore((s) => s.redo);
  const activeView = useWorkspaceStore((s) => s.activeView);

  // Rerender once per minute so live (running) blocks grow visibly.
  const now = useNow(30_000);

  const [date, setDate] = useState<Date>(() => new Date());
  const [view, setView] = useState<'day' | 'month'>('day');
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [adding, setAdding] = useState<AddSeed | null>(null);
  const [exporting, setExporting] = useState(false);
  // Live drag-to-create selection on a day-view track (null = not dragging).
  const [drag, setDrag] = useState<{ path: string | null; a: number; b: number } | null>(null);
  const dragRef = useRef<{ path: string | null; a: number; b: number } | null>(null);
  // Live edge-resize of a finished block (null = not resizing).
  const [resize, setResize] = useState<{ id: string; startMs: number; endMs: number } | null>(null);
  const resizeRef = useRef<{
    id: string; side: 'l' | 'r'; entry: TimeEntry;
    startMs: number; endMs: number;
    min: number; max: number; rect: DOMRect; moved: boolean;
  } | null>(null);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    invoke<Project[]>('get_projects').then(setProjects).catch(() => {});
  }, []);

  // Ctrl+Z / Ctrl+Shift+Z — undo/redo the last time modification. Deliberately
  // narrow: TimeView stays mounted (just hidden) when another view is active,
  // so we gate on activeView === 'time' to make an accidental Ctrl+Z from the
  // dashboard or a workspace impossible. Also inert while typing in an input
  // or while a modal is open, and every action shows a confirmation toast so
  // nothing changes silently.
  const [undoToast, setUndoToast] = useState<string | null>(null);
  const undoToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (activeView !== 'time') return;
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.key.toLowerCase() !== 'z') return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (editing || adding || exporting) return;
      ev.preventDefault();
      const isRedo = ev.shiftKey;
      (isRedo ? redoOp() : undoOp()).then((op: TimeOp | null) => {
        const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const describe = (e: TimeEntry, verb: string) =>
          `${verb} — ${e.project_path.split(/[\\/]/).pop()} · ${fmt(e.start_ms)}–${fmt(e.end_ms)}`;
        let msg: string;
        if (!op) msg = isRedo ? 'Nothing to redo' : 'Nothing to undo';
        else if (op.type === 'add') msg = isRedo ? describe(op.entry, 'Redo: entry re-added') : describe(op.entry, 'Undo: entry removed');
        else if (op.type === 'update') msg = isRedo ? describe(op.after, 'Redo: change reapplied') : describe(op.before, 'Undo: change reverted');
        else msg = isRedo ? describe(op.entry, 'Redo: entry deleted') : describe(op.entry, 'Undo: entry restored');
        setUndoToast(msg);
        if (undoToastTimer.current) clearTimeout(undoToastTimer.current);
        undoToastTimer.current = setTimeout(() => setUndoToast(null), 3000);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeView, editing, adding, exporting, undoOp, redoOp]);

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

  // ── Drag-to-create ──────────────────────────────────────────────────────
  // Press-and-drag on the empty part of a track (or the hour ruler) selects
  // a time range; releasing opens Add Record pre-filled with that range and,
  // when dragged on a project row, that project.
  const msFromPointer = (clientX: number, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round((dayStart + frac * (dayEnd - dayStart)) / DRAG_SNAP_MS) * DRAG_SNAP_MS;
  };
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    const s = Math.min(d.a, d.b);
    const e = Math.max(d.a, d.b);
    if (e - s >= DRAG_SNAP_MS) {
      setAdding({ projectPath: d.path ?? undefined, startMs: s, endMs: e });
    }
  };
  // Spread onto any horizontal strip that maps to the full 24h day.
  const dragProps = (path: string | null) => ({
    onPointerDown: (ev: React.PointerEvent<HTMLDivElement>) => {
      if (ev.button !== 0) return;
      // Entry blocks are buttons — clicking them means "edit", not "select".
      if ((ev.target as HTMLElement).closest('button')) return;
      ev.currentTarget.setPointerCapture(ev.pointerId);
      const ms = msFromPointer(ev.clientX, ev.currentTarget);
      const d = { path, a: ms, b: ms };
      dragRef.current = d;
      setDrag(d);
    },
    onPointerMove: (ev: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const ms = msFromPointer(ev.clientX, ev.currentTarget);
      const d = { ...dragRef.current, b: ms };
      dragRef.current = d;
      setDrag(d);
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });
  // ── Edge resize (finished blocks only) ──────────────────────────────────
  // Grabbing a block's left or right edge stretches/shrinks it, snapped to
  // 5 minutes, clamped against the neighbouring blocks on the same row and
  // the day bounds. The tooltip stays visible with live times while
  // dragging; releasing persists via updateEntry.
  const beginResize = (
    ev: React.PointerEvent<HTMLElement>, e: TimeEntry, side: 'l' | 'r', list: TimeEntry[],
  ) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const track = (ev.currentTarget.parentElement as HTMLElement).parentElement as HTMLElement;
    // Collision bounds from the same row's other entries.
    let min = dayStart;
    let max = dayEnd;
    const eEnd = e.running ? now : e.end_ms;
    for (const o of list) {
      if (o.id === e.id) continue;
      const oEnd = o.running ? now : o.end_ms;
      if (oEnd <= e.start_ms && oEnd > min) min = oEnd;
      if (o.start_ms >= eEnd && o.start_ms < max) max = o.start_ms;
    }
    ev.currentTarget.setPointerCapture(ev.pointerId);
    resizeRef.current = {
      id: e.id, side, entry: e,
      startMs: e.start_ms, endMs: e.end_ms,
      min, max, rect: track.getBoundingClientRect(), moved: false,
    };
    setResize({ id: e.id, startMs: e.start_ms, endMs: e.end_ms });
  };
  const moveResize = (ev: React.PointerEvent<HTMLElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const frac = Math.min(1, Math.max(0, (ev.clientX - r.rect.left) / r.rect.width));
    let ms = Math.round((dayStart + frac * (dayEnd - dayStart)) / DRAG_SNAP_MS) * DRAG_SNAP_MS;
    if (r.side === 'l') {
      ms = Math.max(r.min, Math.min(ms, r.endMs - DRAG_SNAP_MS));
      if (ms === r.startMs) return;
      r.startMs = ms;
    } else {
      ms = Math.min(r.max, Math.max(ms, r.startMs + DRAG_SNAP_MS));
      if (ms === r.endMs) return;
      r.endMs = ms;
    }
    r.moved = true;
    setResize({ id: r.id, startMs: r.startMs, endMs: r.endMs });
  };
  const endResize = async () => {
    const r = resizeRef.current;
    resizeRef.current = null;
    setResize(null);
    if (!r || !r.moved) return;
    if (r.startMs !== r.entry.start_ms || r.endMs !== r.entry.end_ms) {
      await updateEntry({ ...r.entry, start_ms: r.startMs, end_ms: r.endMs });
    }
  };
  const resizeHandleProps = (e: TimeEntry, side: 'l' | 'r', list: TimeEntry[]) => ({
    onPointerDown: (ev: React.PointerEvent<HTMLElement>) => beginResize(ev, e, side, list),
    onPointerMove: moveResize,
    onPointerUp: endResize,
    onPointerCancel: endResize,
    // A resize drag must not fall through to the block's "edit" click.
    onClick: (ev: React.MouseEvent) => ev.stopPropagation(),
  });

  // Selection overlay for the strip identified by `path`.
  const dragHighlight = (path: string | null) => {
    if (!drag || drag.path !== path) return null;
    const s = Math.min(drag.a, drag.b);
    const e = Math.max(drag.a, drag.b);
    if (e <= s) return null;
    const dayMs = dayEnd - dayStart;
    return (
      <div
        className="absolute top-0 bottom-0 bg-brand/30 border border-brand/60 rounded-sm pointer-events-none"
        style={{ left: `${((s - dayStart) / dayMs) * 100}%`, width: `${((e - s) / dayMs) * 100}%` }}
      />
    );
  };

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
          <div className="flex rounded-lg bg-white/5 p-0.5 mr-1">
            {(['day', 'month'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
                  view === v ? 'bg-brand text-white' : 'text-white/50 hover:text-white'
                }`}
              >
                {v === 'day' ? 'Day' : 'Month'}
              </button>
            ))}
          </div>
          <button
            onClick={() => setDate(d => (view === 'day' ? addDays(d, -1) : addMonths(d, -1)))}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            title={view === 'day' ? 'Previous day' : 'Previous month'}
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
            onClick={() => setDate(d => (view === 'day' ? addDays(d, 1) : addMonths(d, 1)))}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            title={view === 'day' ? 'Next day' : 'Next month'}
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
            onClick={() => setAdding({})}
            className="flex items-center gap-2 px-4 py-1.5 bg-brand hover:bg-brand-light text-white rounded-lg transition-colors shadow-lg shadow-brand/20 text-xs font-bold uppercase tracking-wider"
            title="Add a time record manually"
          >
            <Plus size={14} />
            Add Record
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div className="text-sm text-white/40 capitalize">
          {view === 'day' ? fmtDateHuman(date) : `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`}
        </div>
        <SettingsStrip />
      </div>

      {view === 'month' && (
        <MonthGrid
          entries={entries}
          date={date}
          now={now}
          onPickDay={(d) => { setDate(d); setView('day'); }}
        />
      )}

      {view === 'day' && (<>
      {/* Hour ruler. Spans the whole timeline width — same 24-col grid the
          project rows use, so labels line up with the bar gridlines. Also a
          drag-to-create strip (useful when the day has no rows yet). */}
      <div
        className="relative select-none touch-none cursor-crosshair mb-2"
        title="Drag to add a record"
        {...dragProps(null)}
      >
        <div
          className="grid text-[9px] text-white/25 font-mono"
          style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="border-l border-white/5 pl-1 py-0.5">
              {h.toString().padStart(2, '0')}h
            </div>
          ))}
        </div>
        {dragHighlight(null)}
      </div>

      {/* Project rows */}
      {byProject.size === 0 ? (
        <div className="py-20 text-center text-white/30 italic">
          No tracked time on this day. Click the ⏱ icon on a project to start, or drag on the ruler above to add a record.
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
                    tooltip can extend above the row without being clipped.
                    Dragging on the empty part selects a range to create an
                    entry (pre-filled with this row's project). */}
                <div
                  className="relative h-8 bg-white/[0.03] border border-white/5 rounded select-none touch-none cursor-crosshair"
                  {...dragProps(path)}
                >
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
                    // While this block is being edge-resized, render the live
                    // in-progress bounds instead of the stored ones.
                    const isResizing = resize?.id === e.id;
                    const rStart = isResizing ? resize.startMs : e.start_ms;
                    const rEnd = isResizing ? resize.endMs : (e.running ? now : e.end_ms);
                    const sClip = Math.max(rStart, dayStart);
                    const enClip = Math.min(rEnd, dayEnd);
                    const dayMs = dayEnd - dayStart;
                    const left = ((sClip - dayStart) / dayMs) * 100;
                    const width = Math.max(0.3, ((enClip - sClip) / dayMs) * 100);
                    return (
                      <button
                        key={e.id}
                        onClick={() => setEditing(e)}
                        className={`group/block absolute top-0 bottom-0 rounded-sm cursor-pointer ${isResizing ? '' : 'transition-colors'} ${e.running ? RUNNING_BLOCK_CLASS : FINISHED_BLOCK_CLASS}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        <BlockTooltip
                          name={projectName(e.project_path)}
                          startMs={rStart}
                          endMs={rEnd}
                          running={e.running}
                          visible={isResizing}
                        />
                        {!e.running && (
                          <>
                            <span
                              {...resizeHandleProps(e, 'l', list)}
                              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none"
                            />
                            <span
                              {...resizeHandleProps(e, 'r', list)}
                              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none"
                            />
                          </>
                        )}
                      </button>
                    );
                  })}
                  {dragHighlight(path)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </>)}

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
          {view === 'day' && byProject.size > 0 && (
            <>
              <span className="text-white/40 uppercase tracking-widest text-[10px] font-bold">Total</span>
              <span className="font-mono tabular-nums text-white text-base font-bold">{formatMinutes(grandTotalMs)}</span>
            </>
          )}
          {view === 'month' && monthlyAvg.hasData && (
            <>
              <span className="text-white/40 uppercase tracking-widest text-[10px] font-bold">
                Total {MONTH_NAMES[date.getMonth()]}
              </span>
              <span className="font-mono tabular-nums text-white text-base font-bold">
                {formatMinutes(monthlyAvg.rows.reduce((a, r) => a + r.total, 0))}
              </span>
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
          initial={adding}
          onClose={() => setAdding(null)}
        />
      )}

      {/* CSV export modal */}
      {exporting && (
        <ExportModal
          projects={projects}
          onClose={() => setExporting(false)}
        />
      )}

      {/* Undo/redo confirmation toast — undoing must never be silent. */}
      {undoToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[500] px-4 py-2 bg-black/95 border border-white/10 rounded-lg text-xs text-white shadow-[0_8px_24px_rgba(0,0,0,0.6)] pointer-events-none">
          {undoToast}
        </div>
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
    // ISO date headers — "DD/MM" was ambiguous: US-locale Excel parsed
    // "01/07" as January 7th and silently turned days 1-12 into wrong dates.
    const dayCol = (d: Date) => fmtDateInput(d);

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
function BlockTooltip({ name, startMs, endMs, running, visible = false }: { name: string; startMs: number; endMs: number; running: boolean; visible?: boolean }) {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-3 py-1.5 bg-black/95 border border-white/10 rounded-lg whitespace-nowrap ${visible ? 'opacity-100' : 'opacity-0 group-hover/block:opacity-100'} pointer-events-none transition-opacity z-50 shadow-[0_8px_24px_rgba(0,0,0,0.6)]`}>
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
function AddEntryModal({ projects, initial, onClose }: { projects: Project[]; initial?: AddSeed; onClose: () => void }) {
  const addManualEntry = useTimeStore((s) => s.addManualEntry);
  // Seed defaults on first render so the modal opens ready-to-save for the
  // happy path: a drag-to-create selection passes its range (and row project)
  // via `initial`; the toolbar button seeds "the last 10 minutes".
  const [projectPath, setProjectPath] = useState<string>(() => initial?.projectPath ?? projects[0]?.path ?? '');
  const [start, setStart] = useState<string>(() => toDatetimeLocal(initial?.startMs ?? Date.now() - 10 * 60_000));
  const [end, setEnd] = useState<string>(() => toDatetimeLocal(initial?.endMs ?? Date.now()));
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
