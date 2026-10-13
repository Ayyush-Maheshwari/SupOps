import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { BookPlus, Bot, Camera, CameraOff, Check, Clock3, Headset, MonitorUp, PhoneOff, PictureInPicture2, Plus, Send, User, X } from 'lucide-react';
import { messageText } from '@supops/shared';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { cleanTask } from '../lib/format';
import { MAX_IMAGES, prepareImage, useImageAttachments } from '../lib/images';
import { useRunStream } from '../lib/useRunStream';
import { PageHeader } from '../components/Layout';
import { Composer } from '../components/Composer';
import { Markdown } from '../components/Markdown';
import { UserContent } from '../components/Attachments';
import { ReportActions } from '../components/ReportActions';
import { Empty, Panel, Spinner } from '../components/ui';
import type { Agent, Project, Run, RunDetail } from '../lib/types';

/**
 * Call mode: an engineer on a screen-share with a client who gives SupOps no access.
 * The client drives the keyboard; the engineer pastes what the shared screen shows
 * (or captures it in one click) and SupOps answers with the next step, every command
 * rated by the risk engine. When the call ends it leaves a client report and a runbook
 * draft, so the next call like it starts from what this one learned.
 */

const CALL_KEY = 'supops.callRunId';
const BUSY = ['queued', 'running', 'awaiting_approval'];
const ENDED_REASON = 'ended by the operator';

/** One frame of a shared screen. The stream is chosen once per call and only read on a click. */
function useScreenCapture() {
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getDisplayMedia;

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    video.current = null;
    setSharing(null);
  };
  useEffect(() => stop, []);

  /** `from`: the window the click happened in (the floating window asks for the share itself). */
  const capture = async (from: Window = window): Promise<File> => {
    if (!stream.current) {
      const md = from.navigator.mediaDevices;
      if (!md?.getDisplayMedia) throw new Error('This browser cannot capture a window here.');
      const s = await md.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      const track = s.getVideoTracks()[0]!;
      track.addEventListener('ended', stop);
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = s;
      await v.play();
      stream.current = s;
      video.current = v;
      setSharing(track.label || 'the call window');
      // Give the first frame a moment to arrive.
      await new Promise((r) => setTimeout(r, 300));
    }
    const track = stream.current.getVideoTracks()[0];
    // ImageCapture reads the frame straight from the track, so it works while this tab is in
    // the background (the usual case with the floating window); the video element is the fallback.
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame: () => Promise<ImageBitmap> } }).ImageCapture;
    let frame: ImageBitmap | null = null;
    if (IC && track) {
      try {
        frame = await new IC(track).grabFrame();
      } catch {
        frame = null;
      }
    }
    const v = video.current!;
    const canvas = document.createElement('canvas');
    canvas.width = frame?.width || v.videoWidth || 1280;
    canvas.height = frame?.height || v.videoHeight || 720;
    canvas.getContext('2d')!.drawImage(frame ?? v, 0, 0, canvas.width, canvas.height);
    frame?.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('The frame could not be captured.');
    const stamp = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '-');
    return new File([blob], `call-screen-${stamp}.png`, { type: 'image/png' });
  };

  return { supported, sharing, capture, stop };
}

/**
 * The floating call window: a small always-on-top window (Document Picture-in-Picture,
 * Chrome and Edge 116+) that stays beside the meeting app, so capturing and reading
 * the next step never means switching back to this tab. It shares this page's code
 * and state; React renders into it through a portal.
 */
type DocumentPip = { requestWindow: (o: { width: number; height: number }) => Promise<Window> };

