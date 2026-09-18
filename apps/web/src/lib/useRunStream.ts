import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export interface LiveEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Subscribe to a run's event stream.
 *
 * `lastSeq` is the whole trick: on connect (and on every reconnect) we tell the
 * server the highest sequence number we already have, and it replays everything
 * after it before joining us to the live room. That makes a page refresh, a laptop
 * waking from sleep, and a second person opening the same run all behave identically
 * without any special handling.
 */
export interface OutputChunk {
  toolCallId: string;
  chunk: string;
}

export function useRunStream(
  runId: string | undefined,
  seedSeq = -1,
  /** Live command output. Ephemeral -- never replayed after a reconnect. */
  onOutput?: (c: OutputChunk) => void,
) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(seedSeq);

  // Held in a ref so a new callback identity does not tear down the socket.
  const outputRef = useRef(onOutput);
  outputRef.current = onOutput;

  useEffect(() => {
    lastSeq.current = seedSeq;
  }, [seedSeq, runId]);

  useEffect(() => {
    if (!runId) return;

    const socket: Socket = io({ path: '/socket.io' });

    const subscribe = () => {
      setConnected(true);
      socket.emit('run:subscribe', { runId, lastSeq: lastSeq.current });
    };

    socket.on('connect', subscribe);
    socket.on('disconnect', () => setConnected(false));
    socket.on(
      'run:output',
      (e: { runId: string; toolCallId: string; chunk: string }) => {
        if (e.runId !== runId) return;
        outputRef.current?.({ toolCallId: e.toolCallId, chunk: e.chunk });
      },
    );

    socket.on('run:event', (e: { runId: string; seq: number; payload: Record<string, unknown> }) => {
      if (e.runId !== runId || e.seq <= lastSeq.current) return;
      lastSeq.current = e.seq;
      setEvents((prev) => [...prev, { seq: e.seq, type: String(e.payload.type), payload: e.payload }]);
    });

    return () => {
      socket.emit('run:unsubscribe', { runId });
      socket.close();
    };
  }, [runId]);

  return { events, connected };
}
