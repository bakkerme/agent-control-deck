// Backend-only admission. Contains numeric accounting only, never credentials.
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { ACCEPTANCE_MODEL } from './gateway';
export const LIVE_REQUESTS = 2, RESERVE_USD = 0.8, HEADROOM_USD = 2;
// Keep the entire historical nine-query envelope, plus its separate smoke reserve.
// Completed-run evidence permits reconciliation, but no lagging bill releases funds.
export const HISTORICAL_RESERVE_USD = 16.25;
export function pricingBound(model: any) {
  assert.equal(model?.id, ACCEPTANCE_MODEL, 'Pinned model absent');
  const context = model.context_length, output = model.top_provider?.max_completion_tokens;
  assert.ok(Number.isInteger(context) && context > 0 && Number.isInteger(output) && output > 0, 'Missing context/output bound');
  const rows = [model.pricing, ...(model.pricing?.overrides ?? [])];
  let inputRate = 0, outputRate = 0, fixed = 0;
  for (const row of rows) {
    let inputSum = 0, outputSum = 0;
    assert.ok(row && typeof row === 'object', 'Missing pricing');
    for (const [key, value] of Object.entries(row)) {
      if (['overrides','utc_days','utc_start','utc_end'].includes(key)) continue;
      if (key === 'discount') { assert.ok(typeof value === 'number' && value >= 0 && value <= 1, 'Invalid discount'); continue; } // Never subtract discounts.
      assert.ok(typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0, 'Invalid price');
      const price = Number(value);
      if (['prompt','input_cache_read','input_cache_write'].includes(key)) inputSum += price;
      else if (['completion','internal_reasoning'].includes(key)) outputSum += price;
      else if (key === 'request') fixed = Math.max(fixed, price);
      else assert.equal(price, 0, 'Unsupported nonzero charge component: '+key);
    }
    assert.ok(typeof row.prompt === 'string' && typeof row.completion === 'string', 'Missing token pricing');
    inputRate = Math.max(inputRate, inputSum); outputRate = Math.max(outputRate, outputSum);
  }
  const bound = context * inputRate + output * outputRate + fixed;
  assert.ok(Number.isFinite(bound) && bound <= RESERVE_USD, 'Full context/output reservation insufficient');
  return { bound, context, output, inputRate, outputRate, fixed, pricing: rows };
}
export async function financialPreflight(token: string | undefined) {
  assert.ok(token, 'Backend runtime injection unavailable');
  const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, 'Fresh provider accounting unavailable');
  const data = (await response.json() as any).data;
  const usage = Number(data.usage), remaining = Number(data.limit_remaining), limit = Number(data.limit);
  assert.ok([usage,remaining,limit].every(Number.isFinite) && usage >= 0 && remaining >= 0 && limit > 0 && limit <= 20, 'Invalid shared provider cap/accounting');
  const batchUsd = LIVE_REQUESTS * RESERVE_USD;
  const committedUsd = usage + HISTORICAL_RESERVE_USD + batchUsd + HEADROOM_USD;
  assert.ok(committedUsd <= limit && remaining >= HISTORICAL_RESERVE_USD + batchUsd + HEADROOM_USD, 'Shared cap cannot admit historical envelopes plus whole batch and headroom');
  const catalog = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
  assert.equal(catalog.status, 200, 'Current model pricing unavailable');
  const model = (await catalog.json() as any).data?.find((m: any) => m.id === ACCEPTANCE_MODEL);
  const endpoints = await fetch('https://openrouter.ai/api/v1/models/'+ACCEPTANCE_MODEL+'/endpoints', { signal: AbortSignal.timeout(10000) });
  assert.equal(endpoints.status, 200, 'Provider-specific pricing unavailable');
  const allEndpoints = (await endpoints.json() as any).data?.endpoints;
  assert.ok(Array.isArray(allEndpoints) && allEndpoints.length > 0, 'Missing endpoint pricing');
  // Also bound every listed endpoint at the independently enforced 512 output
  // limit, so budgeting does not depend on optional routing fields being honored.
  const allEndpointBounds = allEndpoints.map((e: any) => pricingBound({ id: ACCEPTANCE_MODEL, context_length: e.context_length, top_provider: { max_completion_tokens: Math.min(512, e.max_completion_tokens) }, pricing: e.pricing }).bound);
  const selected = allEndpoints.filter((e: any) => e.provider_name === 'DeepSeek');
  assert.ok(selected?.length === 1, 'Pinned provider endpoint absent or ambiguous');
  const endpoint = selected[0];
  const endpointPricing = pricingBound({ id: ACCEPTANCE_MODEL, context_length: endpoint.context_length, top_provider: { max_completion_tokens: endpoint.max_completion_tokens }, pricing: endpoint.pricing });
  return { checkedAt: new Date().toISOString(), usage, remaining, limit, historicalReserveUsd: HISTORICAL_RESERVE_USD, batchUsd, headroomUsd: HEADROOM_USD, committedUsd, pricing: pricingBound(model), provider: 'DeepSeek', endpointPricing, allEndpointClampedMaximumUsd: Math.max(...allEndpointBounds) };
}
export function reserveBatch(path: string, evidence: Awaited<ReturnType<typeof financialPreflight>>) {
  // Exclusive durable creation: reruns and concurrent coordinators fail closed.
  // Never auto-delete/release this record after success, timeout or crash.
  const directory = resolve(path, '..'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ version: 1, status: 'reserved-retain-after-all-outcomes', maxRequests: LIVE_REQUESTS, reservationPerRequestUsd: RESERVE_USD, ...evidence }, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  const parent = openSync(directory, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
