'use client';

import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface SortableProjectProps {
  id: string; // The project path
  children: React.ReactNode;
}

export function SortableProject({ id, children }: SortableProjectProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.3 : 1,
    cursor: 'grab',
  };

  return (
    <div 
      ref={setNodeRef} 
      style={style} 
      className="h-full"
    >
      {React.isValidElement(children) 
        ? React.cloneElement(children as React.ReactElement<any>, { 
            dragHandleProps: { ...attributes, ...listeners } 
          }) 
        : children}
    </div>
  );
}
