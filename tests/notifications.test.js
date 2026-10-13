"use strict";

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createNotifier, NotificationError } = require('../notifications');

const telegram = { TELEGRAM_BOT_TOKEN: 'dummy-token', TELEGRAM_CHAT_ID: '123' };
const slack = { SLACK_BOT_TOKEN: 'dummy-slack-token', SLACK_ROUTINE_CHANNEL_ID: 'CROUTINE1',
  SLACK_ALERTS_CHANNEL_ID: 'CALERTS1' };

function fakeTransport(responses) {
  const calls = [];
  const request = (options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = payload => {
      calls.push({ options, payload: JSON.parse(payload) });
      const next = responses.shift() || { status: 200, body: { ok: true } };
      queueMicrotask(() => {
        if (next.error) return req.emit('error', new Error('secret in transport error'));
        if (next.timeout) return req.emit('timeout');
        const res = new EventEmitter();
        res.statusCode = next.status || 200;
        res.headers = next.headers || {};
        onResponse(res);
        res.emit('data', Buffer.from(typeof next.body === 'string' ? next.body : JSON.stringify(next.body)));
        res.emit('end');
      });
    };
    return req;
  };
  return { request, calls };
}

test('Telegram is the default and needs no Slack configuration', async () => {
  const transport = fakeTransport([]);
  const notifier = createNotifier(telegram, transport);
  await notifier.sendRoutine('📋 <b>오늘</b> <@U123>');
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].options.hostname, 'api.telegram.org');
  assert.equal(transport.calls[0].options.timeout, 8000);
  assert.equal(transport.calls[0].payload.text, '📋 오늘 <@U123>');
  assert.equal(transport.calls[0].payload.parse_mode, undefined);
});

test('Slack-only needs no Telegram credentials and routes routine versus alerts', async () => {
  const transport = fakeTransport([]);
  const notifier = createNotifier({ OPS_NOTIFICATION_BACKEND: 'slack', ...slack }, transport);
  await notifier.sendRoutine('<b>Morning</b> @here <@U123>');
  await notifier.sendAlert('Failure');
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].options.hostname, 'slack.com');
  assert.equal(transport.calls[0].options.path, '/api/chat.postMessage');
  assert.equal(transport.calls[0].payload.channel, 'CROUTINE1');
  assert.equal(transport.calls[1].payload.channel, 'CALERTS1');
  assert.equal(transport.calls[0].payload.text, 'Morning ＠here ＜＠U123＞');
  for (const call of transport.calls) {
    assert.equal(call.payload.mrkdwn, false);
    assert.equal(call.payload.parse, 'none');
    assert.equal(call.payload.link_names, false);
    assert.equal(call.payload.unfurl_links, false);
    assert.equal(call.payload.unfurl_media, false);
  }
});

test('Dual mode attempts both transports, even if the first fails', async () => {
  const transport = fakeTransport([{ status: 200, body: { ok: false, error: 'secret' } },
    { status: 200, body: { ok: true } }]);
  const notifier = createNotifier({ OPS_NOTIFICATION_BACKEND: 'dual', ...telegram, ...slack }, transport);
  await assert.rejects(notifier.sendAlert('Failure'), error => {
    assert.equal(error.message, 'Slack notification failed');
    assert.doesNotMatch(error.message, /secret|dummy/);
    return true;
  });
  assert.deepEqual(transport.calls.map(call => call.options.hostname), ['slack.com', 'api.telegram.org']);
  assert.equal(transport.calls[0].payload.channel, 'CALERTS1');
});

test('Explicit invalid backend and missing active-provider credentials fail closed', () => {
  for (const env of [{ ...telegram, OPS_NOTIFICATION_BACKEND: 'other' },
    { ...telegram, OPS_NOTIFICATION_BACKEND: '' },
    { OPS_NOTIFICATION_BACKEND: 'telegram' },
    { OPS_NOTIFICATION_BACKEND: 'slack', ...telegram },
    { OPS_NOTIFICATION_BACKEND: 'dual', ...slack }]) {
    assert.throws(() => createNotifier(env), NotificationError);
  }
});

test('Messages are bounded and API body details never appear in errors', async () => {
  const transport = fakeTransport([{ status: 200, body: { ok: false, description: 'secret-credential' } }]);
  const notifier = createNotifier(telegram, transport);
  await assert.rejects(notifier.sendRoutine('x'.repeat(4000)), error => {
    assert.equal(error.message, 'Telegram notification failed');
    assert.doesNotMatch(error.message, /secret-credential|dummy-token/);
    return true;
  });
  assert.equal(transport.calls[0].payload.text.length, 3000);
});

