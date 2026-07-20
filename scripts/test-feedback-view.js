#!/usr/bin/env node
/* Contract test for the AGENT_LOG_KEY-protected feedback reader. */
const assert = require('node:assert/strict');

process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
process.env.AGENT_LOG_KEY = 'test-viewer-key';
const saved = {
  'https://private.test/one': { v:1, ts:Date.parse('2026-07-20T15:00:00Z'), email:'a@example.com', message:'More ferries', device:'mobile', source:'prompt-60s' },
  'https://private.test/two': { v:1, ts:Date.parse('2026-07-19T14:00:00Z'), email:null, message:'Love the buildings', device:'desktop', source:'prompt-60s' }
};
global.fetch = async url => {
  const raw = String(url);
  if (saved[raw]) return { ok:true, status:200, json:async () => saved[raw] };
  const prefix = new URL(raw).searchParams.get('prefix');
  const all = [
    { pathname:'feedback/2026-07-20/1-a.json', downloadUrl:'https://private.test/one', size:120 },
    { pathname:'feedback/2026-07-19/2-b.json', downloadUrl:'https://private.test/two', size:110 }
  ];
  return { ok:true, status:200, json:async () => ({ blobs:all.filter(b => b.pathname.startsWith(prefix)), hasMore:false }) };
};
const { handleFeedbackView } = require('../lib/feedback-view');

function req(query, ip) { return { method:'GET', url:'/api/feedback-log?'+query,
  headers:{ 'x-forwarded-for':ip || '203.0.113.50' }, socket:{} }; }
function res() {
  let raw=''; return { statusCode:200, headers:{}, writeHead(code,headers){ this.statusCode=code; Object.assign(this.headers,headers||{}); },
    end(value){ raw += value || ''; }, json(){ return raw ? JSON.parse(raw) : {}; } };
}
async function call(query,ip) { const response=res(); await handleFeedbackView(req(query,ip),response); return response; }

(async () => {
  let response = await call('days=1&key=wrong','203.0.113.51');
  assert.equal(response.statusCode,401);
  assert.equal(response.json().error,'unauthorized');

  response = await call('days=1&key=test-viewer-key','203.0.113.52');
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),{ days:['2026-07-20','2026-07-19'], count:2 });

  response = await call('day=2026-07-20&key=test-viewer-key','203.0.113.52');
  assert.equal(response.statusCode,200);
  const body = response.json();
  assert.equal(body.count,1);
  assert.equal(body.responses[0].email,'a@example.com');
  assert.equal(body.responses[0].message,'More ferries');
  assert.doesNotMatch(JSON.stringify(body),/private\.test|downloadUrl|pathname/);
  console.log('feedback viewer: ok');
})().catch(e => { console.error(e); process.exitCode=1; });
