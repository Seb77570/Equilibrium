'use client';

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, Minimize2 } from 'lucide-react';

/**
 * Standard OS fullscreen toggle, pinned to the window's top-right corner.
 *
 * Tauri's setFullscreen() drops the native title bar AND the Windows taskbar,
 * so this button is the only way back out — it stays visible in fullscreen by
 * design. F11 mirrors it (WebView2's own F11 is disabled in lib.rs, so the
 * key reaches us here).
 *
 * Deliberately self-contained and mounted once at the app root: it must not
 * depend on the active view, and keeping it in its own file keeps it clear of
 * the workspace toolbar's own buttons.
 */
export default function FullscreenToggle() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggle = async (next?: boolean) => {
    try {
      const win = getCurrentWindow();
      const target = next ?? !(await win.isFullscreen());
      await win.setFullscreen(target);
      setIsFullscreen(target);
    } catch {
      // Not running under Tauri (plain browser / SSR): nothing to toggle.
    }
  };

  // The window can enter/leave fullscreen without us (F11 handled elsewhere,
  // window manager, …), so read the real state on mount rather than assume.
  useEffect(() => {
    getCurrentWindow().isFullscreen().then(setIsFullscreen).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <button
      onClick={() => toggle()}
      title={isFullscreen ? 'Exit fullscreen (F11)' : 'Fullscreen (F11)'}
      className="fixed top-2 right-2 z-[400] p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-brand border border-white/10 transition-colors"
    >
      {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>
  );
}