function useFloatingWindow() {
  const [win, setWin] = useState<Window | null>(null);
  const supported = typeof window !== 'undefined' && 'documentPictureInPicture' in window && window.isSecureContext;

  const open = async () => {
    const dpip = (window as unknown as { documentPictureInPicture: DocumentPip }).documentPictureInPicture;
    const w = await dpip.requestWindow({ width: 380, height: 580 });
    // Carry the app's styles and theme over, so the window looks like SupOps.
    for (const sheet of [...document.styleSheets]) {
      try {
        const style = w.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        w.document.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = w.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          w.document.head.appendChild(link);
        }
      }
    }
    w.document.documentElement.className = document.documentElement.className;
    for (const a of document.documentElement.getAttributeNames()) {
      if (a.startsWith('data-') || a === 'style') w.document.documentElement.setAttribute(a, document.documentElement.getAttribute(a) ?? '');
    }
    w.document.body.className = document.body.className;
    w.document.title = 'SupOps · call';
    w.addEventListener('pagehide', () => setWin(null));
    setWin(w);
  };
  const close = () => {
    win?.close();
    setWin(null);
  };
  useEffect(() => () => win?.close(), [win]);
  return { supported, win, open, close };
}

/** Something to send: what the operator typed and the screens they captured or pasted. */
interface Pending {
  id: string;
  text: string;
  images: Array<{ name: string; data: string; width: number; height: number }>;
  attempts: number;
}

/** The next batch from the queue: in order, as many as fit in one message's image limit. */
function nextBatch(queue: Pending[]): Pending[] {
  const out: Pending[] = [];
  let shots = 0;
  for (const p of queue) {
    if (out.length && shots + p.images.length > MAX_IMAGES) break;
    out.push(p);
    shots += p.images.length;
  }
  return out;
}

