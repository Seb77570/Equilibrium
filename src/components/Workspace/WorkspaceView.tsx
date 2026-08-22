'use client';
import { useState } from 'react';
import { useWorkspaceStore } from '@/app/store/workspaceStore';
import { useTodoStore, useTodos } from '@/app/store/todoStore';
import { Terminal, FolderTree, ListTodo } from 'lucide-react';
import SplitLayout from './SplitLayout';
import FileExplorer from './FileExplorer';
import WorkspaceTodo from './WorkspaceTodo';

export default function WorkspaceView() {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId);
  // Both overlays occupy the same right-edge slot, so only one can be open.
  const [panel, setPanel] = useState<'files' | 'todo' | null>(null);
  const projectPath = activeWorkspace?.metadata?.projectPath;

  // Drives the badge on the to-do button: how much is still open here.
  useTodos();
  const openHere = useTodoStore(
    (s) => s.todos.filter((t) => !t.done && t.project_path === projectPath).length
  );

  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0f1016]">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Terminal size={32} className="text-white/20" />
          </div>
          <h2 className="text-xl font-bold text-white/40 uppercase tracking-[0.2em]">Select a workspace</h2>
          <p className="text-sm text-white/20 font-medium">Choose a project from the sidebar to begin.</p>
        </div>
      </div>
    );
  }

  return (
    // `relative` so a fullscreen TabPane (absolute inset-0) anchors here
    // and covers exactly the workspace area, not the sidebar.
    <div className="flex-1 flex flex-col min-w-0 bg-[#0f1016] overflow-hidden relative">
      <SplitLayout
        node={activeWorkspace.layout}
        workspaceId={activeWorkspace.id}
        metadata={activeWorkspace.metadata}
      />

      {/* Right-edge toggles: files, then this project's to-do list. Hidden
          while a panel is open (each panel has its own close button). Only
          shown when the workspace is bound to a project path on disk. */}
      {projectPath && panel === null && (
        <div className="absolute top-2 right-11 z-[150] flex items-center gap-1">
          <button
            onClick={() => setPanel('files')}
            title="Show file explorer"
            className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-brand border border-white/10 transition-colors"
          >
            <FolderTree size={15} />
          </button>
          <button
            onClick={() => setPanel('todo')}
            title={openHere > 0 ? `${openHere} open task${openHere > 1 ? 's' : ''}` : 'Show to-do list'}
            className="relative p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-brand border border-white/10 transition-colors"
          >
            <ListTodo size={15} />
            {openHere > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-brand text-[9px] font-bold leading-[14px] text-white tabular-nums">
                {openHere}
              </span>
            )}
          </button>
        </div>
      )}

      {projectPath && panel === 'files' && (
        <FileExplorer projectPath={projectPath} onClose={() => setPanel(null)} />
      )}

      {projectPath && panel === 'todo' && (
        <WorkspaceTodo projectPath={projectPath} onClose={() => setPanel(null)} />
      )}
    </div>
  );
}
