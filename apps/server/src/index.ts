import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { config, warnAboutConfig } from './config.ts';
import { verifySessionToken } from './auth.ts';
import { outputSink, sink } from './context.ts';
import { api } from './routes/index.ts';
import { worker } from './worker.ts';
import { healthScheduler } from './health-scheduler.ts';
import { maintenanceScheduler } from './maintenance-scheduler.ts';
import { observeScheduler } from './observe/scheduler.ts';
import { ensureBuiltinAgentsEverywhere } from './services/builtin-agents.ts';
import { slackListener } from './slack/listener.ts';

const app = express();
app.use(cors());
// Runs carry pasted screenshots and the PDF request carries rendered diagrams, so
// that one router gets a bigger body limit; everything else keeps 1 MB. The first
// parser to run wins -- express.json skips a body that is already parsed.
app.use('/api/runs', express.json({ limit: '16mb' }));
// Knowledge imports carry up to five documents of 10 MB each, base64-encoded.
app.use('/api/knowledge/import', express.json({ limit: '70mb' }));
// A diagram picture or draw.io file for the service map.
app.use('/api/service-map/from-diagram', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', api);

// Single-origin serving: when the SPA has been built (the Docker image does this),
// serve it from the API port and fall back to index.html for client-side routes.
// The client already uses relative /api and /socket.io, so nothing else changes.
// `npm run dev` has no dist, so this is inert there (Vite serves the UI on :3000).
if (existsSync(join(config.webDir, 'index.html'))) {
  app.use(express.static(config.webDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      next();
      return;
    }
    res.sendFile(join(config.webDir, 'index.html'));
  });
  console.log(`  serving web UI   ${config.webDir}`);
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('unhandled error:', err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
});

const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
sink.attach(io);
outputSink.attach(io);

// The live stream carries everything a run page shows -- commands, output, approval
// prompts -- so it needs the same session as the REST API. Without this, anyone who
// could reach the port could subscribe to any run and replay its events.
io.use((socket, next) => {
  const user = verifySessionToken((socket.handshake.auth as { token?: unknown } | undefined)?.token);
  if (!user) {
    next(new Error('unauthorized'));
    return;
  }
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  /**
   * `lastSeq` is what makes reconnect, late-join and multi-viewer all correct with
   * one mechanism: we replay the durable events the client has not seen, then join
   * it to the live room. Token deltas missed while disconnected are not replayed --
   * the client gets the completed blocks instead, which is invisible in practice.
   */
  socket.on('run:subscribe', async ({ runId, lastSeq }: { runId: string; lastSeq?: number }) => {
    if (typeof runId !== 'string') return;
    void socket.join(`run:${runId}`);

    const { engine } = await import('./context.ts');
    for (const e of engine.store.listEvents(runId, lastSeq ?? -1)) {
      socket.emit('run:event', { runId, seq: e.seq, payload: e.payload });
    }
  });

  socket.on('run:unsubscribe', ({ runId }: { runId: string }) => {
    if (typeof runId === 'string') void socket.leave(`run:${runId}`);
  });
});

http.listen(config.port, () => {
  console.log(`\n  SupOps server  http://localhost:${config.port}`);
  console.log(`  provider         ${config.llm.baseUrl}`);
  console.log(`  model            ${config.llm.model}`);
  console.log(`  run concurrency  ${config.runConcurrency}`);
  warnAboutConfig();
  ensureBuiltinAgentsEverywhere();
  worker.start();
  healthScheduler.start();
  maintenanceScheduler.start();
  observeScheduler.start();
  // Fire-and-forget: a Slack outage must never block the server from serving.
  void slackListener.start();
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    worker.stop();
    healthScheduler.stop();
    maintenanceScheduler.stop();
    observeScheduler.stop();
    void slackListener.stop();
    http.close(() => process.exit(0));
  });
}