function useTicker(startedAtRaw: number | string | undefined, running: boolean, endedAtRaw?: number | string | null): string {
  // The API may send times as epoch milliseconds or ISO strings.
  const toMs = (v: number | string | null | undefined) => (typeof v === 'string' ? Date.parse(v) : v ?? undefined);
  const startedAt = toMs(startedAtRaw);
  const endedAt = toMs(endedAtRaw);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!startedAt || Number.isNaN(startedAt)) return '00:00';
  // A finished call shows how long it lasted, not time since it began.
  const s = Math.max(0, Math.floor(((!running && endedAt && !Number.isNaN(endedAt) ? endedAt : now) - startedAt) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function Call() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CALL_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (runId) localStorage.setItem(CALL_KEY, runId);
      else localStorage.removeItem(CALL_KEY);
    } catch {
      /* ignore */
    }
  }, [runId]);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const project = projects.data?.find((p) => p.id === projectId);
  const agents = useQuery({ queryKey: ['agents', projectId], queryFn: () => api<Agent[]>(`/agents?projectId=${projectId}`), enabled: !!projectId });
  const agent = agents.data?.find((a) => a.slug === 'console') ?? agents.data?.[0];

  const detail = useQuery({ queryKey: ['run', runId], queryFn: () => api<RunDetail>(`/runs/${runId}`), enabled: !!runId });
  const run = detail.data?.run;
  // A call from another project (the project was switched) is not this page's call.
  const mine = run && run.projectId === projectId ? run : undefined;
  const busy = !!mine && BUSY.includes(mine.status);
  const ended = !!mine && (mine.statusReason === ENDED_REASON || ['failed', 'cancelled', 'expired', 'halted'].includes(mine.status));

  const seedSeq = detail.data?.events.at(-1)?.seq ?? -1;
  const { events } = useRunStream(mine ? runId ?? undefined : undefined, seedSeq, () => undefined);
  useEffect(() => {
    if (events.length) void qc.invalidateQueries({ queryKey: ['run', runId] });
  }, [events.length, runId, qc]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['run', runId] }), 2500);
    return () => clearInterval(t);
  }, [busy, runId, qc]);

  const screen = useScreenCapture();
  const floating = useFloatingWindow();
  const att = useImageAttachments();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const timer = useTicker(mine?.startedAt, !!mine && !ended, mine?.endedAt);
  const bottom = useRef<HTMLDivElement>(null);
  const stepCount = detail.data?.steps.length ?? 0;

  // ---- sending: everything goes through a queue, so nothing waits for SupOps to finish ----
  const [queue, setQueue] = useState<Pending[]>([]);
  const [inFlight, setInFlight] = useState<Pending[]>([]);
  /** After a refused send, wait for fresh run data before trying again (no retry loop on stale state). */
  const [pausedAt, setPausedAt] = useState(0);

  const send = useMutation({
    mutationFn: async (batch: Pending[]) => {
      const texts = batch.map((p) => p.text.trim()).filter(Boolean);
      const images = batch.flatMap((p) => p.images);
      const message = texts.join('\n\n') || (images.length > 1 ? `Here are ${images.length} captures of the client's screen, in order.` : "Here is the client's screen.");
      await post(`/runs/${runId}/message`, { message, ...(images.length ? { images } : {}) });
    },
    onMutate: (batch) => setInFlight(batch),
    onSuccess: () => {
      setError(null);
      setInFlight([]);
      // The run is working again: say so now, rather than sending the next batch on stale state.
      qc.setQueryData<RunDetail>(['run', runId], (d) => (d ? { ...d, run: { ...d.run, status: 'queued' } } : d));
      void qc.invalidateQueries({ queryKey: ['run', runId] });
    },
    onError: (e, batch) => {
      setInFlight([]);
      const again = batch.map((p) => ({ ...p, attempts: p.attempts + 1 }));
      setQueue((q) => [...again, ...q]);
      setPausedAt(Date.now());
      void qc.invalidateQueries({ queryKey: ['run', runId] });
      // A first refusal is usually timing (SupOps had just started a reply); say so only if it repeats.
      if (again.some((p) => p.attempts >= 2)) setError((e as Error).message);
    },
  });

  const free = !!mine && !ended && !busy && !send.isPending;
  useEffect(() => {
    if (!free || !queue.length || detail.dataUpdatedAt <= pausedAt) return;
    const batch = nextBatch(queue);
    setQueue((q) => q.slice(batch.length));
    send.mutate(batch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free, queue, detail.dataUpdatedAt, pausedAt]);

  const enqueue = (text: string, images: Pending['images']) => {
    if (!text.trim() && !images.length) return;
    setQueue((q) => [...q, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, images, attempts: 0 }]);
  };

  useEffect(() => {
    // Braces, not an expression: newer browsers return a Promise from scrollIntoView,
    // and an effect may only return a cleanup function.
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [stepCount, busy, queue.length, inFlight.length]);

  const finish = useMutation({
    mutationFn: () => post(`/runs/${runId}/finish`, {}),
    onSuccess: () => {
      screen.stop();
      floating.close();
      void qc.invalidateQueries({ queryKey: ['run', runId] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const captureNow = async () => {
    setError(null);
    try {
      await att.addFiles([await screen.capture()]);
    } catch (e) {
      const err = e as Error & { name?: string };
      setError(err.name === 'NotAllowedError' ? 'Screen sharing was cancelled. Paste a screenshot instead, or try again.' : err.message);
    }
  };

  /** From the floating window: capture a frame and queue it straight away, with the note if any. */
  const captureAndQueue = async (note: string): Promise<string | null> => {
    try {
      const img = await prepareImage(await screen.capture(floating.win ?? window));
      enqueue(note, [{ name: img.name, data: img.data, width: img.width, height: img.height }]);
      return null;
    } catch (e) {
      const err = e as Error & { name?: string };
      return err.name === 'NotAllowedError' ? 'Sharing was cancelled. Click Capture again and pick the meeting window.' : err.message;
    }
  };

  if (!projectId) return null;
  if (!runId || !mine) {
    return <StartCall projectName={project?.name ?? 'this project'} agent={agent} onStarted={(id) => { setQueue([]); setRunId(id); }} loading={!!runId && detail.isLoading} />;
  }

  const topic = mine.title.replace(/^Call · [^·]+ · /, '');
  const waiting = queue.length + inFlight.length;
  const lastReply = [...(detail.data?.steps ?? [])].reverse().find((s) => s.messageJson.role === 'assistant' && s.messageJson.content)?.messageJson;
  const status: CallStatus = ended ? 'ended' : busy ? 'reading' : inFlight.length ? 'sending' : 'ready';
  return (
    <>
      <PageHeader title="Call" subtitle="Your copilot on a client's screen-share. Paste or capture what you see; SupOps gives the next step." />
      <div className="space-y-3 px-4 pb-6 pt-2 sm:px-6">
        {/* The call bar */}
        <div className="tile flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <span className={clsx('flex items-center gap-2 text-sm font-semibold', ended ? 'text-muted' : 'text-red')}>
            <span className={clsx('h-2.5 w-2.5 rounded-full', ended ? 'bg-muted' : 'animate-pulse bg-red')} />
            {ended ? 'Call ended' : 'Live call'}
          </span>
          <span className="font-mono text-sm tabular-nums text-ink">{timer}</span>
          <span className="order-last min-w-0 basis-full truncate text-sm text-muted sm:order-none sm:basis-auto sm:flex-1">
            <span className="text-ink">{project?.name}</span> · {topic}
          </span>
          {!ended && floating.supported && (
            <button className="btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => (floating.win ? floating.close() : void floating.open().catch((e: Error) => setError(e.message)))} title="A small always-on-top window to capture and read the next step without leaving the meeting">
              <PictureInPicture2 size={14} /> {floating.win ? 'Close floating window' : 'Floating window'}
            </button>
          )}
          {!ended && (
            <button className="btn-danger !min-h-[36px] !px-3 text-xs" disabled={busy || waiting > 0 || finish.isPending} onClick={() => finish.mutate()} title={busy || waiting ? 'Wait until SupOps has answered everything you sent' : 'End the call and write the reports'}>
              {finish.isPending ? <Spinner /> : <PhoneOff size={14} />} End call
            </button>
          )}
          {ended && (
            <button className="btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => { setRunId(null); setQueue([]); screen.stop(); floating.close(); }}>
              <Plus size={14} /> New call
            </button>
          )}
        </div>

        {ended && <AfterCall runId={mine.id} projectId={projectId} run={mine} />}

        {/* The conversation */}
        <div className="tile min-h-[320px] space-y-3 p-4">
          {detail.data?.steps.map((step) => {
            const m = step.messageJson;
            if (m.role === 'system' || m.role === 'tool') return null;
            if (m.role === 'user') {
              return (
                <div key={step.id} className="flex gap-2.5">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-cyan/15 text-cyan"><User size={13} /></span>
                  <div className="min-w-0 flex-1 rounded-inner border border-hairline bg-tile-2/50 px-3 py-2 text-sm">
                    <UserContent runId={mine.id} content={m.content} clean={cleanTask} />
                  </div>
                </div>
              );
            }
            if (!m.content) return null;
            return (
              <div key={step.id} className="flex gap-2.5">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet/15 text-violet"><Bot size={13} /></span>
                <div className="min-w-0 flex-1 px-1 py-1">
                  <Markdown rateCommands>{messageText(m.content)}</Markdown>
                </div>
              </div>
            );
          })}
          {busy && <Thinking />}
          {/* Sent and waiting: shown in order, so the operator sees nothing was lost. */}
          {[...inFlight.map((p) => ({ p, state: 'sending' as const })), ...queue.map((p) => ({ p, state: 'queued' as const }))].map(({ p, state }) => (
            <div key={p.id} className="flex gap-2.5 opacity-75">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-cyan/15 text-cyan"><User size={13} /></span>
              <div className="min-w-0 flex-1 rounded-inner border border-dashed border-edge px-3 py-2 text-sm">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                  {state === 'sending' ? <><Spinner className="!h-3 !w-3" /> Sending…</> : <><Clock3 size={11} /> Queued: goes when SupOps finishes</>}
                  {state === 'queued' && (
                    <button className="ml-auto text-dim hover:text-red" onClick={() => setQueue((q) => q.filter((x) => x.id !== p.id))} aria-label="Remove from the queue" title="Remove"><X size={13} /></button>
                  )}
                </div>
                {p.text && <p className="whitespace-pre-wrap text-ink/90">{p.text}</p>}
                {p.images.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.images.map((img) => <img key={img.name} src={img.data} alt={img.name} className="h-14 w-20 rounded border border-hairline object-cover" />)}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>

        {!ended && (
          // Stays at the bottom of the screen during a long call, so capture and send are always in reach.
          <div className="sticky bottom-0 z-10 -mx-1 space-y-2 bg-ground/95 px-1 pb-3 pt-2 backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              {screen.supported ? (
                <button className="btn-ghost !min-h-[36px] !px-3 text-xs" onClick={() => void captureNow()} title={screen.sharing ? 'Grab the current frame of the shared window' : 'Choose the call window once, then capture a frame with each click'}>
                  <Camera size={14} /> {screen.sharing ? 'Capture screen' : 'Capture call screen'}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted" title="Browsers allow screen capture only over HTTPS or on localhost">
                  <MonitorUp size={13} /> Paste a screenshot with Ctrl+V (capture needs HTTPS)
                </span>
              )}
              {screen.sharing && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-green/40 bg-green/10 px-2.5 py-1 text-[11px] text-green">
                  <span className="h-1.5 w-1.5 rounded-full bg-green" /> Watching: {screen.sharing}
                  <button className="ml-1 text-green/80 hover:text-green" onClick={screen.stop} aria-label="Stop sharing" title="Stop sharing"><CameraOff size={12} /></button>
                </span>
              )}
              {waiting > 0 && <span className="text-[11px] text-amber">{waiting} waiting to send</span>}
              <span className="text-[11px] text-dim">Nothing is recorded: only the frames you capture are sent.</span>
            </div>
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => {
                enqueue(input, att.payload());
                setInput('');
                att.clear();
              }}
              att={att}
              placeholder={busy ? 'SupOps is reading; anything you send now is queued…' : 'What does the client see? Paste output, or a screenshot (Ctrl+V)…'}
              error={error ?? att.error}
            />
          </div>
        )}
      </div>

      {floating.win &&
        createPortal(
          <FloatingCall
            win={floating.win}
            timer={timer}
            client={project?.name ?? ''}
            status={status}
            waiting={waiting}
            sharing={screen.sharing}
            canCapture={!!floating.win.navigator.mediaDevices?.getDisplayMedia}
            lastReply={lastReply ? messageText(lastReply.content) : null}
            onCapture={captureAndQueue}
            onNote={(note) => enqueue(note, [])}
          />,
          floating.win.document.body,
        )}
    </>
  );
}

type CallStatus = 'ready' | 'sending' | 'reading' | 'ended';

/** "SupOps is reading", with a little life to it so a long read never looks stuck. */
function Thinking({ compact = false }: { compact?: boolean }) {
  return (
    <p className={clsx('flex items-center gap-2 px-1 text-muted', compact ? 'text-[12px]' : 'text-sm')}>
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue" style={{ animationDelay: `${i * 150}ms` }} />)}
      </span>
      SupOps is reading it…
    </p>
  );
}

/** The always-on-top window's content: status, the latest next step, and capture. */
function FloatingCall({
  win, timer, client, status, waiting, sharing, canCapture, lastReply, onCapture, onNote,
}: {
  win: Window;
  timer: string;
  client: string;
  status: CallStatus;
  waiting: number;
  sharing: string | null;
  canCapture: boolean;
  lastReply: string | null;
  onCapture: (note: string) => Promise<string | null>;
  onNote: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const reply = useRef<HTMLDivElement>(null);
  useEffect(() => {
    reply.current?.scrollTo({ top: 0 });
  }, [lastReply]);
  useEffect(() => {
    win.document.title = `${status === 'reading' ? '… ' : ''}SupOps · ${timer}`;
  }, [win, status, timer]);

  const capture = async () => {
    setCapturing(true);
    setProblem(null);
    const err = await onCapture(note);
    setCapturing(false);
    if (err) setProblem(err);
    else {
      setNote('');
      setFlash(true);
      setTimeout(() => setFlash(false), 900);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-ground text-ink">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <span className={clsx('h-2 w-2 rounded-full', status === 'ended' ? 'bg-muted' : 'animate-pulse bg-red')} />
        <span className="font-mono text-[13px] tabular-nums">{timer}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{client}</span>
        <span
          className={clsx(
            'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
            status === 'ready' ? 'bg-green/15 text-green' : status === 'ended' ? 'bg-tile-2 text-muted' : 'bg-blue/15 text-blue-text',
          )}
        >
          {status === 'ready' ? 'Ready' : status === 'sending' ? 'Sending…' : status === 'reading' ? 'Reading…' : 'Ended'}
        </span>
      </div>

      <div ref={reply} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {status === 'reading' || status === 'sending' ? <div className="mb-2"><Thinking compact /></div> : null}
        {lastReply ? (
          <>
            <p className="mb-1 text-[10.5px] uppercase tracking-wider text-dim">Latest next step</p>
            <Markdown rateCommands>{lastReply}</Markdown>
          </>
        ) : (
          <p className="text-[12px] text-muted">The next step will show here.</p>
        )}
      </div>

      <div className="space-y-2 border-t border-hairline p-3">
        {waiting > 0 && <p className="text-[11px] text-amber">{waiting} waiting to send: they go as soon as SupOps finishes.</p>}
        {sharing && <p className="truncate text-[11px] text-green">Watching: {sharing}</p>}
        <textarea
          className="input min-h-[52px] resize-none text-[12.5px]"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note: what you see or what they said"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && note.trim()) {
              e.preventDefault();
              onNote(note);
              setNote('');
            }
          }}
        />
        {problem && <p className="text-[11px] text-red">{problem}</p>}
        <div className="flex gap-2">
          <button className={clsx('btn-primary flex-1 !min-h-[40px] justify-center', flash && '!bg-green')} disabled={!canCapture || capturing || status === 'ended'} onClick={() => void capture()} title={sharing ? 'Capture the meeting window now' : 'Pick the meeting window once, then each click captures it'}>
            {capturing ? <Spinner /> : flash ? <Check size={15} /> : <Camera size={15} />} {flash ? 'Captured' : sharing ? 'Capture' : 'Pick window & capture'}
          </button>
          <button className="btn-ghost !min-h-[40px]" disabled={!note.trim() || status === 'ended'} onClick={() => { onNote(note); setNote(''); }} title="Send the note without a capture (Enter)">
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function StartCall({ projectName, agent, onStarted, loading }: { projectName: string; agent: Agent | undefined; onStarted: (runId: string) => void; loading: boolean }) {
  const projectId = useApp((s) => s.projectId);
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const start = useMutation({
    mutationFn: () =>
      post<Run>('/runs', {
        projectId,
        agentId: agent!.id,
        task: notes.trim() ? `${topic.trim()}\n\nWhat we know so far:\n${notes.trim()}` : topic.trim(),
        call: true,
      }),
    onSuccess: (run) => onStarted(run.id),
  });
  if (loading) return <div className="grid place-items-center py-20"><Spinner /></div>;
  return (
    <>
      <PageHeader title="Call" subtitle="Your copilot on a client's screen-share, for systems SupOps cannot reach itself." />
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <Panel className="p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-blue/15 text-blue-text"><Headset size={20} /></span>
            <div>
              <h2 className="text-base font-semibold text-ink">Start a call</h2>
              <p className="text-xs text-muted">Client: <span className="text-ink">{projectName}</span> · switch client from the project menu</p>
            </div>
          </div>
          <label className="mb-3 block">
            <span className="label">What is the call about?</span>
            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Checkout page returns 502 since this morning" maxLength={300} autoFocus />
          </label>
          <label className="mb-4 block">
            <span className="label">What you know so far (optional)</span>
            <textarea className="input min-h-[80px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Recent deploy at 09:40, only EU customers affected…" />
          </label>
          {!agent && <p className="mb-3 text-xs text-amber">This project has no assistant agent yet; add one under Agents.</p>}
          {start.isError && <p className="mb-3 text-xs text-red">{(start.error as Error).message}</p>}
          <button className="btn-primary" disabled={!topic.trim() || !agent || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? <Spinner /> : <Headset size={15} />} Start call
          </button>
        </Panel>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['Paste or capture', 'Paste output or a screenshot of the shared screen, or capture a frame in one click.'],
            ['Next step, rated', 'SupOps gives one step at a time; every command shows whether it only looks or changes something.'],
            ['Reports at the end', 'End the call for a client report (PDF) and a runbook draft for your Knowledge.'],
          ].map(([t, d]) => (
            <div key={t} className="tile p-4">
              <p className="text-[13px] font-medium text-ink">{t}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** What the call leaves behind: the client report, the internal report, and a runbook draft. */
function AfterCall({ runId, projectId, run }: { runId: string; projectId: string; run: Run }) {
  const [runbook, setRunbook] = useState(false);
  const ms = (v: number | string | null) => (typeof v === 'string' ? Date.parse(v) : v ?? NaN);
  const span = ms(run.endedAt) - ms(run.startedAt);
  const mins = Number.isFinite(span) ? Math.max(1, Math.round(span / 60_000)) : null;
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">The call is over{mins ? ` · ${mins} min` : ''}</p>
          <p className="mt-0.5 text-[12px] text-muted">Send the client their report, and keep what this call taught you as a runbook so the next one is faster.</p>
        </div>
        <button className="btn-ghost !min-h-[36px] text-xs" onClick={() => setRunbook(true)}><BookPlus size={14} /> Save as runbook</button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-inner border border-hairline p-3">
          <p className="mb-2 text-[12px] font-medium text-ink">Client report <span className="font-normal text-muted">· plain language, for the client</span></p>
          <ReportActions runId={runId} audience="client" />
        </div>
        <div className="rounded-inner border border-hairline p-3">
          <p className="mb-2 text-[12px] font-medium text-ink">Internal report <span className="font-normal text-muted">· the full record, for your team</span></p>
          <ReportActions runId={runId} />
        </div>
      </div>
      {runbook && <RunbookDialog runId={runId} projectId={projectId} onClose={() => setRunbook(false)} />}
    </Panel>
  );
}

function RunbookDialog({ runId, projectId, onClose }: { runId: string; projectId: string; onClose: () => void }) {
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const [draft, setDraft] = useState<{ title: string; slug: string; body: string } | null>(null);
  const make = useQuery({
    queryKey: ['call-runbook', runId],
    queryFn: () => post<{ title: string; slug: string; body: string }>(`/runs/${runId}/runbook`, {}),
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (make.data && !draft) setDraft(make.data);
  }, [make.data, draft]);
  const save = useMutation({
    mutationFn: () => post('/knowledge', { projectId, kind: 'runbook', slug: draft!.slug, title: draft!.title, body: draft!.body }),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className="tile max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-b-none p-5 sm:rounded-b-tile" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Save as runbook">
        <div className="mb-3 flex items-center gap-3">
          <BookPlus size={18} className="text-blue-text" />
          <h2 className="flex-1 text-base font-semibold text-ink">Save the call as a runbook</h2>
          <button className="text-dim hover:text-ink" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {save.isSuccess ? (
          <Empty
            title={isAdmin ? 'Saved to Knowledge' : 'Saved as a draft'}
            hint={isAdmin ? 'Future runs and calls in this project will use it.' : 'An admin approves it under Knowledge before runs use it.'}
            action={<Link to="/knowledge" className="btn-primary">Open Knowledge</Link>}
          />
        ) : make.isLoading || !draft ? (
          make.isError ? <p className="text-xs text-red">{(make.error as Error).message}</p> : <div className="grid h-40 place-items-center gap-2 text-xs text-muted"><Spinner /> Drafting it from the call…</div>
        ) : (
          <>
            <p className="mb-3 text-[12px] text-muted">Drafted from the call. Edit anything before saving.</p>
            <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_200px]">
              <label className="block"><span className="label">Title</span><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
              <label className="block"><span className="label">Slug</span><input className="input font-mono text-[12px]" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></label>
            </div>
            <label className="mb-4 block"><span className="label">Runbook (Markdown)</span><textarea className="input min-h-[280px] font-mono text-[12px]" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
            {save.isError && <p className="mb-3 text-xs text-red">{(save.error as Error).message}</p>}
            <div className="flex gap-2">
              <button className="btn-primary" disabled={save.isPending || !draft.title.trim() || !draft.body.trim()} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner /> : <BookPlus size={14} />} {isAdmin ? 'Save runbook' : 'Save as draft'}
              </button>
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
