import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import { CERTAINTY, KIND_LABEL, NODE_H, NODE_W, TYPE_META, healthOf, layoutMap } from '../../lib/servicemap';
import type { MapDirection } from '../../lib/servicemap';
import type { MapItem, MapLink } from '../../lib/servicemap';

/**
 * The service map as a graph: tiered left to right (entry points, services, data,
 * machines), pan by dragging, zoom with the wheel or the buttons. How sure each
 * entry is shows in its line: solid = confirmed, dashed = documented only, dotted =
 * seen live but not documented, faint = not seen lately. A red dashed link is a
 * documented connection a scan did not find.
 */

export interface Highlight {
  /** Shown at full strength; everything else is dimmed. */
  ids: Set<string>;
  tone: 'focus' | 'impact' | 'deps' | 'search';
}

/** Below this, names are too small to read: the map pans instead. */
const MIN_READABLE = 0.62;
const MAX_DOWN_H = 960;

/** A curve between two nodes, leaving and entering along the layout's direction. */
function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, direction: MapDirection): string {
  // Across layers the edge follows the direction; within a layer it goes the other way.
  if (direction === 'right' ? b.x !== a.x : b.y === a.y) {
    // Horizontal: side to side.
    const back = b.x < a.x;
    const x1 = back ? a.x : a.x + NODE_W;
    const x2 = back ? b.x + NODE_W : b.x;
    const y1 = a.y + NODE_H / 2;
    const y2 = b.y + NODE_H / 2;
    const mid = Math.max(40, Math.abs(x2 - x1) / 2) * (back ? -1 : 1);
    return `M${x1},${y1} C${x1 + mid},${y1} ${x2 - mid},${y2} ${x2},${y2}`;
  }
  // Vertical: bottom to top (or top to bottom going back up).
  const up = b.y < a.y;
  const x1 = a.x + NODE_W / 2;
  const x2 = b.x + NODE_W / 2;
  const y1 = up ? a.y : a.y + NODE_H;
  const y2 = up ? b.y + NODE_H : b.y;
  const mid = Math.max(30, Math.abs(y2 - y1) / 2) * (up ? -1 : 1);
  return `M${x1},${y1} C${x1},${y1 + mid} ${x2},${y2 - mid} ${x2},${y2}`;
}

const HEALTH_DOT: Record<string, string> = { down: 'rgb(var(--red))', degraded: 'rgb(var(--amber))', ok: 'rgb(var(--green))', unknown: 'transparent' };

