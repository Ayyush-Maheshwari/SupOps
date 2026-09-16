import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlertmanagerMessage, type SlackMessage } from './parse.ts';

const CH = 'C123';

test('firing alert with an attachment + fields is parsed', () => {
  const msg: SlackMessage = {
    attachments: [
      {
        color: 'danger',
        title: '[FIRING:1] HighCpuLoad (prod)',
        text: 'CPU load is above 90%',
        fields: [
          { title: 'alertname', value: 'HighCpuLoad' },
          { title: 'instance', value: '10.0.0.5:9100' },
          { title: 'severity', value: 'critical' },
        ],
      },
    ],
  };
  const p = parseAlertmanagerMessage(msg, CH);
  assert.equal(p.status, 'firing');
  assert.equal(p.severity, 'critical');
  assert.equal(p.title, 'HighCpuLoad');
  assert.equal(p.labels.instance, '10.0.0.5:9100');
  assert.ok(p.summary?.includes('CPU load'));
});

test('resolved is detected from the [RESOLVED] tag and good colour', () => {
  const msg: SlackMessage = {
    attachments: [{ color: 'good', title: '[RESOLVED] HighCpuLoad', text: 'recovered' }],
  };
  const p = parseAlertmanagerMessage(msg, CH);
  assert.equal(p.status, 'resolved');
});

test('the same alert fingerprints stably across firing and resolved', () => {
  const firing: SlackMessage = {
    attachments: [{ color: 'danger', fields: [
      { title: 'alertname', value: 'DiskFull' },
      { title: 'instance', value: 'db-1' },
    ] }],
  };
  const resolved: SlackMessage = {
    attachments: [{ color: 'good', title: '[RESOLVED] DiskFull', fields: [
      { title: 'alertname', value: 'DiskFull' },
      { title: 'instance', value: 'db-1' },
    ] }],
  };
  assert.equal(
    parseAlertmanagerMessage(firing, CH).fingerprint,
    parseAlertmanagerMessage(resolved, CH).fingerprint,
  );
});

test('the same alert in different channels fingerprints differently', () => {
  const msg: SlackMessage = {
    attachments: [{ fields: [{ title: 'alertname', value: 'X' }, { title: 'instance', value: 'n1' }] }],
  };
  assert.notEqual(
    parseAlertmanagerMessage(msg, 'C1').fingerprint,
    parseAlertmanagerMessage(msg, 'C2').fingerprint,
  );
});

test('severity falls back to colour when no severity label is present', () => {
  const warn = parseAlertmanagerMessage({ attachments: [{ color: 'warning', title: 'Flapping' }] }, CH);
  assert.equal(warn.severity, 'warning');
  const none = parseAlertmanagerMessage({ text: 'just some text' }, CH);
  assert.equal(none.severity, 'unknown');
});

test('a plain-text-only message still yields a title', () => {
  const p = parseAlertmanagerMessage({ text: 'NodeDown on worker-3\nseverity: critical' }, CH);
  assert.equal(p.title, 'NodeDown on worker-3');
  assert.equal(p.severity, 'critical');
});

test('severity is read from a Slack-markdown label line in the body', () => {
  const msg: SlackMessage = {
    text: [
      ':rotating_light: *[FIRING:1]* *ContainerHighMemoryUsage*',
      ':warning: *Alert:* `warning`',
      ':memo: *Description:* Container Memory usage is above 80%',
      '• *alertname:* `ContainerHighMemoryUsage`',
      '• *instance:* `10.130.15.80:10250`',
      '• *severity:* `warning`',
      '• *namespace:* `custom-alert`',
    ].join('\n'),
  };
  const p = parseAlertmanagerMessage(msg, CH);
  assert.equal(p.severity, 'warning');
  assert.equal(p.labels.severity, 'warning');
  assert.equal(p.labels.alertname, 'ContainerHighMemoryUsage');
  assert.equal(p.labels.instance, '10.130.15.80:10250');
});

test('labels on one bullet-separated line are parsed (blackbox template)', () => {
  const msg: SlackMessage = {
    text:
      ':rotating_light: *[FIRING:1]* *ProbeFailing* :warning: *Alert:* `critical` ' +
      ':memo: *Description:* Endpoint is Down <https://10.130.9.99:5601/login> and HTTP Status Code is 0 ' +
      ':mag_right: *Details:* • *alertname:* `ProbeFailing` • *instance:* <https://10.130.9.99:5601/login> ' +
      '• *job:* `blackbox-exporter-http-auth` • *namespace:* `custom-alert` • *severity:* `critical`',
  };
  const p = parseAlertmanagerMessage(msg, CH);
  assert.equal(p.severity, 'critical');
  assert.equal(p.labels.severity, 'critical');
  assert.equal(p.labels.alertname, 'ProbeFailing');
  assert.equal(p.labels.job, 'blackbox-exporter-http-auth');
});

test('severity from an *Alert:* label (no severity key, no colour)', () => {
  const msg: SlackMessage = {
    text:
      ':rotating_light: *[FIRING:1]* *ProbeFailing* :warning: *Alert:* `critical` ' +
      ':memo: *Description:* Endpoint is Down ' +
      ':mag_right: *Details:* • *alertname:* `ProbeFailing` • *job:* `blackbox-exporter-http-auth`',
  };
  assert.equal(parseAlertmanagerMessage(msg, CH).severity, 'critical');
});

test('severity synonyms normalise (warn -> warning, P1 -> critical)', () => {
  assert.equal(parseAlertmanagerMessage({ text: 'severity: warn' }, CH).severity, 'warning');
  assert.equal(parseAlertmanagerMessage({ text: 'priority: P1' }, CH).severity, 'critical');
});
