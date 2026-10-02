import { useState } from 'react';
import { copyText } from '../lib/clipboard';
import { clsx } from 'clsx';
import { Check, Copy, FileDown, FileText } from 'lucide-react';
import { api, getToken } from '../lib/api';
import { extractMermaidBlocks, messageText } from '@supops/shared';
import { diagramToPng } from '../lib/mermaid';
import type { RunDetail } from '../lib/types';
import { Spinner } from './ui';

interface Report {
  filename: string;
  markdown: string;
}

/**
 * Copy and download the incident document.
 *
 * Both go through the same server-rendered Markdown so the file and the clipboard
 * are byte-identical -- the browser never assembles its own version, which is how
 * the two quietly drift apart. The download is fetched and turned into a blob rather
 * than linked directly, because the API needs an Authorization header that a plain
 * anchor cannot carry.
 */
export function ReportActions({ runId }: { runId: string }) {
  const [busy, setBusy] = useState<'copy' | 'pdf' | 'md' | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = () => api<Report>(`/runs/${runId}/report`);

  async function copy() {
    setBusy('copy');
    setError(null);
    try {
      const { markdown } = await fetchReport();
      if (!(await copyText(markdown))) throw new Error('clipboard blocked');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard access can be refused outright (permissions, insecure context),
      // and failing silently would look like the button does nothing.
      setError(
        err instanceof Error && /clipboard|denied|not allowed/i.test(err.message)
          ? 'Clipboard access was blocked by the browser. Use Download instead.'
          : err instanceof Error
            ? err.message
            : 'Could not copy the report',
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * Browsers flag every download from a plain-http page as insecure, and no header or
   * blob trick avoids it. Viewing is not a download, though: over http the report
   * opens in a new tab (the PDF viewer, or plain text) and is saved from there. Over
   * https or on localhost it downloads directly as usual.
   *
   * The tab is opened synchronously in the click handler, before the fetch, because a
   * window opened after an await counts as a popup and gets blocked.
   */
  const viewInstead = !window.isSecureContext;
  const openViewer = (): Window | null => {
    if (!viewInstead) return null;
    const win = window.open('', '_blank');
    if (win) win.document.title = 'Preparing report…';
    return win;
  };

  function deliver(win: Window | null, blob: Blob, filename: string) {
    if (!win) {
      saveBlob(blob, filename);
      return;
    }
    const url = URL.createObjectURL(blob);
    win.location.href = url;
    // The tab needs the URL for as long as it is loading; free it well after.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * The agent's diagrams as PNGs, for the PDF. Mermaid needs a browser, so they are
   * drawn here (light theme, print resolution) and sent with the request; one that
   * fails to render is simply left out and the PDF prints its source instead.
   */
  async function renderDiagrams(): Promise<Array<{ source: string; png: string }>> {
    const detail = await api<RunDetail>(`/runs/${runId}`);
    const sources = detail.steps
      .filter((s) => s.messageJson.role === 'assistant')
      .flatMap((s) => extractMermaidBlocks(messageText(s.messageJson.content)).map((b) => b.source));
    const out: Array<{ source: string; png: string }> = [];
    for (const src of [...new Set(sources)].slice(-8)) {
      const r = await diagramToPng(src);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * The PDF is rendered server-side, so it is fetched as bytes rather than built
   * here. A plain link cannot carry the Authorization header, hence the manual
   * fetch-then-blob rather than an <a href>.
   */
  async function downloadPdf() {
    const win = openViewer();
    setBusy('pdf');
    setError(null);
    try {
      const diagrams = await renderDiagrams().catch(() => []);
      const res = await fetch(`/api/runs/${runId}/report?format=pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagrams }),
      });
      if (!res.ok) throw new Error(`The server could not render the PDF (${res.status})`);

      const disposition = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `report-${runId}.pdf`;
      deliver(win, await res.blob(), name);
    } catch (err) {
      win?.close();
      setError(err instanceof Error ? err.message : 'Could not download the PDF');
    } finally {
      setBusy(null);
    }
  }

  async function downloadMarkdown() {
    const win = openViewer();
    setBusy('md');
    setError(null);
    try {
      const { filename, markdown } = await fetchReport();
      // text/plain so the tab shows it; text/markdown would be downloaded instead.
      const type = win ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8';
      deliver(win, new Blob([markdown], { type }), filename);
    } catch (err) {
      win?.close();
      setError(err instanceof Error ? err.message : 'Could not download the report');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-2">
        <button className="btn-ghost" onClick={copy} disabled={busy !== null} title="Copy the report as Markdown">
          {busy === 'copy' ? <Spinner /> : copied ? <Check size={15} className="text-green" /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className="btn-ghost"
          onClick={downloadMarkdown}
          disabled={busy !== null}
          title={viewInstead ? 'Open as Markdown in a new tab (save it with Ctrl+S)' : 'Download as Markdown, for a ticket or wiki'}
        >
          {busy === 'md' ? <Spinner /> : <FileText size={15} />} .md
        </button>
        <button className="btn-primary" onClick={downloadPdf} disabled={busy !== null} title={viewInstead ? 'Open the PDF in a new tab (save it from the viewer)' : 'Download as a PDF'}>
          {busy === 'pdf' ? <Spinner /> : <FileDown size={15} />} PDF
        </button>
      </div>
      {error && <p className={clsx('max-w-xs text-right text-xs text-red')}>{error}</p>}
    </div>
  );
}
