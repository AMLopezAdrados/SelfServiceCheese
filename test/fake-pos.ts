import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { SumUpClient } from '../src/sumup.ts';

// A stand-in for the Olga's Cheese POS with exactly the endpoints the kiosk
// uses, behaving like the real ones: amount_eur from the open day's rate,
// sumup-check and sumup-cancel asking "SumUp" (here: the virtual Solo's
// transaction record) before deciding anything.

export interface FakeSale {
  id: string;
  items: { product_id: string; name_at_sale: string; unit_price_at_sale: number; qty: number }[];
  amount_local: number;
  amount_eur: number;
  currency: string;
  status: 'pending_payment' | 'completed' | 'payment_failed' | 'cancelled';
}

export interface FakePos {
  url: string;
  sales: Map<string, FakeSale>;
  logins: number;
  canVerify: boolean; // false = the POS has no SumUp link (sumup-check stays "checking")
  expireSessions(): void;
  close(): Promise<void>;
}

export async function startFakePos(sumup: SumUpClient): Promise<FakePos> {
  const app = express();
  app.use(express.json());
  const tokens = new Set<string>();
  const event = { id: randomUUID(), name: 'BX Ramstein', display_name: 'BX Ramstein', sales_mode: 'bx', open_day_count: 1 };
  const kaas = randomUUID();
  const mosterd = randomUUID();
  const prices = [
    { product_id: randomUUID(), name: 'Gouda oud', category: 'kaas', category_id: kaas, price: '14.00' },
    { product_id: randomUUID(), name: 'Gouda jong', category: 'kaas', category_id: kaas, price: '11.00' },
    { product_id: randomUUID(), name: 'Mosterd grof', category: 'mosterd', category_id: mosterd, price: '6.00' },
  ];
  const state: FakePos = {
    url: '',
    sales: new Map(),
    logins: 0,
    canVerify: true,
    expireSessions: () => tokens.clear(),
    close: async () => {},
  };

  app.post('/auth/login', (req, res) => {
    if (req.body?.username !== 'kiosk' || req.body?.pin !== '2468') return void res.status(401).json({ error: 'Ongeldige gebruikersnaam of PIN' });
    state.logins += 1;
    const token = randomUUID();
    tokens.add(token);
    res.json({ token, cashier_id: 'kiosk' });
  });
  app.use((req, res, next) => {
    const token = (req.header('authorization') ?? '').replace('Bearer ', '');
    if (!tokens.has(token)) return void res.status(401).json({ error: 'not authenticated' });
    next();
  });
  app.get('/events', (_req, res) => res.json({ events: [event, { ...event, id: randomUUID(), sales_mode: 'bazaar' }] }));
  app.get('/events/:id', (req, res) => { if (req.params.id === event.id) res.json({ event }); else res.status(404).json({ error: "event not found" }); });
  app.get('/events/:id/prices', (_req, res) => res.json({ event_id: event.id, currency: 'USD', sales_mode: 'bx', prices }));
  app.get('/events/:id/days', (_req, res) => res.json({ days: [{ status: 'open', settlement_exchange_rate_usd_eur: '0.9' }] }));
  app.post('/sales', (req, res) => {
    const b = req.body;
    const total = Math.round(b.items.reduce((s: number, i: any) => s + i.unit_price_at_sale * i.qty, 0) * 100) / 100;
    if (Math.abs(total - b.amount_local) > 0.01) return void res.status(422).json({ error: 'amount_local does not match the items total' });
    if (b.payment_method !== 'sumup') return void res.status(400).json({ error: 'payment_method' });
    const sale: FakeSale = { id: b.id, items: b.items, amount_local: b.amount_local, amount_eur: Math.round(b.amount_local * 0.9 * 100) / 100, currency: 'USD', status: 'pending_payment' };
    state.sales.set(sale.id, sale);
    res.status(201).json({ sale: { ...sale, amount_local: String(sale.amount_local), amount_eur: String(sale.amount_eur) } });
  });
  // Like the real POS: only SumUp's own record decides.
  app.post('/sales/:id/sumup-check', (req, res) => {
    const sale = state.sales.get(req.params.id);
    if (!sale) return void res.status(404).json({ error: 'sale not found' });
    if (!state.canVerify) return void res.json({ state: 'checking', reason: 'no_oauth', sale });
    const tx = sumup.mockTransaction(sale.id);
    if (sale.status === 'pending_payment' && tx?.status === 'SUCCESSFUL') sale.status = 'completed';
    if (sale.status === 'pending_payment' && tx?.status === 'FAILED') sale.status = 'payment_failed';
    const map = { completed: 'paid', payment_failed: 'failed', pending_payment: 'checking', cancelled: 'closed' } as const;
    res.json({ state: map[sale.status], sale });
  });
  app.post('/sales/:id/sumup-cancel', (req, res) => {
    const sale = state.sales.get(req.params.id);
    if (!sale) return void res.status(404).json({ error: 'sale not found' });
    if (state.canVerify && sumup.mockTransaction(sale.id)?.status === 'SUCCESSFUL') {
      sale.status = 'completed';
      return void res.status(409).json({ error: 'Deze betaling is alsnog gelukt bij SumUp' });
    }
    if (sale.status !== 'pending_payment' && sale.status !== 'payment_failed') {
      return void res.status(409).json({ error: 'Deze SumUp-betaling kan nog lopen' });
    }
    sale.status = 'cancelled';
    res.json({ sale });
  });

  const server = app.listen(0);
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
