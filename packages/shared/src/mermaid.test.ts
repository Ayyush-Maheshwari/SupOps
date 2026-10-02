import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagramKey, extractMermaidBlocks, repairMermaid } from './mermaid.ts';

// The diagram a model actually produced for "draw a flow chart of the mongo setup".
// Mermaid refuses it: the subgraph titles have unquoted parentheses.
const REAL = `graph TD
    %% Client Application Layer
    Client[Acme Application / API Services] -->|Read / Write Requests| Router[(Database Connection / DNS)]
    Router -->|Primary Operations: Writes & Reads| Node2
    subgraph mongo2 [VM: mongo2 (Primary) - 10.0.5.98]
        subgraph Docker2 [Docker Container: mongo]
            DB2[(MongoDB 3.2<br/>Port: 27017)]
        end
    end
    DB2 ==>|Data Replication & Heartbeat Sync| DB1
    Monitoring -.->|Scrapes Metrics| mongo2`;

test('quotes subgraph titles and node labels that contain punctuation', () => {
  const fixed = repairMermaid(REAL);
  assert.match(fixed, /subgraph mongo2 \["VM: mongo2 \(Primary\) - 10\.0\.5\.98"\]/);
  assert.match(fixed, /subgraph Docker2 \["Docker Container: mongo"\]/);
  assert.match(fixed, /DB2\[\("MongoDB 3\.2<br\/>Port: 27017"\)\]/);
  // Safe labels, comments and edge labels are left exactly as written.
  assert.match(fixed, /Client\[Acme Application \/ API Services\]/);
  assert.match(fixed, /Router\[\(Database Connection \/ DNS\)\]/);
  assert.match(fixed, /%% Client Application Layer/);
  assert.match(fixed, /-->\|Primary Operations: Writes & Reads\| Node2/);
});

test('repair is idempotent and never re-quotes a quoted label', () => {
  const once = repairMermaid(REAL);
  assert.equal(repairMermaid(once), once);
  const quoted = 'flowchart LR\n  A["call fn(x: 1)"] --> B{"ok?"}';
  assert.equal(repairMermaid(quoted), quoted);
});

test('every node shape is handled, and inner quotes are escaped', () => {
  const src = 'flowchart TD\n  A(round: x) --> B{choice?}\n  C([stadium (s)]) --> D[[sub: r]]\n  E((circle #1)) --> F{{hex: h}}\n  G[say "hi" (now)]';
  const out = repairMermaid(src);
  assert.match(out, /A\("round: x"\)/);
  assert.match(out, /B\{"choice\?"\}|B\{choice\?\}/);
  assert.match(out, /C\(\["stadium \(s\)"\]\)/);
  assert.match(out, /D\[\["sub: r"\]\]/);
  assert.match(out, /E\(\("circle #1"\)\)/);
  assert.match(out, /F\{\{"hex: h"\}\}/);
  assert.match(out, /G\["say #quot;hi#quot; \(now\)"\]/);
});

test('edge labels with brackets are quoted; plain ones are not', () => {
  const out = repairMermaid('flowchart LR\n  A[api] -->|writes (sync)| B[db]\n  B -.->|reads: 5/s| C[cache]');
  assert.match(out, /-->\|"writes \(sync\)"\| B\[db\]/);
  assert.match(out, /-\.->\|reads: 5\/s\| C\[cache\]/);
});

test('non-flowchart diagrams are left alone', () => {
  const seq = 'sequenceDiagram\n  Alice->>Bob: Hello (there)';
  assert.equal(repairMermaid(seq), seq);
});

test('extracts fenced blocks with the nearest heading as a title', () => {
  const md = 'Intro text.\n\n### Flow Chart\n\n```mermaid\n' + REAL + '\n```\n\nAfter.\n\n```mermaid\nflowchart LR\n A --> B\n```';
  const blocks = extractMermaidBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.title, 'Flow Chart');
  assert.ok(blocks[0]!.source.startsWith('graph TD'));
  assert.equal(blocks[1]!.title, 'After.');
  assert.equal(extractMermaidBlocks('no diagrams here\n```bash\nls\n```').length, 0);
});

test('diagramKey ignores indentation and blank lines', () => {
  assert.equal(diagramKey('graph TD\n    A --> B\n\n'), diagramKey('graph TD\nA --> B'));
});
