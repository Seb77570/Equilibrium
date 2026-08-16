'use client';
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// ── Split-flap date-time picker ────────────────────────────────────────────
// Replaces native datetime-local inputs with inline split-flap rows
// (hours, minutes | day, month-name, year — 24h, no AM/PM). The value stays
// in the "YYYY-MM-DDTHH:mm" local string callers already parse. Shared by
// the Time view modals and the chrono Backdate-start picker.
//
// Split-flap concept (SNCF departure board, modernized): five columns left
// to right — hours, minutes, then day / month-name / year. Arrows above and
// below each column step the value (wrapping around); the mouse wheel works
// too; clicking a tile turns it into a text input. Value changes play a
// small flap animation (.flip-up / .flip-down in globals.css) under a seam
// line across the middle of each tile.

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n: number) => String(n).padStart(2, '0');
export const daysInMonth = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();

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

// Inline field: label + one always-visible flap row, edited in place.
export function DateTimeFlipField({
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
