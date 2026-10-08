import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { FileCode2, ImageIcon, Upload, X } from 'lucide-react';
import { post } from '../../lib/api';
import { Spinner } from '../ui';

/**
 * An architecture diagram into the map: a picture, a draw.io file, or Mermaid /
 * PlantUML / Graphviz text. What it shows comes back as suggestions to review.
 */

const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.svg,.drawio,.xml,.mmd,.mermaid,.md,.puml,.plantuml,.iuml,.dot,.gv,.txt';
const MAX_SIDE = 2400;

interface Result {
  proposals: number;
  supported: number;
  components: number;
  connections: number;
  read: 'exactly' | 'by the model';
}

type Picked = { kind: 'image'; data: string; file: string } | { kind: 'text'; text: string; file: string };

/** A picture, scaled so the model sees it whole and the upload stays small. */
function rasterize(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((img.naturalWidth || 1200) * k));
      c.height = Math.max(1, Math.round((img.naturalHeight || 800) * k));
      const g = c.getContext('2d')!;
      // Transparent diagrams (SVG, many PNGs) on white, as they were drawn.
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      const png = c.toDataURL('image/png');
      resolve(png.length > 8_000_000 ? c.toDataURL('image/jpeg', 0.9) : png);
    };
    img.onerror = () => reject(new Error('That picture could not be opened.'));
    img.src = src;
  });
}

async function readFile(f: File): Promise<Picked> {
  const name = f.name.toLowerCase();
  if (f.size > 20 * 1024 * 1024) throw new Error('That file is larger than 20 MB.');
  if (/\.(png|jpe?g|webp|gif)$/.test(name) || /^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
    const url = URL.createObjectURL(f);
    try {
      return { kind: 'image', data: await rasterize(url), file: f.name };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const text = await f.text();
  if (name.endsWith('.svg') && !text.includes('mxfile')) {
    // A plain SVG is a picture; a draw.io SVG export carries the diagram itself and is read exactly.
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
      return { kind: 'image', data: await rasterize(url), file: f.name };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { kind: 'text', text, file: f.name };
}

const formatOf = (text: string) =>
  /mxfile|mxGraphModel/.test(text) ? 'draw.io' : /^\s*(flowchart|graph|C4\w*|architecture-beta)\b/m.test(text) ? 'Mermaid' : /@startuml/i.test(text) ? 'PlantUML' : /^\s*(strict\s+)?(di)?graph\b[^{]*\{/m.test(text) ? 'Graphviz' : 'text';

export function DiagramImport({ projectId, onDone }: { projectId: string; onDone: (msg: string) => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setReading(true);
    try {
      const p = await readFile(f);
      setPicked(p);
      setPasted('');
      if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const send = useMutation({
    mutationFn: () => {
      const body = picked?.kind === 'image' ? { image: picked.data } : { text: picked?.kind === 'text' ? picked.text : pasted };
      return post<Result>('/service-map/from-diagram', { projectId, name: name.trim() || picked?.file || 'Architecture diagram', ...body });
    },
    onSuccess: (r) => {
      const title = name.trim() || picked?.file || 'the diagram';
      onDone(
        `Read “${title}” ${r.read}: ${r.components} component${r.components === 1 ? '' : 's'} and ${r.connections} connection${r.connections === 1 ? '' : 's'}. ` +
          (r.proposals ? `${r.proposals} change${r.proposals === 1 ? '' : 's'} to review under Suggestions` : 'Nothing new for the map') +
          (r.supported ? `; ${r.supported} already on it and now backed by the diagram.` : '.'),
      );
    },
    onError: (e) => setError((e as Error).message),
  });

  const text = picked?.kind === 'text' ? picked.text : pasted;
  const ready = !!picked || pasted.trim().length > 10;
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-relaxed text-muted">
        A picture of your architecture (PNG, JPG, SVG), a draw.io file, or Mermaid, PlantUML or Graphviz text. A draw.io file is read exactly;
        anything else is read by the model. What it shows comes back as suggestions: nothing changes until you accept.
      </p>

      {picked ? (
        <div className="flex items-center gap-3 rounded-inner border border-hairline bg-tile-2/50 p-3">
          {picked.kind === 'image' ? (
            <img src={picked.data} alt="" className="h-16 w-24 shrink-0 rounded border border-hairline bg-white object-contain" />
          ) : (
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded border border-hairline bg-ground/60 text-cyan"><FileCode2 size={22} /></span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{picked.file}</p>
            <p className="text-[11.5px] text-muted">{picked.kind === 'image' ? 'A picture: read by the model' : `${formatOf(picked.text)}${formatOf(picked.text) === 'draw.io' ? ': read exactly' : ': read by the model'}`}</p>
          </div>
          <button className="btn-ghost !min-h-[30px] !px-2" onClick={() => setPicked(null)} aria-label="Choose another"><X size={14} /></button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files[0]); }}
            className={clsx('flex w-full flex-col items-center gap-2 rounded-inner border border-dashed px-4 py-7 text-center transition-colors', over ? 'border-blue bg-blue/10' : 'border-edge hover:border-blue/60 hover:bg-white/[0.02]')}
          >
            {reading ? <Spinner /> : <span className="flex gap-2 text-muted"><ImageIcon size={20} /><Upload size={20} /></span>}
            <span className="text-[13px] font-medium text-ink">Drop a diagram here, or choose a file</span>
            <span className="text-[11px] text-dim">PNG · JPG · SVG · draw.io · Mermaid · PlantUML · Graphviz</span>
          </button>
          <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ''; }} />
          <label className="block">
            <span className="label">Or paste the diagram's text</span>
            <textarea className="input min-h-[96px] font-mono text-[12px]" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'flowchart LR\n  lb[lb-1] --> web[web-1]\n  web --> db[(db-1)]'} />
          </label>
        </>
      )}

      <label className="block">
        <span className="label">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production architecture" maxLength={120} />
        <span className="mt-1 block text-[11px] text-dim">Importing a diagram with the same name again replaces what it said before.</span>
      </label>

      {error && <p className="text-xs text-red">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={!ready || send.isPending || reading} onClick={() => { setError(null); send.mutate(); }}>
          {send.isPending ? <Spinner /> : <FileCode2 size={14} />} {send.isPending ? (picked?.kind === 'image' || (text && formatOf(text) !== 'draw.io') ? 'Reading it with the model…' : 'Reading…') : 'Read diagram'}
        </button>
      </div>
    </div>
  );
}
