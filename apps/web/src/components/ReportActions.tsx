import { useState } from 'react';
import { clsx } from 'clsx';
import { Check, Copy, FileDown, FileText } from 'lucide-react';
import { api, getToken } from '../lib/api';
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
      await navigator.clipboard.writeText(markdown);
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
   * The PDF is rendered server-side, so it is fetched as bytes rather than built
   * here. A plain link cannot carry the Authorization header, hence the manual
   * fetch-then-blob rather than an <a href>.
   */
  async function downloadPdf() {
    setBusy('pdf');
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/report?format=pdf`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) throw new Error(`The server could not render the PDF (${res.status})`);

      const disposition = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `report-${runId}.pdf`;
      saveBlob(await res.blob(), name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download the PDF');
    } finally {
      setBusy(null);
    }
  }

  async function downloadMarkdown() {
    setBusy('md');
    setError(null);
    try {
      const { filename, markdown } = await fetchReport();
      saveBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), filename);
    } catch (err) {
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
          title="Download as Markdown, for a ticket or wiki"
        >
          {busy === 'md' ? <Spinner /> : <FileText size={15} />} .md
        </button>
        <button className="btn-primary" onClick={downloadPdf} disabled={busy !== null} title="Download as a PDF">
          {busy === 'pdf' ? <Spinner /> : <FileDown size={15} />} PDF
        </button>
      </div>
      {error && <p className={clsx('max-w-xs text-right text-xs text-red')}>{error}</p>}
    </div>
  );
}
