"use strict";

const https = require('https');

const MAX_MESSAGE_LENGTH = 3000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRY_AFTER_SECONDS = 3;
const SLACK_HOST = 'slack.com';

class NotificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotificationError';
  }
}

function configuration(env) {
  const backend = env.OPS_NOTIFICATION_BACKEND === undefined ? 'telegram' : env.OPS_NOTIFICATION_BACKEND;
  if (!['telegram', 'slack', 'dual'].includes(backend)) {
    throw new NotificationError('Unsupported notification backend');
  }
  if (['telegram', 'dual'].includes(backend) && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) {
    throw new NotificationError('Missing Telegram notification configuration');
  }
  if (['slack', 'dual'].includes(backend)) {
    if (!env.SLACK_BOT_TOKEN || !/^[CGD][A-Z0-9]+$/.test(env.SLACK_ROUTINE_CHANNEL_ID || '') ||
        !/^[CGD][A-Z0-9]+$/.test(env.SLACK_ALERTS_CHANNEL_ID || '')) {
      throw new NotificationError('Missing or invalid Slack notification configuration');
    }
  }
  return backend;
}

function redactText(message, env) {
  // Redact complete quoted values first: a word-based replacement leaves the
  // remainder of `password="two words"` visible. Keep the quote pair so JSON
  // and human-readable summaries remain intelligible.
  const field = String.raw`["']?(?:api[_-]?key|password|passwd|secret|token|authorization|set-cookie|cookie)["']?\s*[:=]\s*`;
  let safe = message
    .replace(/(\b(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(new RegExp(`(${field})"(?:\\\\.|[^"\\\\])*"`, 'gi'), '$1"[REDACTED]"')
    .replace(new RegExp(`(${field})'(?:\\\\.|[^'\\\\])*'`, 'gi'), "$1'[REDACTED]'")
    .replace(new RegExp(`(${field})(?:Bearer\\s+)?[^\\s"'&,;}\\]]+`, 'gi'), '$1[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|\d{8,}:[A-Za-z0-9_-]{30,})\b/g, '[REDACTED]');
  for (const [key, value] of Object.entries(env)) {
    if (/(?:TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|WEBHOOK)/i.test(key) &&
        typeof value === 'string' && value.length >= 4) {
      safe = safe.split(value).join('[REDACTED]');
    }
  }
  return safe;
}

function boundedText(message, env) {
  if (typeof message !== 'string') throw new NotificationError('Invalid notification text');
  // The historical template used only <b> tags. Send plain text so Notion titles
  // cannot inject either Telegram HTML or Slack formatting.
  return Array.from(redactText(message.replace(/<\/?b>/gi, ''), env)).slice(0, MAX_MESSAGE_LENGTH).join('');
}

function slackText(message) {
  // Even direct mention syntax and @here/@channel are inert in the Slack copy.
  return message.replace(/@/g, '＠').replace(/</g, '＜').replace(/>/g, '＞');
}

function retryAfter(headers) {
  const raw = headers && headers['retry-after'];
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

function requestJson(options, payload, request = https.request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const req = request({ ...options, timeout: REQUEST_TIMEOUT_MS }, res => {
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish(new NotificationError('Notification response too large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on('error', () => finish(new NotificationError('Notification response failed')));
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode || 0;
        if (status === 429) {
          const error = new NotificationError('Notification rate limited');
          error.retryAfter = retryAfter(res.headers);
          finish(error);
          return;
        }
        if (status < 200 || status >= 300) {
          finish(new NotificationError(`Notification HTTP ${status}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Invalid JSON object');
          }
          finish(null, parsed);
        } catch (_) {
          finish(new NotificationError('Invalid notification response'));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish(new NotificationError('Notification timed out'));
    });
    req.on('error', () => finish(new NotificationError('Notification transport failed')));
    deadline = setTimeout(() => {
      req.destroy();
      finish(new NotificationError('Notification timed out'));
    }, REQUEST_TIMEOUT_MS);
    req.end(payload);
  });
}

async function sendWithBoundedRetry(options, payload, request, sleep) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await requestJson(options, payload, request);
      if (result.ok !== true) throw new NotificationError('Notification API rejected message');
      return;
    } catch (error) {
      // A 429 is known not to have accepted the message. Other errors can have
      // an unknown delivery outcome, so they are never automatically replayed.
      if (error.retryAfter !== undefined && error.retryAfter !== null && attempt === 0) {
        await sleep(error.retryAfter * 1000);
        continue;
      }
      throw error;
    }
  }
}

function createNotifier(env, { request = https.request, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const backend = configuration(env);
  async function send(message, kind) {
    if (kind !== 'routine' && kind !== 'alerts') throw new NotificationError('Invalid notification destination');
    const plain = boundedText(message, env);
    const failures = [];
    if (backend === 'slack' || backend === 'dual') {
      const channel = kind === 'routine' ? env.SLACK_ROUTINE_CHANNEL_ID : env.SLACK_ALERTS_CHANNEL_ID;
      const payload = JSON.stringify({ channel, text: slackText(plain), mrkdwn: false,
        parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
      try {
        await sendWithBoundedRetry({ hostname: SLACK_HOST, path: '/api/chat.postMessage', method: 'POST',
          headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' } },
        payload, request, sleep);
      } catch (_) {
        failures.push('Slack notification failed');
      }
    }
    if (backend === 'telegram' || backend === 'dual') {
      const payload = JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: plain,
        disable_web_page_preview: true });
      try {
        await sendWithBoundedRetry({ hostname: 'api.telegram.org',
          path: `/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST',
          headers: { 'Content-Type': 'application/json' } }, payload, request, sleep);
      } catch (_) {
        failures.push('Telegram notification failed');
      }
    }
    if (failures.length) throw new NotificationError(failures.join('; '));
  }
  return {
    sendRoutine: message => send(message, 'routine'),
    sendAlert: message => send(message, 'alerts'),
  };
}

module.exports = { createNotifier, NotificationError };
