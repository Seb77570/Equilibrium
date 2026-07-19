'use client';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { LayoutNode, Workspace } from '@/app/store/workspaceStore';
import TabPane from './TabPane';

interface SplitLayoutProps {
  node: LayoutNode;
  workspaceId: string;
  metadata?: Workspace['metadata'];
}

export default function SplitLayout({ node, workspaceId, metadata }: SplitLayoutProps) {
  // Leaf pane — render the tab content directly
  if (node.type === 'pane') {
    return (
      <TabPane
        paneId={node.id}
        tabIds={node.tabIds}
        activeTabId={node.activeTabId}
        workspaceId={workspaceId}
        metadata={metadata}
      />
    );
  }

  // Split node — render resizable panels.
  // v4 API: Group takes `orientation`, and Panel `defaultSize` numbers are
  // interpreted as PIXELS — sizes must be passed as percentage strings.
  return (
    <Group orientation={node.direction} className="h-full w-full">
      {node.children.flatMap((child, index) => {
        const isLast = index === node.children.length - 1;
        const sizePct = node.sizes?.[index] ?? 100 / node.children.length;

        const panel = (
          <Panel
            key={child.id}
            defaultSize={`${sizePct}%`}
            minSize="8%"
          >
            <div className="h-full w-full overflow-hidden">
              <SplitLayout node={child} workspaceId={workspaceId} metadata={metadata} />
            </div>
          </Panel>
        );

        if (isLast) return [panel];

        const handle = (
          <Separator
            key={`${child.id}-handle`}
            className={
              node.direction === 'horizontal'
                ? 'w-[2px] cursor-col-resize bg-white hover:bg-sky-400 transition-colors'
                : 'h-[2px] cursor-row-resize bg-white hover:bg-sky-400 transition-colors'
            }
          />
        );

        return [panel, handle];
      })}
    </Group>
  );
}
