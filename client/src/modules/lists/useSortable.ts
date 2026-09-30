// Tiny pointer-based sortable for a vertical list (mouse + touch), with auto-scroll.
// Items register their element; a drag handle starts the drag. Other rows slide out of the way
// with CSS transforms; on drop `onReorder(newIds)` is called with the group's new order.
import { useCallback, useEffect, useRef, useState } from 'react';

interface DragState {
  id: number;
  pointerId: number;
  startY: number;
  startScroll: number;
  from: number;
  to: number;
  rects: DOMRect[];
  ids: number[];
  height: number;
}

export function useSortable(ids: number[], onReorder: (ids: number[]) => void) {
  const els = useRef(new Map<number, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  const lastY = useRef(0);
  const raf = useRef(0);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const register = useCallback(
    (id: number) => (el: HTMLElement | null) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    [],
  );

  const layout = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    const dy = lastY.current - d.startY + (window.scrollY - d.startScroll);
    const center = d.rects[d.from].top + d.rects[d.from].height / 2 + dy;
    let to = d.from;
    for (let i = 0; i < d.rects.length; i++) {
      const mid = d.rects[i].top + d.rects[i].height / 2;
      if (i < d.from && center < mid) { to = i; break; }
      if (i > d.from && center > mid) to = i;
    }
    d.to = to;
    d.ids.forEach((id, i) => {
      const el = els.current.get(id);
      if (!el) return;
      if (id === d.id) {
        el.style.transform = `translateY(${dy}px) scale(1.02)`;
        return;
      }
      let shift = 0;
      if (d.from < to && i > d.from && i <= to) shift = -d.height;
      if (d.from > to && i < d.from && i >= to) shift = d.height;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }, []);

  const tick = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    const edge = 80;
    const vh = window.innerHeight;
    let speed = 0;
    if (lastY.current < edge + 60) speed = -Math.ceil((edge + 60 - lastY.current) / 6);
    else if (lastY.current > vh - edge - 70) speed = Math.ceil((lastY.current - (vh - edge - 70)) / 6);
    if (speed) {
      window.scrollBy(0, speed);
      layout();
    }
    raf.current = requestAnimationFrame(tick);
  }, [layout]);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const d = drag.current;
    if (d) {
      for (const id of d.ids) {
        const el = els.current.get(id);
        if (el) {
          el.style.transform = '';
          el.style.transition = '';
          el.style.zIndex = '';
          el.style.position = '';
        }
      }
    }
    drag.current = null;
    setDraggingId(null);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const handleProps = useCallback(
    (id: number) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const list = idsRef.current;
        const from = list.indexOf(id);
        if (from < 0) return;
        const rects = list.map((x) => els.current.get(x)?.getBoundingClientRect() ?? new DOMRect());
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const gap = rects.length > 1 ? Math.max(0, (rects[1]?.top ?? 0) - (rects[0]?.bottom ?? 0)) : 0;
        drag.current = { id, pointerId: e.pointerId, startY: e.clientY, startScroll: window.scrollY, from, to: from, rects, ids: list, height: rects[from].height + gap };
        lastY.current = e.clientY;
        for (const x of list) {
          const el = els.current.get(x);
          if (!el) continue;
          el.style.transition = x === id ? 'box-shadow 150ms' : 'transform 180ms cubic-bezier(0.2,0.9,0.3,1)';
          if (x === id) {
            el.style.position = 'relative';
            el.style.zIndex = '20';
          }
        }
        setDraggingId(id);
        raf.current = requestAnimationFrame(tick);
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        if (!drag.current || drag.current.pointerId !== e.pointerId) return;
        lastY.current = e.clientY;
        layout();
      },
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const { from, to, ids: list } = d;
        cleanup();
        if (from !== to) {
          const next = [...list];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          onReorderRef.current(next);
        }
      },
      onPointerCancel: () => cleanup(),
      style: { touchAction: 'none' as const },
    }),
    [cleanup, layout, tick],
  );

  /** Keyboard reorder: returns the new order when moving `id` by `delta`, or null at the ends. */
  const moveBy = useCallback((id: number, delta: number): number[] | null => {
    const list = idsRef.current;
    const from = list.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return null;
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, id);
    onReorderRef.current(next);
    return next;
  }, []);

  return { register, handleProps, draggingId, moveBy };
}
