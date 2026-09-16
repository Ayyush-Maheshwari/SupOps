import type { Server } from 'socket.io';
import type { EventSink, OutputSink, RunEventPayload } from '@supops/core';

/**
 * Bridges the engine's durable events onto Socket.IO.
 *
 * `packages/core` knows nothing about sockets; it only calls `emit`. That seam is
 * what lets the worker move into its own process later without touching the engine.
 */
export class SocketEventSink implements EventSink {
  private io: Server | null = null;

  attach(io: Server): void {
    this.io = io;
  }

  emit(runId: string, seq: number, payload: RunEventPayload): void {
    this.io?.to(`run:${runId}`).emit('run:event', { runId, seq, payload });
  }
}

/**
 * Live command output. Emitted straight to the room and never written to
 * `run_events` -- this is the ephemeral half of the two-channel design, the same
 * treatment token deltas get.
 */
export class SocketOutputSink implements OutputSink {
  private io: Server | null = null;

  attach(io: Server): void {
    this.io = io;
  }

  chunk(runId: string, toolCallId: string, text: string): void {
    this.io?.to(`run:${runId}`).emit('run:output', { runId, toolCallId, chunk: text });
  }
}
