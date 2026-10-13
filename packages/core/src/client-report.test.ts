import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallTranscript, buildClientReportMarkdown, callScreenshots, parseClientReport, parseRunbookDraft, reportScreenshots } from './client-report.ts';
import { buildClientPdfDefinition } from './pdf/client-pdf.ts';
import type { ChatMessage } from '@supops/shared';

const steps: Array<{ messageJson: ChatMessage }> = [
  { messageJson: { role: 'system', content: 'secret system prompt' } },
  { messageJson: { role: 'user', content: [{ type: 'text', text: 'Client says the site is slow' }, { type: 'image_url', image_url: { url: 'supops-attachment:a' } }] } },
  { messageJson: { role: 'assistant', content: 'Ask them to run df -h.' } },
];

test('the transcript has the conversation and screenshot markers, never the system prompt', () => {
  const t = buildCallTranscript(steps);
  assert.match(t, /ENGINEER: Client says the site is slow \[screenshot 1\]/);
  assert.match(t, /SUPOPS: Ask them to run df -h\./);
  assert.doesNotMatch(t, /secret system prompt/);
});

test('the client report is plain: no approvals, model or token counts', () => {
  const r = parseClientReport('{"title":"Disk full on web-1","status":"resolved","summary":"Fixed.","checks":["df -h showed 97%"],"actions":["Old logs removed"],"recommendations":["Rotate logs daily"]}', 'x');
  const meta = { projectName: 'Acme', engineer: 'Ayush', startedAt: new Date('2026-10-01T10:00:00Z'), endedAt: new Date('2026-10-01T10:24:00Z') };
  const md = buildClientReportMarkdown(r, meta);
  assert.match(md, /^# Disk full on web-1/);
  assert.match(md, /\*\*Status:\*\* Resolved/);
  assert.match(md, /24 min/);
  assert.doesNotMatch(md, /approv|token|model|SupOps/i);
  const pdf = JSON.stringify(buildClientPdfDefinition(r, meta));
  assert.doesNotMatch(pdf.replace(/"image":"[^"]*"/g, ''), /Approvals|tokens/);
});

test('a broken model answer still gives a usable report and runbook', () => {
  const r = parseClientReport('not json', 'Slow site');
  assert.equal(r.title, 'Slow site');
  assert.equal(r.status, 'open');
  assert.ok(r.summary.length > 0);
  const rb = parseRunbookDraft(null, 'Slow site', 'ENGINEER: hi');
  assert.equal(rb.slug, 'slow-site');
  assert.match(rb.body, /ENGINEER: hi/);
});

test('a report keeps only the few screenshots the model chose, numbered as in the transcript', () => {
  const shot = (id: string): ChatMessage => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: `supops-attachment:${id}` } }] });
  const many = Array.from({ length: 20 }, (_, i) => ({ messageJson: shot(`s${i + 1}`) }));
  const urls = callScreenshots(many);
  assert.equal(urls.length, 20);
  assert.equal(urls[2], 'supops-attachment:s3');
  assert.match(buildCallTranscript(many), /\[screenshot 20\]/);

  const r = parseClientReport('{"title":"t","screenshots":[{"n":17,"caption":"Fixed"},{"n":3,"caption":"Error"},{"n":3},{"n":99},{"n":5},{"n":8},{"n":9}]}', 'x');
  // duplicates and numbers the call does not have dropped; the model's top four, shown in call order
  assert.deepEqual(reportScreenshots(r, 20).map((s) => s.n), [3, 5, 8, 17]);
  assert.deepEqual(reportScreenshots(r, 10).map((s) => s.n), [3, 5, 8, 9]);
  assert.equal(reportScreenshots(r, 20)[0]?.caption, 'Error');

  // the model said none are worth it: none
  assert.deepEqual(reportScreenshots(parseClientReport('{"title":"t","screenshots":[]}', 'x'), 20), []);
  // no choice at all (model down): first and last only
  assert.deepEqual(reportScreenshots(parseClientReport(null, 'x'), 20).map((s) => s.n), [1, 20]);
  assert.deepEqual(reportScreenshots(parseClientReport(null, 'x'), 2).map((s) => s.n), [1, 2]);
});

test('the PDF says the screenshots are a selection and captions each one', () => {
  const r = parseClientReport('{"title":"t"}', 'x');
  const meta = { projectName: 'Acme', engineer: null, startedAt: new Date('2026-10-01T10:00:00Z'), endedAt: null };
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const pdf = JSON.stringify(buildClientPdfDefinition(r, meta, [{ dataUrl: png, n: 4, caption: 'Disk at 97%' }], 23));
  assert.match(pdf, /1 of the 23 screenshots/);
  assert.match(pdf, /Screenshot 4/);
  assert.match(pdf, /Disk at 97%/);
});
