import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from './StoragePanel';

/**
 * A warning before the disk fills. Runs keep transcripts, command output and
 * images, and a full disk stops SQLite writing -- which stops every run. Shown when
 * under 1 GB or 10% is free, with a link to the clean-up controls.
 */
export function LowDiskBanner() {
  const q = useQuery({
    queryKey: ['storage'],
    queryFn: () => api<{ freeDiskBytes: number | null; totalDiskBytes: number | null; retention: { days: number | null } }>('/maintenance/storage'),
    refetchInterval: 5 * 60_000,
  });
  const s = q.data;
  if (!s || s.freeDiskBytes === null || !s.totalDiskBytes) return null;
  const low = s.freeDiskBytes < 1024 ** 3 || s.freeDiskBytes / s.totalDiskBytes < 0.1;
  if (!low) return null;
  return (
    <div className="mx-6 mt-4 flex items-start gap-3 rounded-inner border border-amber/40 bg-amber/10 px-4 py-3 text-sm text-amber">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        Disk space is low: {formatBytes(s.freeDiskBytes)} free. When it fills, runs stop.{' '}
        <Link to="/settings" className="font-medium underline">
          {s.retention.days === null ? 'Turn on history clean-up' : 'Clean up history now'}
        </Link>
      </div>
    </div>
  );
}
