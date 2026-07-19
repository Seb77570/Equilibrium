'use client';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '@/app/store/workspaceStore';

interface Project {
  name: string;
  path: string;
  port?: number;
}

interface PortMonitorProps {
  projects: Project[];
}

export default function PortMonitor({ projects }: PortMonitorProps) {
  const { setProjectStatus } = useWorkspaceStore();

  useEffect(() => {
    if (!projects.length) return;

    const checkAllPorts = async () => {
      const promises = projects.map(async (project) => {
        if (!project.port) {
          setProjectStatus(project.path, false);
          return;
        }
        try {
          const active = await invoke<boolean>('is_port_open', { port: project.port });
          setProjectStatus(project.path, active);
        } catch (err) {
          setProjectStatus(project.path, false);
        }
      });
      await Promise.all(promises);
    };

    checkAllPorts();
    const interval = setInterval(checkAllPorts, 3000);
    return () => clearInterval(interval);
  }, [projects, setProjectStatus]);

  return null; // This component doesn't render anything
}