export function MapGraph({
  items, links, selected, onSelect, highlight, height = 520,
}: {
  items: MapItem[];
  links: MapLink[];
  selected: { kind: 'item' | 'link'; id: string } | null;
  onSelect: (s: { kind: 'item' | 'link'; id: string } | null) => void;
  highlight: Highlight | null;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Left to right when it fits readably; top to bottom in a narrow panel or on a phone.
  const { pos, width, height: contentH, direction } = useMemo(() => {
    const right = layoutMap(items, links, 'right');
    if (!boxW || (boxW - 48) / right.width >= MIN_READABLE) return { ...right, direction: 'right' as const };
    return { ...layoutMap(items, links, 'down'), direction: 'down' as const };
  }, [items, links, boxW]);
  // Downward, the map fills the width at a readable size and the panel grows to hold it.
  const downK = Math.min(1.1, Math.max(MIN_READABLE, (boxW - 48) / Math.max(width, 1)));
  const boxH = direction === 'down' ? Math.max(360, Math.min(MAX_DOWN_H, contentH * downK + 72)) : height;
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const fit = () => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    // Never shrink below readable: a bigger map starts at its beginning and pans.
    const k = direction === 'down' ? downK : Math.min(1.2, Math.max(MIN_READABLE, Math.min((w - 48) / Math.max(width, 1), (h - 48) / Math.max(contentH, 1))));
    const x = width * k <= w - 48 ? (w - width * k) / 2 : 24;
    const y = contentH * k <= h - 48 ? (h - contentH * k) / 2 : 24;
    setView({ k, x, y });
  };
  // Fit when the map's shape changes, not on every refresh.
  useEffect(fit, [width, contentH, boxH, downK]);

  const zoom = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * factor));
      const el = box.current;
      const px = cx ?? (el ? el.clientWidth / 2 : 0);
      const py = cy ?? (el ? el.clientHeight / 2 : 0);
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });

  const dim = (id: string) => !!highlight && !highlight.ids.has(id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const tone = highlight?.tone === 'impact' ? 'rgb(var(--red))' : highlight?.tone === 'deps' ? 'rgb(var(--blue))' : 'rgb(var(--blue))';

  return (
    <div
      ref={box}
      className="relative overflow-hidden rounded-inner border border-hairline bg-ground/40"
      style={{ height: boxH }}
      onWheel={(e) => {
        const r = box.current!.getBoundingClientRect();
        zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      }}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button')) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) {
          // Only a real drag takes the pointer, so a click still reaches a node.
          d.moved = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
        if (d.moved) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        // A click on empty space clears the selection.
        if (d && !d.moved && (e.target as Element).tagName === 'svg') onSelect(null);
      }}
    >
      <svg className="h-full w-full touch-none select-none" role="img" aria-label={`Service map: ${items.length} components, ${links.length} links`}>
        <defs>
          {['muted', 'red', 'blue', 'amber'].map((c) => (
            <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={`rgb(var(--${c}))`} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map((l) => {
            const a = pos.get(l.fromId);
            const b = pos.get(l.toId);
            if (!a || !b) return null;
            const d = edgePath(a, b, direction);
            const c = CERTAINTY[l.confidence.certainty];
            const drift = l.confidence.drift === 'not_seen';
            const isSel = selected?.kind === 'link' && selected.id === l.id;
            const lit = highlight ? highlight.ids.has(l.id) : false;
            const color = drift ? 'rgb(var(--red))' : lit ? tone : isSel ? 'rgb(var(--blue))' : l.kind === 'monitors' ? 'rgb(var(--violet))' : 'rgb(var(--muted))';
            const marker = drift ? 'red' : lit || isSel ? 'blue' : 'muted';
            return (
              <g key={l.id} opacity={highlight && !lit ? 0.12 : c.opacity} className="cursor-pointer" onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'link', id: l.id }); }}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
                <path d={d} fill="none" stroke={color} strokeWidth={isSel || lit ? 2.2 : l.kind === 'runs_on' || l.kind === 'monitors' ? 1 : 1.5} strokeDasharray={drift ? '6 4' : c.dash} markerEnd={`url(#arrow-${marker})`} />
                {(isSel || lit) && (
                  <text x={(a.x + b.x + NODE_W) / 2} y={(a.y + b.y + NODE_H) / 2 - 6} textAnchor="middle" className="fill-ink text-[10px]" style={{ paintOrder: 'stroke', stroke: 'rgb(var(--ground))', strokeWidth: 3 }}>
                    {KIND_LABEL[l.kind]}
                  </text>
                )}
              </g>
            );
          })}
          {items.map((i) => {
            const p = pos.get(i.id);
            if (!p) return null;
            const meta = TYPE_META[i.type];
            const Icon = meta.icon;
            const c = CERTAINTY[i.confidence.certainty];
            const isSel = selected?.kind === 'item' && selected.id === i.id;
            const lit = highlight?.ids.has(i.id);
            const health = healthOf(i);
            return (
              <g
                key={i.id}
                transform={`translate(${p.x},${p.y})`}
                opacity={dim(i.id) ? 0.18 : c.opacity}
                className="cursor-pointer"
                onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'item', id: i.id }); }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  fill="rgb(var(--tile))"
                  stroke={isSel ? 'rgb(var(--blue))' : lit && highlight?.tone !== 'search' ? tone : health === 'down' ? 'rgb(var(--red))' : 'rgb(var(--edge))'}
                  strokeWidth={isSel || lit ? 2 : 1.2}
                  strokeDasharray={c.dash}
                />
                <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={meta.color} opacity={0.9} />
                <Icon x={12} y={14} width={17} height={17} color={meta.color} strokeWidth={2} />
                <text x={38} y={20} className="fill-ink text-[12px] font-medium">{i.name.length > 19 ? `${i.name.slice(0, 18)}…` : i.name}</text>
                <text x={38} y={35} className="fill-muted text-[10px]">{meta.label}{i.env ? ` · ${i.env}` : ''}</text>
                {health !== 'unknown' && <circle cx={NODE_W - 12} cy={12} r={4.5} fill={HEALTH_DOT[health]} />}
                {i.confidence.drift && <circle cx={NODE_W - 12} cy={NODE_H - 12} r={3.5} fill={i.confidence.drift === 'not_seen' ? 'rgb(var(--red))' : 'rgb(var(--amber))'} />}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-inner border border-edge bg-tile/90 backdrop-blur">
        <button className="p-2 text-muted hover:text-ink" onClick={() => zoom(1.25)} aria-label="Zoom in"><Plus size={14} /></button>
        <button className="border-y border-hairline p-2 text-muted hover:text-ink" onClick={() => zoom(0.8)} aria-label="Zoom out"><Minus size={14} /></button>
        <button className="p-2 text-muted hover:text-ink" onClick={fit} aria-label="Show the whole map" title="Show the whole map"><LocateFixed size={14} /></button>
      </div>
      <Legend />
    </div>
  );
}

function Legend() {
  const row = (dash: string | undefined, color: string, label: string) => (
    <span className="flex items-center gap-1.5">
      <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="1.6" strokeDasharray={dash} /></svg>
      {label}
    </span>
  );
  return (
    <div className={clsx('absolute bottom-3 left-3 hidden flex-wrap items-center gap-x-3 gap-y-1 rounded-inner border border-edge bg-tile/90 px-2.5 py-1.5 text-[10px] text-muted backdrop-blur sm:flex')}>
      {row(undefined, 'rgb(var(--muted))', 'Confirmed')}
      {row('6 4', 'rgb(var(--muted))', 'Documented')}
      {row('6 4', 'rgb(var(--red))', 'Documented, not seen')}
    </div>
  );
}
