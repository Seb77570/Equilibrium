'use client';
import { useEffect } from 'react';
import { useWorkspaceStore } from '@/app/store/workspaceStore';

// Global keyboard shortcuts that need to apply across the whole app:
//
//  - Ctrl+R / Ctrl+Shift+R / F5 / Ctrl+F5  → blocked. WebView2 would do a full
//    reload otherwise, destroying the workspace state (terminals, browser
//    overlays, etc.).
//
//  - Ctrl+Tab / Ctrl+Shift+Tab → cycle the active tab inside the focused pane
//    of the current workspace. xterm.js would normally swallow these inside a
//    terminal; we listen on `window` in the capture phase so we run first.
export default function BlockReloadShortcuts() {
  const cycleTabInFocusedPane = useWorkspaceStore(s => s.cycleTabInFocusedPane);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isReload =
        e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));
      if (isReload) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab. Match on `e.key === 'Tab'` AND ctrl. Alt
      // pressed → bail (Alt+Tab is the OS window switcher, never ours).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Tab') {
        if (!activeWorkspaceId) return;
        e.preventDefault();
        e.stopPropagation();
        cycleTabInFocusedPane(activeWorkspaceId, e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
  }, [activeWorkspaceId, cycleTabInFocusedPane]);

  // Suppress WebView2's native right-click menu (Reload / Inspect / Back / …).
  // It otherwise pops up over the app's own right-click actions — e.g.
  // right-clicking a project's idle timer to backdate the start. Editable
  // fields keep their menu so copy/paste still works there.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  return null;
}
