import { Terminal, IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// Persistent xterm registry, keyed by tab id.
//
// Why this exists in two parts:
//
// 1. Bleed prevention. React reuses TerminalTab across tab switches when JSX
//    position is the same — without `key={tab.id}` and per-id state, the new
//    tab inherits the previous tab's xterm via useRef and shows old content.
//
// 2. xterm.open() can only be called ONCE per parent. Calling it on a fresh
//    React-managed div on every remount leaves xterm's renderer in an
//    inconsistent state (orphaned canvas, missing helpers) and produces a
//    permanently black terminal.
//
// The fix is the "stable wrapper" pattern: xterm renders into a plain DOM
// div that lives at module scope. React's TerminalTab just moves that
// wrapper into and out of its container via appendChild. The canvas and
// internal renderer never see their parent change — they just travel with
// the wrapper.

export interface TerminalEntry {
  term: Terminal;
  fitAddon: FitAddon;
  // Stable DOM root passed to term.open(). Never destroyed until the entry
  // is disposed; React only moves it in/out of containers.
  wrapper: HTMLDivElement;
  opened: boolean;
  // PTY listener + onData persist for the entry's lifetime so terminal
  // output is never dropped while a tab is hidden.
  unlistenPty?: () => void;
  onDataDisposable?: IDisposable;
  // Setup phase guards (used by TerminalTab).
  spawnInitiated: boolean;
  setupComplete: boolean;
  // Last (rows, cols) we sent to the PTY. Used to dedupe ResizeObserver
  // bursts so we don't flood a freshly-spawned WSL → bash → claude chain
  // with SIGWINCH while it's still installing handlers.
  lastSentRows: number;
  lastSentCols: number;
}

const registry = new Map<string, TerminalEntry>();

export function getOrCreateTerminalEntry(id: string, shell?: string): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.position = 'relative';

  // WSL terminals get a very soft blue-tinted background so they're easy to
  // tell apart from PowerShell at a glance (both stay dark). PowerShell keeps
  // the default near-black.
  const isWsl = shell === 'wsl';
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: {
      background: isWsl ? '#0f1320' : '#0f1016',
      foreground: '#d4d4d4',
      cursor: '#a78bfa',
      black: '#1e1e1e',
      brightBlack: '#666666',
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const entry: TerminalEntry = {
    term,
    fitAddon,
    wrapper,
    opened: false,
    spawnInitiated: false,
    setupComplete: false,
    lastSentRows: 0,
    lastSentCols: 0,
  };
  registry.set(id, entry);
  return entry;
}

export function disposeTerminalEntry(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  // Order matters: stop receiving events before disposing the xterm,
  // otherwise a late event triggers a write on a disposed instance.
  try { entry.unlistenPty?.(); } catch (e) { console.error('[terminalRegistry] unlisten:', e); }
  try { entry.onDataDisposable?.dispose(); } catch (e) { console.error('[terminalRegistry] onData dispose:', e); }
  try { entry.term.dispose(); } catch (e) { console.error('[terminalRegistry] term dispose:', e); }
  try { entry.wrapper.parentElement?.removeChild(entry.wrapper); } catch (e) { console.error('[terminalRegistry] detach:', e); }
  registry.delete(id);
}
