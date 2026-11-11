import { randomUUID } from 'node:crypto';
import type { PosConfig } from './config.ts';
import { HttpError } from './http.ts';

// The Olga's Cheese POS, used as an ordinary API client — the same endpoints
// the POS's own tablets use. Nothing in the POS is changed for the kiosk:
//
//   POST /auth/login                     the kiosk's own staff account
//   GET  /events, /events/:id            which BX event the kiosk sells for
//   GET  /events/:id/prices              the price list (event currency)
//   GET  /events/:id/days                the open day and its USD→EUR rate
//   POST /sales                          a BX sale, payment_method 'sumup'
//   POST /sales/:id/sumup-check          the POS asks SumUp itself → paid
//   POST /sales/:id/sumup-cancel         close a sale whose payment failed
//
// The POS computes amount_eur (with the day's settlement rate); that is the
// amount the Solo charges. The POS sale id is the SumUp foreign id, so the
// POS's own checks (sumup-check, its 30 s sweep, reconcile, the SumUp day
// report) find kiosk payments exactly like the kassa's own.

export interface CatalogueProduct {
  id: string;
  name: string;
  category_id: string;
  category: string;
  price: number;
}

export interface Catalogue {
  event: { id: string; name: string };
  currency: 'USD' | 'EUR';
  rate: number;
  products: CatalogueProduct[];
}

export interface PosSale {
  id: string;
  amount_local: number;
  amount_eur: number;
  currency: string;
}

export interface SaleItem {
  product_id: string;
  name_at_sale: string;
  unit_price_at_sale: number;
  qty: number;
}

interface PosResponse {
  status: number;
  body: any;
}

const CATALOGUE_TTL_MS = 60_000;

export class PosClient {
  private token: string | null = null;
  private cache: { at: number; value: Catalogue } | null = null;

  constructor(private readonly cfg: PosConfig) {}

  get configured(): boolean {
    return !!(this.cfg.url && this.cfg.username && this.cfg.pin);
  }

  private async raw(method: string, path: string, body?: unknown, token?: string | null): Promise<PosResponse> {
    let res: globalThis.Response;
    try {
      res = await fetch(`${this.cfg.url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new HttpError(502, `the POS is unreachable (${this.cfg.url}): ${(err as Error).message}`);
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  private async login(): Promise<string> {
    if (!this.configured) throw new HttpError(503, 'the POS is not configured (POS_URL, POS_USERNAME, POS_PIN)');
    const r = await this.raw('POST', '/auth/login', { username: this.cfg.username, pin: this.cfg.pin });
    if (r.status !== 200 || !r.body?.token) {
      throw new HttpError(503, `the POS refused the kiosk login for "${this.cfg.username}" (${r.status})`);
    }
    this.token = r.body.token as string;
    return this.token;
  }

  // Logs in on first use and again once when the session has expired.
  private async request(method: string, path: string, body?: unknown): Promise<PosResponse> {
    const token = this.token ?? (await this.login());
    let r = await this.raw(method, path, body, token);
    if (r.status === 401) r = await this.raw(method, path, body, await this.login());
    return r;
  }

  private failed(action: string, r: PosResponse): HttpError {
    const msg = typeof r.body?.error === 'string' ? r.body.error : `HTTP ${r.status}`;
    return new HttpError(r.status >= 500 ? 502 : r.status === 404 ? 404 : 409, `POS could not ${action}: ${msg}`);
  }

  // POS_EVENT_ID, or else the one BX event that has a day open right now.
  async findEvent(): Promise<{ id: string; name: string }> {
    if (this.cfg.eventId) {
      const r = await this.request('GET', `/events/${encodeURIComponent(this.cfg.eventId)}`);
      if (r.status !== 200) throw this.failed('find POS_EVENT_ID', r);
      const e = r.body.event;
      return { id: e.id, name: e.display_name || e.name };
    }
    const r = await this.request('GET', '/events');
    if (r.status !== 200) throw this.failed('list the events', r);
    const open = (r.body.events as any[]).filter((e) => e.sales_mode !== 'bazaar' && e.open_day_count > 0);
    if (open.length === 0) throw new HttpError(409, 'no BX event has an open day in the POS: start the day first');
    if (open.length > 1) throw new HttpError(409, `${open.length} events have an open day: set POS_EVENT_ID`);
    return { id: open[0].id, name: open[0].display_name || open[0].name };
  }

  async catalogue(force = false): Promise<Catalogue> {
    if (!force && this.cache && Date.now() - this.cache.at < CATALOGUE_TTL_MS) return this.cache.value;
    const event = await this.findEvent();
    const [prices, days] = await Promise.all([
      this.request('GET', `/events/${event.id}/prices`),
      this.request('GET', `/events/${event.id}/days`),
    ]);
    if (prices.status !== 200) throw this.failed('load the price list', prices);
    if (days.status !== 200) throw this.failed('load the event days', days);
    if (prices.body.sales_mode === 'bazaar') throw new HttpError(409, 'this is a bazaar event: the kiosk only sells BX (paid on the spot)');
    const open = (days.body.days as any[]).find((d) => d.status === 'open');
    if (!open) throw new HttpError(409, `"${event.name}" has no open day: start the day in the POS first`);
    const value: Catalogue = {
      event,
      currency: prices.body.currency,
      rate: prices.body.currency === 'EUR' ? 1 : Number(open.settlement_exchange_rate_usd_eur),
      products: (prices.body.prices as any[]).map((p) => ({
        id: p.product_id,
        name: p.name,
        category_id: p.category_id,
        category: p.category,
        price: Number(p.price),
      })),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async createSale(eventId: string, items: SaleItem[], amountLocal: number): Promise<PosSale> {
    const r = await this.request('POST', '/sales', {
      id: randomUUID(),
      event_id: eventId,
      items,
      amount_local: amountLocal,
      payment_method: 'sumup',
      created_at: new Date().toISOString(),
    });
    if (r.status !== 201 && r.status !== 200) throw this.failed('record the sale', r);
    const s = r.body.sale;
    return { id: s.id, amount_local: Number(s.amount_local), amount_eur: Number(s.amount_eur), currency: s.currency };
  }

  // The POS asks SumUp itself (by foreign id = sale id). true once the POS
  // has booked the sale as paid.
  async confirmPaid(saleId: string): Promise<boolean> {
    const r = await this.request('POST', `/sales/${saleId}/sumup-check`);
    return r.status === 200 && r.body?.state === 'paid';
  }

  // 'paid': the POS found the payment at SumUp after all, so nothing was
  // cancelled. 'refused': the POS thinks the payment may still be running.
  async cancelSale(saleId: string): Promise<'cancelled' | 'paid' | 'refused'> {
    const r = await this.request('POST', `/sales/${saleId}/sumup-cancel`);
    if (r.status === 200) return 'cancelled';
    if (r.status === 409 && /gelukt/i.test(String(r.body?.error))) return 'paid';
    return 'refused';
  }
}
