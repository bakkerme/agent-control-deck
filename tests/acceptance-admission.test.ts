import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pricingBound, reserveBatch, financialPreflight, HISTORICAL_RESERVE_USD, LIVE_REQUESTS, RESERVE_USD, HEADROOM_USD } from '../scripts/embedded-acceptance/admission';
import { ACCEPTANCE_MODEL } from '../scripts/embedded-acceptance/gateway';
const model = { id: ACCEPTANCE_MODEL, context_length: 1000, top_provider: { max_completion_tokens: 1000 }, pricing: { prompt: '0.0001', completion: '0.0002' } };
test('pricing includes additive cache/reasoning, fixed fees and all time overrides', () => {
  const result = pricingBound({ ...model, pricing: { ...model.pricing, request: '0.1', overrides: [{ prompt: '0.0002', completion: '0.0003', input_cache_write: '0.0001', internal_reasoning: '0.0001' }] } });
  assert.ok(Math.abs(result.bound - 0.8) < 1e-10);
  for (const extra of [{ image: '1' }, { web_search: '1' }, { new_fee: '0.1' }, { request: '-1' }, { completion: 'NaN' }, { prompt: '' }]) assert.throws(() => pricingBound({ ...model, pricing: { ...model.pricing, ...extra } }));
  assert.throws(() => pricingBound({ ...model, context_length: undefined }));
  assert.throws(() => pricingBound({ ...model, pricing: { prompt: '1', completion: '1' } }));
  assert.equal(pricingBound({ ...model, pricing: { ...model.pricing, overrides: [{ min_prompt_tokens: 500, prompt: '0.0002', completion: '0.0003' }] } }).bound, 0.5);
  assert.throws(() => pricingBound({ ...model, pricing: { ...model.pricing, min_prompt_tokens: -1 } }));
});
test('fresh preflight fails closed on accounting, unsupported fees and expensive fallback endpoints', async () => {
  const original = globalThis.fetch;
  let forwards = 0;
  try {
    for (const scenario of ['pass','unavailable','overspent','invalid','fee','fallback']) {
      globalThis.fetch = (async (url: string) => {
        forwards++;
        if (url.endsWith('/key')) return new Response(JSON.stringify({ data: { usage: scenario === 'overspent' ? 1 : scenario === 'invalid' ? 'NaN' : 0.001, limit: 20, limit_remaining: 19.999 } }), { status: scenario === 'unavailable' ? 503 : 200 });
        if (url.endsWith('/endpoints')) return new Response(JSON.stringify({ data: { endpoints: [{ provider_name: 'DeepSeek', context_length: 1000, max_completion_tokens: 1000, pricing: model.pricing }, { provider_name: 'Other', context_length: 1000, max_completion_tokens: 1000, pricing: { ...model.pricing, prompt: scenario === 'fallback' ? '1' : '0.0001' } }] } }));
        return new Response(JSON.stringify({ data: [{ ...model, pricing: { ...model.pricing, web_search: scenario === 'fee' ? '1' : '0' } }] }));
      }) as typeof fetch;
      if (scenario === 'pass') {
        const admission = await financialPreflight('synthetic-test-only');
        assert.ok(Math.abs(admission.committedUsd - 19.851) < 1e-10); assert.ok(admission.allEndpointClampedMaximumUsd < 0.8);
      } else await assert.rejects(financialPreflight('synthetic-test-only'));
    }
    assert.ok(forwards > 0);
  } finally { globalThis.fetch = original; }
});
test('durable whole-batch reservation refuses a second coordinator and survives completion', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'acd-admission-')), path = join(root,'reservation.json');
  const evidence = { usage: 0.001348632, historicalReserveUsd: HISTORICAL_RESERVE_USD, batchUsd: LIVE_REQUESTS * RESERVE_USD, headroomUsd: HEADROOM_USD } as any;
  try {
    reserveBatch(path, evidence);
    assert.throws(() => reserveBatch(path, evidence), { code: 'EEXIST' });
    const stored = JSON.parse(readFileSync(path,'utf8'));
    assert.equal(stored.maxRequests, 2); assert.equal(stored.batchUsd, 1.6);
    assert.equal(stored.status, 'reserved-retain-after-all-outcomes');
    assert.ok(stored.usage + stored.historicalReserveUsd + stored.batchUsd + stored.headroomUsd < 20);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
