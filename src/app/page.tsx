'use client';

import { useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import { useWorkspaceStore } from "@/app/store/workspaceStore";
import ProjectCard from "@/components/ProjectCard";
import SettingsView from "@/components/SettingsView";
import TodoView from "@/components/TodoView";
import TimeView from "@/components/TimeView";
import WorkspaceView from "@/components/Workspace/WorkspaceView";
import PortMonitor from "@/components/PortMonitor";
import FullscreenToggle from "@/components/FullscreenToggle";
import { useTimeTracker } from "@/app/store/timeStore";
import { SortableProject } from "@/components/SortableProject";
import DetachedTabView from "@/components/DetachedTabView";
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { TabConfig } from "@/app/store/workspaceStore";
import { Plus, Trash2, Settings, FolderPlus } from "lucide-react";
import { 
  DndContext, 
  closestCenter, 
  KeyboardSensor, 
  PointerSensor, 
  useSensor, 
  useSensors,
  DragEndEvent,
  useDroppable,
  DragOverlay,
  DragStartEvent,
  DragOverEvent,
} from '@dnd-kit/core';
import { 
  arrayMove, 
  SortableContext, 
  sortableKeyboardCoordinates, 
  rectSortingStrategy
} from '@dnd-kit/sortable';

interface Project {
  name: string;
  path: string;
  project_type: string;
  description?: string;
  port?: number;
  dev_command?: string;
  instructions?: string;
  install_path?: string;
  executable_path?: string;
  claude_env?: string;
  links?: {
    github?: string;
    vercel?: string;
    aws?: string;
    other?: string[];
  };
}

interface ProjectSection {
  id: string;
  title: string;
  color: string;
  project_paths: string[];
}

interface DashboardConfig {
  sections: ProjectSection[];
}

// Entry-point dispatcher. Detached tab windows load the same static bundle
// as the main window — we tell them apart by the Tauri window LABEL.
// The main window's label is "main" (set in tauri.conf.json); detached
// windows use unique labels prefixed with "detached-". Anything other than
// exactly "main" is treated as a detached window.
export default function Home() {
  const [route, setRoute] = useState<'detached' | 'main' | null>(null);
  const [debugInfo, setDebugInfo] = useState<string>('detecting window...');

  useEffect(() => {
    let label = '<unknown>';
    let detection: 'tauri' | 'fallback' = 'tauri';
    try {
      label = getCurrentWindow().label;
    } catch (err) {
      detection = 'fallback';
      console.error('[Home] getCurrentWindow failed:', err);
      label = 'main'; // default to main if Tauri APIs aren't available
    }
    const next = label === 'main' ? 'main' : 'detached';
    console.log(`[Home] window label="${label}" detection=${detection} → route=${next}`);
    setDebugInfo(`label="${label}" → ${next}`);
    setRoute(next);
  }, []);

  if (route === null) {
    // Visible placeholder so a stuck dispatcher is obvious instead of
    // looking like a blank window. If you ever see this hang, the useEffect
    // above didn't run or threw silently.
    return (
      <div style={{
        padding: 20,
        color: 'white',
        background: '#0f1016',
        height: '100vh',
        fontFamily: 'monospace',
        fontSize: 12,
      }}>
        Equilibrium — initialising window… ({debugInfo})
      </div>
    );
  }
  return route === 'detached' ? <DetachedTabView /> : <MainDashboard />;
}

function MainDashboard() {
  const { activeView, setActiveView, addTab } = useWorkspaceStore();

  // Boots the time-tracking subsystem: loads persisted entries, attaches
  // activity listeners on the window for the 5-min idle auto-stop, and
  // installs the once-per-minute on-disk checkpoint of running entries so
  // a crashed app loses ≤60s of an in-progress session.
  useTimeTracker();

  // Listen for reattach events from detached windows.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ workspace_id: string; pane_id: string; tab_json: string }>(
      'tab-reattached',
      (event) => {
        try {
          const tab = JSON.parse(event.payload.tab_json) as TabConfig;
          addTab(event.payload.workspace_id, tab, event.payload.pane_id);
          useWorkspaceStore.getState().setActiveWorkspace(event.payload.workspace_id);
          useWorkspaceStore.getState().setActiveView('workspaces');
        } catch (err) {
          console.error('Failed to reattach tab:', err);
        }
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [addTab]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Avoid accidental drags on clicks
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchProjects = async () => {
    try {
      const [fetchedProjects, fetchedConfig] = await Promise.all([
        invoke<Project[]>('get_projects'),
        invoke<DashboardConfig>('get_dashboard_config')
      ]);
      
      setProjects(fetchedProjects);
      
      // If config is empty (first run), populate it with discovered projects
      if (fetchedConfig.sections.length === 1 && fetchedConfig.sections[0].project_paths.length === 0) {
        fetchedConfig.sections[0].project_paths = fetchedProjects.map(p => p.path);
        await invoke('save_dashboard_config', { config: fetchedConfig });
      }
      
      setConfig(fetchedConfig);
    } catch (error) {
      console.error('Failed to update dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  // --- Add a project by folder path (native picker or pasted path) ---
  const [showAddPath, setShowAddPath] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [adding, setAdding] = useState(false);

  const addProjectByPath = async (rawPath: string) => {
    const path = rawPath.trim().replace(/^["']|["']$/g, "");
    if (!path || adding) return;
    setAdding(true);
    try {
      const project = await invoke<Project>('add_project', { path });
      // Drop it into the first section so it shows up immediately. On the very
      // first run config is null and fetchProjects() auto-populates instead.
      if (config && config.sections.length > 0) {
        const sections = config.sections.map((s, i) =>
          i === 0 ? { ...s, project_paths: [...s.project_paths, project.path] } : s
        );
        await invoke('save_dashboard_config', { config: { ...config, sections } });
      }
      setAddPath("");
      setShowAddPath(false);
      await fetchProjects();
    } catch (e) {
      alert('Could not add project: ' + e);
    } finally {
      setAdding(false);
    }
  };

  const browseForProject = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: 'Select a project folder' });
      if (typeof selected === 'string') {
        await addProjectByPath(selected);
      }
    } catch (e) {
      console.error('Folder picker failed:', e);
    }
  };

  const saveConfig = async (newConfig: DashboardConfig) => {
    try {
      await invoke('save_dashboard_config', { config: newConfig });
    } catch (err) {
      console.error('Failed to save configuration:', err);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !config) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    // Find the containers
    const activeSection = config.sections.find(s => s.project_paths.includes(activeId));
    // Check if dropping on a section header or an item inside a section
    const overSection = config.sections.find(s => s.id === overId || s.project_paths.includes(overId));

    if (!overSection) return; // Dropped outside or on Uncategorized (not yet droppable)

    if (activeSection?.id !== overSection.id) {
      const newSections = config.sections.map(s => {
        if (activeSection && s.id === activeSection.id) {
          return { ...s, project_paths: s.project_paths.filter(id => id !== activeId) };
        }
        if (s.id === overSection.id) {
          const overIndex = s.project_paths.indexOf(overId);
          const newIndex = overIndex >= 0 ? overIndex : s.project_paths.length;
          // Avoid duplicates if already moved
          if (s.project_paths.includes(activeId)) return s;
          const newPaths = [...s.project_paths];
          newPaths.splice(newIndex, 0, activeId);
          return { ...s, project_paths: newPaths };
        }
        return s;
      });

      setConfig({ ...config, sections: newSections });
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveProject(null);

    if (!over || !config) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Determination of target section/container
    const overSection = config.sections.find(s => s.id === overId || s.project_paths.includes(overId));
    
    if (overSection) {
      // If we are dropping on an item in the same section, we might need a final sort
      // but usually DragOver + SortableContext handles this. 
      // We just need to persist the CURRENT state of config.sections.
      await saveConfig(config);
    }
  };

  const createSection = async () => {
    if (!config) return;
    const title = prompt("Section Name:");
    if (!title) return;

    const newSection: ProjectSection = {
      id: `section-${Date.now()}`,
      title,
      color: "#3b82f6", // Default blue
      project_paths: [],
    };

    const newConfig = { ...config, sections: [...config.sections, newSection] };
    setConfig(newConfig);
    await saveConfig(newConfig);
  };

  const deleteSection = async (sectionId: string) => {
    if (!config || sectionId === 'default') return;
    
    const newSections = config.sections.filter(s => s.id !== sectionId);
    const newConfig = { ...config, sections: newSections };
    setConfig(newConfig);
    await saveConfig(newConfig);
  };

  const renameSection = async (sectionId: string, currentTitle: string) => {
    if (!config) return;
    const newTitle = prompt("Rename Section:", currentTitle);
    if (!newTitle) return;

    const newSections = config.sections.map(s => 
      s.id === sectionId ? { ...s, title: newTitle } : s
    );
    const newConfig = { ...config, sections: newSections };
    setConfig(newConfig);
    await saveConfig(newConfig);
  };

  const changeSectionColor = async (sectionId: string) => {
    if (!config) return;
    const colors = [
      "#3b82f6", // Blue
      "#8b5cf6", // Purple
      "#ec4899", // Pink
      "#ef4444", // Red
      "#f59e0b", // Amber
      "#10b981", // Emerald
      "#06b6d4"  // Cyan
    ];
    
    const section = config.sections.find(s => s.id === sectionId);
    if (!section) return;
    
    const currentIndex = colors.indexOf(section.color);
    const nextIndex = (currentIndex + 1) % colors.length;
    const nextColor = colors[nextIndex];

    const newSections = config.sections.map(s => 
      s.id === sectionId ? { ...s, color: nextColor } : s
    );
    const newConfig = { ...config, sections: newSections };
    setConfig(newConfig);
    await saveConfig(newConfig);
  };

  // Helper to get projects for a specific section
  const getProjectsForSection = (section: ProjectSection) => {
    return section.project_paths
      .map(path => projects.find(p => p.path === path))
      .filter((p): p is Project => p !== undefined);
  };

  // Helper for projects not in any section
  const getUncategorizedProjects = () => {
    const categorizedPaths = new Set(config?.sections.flatMap(s => s.project_paths) || []);
    return projects.filter(p => !categorizedPaths.has(p.path));
  };

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-base">
      <PortMonitor projects={projects} />
      <FullscreenToggle />
      <Sidebar activeView={activeView} onNavigate={setActiveView} />
      
      <div className="flex-1 relative">
        <div className={`absolute inset-0 p-8 overflow-y-auto transition-opacity duration-300 ${activeView === 'settings' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <SettingsView />
        </div>

        <div className={`absolute inset-0 p-8 overflow-y-auto transition-opacity duration-300 ${activeView === 'todo' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <TodoView />
        </div>

        <div className={`absolute inset-0 p-8 overflow-y-auto transition-opacity duration-300 ${activeView === 'time' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <TimeView />
        </div>

        <div className={`absolute inset-0 flex transition-opacity duration-300 ${activeView === 'workspaces' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <WorkspaceView />
        </div>

        <div className={`absolute inset-0 p-8 overflow-y-auto transition-opacity duration-300 ${activeView === 'dashboard' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <header className="mb-12 flex justify-between items-end">
            <div>
              <div className="flex items-center gap-4 mb-2">
                <h1 className="text-4xl font-bold gradient-text tracking-tight">Equilibrium</h1>
                <button
                  onClick={() => setActiveView('settings')}
                  className="p-2 text-ink-faint hover:text-ink hover:bg-surface-raised rounded-lg transition-all"
                  title="Settings"
                >
                  <Settings size={24} />
                </button>
              </div>
              <p className="text-ink-dim font-medium tracking-wide flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-alive animate-pulse" />
                Manage your projects with elegance.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={browseForProject}
                disabled={adding}
                className="flex items-center gap-2 px-4 py-2 bg-alive hover:brightness-110 text-[#06210f] font-medium rounded-md transition-all disabled:opacity-50 shadow-lg shadow-alive/20"
                title="Pick a folder to add as a project"
              >
                <FolderPlus size={18} />
                <span>{adding ? 'Adding…' : 'Add Project'}</span>
              </button>
              <button
                onClick={() => setShowAddPath(v => !v)}
                className={`px-3 py-2 border rounded-md transition-colors text-sm ${showAddPath ? 'bg-surface-hi text-ink border-line' : 'bg-surface-raised hover:bg-surface-hi text-ink-dim border-line'}`}
                title="Add by pasting a path instead"
              >
                Paste path
              </button>
              <button
                onClick={createSection}
                className="flex items-center gap-2 px-4 py-2 bg-surface-raised hover:bg-surface-hi text-ink-dim border border-line rounded-md transition-colors"
              >
                <Plus size={18} />
                <span>New Section</span>
              </button>
            </div>
          </header>

          {showAddPath && (
            <div className="flex items-center gap-2 mb-8 animate-in fade-in slide-in-from-top-2 duration-300">
              <input
                type="text"
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addProjectByPath(addPath); }}
                placeholder="C:\Path\To\Your\Project"
                autoFocus
                className="flex-1 bg-white/5 border border-white/10 rounded-md px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand/40 transition-colors font-mono"
              />
              <button
                onClick={() => addProjectByPath(addPath)}
                disabled={adding || !addPath.trim()}
                className="px-5 py-2.5 bg-brand hover:bg-brand-light text-white rounded-md transition-colors disabled:opacity-40 text-sm font-bold"
              >
                Add
              </button>
            </div>
          )}

          <DndContext 
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={(event: DragStartEvent) => {
              const id = event.active.id as string;
              setActiveId(id);
              setActiveProject(projects.find(p => p.path === id) || null);
            }}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              setActiveId(null);
              setActiveProject(null);
            }}
          >
            <section className="space-y-12">
              {loading ? (
                <div className="py-20 text-center text-white/30 italic animate-pulse">
                  Loading projects...
                </div>
              ) : projects.length > 0 ? (
                <>
                  {config?.sections.map((section) => {
                    const sectionProjects = getProjectsForSection(section);
                    
                    return (
                      <div key={section.id} className="space-y-6">
                        <div className="flex justify-between items-center group/section">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => changeSectionColor(section.id)}
                              className="w-4 h-4 rounded-full border border-white/10 transition-transform hover:scale-125 shadow-lg shadow-black/50"
                              style={{ backgroundColor: section.color }}
                              title="Change Section Color"
                            />
                            <h2 
                              className="text-xl font-semibold px-1 cursor-pointer transition-colors"
                              style={{ color: section.id === 'default' ? '#fff' : `${section.color}cc` }}
                              onClick={() => renameSection(section.id, section.title)}
                            >
                              {section.title}
                            </h2>
                          </div>
                          {section.id !== 'default' && (
                            <button 
                              onClick={() => deleteSection(section.id)}
                              className="p-2 text-white/20 hover:text-red-400 opacity-0 group-hover/section:opacity-100 transition-all font-mono text-[10px] uppercase font-bold"
                              title="Delete Section"
                            >
                               Remove
                            </button>
                          )}
                        </div>
                        <SortableContext 
                          items={section.project_paths}
                          strategy={rectSortingStrategy}
                        >
                          <DroppableSection 
                            id={section.id} 
                            sectionProjects={sectionProjects} 
                            activeId={activeId} 
                            onUpdate={fetchProjects}
                            color={section.color}
                          />
                        </SortableContext>
                      </div>
                    );
                  })}
                  
                  {/* Uncategorized Section */}
                  {getUncategorizedProjects().length > 0 && (
                    <div className="space-y-6">
                      <h2 className="text-xl font-semibold text-white/70 px-1">
                        {config?.sections.length === 1 && config.sections[0].project_paths.length === 0 
                          ? "Discovered Projects" 
                          : "Uncategorized"}
                      </h2>
                      <SortableContext items={getUncategorizedProjects().map(p => p.path)} strategy={rectSortingStrategy}>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(560px,1fr))] gap-6">
                          {getUncategorizedProjects().map((project) => (
                            <SortableProject key={project.path} id={project.path}>
                              <ProjectCard 
                                name={project.name} 
                                project_type={project.project_type} 
                                description={project.description} 
                                port={project.port}
                                path={project.path}
                                dev_command={project.dev_command}
                                instructions={project.instructions}
                                install_path={project.install_path}
                                executable_path={project.executable_path}
                                claude_env={project.claude_env}
                                links={project.links}
                                isDragging={activeId === project.path}
                                onUpdate={fetchProjects}
                              />
                            </SortableProject>
                          ))}
                        </div>
                      </SortableContext>
                    </div>
                  )}
                </>
              ) : (
                <div className="py-20 text-center text-white/30 italic">
                  No projects yet — click <span className="text-brand not-italic font-semibold">Add Project</span> to pick a folder.
                </div>
              )}
            </section>

            <DragOverlay>
              {activeProject ? (
                <div className="w-[560px] scale-105 shadow-2xl shadow-black/50 pointer-events-none rotate-2 origin-center">
                  <ProjectCard 
                    name={activeProject.name} 
                    project_type={activeProject.project_type} 
                    description={activeProject.description} 
                    port={activeProject.port}
                    path={activeProject.path}
                    dev_command={activeProject.dev_command}
                    instructions={activeProject.instructions}
                    install_path={activeProject.install_path}
                    executable_path={activeProject.executable_path}
                    claude_env={activeProject.claude_env}
                    links={activeProject.links}
                    isDragging={true}
                    onUpdate={fetchProjects}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>
    </main>
  );
}

function DroppableSection({ id, sectionProjects, activeId, onUpdate, color }: { id: string, sectionProjects: Project[], activeId: string | null, onUpdate: () => void, color?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  
  return (
    <div 
      ref={setNodeRef}
      className={`grid grid-cols-[repeat(auto-fill,minmax(560px,1fr))] gap-6 min-h-[140px] border-2 border-dashed transition-all duration-500 p-3 rounded-[10px] ${
        isOver ? 'shadow-inner' : 'border-transparent'
      } ${sectionProjects.length === 0 ? 'border-white/5 flex items-center justify-center bg-white/[0.02]' : ''}`}
      style={{ 
        borderColor: isOver ? `${color}44` : 'transparent',
        backgroundColor: isOver ? `${color}08` : undefined
      }}
    >
      {sectionProjects.length > 0 ? (
        sectionProjects.map((project) => (
          <SortableProject key={project.path} id={project.path}>
            <ProjectCard 
              name={project.name} 
              project_type={project.project_type} 
              description={project.description} 
              port={project.port}
              path={project.path}
              dev_command={project.dev_command}
              instructions={project.instructions}
              install_path={project.install_path}
              executable_path={project.executable_path}
              claude_env={project.claude_env}
              links={project.links}
              isDragging={activeId === project.path}
              onUpdate={onUpdate}
              accentColor={color}
            />
          </SortableProject>
        ))
      ) : (
        <div className="flex flex-col items-center gap-2 text-white/5 italic text-sm py-10 uppercase tracking-[0.2em] font-bold">
          <Plus size={24} className="opacity-20" />
          <span>Drop projects here</span>
        </div>
      )}
    </div>
  );
}
