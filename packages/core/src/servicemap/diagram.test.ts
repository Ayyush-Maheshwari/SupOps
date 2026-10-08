import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { diagramFormat, parseDrawio, typeFromShape } from './diagram.ts';

const GRAPH = `<mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="lb" value="lb-1" style="shape=mxgraph.aws4.elastic_load_balancing;" vertex="1" parent="1"/>
  <mxCell id="vm" value="app-vm" style="swimlane;container=1;" vertex="1" parent="1"/>
  <mxCell id="api" value="&lt;b&gt;api&lt;/b&gt;&lt;br&gt;" style="rounded=1;" vertex="1" parent="vm"/>
  <mxCell id="db" value="db-1" style="shape=cylinder3;" vertex="1" parent="1"/>
  <mxCell id="rep" value="db-2" style="shape=cylinder3;" vertex="1" parent="1"/>
  <mxCell id="note" value="Legend: arrows are calls" style="text;" vertex="1" parent="1"/>
  <mxCell id="e1" edge="1" source="lb" target="api" parent="1" style="endArrow=classic;"/>
  <mxCell id="e2" value="tcp/5432" edge="1" source="api" target="db" parent="1"/>
  <mxCell id="e3" value="streaming replication" edge="1" source="db" target="rep" parent="1"/>
  <mxCell id="e4" edge="1" source="db" target="api" parent="1" style="startArrow=classic;endArrow=none;"/>
</root></mxGraphModel>`;

test('draw.io: boxes, arrows, shapes, containers, exactly', () => {
  const x = parseDrawio(`<mxfile><diagram name="p">${GRAPH}</diagram></mxfile>`)!;
  assert.deepEqual(x.items.map((i) => [i.name, i.type]), [['lb-1', 'load_balancer'], ['app-vm', 'host'], ['api', 'service'], ['db-1', 'database'], ['db-2', 'database']], 'HTML labels read as text; the legend is skipped');
  const links = x.links.map((l) => `${l.from} ${l.kind} ${l.to}${l.detail ? ` (${l.detail})` : ''}`);
  assert.ok(links.includes('lb-1 routes_to api'));
  assert.ok(links.includes('api depends_on db-1 (tcp/5432)'));
  assert.ok(links.includes('db-1 replicates_to db-2 (streaming replication)'));
  assert.ok(links.includes('api runs_on app-vm'), 'a box inside a machine runs on it');
  assert.equal(links.filter((l) => l.startsWith('api depends_on db-1')).length, 1, 'an arrow drawn backwards (head at the start) is the same call, once');
});

test('draw.io: the compressed form draw.io saves by default', () => {
  const packed = deflateRawSync(Buffer.from(encodeURIComponent(GRAPH), 'latin1')).toString('base64');
  const x = parseDrawio(`<mxfile host="app.diagrams.net"><diagram id="a" name="Page-1">${packed}</diagram></mxfile>`)!;
  assert.equal(x.items.length, 5);
  assert.equal(parseDrawio('flowchart LR\n  a --> b'), null, 'not draw.io: left to the model');
});

test('shapes and labels give types; formats are told apart', () => {
  assert.equal(typeFromShape('shape=mxgraph.aws4.elasticache;', 'sessions'), 'cache');
  assert.equal(typeFromShape('rounded=1;', 'orders-postgres'), 'database');
  assert.equal(typeFromShape('rounded=1;', 'checkout'), 'service');
  assert.equal(diagramFormat('flowchart LR\n a-->b'), 'mermaid');
  assert.equal(diagramFormat('@startuml\n[a] --> [b]\n@enduml'), 'plantuml');
  assert.equal(diagramFormat('digraph g { a -> b }'), 'graphviz');
});
