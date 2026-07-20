#!/usr/bin/env node
/* Focused contract test for POST /api/feedback. No real network or Blob writes. */
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
const writes = [];
global.fetch = async (url, options) => {
  writes.push({ url: String(url), options });
  return { ok: true, status: 200 };
};
const { handleFeedback } = require('../lib/feedback-core');

function request(body, ip) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; Mobile)',
    'x-forwarded-for': ip || '203.0.113.20' };
  req.socket = {};
  return req;
}
function response() {
  let raw = '';
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    end(s) { raw += s || ''; }, json() { return raw ? JSON.parse(raw) : {}; } };
}
async function call(body, ip) {
  const res = response();
  await handleFeedback(request(body, ip), res);
  return res;
}

(async () => {
  let res = await call({ email: ' DAVID@example.com ', message: '  More ferries, please!\r\nThanks. ', source: 'prompt-60s' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/feedback\/\d{4}-\d{2}-\d{2}\/\d+-[a-f0-9]{8}\.json$/);
  const saved = JSON.parse(writes[0].options.body);
  assert.equal(saved.email, 'david@example.com');
  assert.equal(saved.message, 'More ferries, please!\nThanks.');
  assert.equal(saved.device, 'mobile');

  res = await call({ email: '', message: 'Anonymous idea' }, '203.0.113.21');
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(writes[1].options.body).email, null);

  res = await call({ email: 'not-an-email', message: 'Hello' }, '203.0.113.22');
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /valid email/);
  assert.equal(writes.length, 2);

  res = await call({ email: 'bot@example.com', message: 'spam', company: 'Spambots Inc.' }, '203.0.113.23');
  assert.equal(res.statusCode, 200);
  assert.equal(writes.length, 2);

  console.log('feedback endpoint: ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
