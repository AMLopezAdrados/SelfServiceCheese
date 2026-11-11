import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Config } from './config.ts';
import { asyncHandler, errorHandler, HttpError } from './http.ts';
import { Orders, orderView, type OrdersOptions } from './orders.ts';
import { PosClient } from './pos.ts';
import { SumUpClient } from './sumup.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AppDeps {
  sumup?: SumUpClient;
  pos?: PosClient;
  orders?: OrdersOptions;
}

export function createApp(cfg: Config, deps: AppDeps = {}) {
  const sumup = deps.sumup ?? new SumUpClient(cfg.sumup);
  const pos = deps.pos ?? new PosClient(cfg.pos);
  const orders = new Orders(sumup, pos, cfg, deps.orders);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // SumUp's return_url. Public (SumUp has no kiosk key), logged, and only
  // ever a reason to look again: the outcome is read from SumUp's API.
  app.post(
    '/api/sumup/webhook/:id',
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      console.log(`SumUp webhook for order ${id}: ${JSON.stringify(req.body ?? null).slice(0, 500)}`);
      if (orders.has(id)) await orders.refresh(id).catch((err) => console.error(`webhook refresh ${id}: ${(err as Error).message}`));
      res.status(204).end();
    }),
  );

  // Everything else under /api needs the kiosk key when one is configured:
  // the tablet opens the kiosk once as /?key=… and remembers it.
  app.use('/api', (req, res, next) => {
    if (!cfg.accessKey) return next();
    const key = req.header('x-kiosk-key') ?? '';
    if (key && sameSecret(key, cfg.accessKey)) return next();
    res.status(401).json({ error: 'kiosk key required' });
  });

  // Is the kiosk ready to sell? Shown in the staff panel.
  app.get(
    '/api/status',
    asyncHandler(async (_req, res) => {
      const readerId = sumup.defaultReaderId;
      const [catalogue, readers, reader] = await Promise.all([
        pos.configured ? pos.catalogue(true).then((c) => ({ ok: true as const, c }), (err) => ({ ok: false as const, error: (err as Error).message })) : Promise.resolve({ ok: false as const, error: 'POS_URL, POS_USERNAME and POS_PIN are not set' }),
        sumup.configured ? sumup.listReaders().catch(() => []) : Promise.resolve([]),
        readerId ? sumup.readerStatus(readerId) : Promise.resolve(null),
      ]);
      const named = readers.find((r) => r.id === readerId);
      res.json({
        live: catalogue.ok && sumup.configured && !!readerId,
        pos: catalogue.ok
          ? { configured: true, ok: true, event: catalogue.c.event.name, currency: catalogue.c.currency, rate: catalogue.c.rate, products: catalogue.c.products.length }
          : { configured: pos.configured, ok: false, error: catalogue.error },
        sumup: {
          configured: sumup.configured,
          mock: sumup.mock,
          reader: readerId ? { id: readerId, name: named?.name ?? null, ...(reader ?? { status: 'UNKNOWN' }) } : null,
        },
      });
    }),
  );

  app.post('/api/staff-pin', (req, res) => {
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    res.json({ ok: sameSecret(pin, cfg.staffPin) });
  });

  app.get(
    '/api/catalogue',
    asyncHandler(async (_req, res) => {
      const c = await pos.catalogue();
      res.json(c);
    }),
  );

  app.post(
    '/api/orders',
    asyncHandler(async (req, res) => {
      const order = await orders.create(req.body?.lines);
      res.status(201).json(orderView(order));
    }),
  );

  app.post(
    '/api/orders/:id/poll',
    asyncHandler(async (req, res) => {
      const order = await orders.refresh(req.params.id);
      const reader = order.state === 'waiting' ? await sumup.readerStatus(order.readerId) : undefined;
      res.json(orderView(order, reader));
    }),
  );

  app.post(
    '/api/orders/:id/cancel',
    asyncHandler(async (req, res) => {
      const order = await orders.cancel(req.params.id);
      res.json({ ...orderView(order), terminate_error: order.terminateError ?? null });
    }),
  );

  app.use('/api', () => {
    throw new HttpError(404, 'not found');
  });
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));
  app.use(errorHandler);

  return { app, orders, sumup, pos };
}