test('Credential-shaped values and configured secrets are removed before truncation on all backends', async () => {
  const fake = 'fixture-only-credential-ABCD1234';
  const message = `업무 제목 https://example.test/work?view=week&api_key=${fake} ` +
    `password = "${fake}" api-key: ${fake} apikey=${fake} passwd=${fake} ` +
    `secret: '${fake}' token=${fake} authorization: Bearer ${fake} ` +
    `Cookie: session=${fake}; Path=/; ${fake}`;
  for (const backend of ['telegram', 'slack', 'dual']) {
    const transport = fakeTransport([]);
    const notifier = createNotifier({ OPS_NOTIFICATION_BACKEND: backend, ...telegram, ...slack,
      CUSTOM_SECRET: fake }, transport);
    await notifier.sendAlert(message);
    assert.equal(transport.calls.length, backend === 'dual' ? 2 : 1);
    for (const call of transport.calls) {
      assert.doesNotMatch(call.payload.text, /fixture-only-credential-ABCD1234/);
      assert.match(call.payload.text, /업무 제목/);
      assert.match(call.payload.text, /example\.test/);
      assert.ok(call.payload.text.length <= 3000);
    }
  }
});

test('Unconfigured secrets in JSON, quoted fields, headers and query strings are redacted', async () => {
  const secret = 'fixture-private-abc';
  const samples = [
    `{"api_key":"${secret}"}`,
    `{"password": "${secret} with spaces"}`,
    `passwd='${secret} with spaces'`,
    `api-key = ${secret}`,
    `apikey=${secret}`,
    `https://example.test/work?view=week&token=${secret}&tab=mine`,
    `authorization: Bearer ${secret}`,
    `Cookie: session=${secret}; other=fixture-other`,
    `{"Cookie":"session=${secret}; other=fixture-other"}`,
    `https://example.test/work?view=week&cookie=session%3D${secret}&tab=mine`,
    `Bearer ${secret}`,
  ];
  for (const backend of ['telegram', 'slack', 'dual']) {
    const transport = fakeTransport([]);
    const notifier = createNotifier({ OPS_NOTIFICATION_BACKEND: backend, ...telegram, ...slack }, transport);
    await notifier.sendAlert(`오늘 업무 https://example.test/work\n${samples.join('\n')}`);
    for (const call of transport.calls) {
      assert.doesNotMatch(call.payload.text, /fixture-private-abc|fixture-other|with spaces/);
      assert.match(call.payload.text, /오늘 업무/);
      assert.match(call.payload.text, /example\.test\/work/);
    }
  }
});

test('Timeout, network error and 5xx fail without replay', async () => {
  for (const response of [{ timeout: true }, { error: true }, { status: 503, body: 'secret-body' }]) {
    const transport = fakeTransport([response]);
    const notifier = createNotifier({ OPS_NOTIFICATION_BACKEND: 'slack', ...slack }, transport);
    await assert.rejects(notifier.sendRoutine('test'), /Slack notification failed/);
    assert.equal(transport.calls.length, 1);
  }
});

test('Only a bounded 429 receives one retry', async () => {
  const sleeps = [];
  const transport = fakeTransport([{ status: 429, headers: { 'retry-after': '2' }, body: {} },
    { status: 200, body: { ok: true } }]);
  const notifier = createNotifier(telegram, { request: transport.request, sleep: ms => { sleeps.push(ms); } });
  await notifier.sendRoutine('test');
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);

  const long = fakeTransport([{ status: 429, headers: { 'retry-after': '30' }, body: {} }]);
  const noRetry = createNotifier(telegram, { request: long.request, sleep: () => assert.fail('must not sleep') });
  await assert.rejects(noRetry.sendRoutine('test'), /Telegram notification failed/);
  assert.equal(long.calls.length, 1);
});

test('Oversize and malformed responses fail safely', async () => {
  for (const response of [{ status: 200, body: 'x'.repeat(65537) },
    { status: 200, body: 'not-json' }]) {
    const transport = fakeTransport([response]);
    const notifier = createNotifier(telegram, transport);
    await assert.rejects(notifier.sendRoutine('test'), /Telegram notification failed/);
    assert.equal(transport.calls.length, 1);
  }
});
