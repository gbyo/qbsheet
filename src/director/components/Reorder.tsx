import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from './Controls';
import { Icon } from './Icon';

/**
 * Explicit reorder mode.
 *
 * # Why not Up/Down buttons on every row
 *
 * Because they were on every row. Every round and every day event carried a
 * permanent pair of arrow buttons — chrome for an action a director takes when
 * they realise lunch is in the wrong place, which is roughly once. Between them
 * and the state toolbar there was no room left for the round itself.
 *
 * # How this works
 *
 * Reordering is a mode the operator enters deliberately from the section's
 * actions. Inside it, each item gets a grip and a pair of move controls; the
 * grip supports pointer drag, and the move controls give keyboard and
 * screen-reader users the same capability rather than a worse one. Changes
 * apply as they are made — this is an operation, not a form — and the mode has
 * an obvious way out.
 *
 * Every move is announced, because a silent reorder is invisible to anyone not
 * watching the list.
 */

export function useReorderMode() {
  const [active, setActive] = useState(false);
  return {
    active,
    enter: () => setActive(true),
    exit: () => setActive(false),
    toggle: () => setActive((c) => !c),
  };
}

export function ReorderToggle({
  active,
  onToggle,
  label = 'Reorder',
  disabled = false,
}: {
  active: boolean;
  onToggle: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={active ? 'primary' : 'quiet'}
      icon="sort"
      disabled={disabled}
      aria-pressed={active}
      onClick={onToggle}
    >
      {active ? 'Done reordering' : label}
    </Button>
  );
}

/**
 * The controls a single item shows while reorder mode is on.
 *
 * `onMove` receives a delta. The component renders the grip for pointer drag
 * and two buttons for everything else; both paths end in the same call, so the
 * keyboard route is not a lesser one.
 */
export function ReorderHandle({
  label,
  index,
  count,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  /** What is being moved, for the accessible names: "Round 4". */
  label: string;
  index: number;
  count: number;
  onMove: (delta: number) => void;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <div className="director-reorder-handle">
      <span
        className="director-reorder-grip"
        draggable
        role="presentation"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          // Firefox refuses to start a drag without payload.
          event.dataTransfer.setData('text/plain', String(index));
          onDragStart?.();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          onDragOver?.();
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDrop?.();
        }}
        onDragEnd={() => onDragEnd?.()}
      >
        <Icon name="drag" size={16} />
      </span>
      <IconButton
        icon="chevron"
        size="sm"
        className="director-reorder-up"
        label={`Move ${label} earlier`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <IconButton
        icon="chevron"
        size="sm"
        className="director-reorder-down"
        label={`Move ${label} later`}
        disabled={index >= count - 1}
        onClick={() => onMove(1)}
      />
      <span className="director-visually-hidden" role="status">
        {`Position ${index + 1} of ${count}`}
      </span>
    </div>
  );
}

/** The instruction line shown while reorder mode is on. */
export function ReorderNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="director-reorder-notice" role="status">
      <Icon name="sort" size={14} />
      {children ?? 'Drag an item, or use the move buttons. Changes apply as you make them.'}
    </p>
  );
}

/**
 * Drag bookkeeping for a reorderable list: which index is being dragged and
 * which it is currently over. The caller owns the actual move.
 */
export function useDragReorder(onReorder: (from: number, to: number) => void) {
  const from = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  useEffect(
    () => () => {
      from.current = null;
    },
    [],
  );
  return {
    overIndex: over,
    handlers: (index: number) => ({
      onDragStart: () => {
        from.current = index;
      },
      onDragOver: () => setOver(index),
      onDrop: () => {
        const source = from.current;
        if (source != null && source !== index) onReorder(source, index);
        from.current = null;
        setOver(null);
      },
      onDragEnd: () => {
        from.current = null;
        setOver(null);
      },
    }),
  };
}
