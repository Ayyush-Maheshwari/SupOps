import { repairMermaid } from '@supops/shared';

/**
 * Mermaid, loaded on first use. It is a large library and most pages never show a
 * diagram, so it stays out of the main bundle.
 *
 * Model output is untrusted, hence `securityLevel: 'strict'` (labels are sanitised,
 * click handlers and scripts are disabled) and `htmlLabels: false` (labels are plain
 * SVG text, no <foreignObject>). The latter also keeps the SVG drawable onto a canvas,
 * which is how diagrams reach the PDF.
 */
type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
const load = (): Promise<Mermaid> => (loading ??= import('mermaid').then((m) => m.default));

type Theme = 'dark' | 'light';

const THEMES: Record<Theme, Record<string, string>> = {
  // Matches the app's dark tiles and blue accent.
  dark: {
    background: 'transparent',
    primaryColor: '#1b1e28',
    primaryBorderColor: '#0a84ff',
    primaryTextColor: '#f5f5f7',
    secondaryColor: '#13151d',
    tertiaryColor: '#13151d',
    lineColor: '#8e8e96',
    textColor: '#f5f5f7',
    clusterBkg: '#13151d',
    clusterBorder: '#3a3f4d',
    edgeLabelBackground: '#13151d',
    titleColor: '#f5f5f7',
    nodeTextColor: '#f5f5f7',
  },
  // The PDF is a white page.
  light: {
    background: '#ffffff',
    primaryColor: '#eef4ff',
    primaryBorderColor: '#0a84ff',
    primaryTextColor: '#0f172a',
    secondaryColor: '#f5f7fb',
    tertiaryColor: '#f5f7fb',
    lineColor: '#64748b',
    textColor: '#0f172a',
    clusterBkg: '#f8fafc',
    clusterBorder: '#cbd5e1',
    edgeLabelBackground: '#ffffff',
    titleColor: '#0f172a',
    nodeTextColor: '#0f172a',
  },
};

// mermaid.initialize is global, so renders are serialised: a dark render for the
// page and a light one for the PDF must not interleave their configs.
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function configure(mermaid: Mermaid, theme: Theme): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // Without this a failed render appends Mermaid's own "Syntax error" bomb
    // graphic to <body>, where it stays for good.
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: { ...THEMES[theme], fontFamily: 'Inter, "Outfit Variable", system-ui, sans-serif', fontSize: '14px' },
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: 'basis', padding: 12 },
    sequence: { useMaxWidth: true },
  });
}

/** Does it parse? Checked before rendering, so a bad diagram never reaches the DOM. */
async function parses(mermaid: Mermaid, source: string): Promise<boolean> {
  try {
    return (await mermaid.parse(source, { suppressErrors: true })) !== false;
  } catch {
    return false;
  }
}

async function renderOnce(mermaid: Mermaid, source: string): Promise<string> {
  seq += 1;
  const id = `supops-diagram-${seq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // render() works in a temporary element on <body>; make sure none is left behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

export interface RenderedDiagram {
  svg: string;
  /** The source that actually rendered: the original, or the repaired version. */
  source: string;
  repaired: boolean;
}

/** Render a diagram, repairing common model mistakes if the original does not parse. */
export function renderDiagram(source: string, theme: Theme = 'dark'): Promise<RenderedDiagram> {
  const job = queue.then(async () => {
    const mermaid = await load();
    configure(mermaid, theme);
    if (await parses(mermaid, source)) return { svg: await renderOnce(mermaid, source), source, repaired: false };
    const fixed = repairMermaid(source);
    if (fixed !== source && (await parses(mermaid, fixed))) {
      return { svg: await renderOnce(mermaid, fixed), source: fixed, repaired: true };
    }
    // Neither version parses: surface Mermaid's message, without it drawing anything.
    try {
      await mermaid.parse(fixed);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    throw new Error('This diagram could not be drawn.');
  });
  queue = job.catch(() => undefined);
  return job;
}

/**
 * Rasterise a diagram for the PDF: light theme, 2x for print sharpness, white
 * background. Resolves null when it cannot render, and the PDF then prints the source.
 */
export async function diagramToPng(source: string, maxWidth = 1800): Promise<{ source: string; png: string } | null> {
  try {
    const { svg, source: used } = await renderDiagram(source, 'light');
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const el = doc.documentElement;
    const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const w0 = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 800;
    const h0 = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 600;
    const scale = Math.min(2, maxWidth / w0);
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    // An explicit size, or the browser draws it at 100% of nothing.
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.removeAttribute('style');
    const xml = new XMLSerializer().serializeToString(el);

    const img = new Image();
    img.decoding = 'async';
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { source: used, png: canvas.toDataURL('image/png') };
  } catch {
    return null;
  }
}
