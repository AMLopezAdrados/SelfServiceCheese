import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { SumUpClient } from '../src/sumup.ts';
import { startFakePos, type FakePos } from './fake-pos.ts';

// The kiosk server end to end over HTTP: a virtual Solo (SUMUP_MOCK) and a
// stand-in POS that behaves like the real one.
//   npm test

const DELAY = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(overrides: Partial<Config> = {}, posUrl = ''): Config {
  const base = loadConfig({
    SUMUP_MOCK: 'true',
    SUMUP_MOCK_DELAY_MS: String(DELAY),
    POS_URL: posUrl,
    POS_USERNAME: 'kiosk',
    POS_PIN: '2468',
    KIOSK_STAFF_PIN: '4321',
    KIOSK_DATA_DIR: '',
  });
  return { ...base, ...overrides };
}

async function start(cfgOverrides: Partial<Config> = {}, sumupDelay = DELAY, ordersOpts = {}) {
  const sumup = new SumUpClient({ ...config().sumup, mockDelayMs: sumupDelay });
  const pos = await startFakePos(sumup);
  const cfg = config(cfgOverrides, pos.url);
  const { app, orders } = createApp(cfg, { sumup, orders: { stuckAfterMs: 3000, cancelWaitMs: 1500, cancelPollMs: 100, ...ordersOpts } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return {
    sumup, pos, orders, call,
    close: async () => { orders.stop(); server.close(); await pos.close(); },
  };
}

let k: Awaited<ReturnType<typeof start>>;
let fakePos: FakePos;
let catalogue: { products: { id: string; name: string; price: number }[]; currency: string; rate: number };
const productId = (name: string) => catalogue.products.find((p) => p.name === name)!.id;
// 2 × Gouda oud ($14) + 1 × Mosterd grof ($6) = $34.00 → €30.60 at 0.9
const order34 = () => ({ lines: [{ product_id: productId('Gouda oud'), qty: 2 }, { product_id: productId('Mosterd grof'), qty: 1 }] });

test.before(async () => {
  k = await start();
  fakePos = k.pos;
  catalogue = (await k.call('GET', '/api/catalogue')).json;
});
test.after(async () => {
  await k.close();
});

test('status: ready with the POS event, its currency and rate, and the Solo online', async () => {
  const s = (await k.call('GET', '/api/status')).json;
  assert.equal(s.live, true);
  assert.deepEqual([s.pos.event, s.pos.currency, s.pos.rate, s.pos.products], ['BX Ramstein', 'USD', 0.9, 3]);
  assert.equal(s.sumup.reader.status, 'ONLINE');
  assert.equal(catalogue.currency, 'USD');
});

test('an order is priced from the POS price list, recorded in the POS and put on the Solo in EUR', async () => {
  // The browser sends ids and quantities only; any price it sends is ignored.
  const created = await k.call('POST', '/api/orders', { lines: [...order34().lines.map((l) => ({ ...l, price: 0.01 }))] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual([created.json.amount_local, created.json.currency, created.json.amount_eur], [34, 'USD', 30.6]);

  const sale = [...fakePos.sales.values()].at(-1)!;
  assert.deepEqual(sale.items.map((i) => [i.name_at_sale, i.unit_price_at_sale, i.qty]), [['Gouda oud', 14, 2], ['Mosterd grof', 6, 1]]);
  assert.equal(created.json.reference, sale.id.slice(0, 8).toUpperCase());

  const sent = k.sumup.sent.at(-1)!.body as any;
  assert.deepEqual(sent.total_amount, { currency: 'EUR', minor_unit: 2, value: 3060 });
  assert.equal(sent.affiliate.foreign_transaction_id, sale.id);
  assert.equal(sent.return_url, undefined, 'no return_url without a public https address');
  await sleep(DELAY + 100);
  await k.call('POST', `/api/orders/${created.json.id}/poll`);
});

test('customer pays: waiting with the Solo asking for a card, then paid, confirmed by the POS, with card details', async () => {
  const { json: o } = await k.call('POST', '/api/orders', order34());
  const first = (await k.call('POST', `/api/orders/${o.id}/poll`)).json;
  assert.equal(first.state, 'waiting');
  assert.equal(first.reader.state, 'WAITING_FOR_CARD');
  await sleep(DELAY + 100);
  const done = (await k.call('POST', `/api/orders/${o.id}/poll`)).json;
  assert.equal(done.state, 'paid');
  assert.equal(done.pos_confirmed, true);
  assert.deepEqual([done.card.type, done.card.last4], ['VISA', '4242']);
  assert.equal([...fakePos.sales.values()].at(-1)!.status, 'completed');
});

test('paid at SumUp but the POS cannot verify yet: the customer is done, the POS confirmation follows later', async () => {
  fakePos.canVerify = false;
  const { json: o } = await k.call('POST', '/api/orders', order34());
  await sleep(DELAY + 100);
  const done = (await k.call('POST', `/api/orders/${o.id}/poll`)).json;
  assert.equal(done.state, 'paid');
  assert.equal(done.pos_confirmed, false);
  fakePos.canVerify = true;
  await k.orders.refresh(o.id); // what the background loop does
  assert.equal(k.orders.get(o.id).posConfirmed, true);
});

test('declined card: failed, and the POS sale is closed', async () => {
  k.sumup.setMockOutcome('declined');
  try {
    const { json: o } = await k.call('POST', '/api/orders', order34());
    await sleep(DELAY + 100);
    const r = (await k.call('POST', `/api/orders/${o.id}/poll`)).json;
    assert.deepEqual([r.state, r.failure], ['failed', 'declined']);
    assert.equal([...fakePos.sales.values()].at(-1)!.status, 'cancelled');
  } finally {
    k.sumup.setMockOutcome(null);
  }
});

test('customer walks away: the Solo times out, failed/timeout, the POS sale is closed', async () => {
  k.sumup.setMockOutcome('timeout');
  try {
    const { json: o } = await k.call('POST', '/api/orders', order34());
    await sleep(DELAY + 100);
    const r = (await k.call('POST', `/api/orders/${o.id}/poll`)).json;
    assert.deepEqual([r.state, r.failure], ['failed', 'timeout']);
    assert.equal([...fakePos.sales.values()].at(-1)!.status, 'cancelled');
  } finally {
    k.sumup.setMockOutcome(null);
  }
});

test('"Cancel payment": the Solo is stopped, failed/cancelled, the POS sale closed, the reader free again', async () => {
  const { json: o } = await k.call('POST', '/api/orders', order34());
  const r = (await k.call('POST', `/api/orders/${o.id}/cancel`)).json;
  assert.deepEqual([r.state, r.failure, r.terminate_error], ['failed', 'cancelled', null]);
  assert.equal([...fakePos.sales.values()].at(-1)!.status, 'cancelled');
  const next = await k.call('POST', '/api/orders', order34());
  assert.equal(next.status, 201);
  await sleep(DELAY + 100);
  await k.call('POST', `/api/orders/${next.json.id}/poll`);
});

test('Solo offline: 409 with the reason, and the POS sale is closed again', async () => {
  k.sumup.setMockOutcome('offline');
  try {
    const before = fakePos.sales.size;
    const r = await k.call('POST', '/api/orders', order34());
    assert.equal(r.status, 409);
    assert.match(r.json.error, /offline/);
    assert.equal(fakePos.sales.size, before + 1);
    assert.equal([...fakePos.sales.values()].at(-1)!.status, 'cancelled');
  } finally {
    k.sumup.setMockOutcome(null);
  }
});

test('bad orders never reach the POS', async () => {
  const before = fakePos.sales.size;
  assert.equal((await k.call('POST', '/api/orders', { lines: [] })).status, 400);
  assert.equal((await k.call('POST', '/api/orders', { lines: [{ product_id: 'nope', qty: 1 }] })).status, 400);
  assert.equal((await k.call('POST', '/api/orders', { lines: [{ product_id: productId('Gouda oud'), qty: 0.5 }] })).status, 400);
  assert.equal(fakePos.sales.size, before);
});

test('SumUp webhook: no kiosk key needed, and it settles the order without a poll', async () => {
  const { json: o } = await k.call('POST', '/api/orders', order34());
  await sleep(DELAY + 100);
  const hook = await k.call('POST', `/api/sumup/webhook/${o.id}`, { event_type: 'solo.transaction.updated', payload: { status: 'successful' } });
  assert.equal(hook.status, 204);
  assert.equal(k.orders.get(o.id).state, 'paid');
  assert.equal((await k.call('POST', '/api/sumup/webhook/unknown', {})).status, 204);
});

test('an expired POS session is renewed transparently', async () => {
  const logins = fakePos.logins;
  fakePos.expireSessions();
  const c = await k.call('GET', '/api/catalogue');
  assert.equal(c.status, 200);
  const { status } = await k.call('POST', '/api/orders', order34());
  assert.equal(status, 201);
  assert.equal(fakePos.logins, logins + 1);
  await sleep(DELAY + 100);
});

test('staff PIN is checked on the server', async () => {
  assert.equal((await k.call('POST', '/api/staff-pin', { pin: '4321' })).json.ok, true);
  assert.equal((await k.call('POST', '/api/staff-pin', { pin: '1234' })).json.ok, false);
});

test('with KIOSK_ACCESS_KEY: the API needs the key, SumUp\'s webhook does not', async () => {
  const locked = await start({ accessKey: 'secret-key', publicUrl: 'https://kiosk.test' });
  try {
    assert.equal((await locked.call('GET', '/api/status')).status, 401);
    assert.equal((await locked.call('GET', '/api/status', undefined, { 'x-kiosk-key': 'wrong' })).status, 401);
    assert.equal((await locked.call('GET', '/api/status', undefined, { 'x-kiosk-key': 'secret-key' })).status, 200);
    assert.equal((await locked.call('POST', '/api/sumup/webhook/x', {})).status, 204);
    // With a public https address SumUp gets a return_url.
    const cat = (await locked.call('GET', '/api/catalogue', undefined, { 'x-kiosk-key': 'secret-key' })).json;
    const created = await locked.call('POST', '/api/orders', { lines: [{ product_id: cat.products[0].id, qty: 1 }] }, { 'x-kiosk-key': 'secret-key' });
    assert.equal((locked.sumup.sent.at(-1)!.body as any).return_url, `https://kiosk.test/api/sumup/webhook/${created.json.id}`);
  } finally {
    await locked.close();
  }
});

test('SumUp never answers: the order becomes "stuck" for staff instead of letting the customer pay twice', async () => {
  const slow = await start({}, 60_000, { stuckAfterMs: 300 });
  try {
    const cat = (await slow.call('GET', '/api/catalogue')).json;
    const { json: o } = await slow.call('POST', '/api/orders', { lines: [{ product_id: cat.products[0].id, qty: 1 }] });
    await sleep(400);
    assert.equal((await slow.call('POST', `/api/orders/${o.id}/poll`)).json.state, 'stuck');
  } finally {
    await slow.close();
  }
});

test('assortment: staff switch categories and products off; the kiosk hides them and refuses to sell them', async () => {
  const pin = { 'x-staff-pin': '4321' };
  assert.equal((await k.call('GET', '/api/admin/assortment')).status, 403);
  assert.equal((await k.call('GET', '/api/admin/assortment', undefined, { 'x-staff-pin': '0000' })).status, 403);
  const all = (await k.call('GET', '/api/admin/assortment', undefined, pin)).json;
  assert.deepEqual(all.categories.map((c: any) => [c.name, c.enabled, c.products.length]), [['kaas', true, 2], ['mosterd', true, 1]]);

  const mosterd = all.categories.find((c: any) => c.name === 'mosterd');
  const jong = all.categories.find((c: any) => c.name === 'kaas').products.find((p: any) => p.name === 'Gouda jong');
  const saved = await k.call('PUT', '/api/admin/assortment', { disabled_categories: [mosterd.id], disabled_products: [jong.id] }, pin);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.visible_products, 1);

  const shown = (await k.call('GET', '/api/catalogue')).json;
  assert.deepEqual(shown.products.map((p: any) => p.name), ['Gouda oud']);
  const refused = await k.call('POST', '/api/orders', { lines: [{ product_id: jong.id, qty: 1 }] });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /not available/);
  assert.equal((await k.call('GET', '/api/status')).json.pos.products, 1);

  assert.equal((await k.call('PUT', '/api/admin/assortment', { disabled_categories: 'x', disabled_products: [] }, pin)).status, 400);
  await k.call('PUT', '/api/admin/assortment', { disabled_categories: [], disabled_products: [] }, pin);
  assert.equal((await k.call('GET', '/api/catalogue')).json.products.length, 3);
});

test('assortment is kept in a file and survives a restart', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { AssortmentStore } = await import('../src/assortment.ts');
  const file = join(mkdtempSync(join(tmpdir(), 'kiosk-')), 'sub', 'assortment.json');
  new AssortmentStore(file).save(['cat-1'], ['prod-1', 'prod-1']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).disabledProducts, ['prod-1']);
  const again = new AssortmentStore(file).get();
  assert.deepEqual([again.disabledCategories, again.disabledProducts], [['cat-1'], ['prod-1']]);
});
