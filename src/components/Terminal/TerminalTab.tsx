'use client';
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getOrCreateTerminalEntry } from '@/lib/terminalRegistry';
import { useWorkspaceStore } from '@/app/store/workspaceStore';
import '@xterm/xterm/css/xterm.css';

interface TerminalTabProps {
  id: string;
  shell?: string;
  cwd?: string;
  initialCommand?: string;
  // Set for Claude tabs: drives working/idle status keyed by this session id.
  agentSessionId?: string;
}

// Module-level guard so initialCommand is sent at most once even across
// React StrictMode mount/unmount/mount and tab-switch remounts.
const initialCommandsSent = new Set<string>();

export default function TerminalTab({ id, shell, cwd, initialCommand, agentSessionId }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const entry = getOrCreateTerminalEntry(id, shell);
    const container = containerRef.current;

    // Move (or place) the persistent xterm wrapper into our React container.
    // appendChild on an already-attached node moves it; xterm's canvas and
    // helpers move with it without losing state.
    container.appendChild(entry.wrapper);

    // First mount of this id: actually call xterm.open() and bind keyboard
    // shortcuts. Subsequent mounts skip this entirely.
    if (!entry.opened) {
      entry.term.open(entry.wrapper);
      entry.opened = true;

      // Renderer kick. Opening before the container has real dimensions can
      // leave xterm's DOM renderer blank until something forces a relayout —
      // this is the intermittent "permanently black terminal". (The now-removed
      // [equil] log writes used to trigger this implicitly.) A fit + refresh
      // once the container is laid out paints it; invisible, no stray content.
      requestAnimationFrame(() => {
        try {
          entry.fitAddon.fit();
          entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
        } catch (_) {}
      });

      //   Ctrl+V             → paste from clipboard (xterm sends raw ^V otherwise)
      //   Ctrl+Backspace     → backward-kill-word — readline / PSReadLine bind ^W there
      //   Ctrl+Alt+Space     → swallowed; reserved for the user's voice-input
      //                        global hotkey. Without this, xterm forwards it to
      //                        PSReadLine which interprets Ctrl+Space as
      //                        MenuComplete and loops while the key is held.
      entry.term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const ctrl = event.ctrlKey || event.metaKey;
        if (ctrl && event.altKey && (event.key === ' ' || event.code === 'Space')) {
          event.preventDefault();
          return false;
        }
        // Ctrl+Tab / Ctrl+Shift+Tab → handled globally as pane-tab cycling;
        // never write to the PTY.
        if (ctrl && !event.altKey && event.key === 'Tab') {
          return false;
        }
        if (ctrl && (event.key === 'c' || event.key === 'C')) {
          // Copy. Two gestures, mirroring Windows Terminal / VS Code:
          //   Ctrl+Shift+C → always a copy; never reaches the PTY.
          //   Ctrl+C       → copy ONLY when text is selected. With no
          //                  selection it must stay the SIGINT interrupt
          //                  (\x03) so the user can still kill a running
          //                  process (or clear Claude Code's input line).
          // This is why plain Ctrl+C used to wipe Claude's input without
          // copying: it was forwarded to the PTY as an interrupt.
          if (event.shiftKey || entry.term.hasSelection()) {
            const selection = entry.term.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection).catch((err) => {
                console.error('Copy failed:', err);
              });
              entry.term.clearSelection();
            }
            event.preventDefault();
            return false;
          }
          // No selection → let xterm forward \x03 to the PTY as usual.
          return true;
        }
        if (ctrl && (event.key === 'v' || event.key === 'V')) {
          // preventDefault is critical: without it, the browser still fires a
          // native `paste` event on xterm's hidden textarea, and xterm's own
          // paste handler writes the clipboard a second time → double paste.
          event.preventDefault();
          // Two-stage paste:
          //   1. Try clipboard.read() — returns ALL types including image/*.
          //      Win+Shift+S, Snipping Tool, etc. put binary image data on the
          //      clipboard (no file path), so plain readText returns nothing.
          //      We dump the bytes to %TEMP%\equilibrium-clipboard\… and paste
          //      the file path so Claude Code (or any image-aware CLI) can
          //      pick it up as a vision input.
          //   2. Fallback to readText for normal text paste.
          (async () => {
            try {
              if (navigator.clipboard.read) {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                  const imgType = item.types.find((t) => t.startsWith('image/'));
                  if (imgType) {
                    const blob = await item.getType(imgType);
                    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
                    const ext = imgType.split('/')[1] ?? 'png';
                    const path = await invoke<string>('save_clipboard_image', { bytes, ext });
                    if (path) {
                      await invoke('write_to_terminal', { id, data: path });
                    }
                    return;
                  }
                }
              }
            } catch (err) {
              // Permission errors, no image, etc. — fall through to text path.
              console.warn('clipboard.read() unavailable or failed; trying text:', err);
            }
            try {
              const text = await navigator.clipboard.readText();
              if (text) await invoke('write_to_terminal', { id, data: text });
            } catch (err) {
              console.error('Paste failed:', err);
            }
          })();
          return false;
        }
        if (event.ctrlKey && event.key === 'Backspace') {
          invoke('write_to_terminal', { id, data: '\x17' }).catch((err) => {
            console.error('Ctrl+Backspace write failed:', err);
          });
          return false;
        }
        return true;
      });
    }

    const t0 = performance.now();
    // Console-only diagnostics. We deliberately do NOT write these into xterm:
    // injected text corrupts full-screen TUIs (Claude Code in particular), and
    // the prompt-recovery path no longer depends on terminal log lines. Still
    // mirrored to devtools for cross-referencing with the Rust eprintln logs.
    const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info') => {
      const ms = Math.round(performance.now() - t0);
      const line = `[equil +${ms}ms] ${msg}`;
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[TerminalTab:${id}] ${line}`);
    };

    let cancelled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    // Lost-prompt recovery. The reader thread's first `pty-output` event can be
    // dropped by a congested WebView2 IPC bridge at startup, so xterm never
    // shows the prompt. We watch for output; if none arrives but Rust HAS
    // buffered some, the event was dropped → replay the buffer once. In the
    // normal case output arrives live and we never replay (no duplication).
    let receivedOutput = false;
    let replayed = false;
    let replayTimer: ReturnType<typeof setInterval> | undefined;

    // Claude working/idle detection via its animated spinner glyph. While
    // generating/running tools Claude rotates a star glyph (✶ ✻ ✽ ✢ …) that
    // changes every frame — so it is re-emitted continuously on BOTH a real PTY
    // (WSL) and Windows ConPTY (where only changed cells stream, which is why
    // the static "esc to interrupt" hint, sent just once, was undetectable).
    // Idle screens carry no spinner glyph → no false positives. We also accept
    // the literal "interrupt" word as a secondary trigger (belt-and-suspenders).
    const SPINNER = /[✠-❏]/; // dingbat stars/asterisks (✶ ✻ ✽ ✢ …)
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    let agentCarry = '';
    let agentWorking = false;
    let agentIdleTimer: ReturnType<typeof setTimeout> | undefined;
    // Clear the "unread" notification dot — the user is interacting with /
    // looking at this conversation.
    const markRead = () => {
      if (agentSessionId) useWorkspaceStore.getState().setAgentUnread(agentSessionId, false);
    };
    const checkAgentMarker = (data: string) => {
      if (!agentSessionId) return;
      const combined = stripAnsi(agentCarry + data);
      agentCarry = data.slice(-16);
      if (!SPINNER.test(combined) && !combined.toLowerCase().includes('interrupt')) return;
      if (!agentWorking) {
        agentWorking = true;
        useWorkspaceStore.getState().setAgentStatus(agentSessionId, 'working');
        // New activity supersedes any pending "finished" notification.
        useWorkspaceStore.getState().setAgentUnread(agentSessionId, false);
      }
      if (agentIdleTimer) clearTimeout(agentIdleTimer);
      agentIdleTimer = setTimeout(() => {
        agentWorking = false;
        useWorkspaceStore.getState().setAgentStatus(agentSessionId, 'idle');
        // Claude just finished → raise the unread dot until the user looks.
        useWorkspaceStore.getState().setAgentUnread(agentSessionId, true);
      }, 1500);
    };

    const sendInitialCommand = () => {
      if (cancelled || !initialCommand || initialCommandsSent.has(id)) return;
      initialCommandsSent.add(id);
      if (quietTimer) { clearTimeout(quietTimer); quietTimer = undefined; }
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = undefined; }
      invoke('write_to_terminal', { id, data: initialCommand + '\r' })
        .then(() => log(`Initial command sent: ${initialCommand}`))
        .catch((e) => log(`Failed to send command: ${e}`, 'error'));
    };

    // Focus on mount so the terminal is keyboard-ready immediately.
    // The actual fit() now happens inside initOnce BEFORE spawn_terminal
    // so the PTY is created with the right dimensions from the get-go —
    // critical because Windows ConPTY → WSL has flaky SIGWINCH propagation
    // and a wrong initial size garbles TUIs like Claude Code.
    const focusTimer = setTimeout(() => {
      try { entry.term.focus(); } catch (_) {}
      markRead(); // switching to / focusing the tab counts as reading it
    }, 50);

    // Debounce + dedupe resizes. Burst events fire during initial mount as
    // flexbox/react-resizable-panels settle; if any of those land *while*
    // claude (or another TUI) is starting up inside WSL, the SIGWINCH chain
    // through Windows ConPTY → wsl.exe → bash drops or reorders signals and
    // the TUI ends up rendering for the wrong size. Coalescing into one
    // settled-size resize avoids that.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const fireResize = () => {
      try {
        entry.fitAddon.fit();
        // Repaint on every settle — when the container first gains real
        // dimensions (0 → N), this is what un-blanks a renderer that opened
        // against a zero-size element.
        entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
        const r = entry.term.rows, c = entry.term.cols;
        if (r === entry.lastSentRows && c === entry.lastSentCols) return;
        entry.lastSentRows = r;
        entry.lastSentCols = c;
        invoke('resize_terminal', { id, rows: r, cols: c }).catch(() => {});
      } catch (_) {}
    };
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fireResize, 100);
    });
    resizeObserver.observe(container);

    // Clicking anywhere in the terminal clears the unread notification dot.
    container.addEventListener('mousedown', markRead);

    // PTY listener + spawn + onData run exactly once per terminal id.
    // After the first mount, the listener stays registered so output emitted
    // while the tab is hidden is still written into xterm and visible when
    // the user returns to the tab.
    const initOnce = async () => {
      if (entry.setupComplete) {
        log('initOnce: setupComplete=true, skipping init');
        return;
      }
      log(`mount started — shell="${shell || 'default'}" cwd="${cwd || 'none'}"`);

      try {
        // 1) IPC sanity check. If this hangs or fails, every subsequent
        //    invoke would too — and we'd rather fail loudly here than stall
        //    silently inside spawn_terminal.
        log('step 1/4 — pinging Rust IPC...');
        try {
          const pong = await invoke<string>('pty_ping', { tag: id.slice(0, 8) });
          log(`step 1/4 — ping OK: ${pong}`);
        } catch (e) {
          log(`step 1/4 — ping FAILED: ${e}`, 'error');
          throw e;
        }

        // 2) Attach the pty-output listener BEFORE spawn so we don't miss
        //    the very first prompt bytes the reader thread emits.
        log(`step 2/4 — calling listen('pty-output:${id.slice(0, 8)}…')...`);
        const unlistenFn = await listen<{ id: string; data: string }>(
          `pty-output:${id}`,
          (event) => {
            if (event.payload.data) {
              receivedOutput = true;
              checkAgentMarker(event.payload.data);
            }
            entry.term.write(event.payload.data);
            if (initialCommand && !initialCommandsSent.has(id)) {
              if (quietTimer) clearTimeout(quietTimer);
              quietTimer = setTimeout(sendInitialCommand, 800);
            }
          }
        );
        log('step 2/4 — listen() resolved');

        if (cancelled) {
          log('cancelled after listen → disposing fresh listener', 'warn');
          unlistenFn();
          return;
        }
        if (entry.unlistenPty) {
          log('parallel mount already set unlistenPty → disposing fresh listener', 'warn');
          unlistenFn();
          return;
        }
        entry.unlistenPty = unlistenFn;
        log('step 2/4 — listener stored on entry');

        // Attach onData BEFORE spawning. xterm answers the shell's startup
        // cursor-position query (ESC[6n / DSR) by emitting the report through
        // onData; if no handler exists when that first reply is generated, it
        // is dropped and the shell blocks forever waiting for it → a terminal
        // that renders only a cursor and never shows a prompt. Attaching here
        // (before any PTY byte can arrive) closes that race. write_to_terminal
        // tolerates the session not existing yet (the reply only fires once
        // output arrives, i.e. after the session is registered).
        if (!entry.onDataDisposable) {
          entry.onDataDisposable = entry.term.onData((data) => {
            markRead(); // typing in the terminal clears the unread dot
            invoke('write_to_terminal', { id, data }).catch((e) => {
              console.error(`[TerminalTab:${id}] write_to_terminal failed:`, e);
            });
          });
          log('onData handler attached (pre-spawn)');
        }

        // 3) Spawn the PTY. spawn_terminal returns true=new, false=reconnect.
        if (!entry.spawnInitiated) {
          entry.spawnInitiated = true;

          // Wait for the container's width to be STABLE across two
          // consecutive frames before fitting. One rAF isn't enough — flex
          // layouts inside react-resizable-panels frequently settle over
          // 2-3 frames, and a fit() taken on a transient intermediate width
          // hands the PTY a too-small size that sticks (Windows ConPTY → WSL
          // SIGWINCH propagation is unreliable enough that the wrong initial
          // size is what TUIs like Claude Code end up rendering against).
          let stable = 0, lastW = -1;
          for (let i = 0; i < 8; i++) {
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            const w = container.clientWidth;
            if (w > 0 && w === lastW) {
              if (++stable >= 2) break;
            } else {
              stable = 0;
              lastW = w;
            }
          }
          let initRows = entry.term.rows;
          let initCols = entry.term.cols;
          try {
            entry.fitAddon.fit();
            initRows = entry.term.rows;
            initCols = entry.term.cols;
            entry.lastSentRows = initRows;
            entry.lastSentCols = initCols;
            // Force a repaint now that the container is stably sized — recovers
            // a renderer that opened blank against a 0-size container.
            entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
            log(`pre-spawn fit: ${initCols}x${initRows} (container ${container.clientWidth}px stable)`);
          } catch (e) {
            log(`pre-spawn fit failed (using defaults ${initCols}x${initRows}): ${e}`, 'warn');
          }

          log(`step 3/4 — invoking spawn_terminal... shell=${shell || 'default'} cwd=${JSON.stringify(cwd)} cmd=${JSON.stringify(initialCommand)}`);
          const isNew = await invoke<boolean>('spawn_terminal', {
            id,
            shell: shell || null,
            cwd: cwd || null,
            rows: initRows,
            cols: initCols,
          });
          log(`step 3/4 — spawn_terminal returned isNew=${isNew}`);

          if (isNew && initialCommand && !initialCommandsSent.has(id)) {
            log(`scheduling fallback initial command ('${initialCommand}') in 8s if shell stays silent`);
            fallbackTimer = setTimeout(() => {
              log('shell stayed silent — sending initial command anyway', 'warn');
              sendInitialCommand();
            }, 8000);
          }

          // Lost-prompt recovery. Poll for ~12s: as soon as Rust has captured
          // output that never reached xterm (live event dropped under WebView2
          // IPC congestion), replay it once. If output arrived live,
          // receivedOutput short-circuits this and nothing is replayed.
          if (isNew) {
            let attempts = 0;
            replayTimer = setInterval(async () => {
              attempts += 1;
              if (cancelled || receivedOutput || replayed || attempts > 12) {
                clearInterval(replayTimer);
                replayTimer = undefined;
                return;
              }
              try {
                const buffered = await invoke<string>('get_terminal_buffer', { id });
                if (!cancelled && !receivedOutput && !replayed && buffered) {
                  replayed = true;
                  receivedOutput = true;
                  entry.term.write(buffered);
                  log('recovered dropped initial output via buffer replay', 'warn');
                  clearInterval(replayTimer);
                  replayTimer = undefined;
                }
              } catch (e) {
                log(`get_terminal_buffer failed: ${e}`, 'warn');
              }
            }, 1000);
          }
        } else {
          log('step 3/4 — spawn already initiated by parallel mount, skipping');
        }

        entry.setupComplete = true;
        log('initOnce DONE — setupComplete=true');
      } catch (err) {
        if (!cancelled) log(`FATAL during initOnce: ${err}`, 'error');
        else log(`error after cancel (ignored): ${err}`, 'warn');
      }
    };

    initOnce();

    return () => {
      cancelled = true;
      clearTimeout(focusTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (replayTimer) clearInterval(replayTimer);
      if (agentIdleTimer) clearTimeout(agentIdleTimer);
      container.removeEventListener('mousedown', markRead);
      resizeObserver.disconnect();
      // Detach the wrapper from this container — it stays alive in the
      // registry, ready to be re-attached on the next mount.
      try {
        if (entry.wrapper.parentElement === container) {
          container.removeChild(entry.wrapper);
        }
      } catch (_) {}
      // PTY listener and onData are NOT disposed here — they live with the
      // entry until the tab is killed via removeTab/removeWorkspace.
    };
  }, [id, shell, cwd, initialCommand, agentSessionId]);

  return (
    <div className="relative w-full h-full bg-[#0f1016]">
      <div ref={containerRef} className="absolute inset-1 overflow-hidden" />
    </div>
  );
}
