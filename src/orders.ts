import { randomUUID } from 'node:crypto';
import type { AssortmentStore } from './assortment.ts';
import type { Config } from './config.ts';
import { HttpError, round2, sleep } from './http.ts';
import type { PosClient, SaleItem } from './pos.ts';
import type { CheckoutStatus, ReaderCheckout, ReaderStatus, SumUpClient, SumUpTransaction } from './sumup.ts';

// One kiosk order = one POS sale = one payment on the Solo.
//
//   create  → price the lines from the POS price list (never the browser's
//             prices), record a BX sale in the POS (payment_method 'sumup'),
//             put the POS's amount_eur on the Solo with the sale id as
//             SumUp's foreign id.
//   refresh → ask SumUp: the reader checkout says pending / successful /
//             failed / cancelled; the transaction record (by foreign id) has
//             the final word on "paid" and gives card type, last 4, code.
//             Paid → ask the POS to confirm (the POS asks SumUp itself).
//             Failed → close the POS sale (the POS asks SumUp once more first).
//   cancel  → stop the payment on the Solo, then wait for SumUp to say how
//             it ended. If SumUp cannot confirm, the order is "stuck" and a
//             person looks — the customer is never sent to pay twice.
//
// "Try again" is a new order: a new POS sale, so a failure of one attempt can
// never be mistaken for the outcome of the next.

export type OrderState = 'waiting' | 'paid' | 'failed' | 'stuck';
export type Failure = 'declined' | 'timeout' | 'cancelled' | null;

export interface Order {
  id: string;
  saleId: string;
  readerId: string;
  checkoutId: string | null;
  eventName: string;
  amountLocal: number;
  currency: string;
  amountEur: number;
  rate: number;
  state: OrderState;
  failure: Failure;
  checkoutStatus: CheckoutStatus | null;
  posConfirmed: boolean;
  posCancelled: boolean;
  card: { type: string | null; last4: string | null; code: string | null } | null;
  cancelRequested: boolean;
  createdAt: number;
  settledAt: number | null;
}

export interface OrdersOptions {
  stuckAfterMs?: number;
  cancelWaitMs?: number;
  cancelPollMs?: number;
}

export interface OrderLine {
  product_id: string;
  qty: number;
}

export class Orders {
  private readonly orders = new Map<string, Order>();
  private readonly inFlight = new Map<string, Promise<Order>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly stuckAfterMs: number;
  private readonly cancelWaitMs: number;
  private readonly cancelPollMs: number;

  constructor(
    private readonly sumup: SumUpClient,
    private readonly pos: PosClient,
    private readonly cfg: Config,
    options: OrdersOptions = {},
    private readonly assortment: AssortmentStore | null = null,
  ) {
    // The Solo gives up on a waiting payment well before this.
    this.stuckAfterMs = options.stuckAfterMs ?? 4 * 60_000;
    this.cancelWaitMs = options.cancelWaitMs ?? 15_000;
    this.cancelPollMs = options.cancelPollMs ?? 1_500;
  }

  has(id: string): boolean {
    return this.orders.has(id);
  }

  get(id: string): Order {
    const order = this.orders.get(id);
    if (!order) throw new HttpError(404, 'order not found');
    return order;
  }

  async create(rawLines: unknown): Promise<Order> {
    if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > 50) {
      throw new HttpError(400, 'lines must be a non-empty array of { product_id, qty }');
    }
    const qtyById = new Map<string, number>();
    for (const line of rawLines as OrderLine[]) {
      const qty = Number(line?.qty);
      if (typeof line?.product_id !== 'string' || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        throw new HttpError(400, 'every line needs a product_id and a whole qty between 1 and 50');
      }
      qtyById.set(line.product_id, (qtyById.get(line.product_id) ?? 0) + qty);
    }

    if (!this.sumup.configured) throw new HttpError(503, 'SumUp is not configured on the kiosk server');
    const readerId = this.sumup.defaultReaderId;
    if (!readerId) throw new HttpError(503, 'no SumUp Solo chosen: set SUMUP_READER_ID (npm run readers)');

    const catalogue = await this.pos.catalogue();
    const items: SaleItem[] = [...qtyById].map(([productId, qty]) => {
      const product = catalogue.products.find((p) => p.id === productId);
      if (!product) throw new HttpError(400, 'a product in this order is no longer on the price list');
      if (this.assortment && !this.assortment.isAvailable(product)) throw new HttpError(400, `${product.name} is not available at the kiosk right now`);
      return { product_id: product.id, name_at_sale: product.name, unit_price_at_sale: product.price, qty };
    });
    const amountLocal = round2(items.reduce((sum, i) => sum + i.unit_price_at_sale * i.qty, 0));

    const sale = await this.pos.createSale(catalogue.event.id, items, amountLocal);
    const id = randomUUID();
    const returnUrl = this.cfg.publicUrl.startsWith('https://') ? `${this.cfg.publicUrl}/api/sumup/webhook/${id}` : undefined;

    let checkoutId: string | null;
    try {
      ({ checkoutId } = await this.sumup.startCheckout(readerId, {
        foreignId: sale.id,
        amountEur: sale.amount_eur,
        description: `Olga's Cheese - ${catalogue.event.name}`,
        returnUrl,
      }));
    } catch (err) {
      // The Solo never received this payment (offline, busy, bad key): close
      // the POS sale again so it does not linger as an open card payment.
      await this.pos.cancelSale(sale.id).catch(() => 'refused');
      throw err;
    }

    const order: Order = {
      id,
      saleId: sale.id,
      readerId,
      checkoutId,
      eventName: catalogue.event.name,
      amountLocal: sale.amount_local,
      currency: sale.currency,
      amountEur: sale.amount_eur,
      rate: catalogue.rate,
      state: 'waiting',
      failure: null,
      checkoutStatus: 'pending',
      posConfirmed: false,
      posCancelled: false,
      card: null,
      cancelRequested: false,
      createdAt: Date.now(),
      settledAt: null,
    };
    this.orders.set(id, order);
    return order;
  }

  // One refresh per order at a time: the kiosk's poll, SumUp's webhook and
  // the background loop may all ask at once.
  refresh(id: string): Promise<Order> {
    const order = this.get(id);
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = this.doRefresh(order).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  private async doRefresh(o: Order): Promise<Order> {
    if (o.state === 'paid') {
      if (!o.posConfirmed) await this.confirmWithPos(o);
      return o;
    }
    if (o.state !== 'waiting') return o;

    const checkout: ReaderCheckout | null = o.checkoutId
      ? await this.sumup.getCheckout(o.readerId, o.checkoutId).catch(() => null)
      : null;
    if (checkout) o.checkoutStatus = checkout.status;
    if (checkout?.status === 'pending') return this.checkStuck(o);

    const tx = await this.sumup.findTransaction(o.saleId).catch(() => null);
    if (checkout?.status === 'successful' || tx?.status === 'SUCCESSFUL') return this.markPaid(o, tx);
    if (checkout && (checkout.status === 'failed' || checkout.status === 'cancelled')) {
      return this.markFailed(o, checkout.status === 'failed' || checkout.failureReason === 'declined' ? 'declined' : 'timeout');
    }
    if (!checkout && tx && (tx.status === 'FAILED' || tx.status === 'CANCELLED')) return this.markFailed(o, 'declined');
    return this.checkStuck(o);
  }

  private checkStuck(o: Order): Order {
    if (Date.now() - o.createdAt > this.stuckAfterMs) o.state = 'stuck';
    return o;
  }

  private async markPaid(o: Order, tx: SumUpTransaction | null): Promise<Order> {
    o.state = 'paid';
    o.failure = null;
    o.settledAt = Date.now();
    if (tx) o.card = { type: tx.cardType, last4: tx.last4, code: tx.code };
    await this.confirmWithPos(o);
    return o;
  }

  private async markFailed(o: Order, reason: Exclude<Failure, null>): Promise<Order> {
    const result = await this.pos.cancelSale(o.saleId).catch(() => 'refused' as const);
    if (result === 'paid') {
      // The POS found the payment at SumUp after all: a payment that went
      // through always wins over a failure signal.
      o.posConfirmed = true;
      return this.markPaid(o, await this.sumup.findTransaction(o.saleId).catch(() => null));
    }
    o.state = 'failed';
    o.failure = o.cancelRequested ? 'cancelled' : reason;
    o.posCancelled = result === 'cancelled';
    o.settledAt = Date.now();
    if (!o.posCancelled) console.warn(`POS did not cancel sale ${o.saleId} (${result}); it stays open for staff`);
    return o;
  }

  private async confirmWithPos(o: Order): Promise<void> {
    if (o.posConfirmed) return;
    o.posConfirmed = await this.pos.confirmPaid(o.saleId).catch(() => false);
  }

  async cancel(id: string): Promise<Order & { terminateError?: string }> {
    const o = this.get(id);
    if (o.state !== 'waiting') return o;
    o.cancelRequested = true;
    let terminateError: string | undefined;
    try {
      await this.sumup.terminate(o.readerId);
    } catch (err) {
      terminateError = (err as Error).message;
    }
    const until = Date.now() + this.cancelWaitMs;
    for (;;) {
      await this.refresh(id);
      if (o.state !== 'waiting' || Date.now() >= until) break;
      await sleep(this.cancelPollMs);
    }
    if (o.state === 'waiting') o.state = 'stuck';
    return { ...o, ...(terminateError ? { terminateError } : {}) };
  }

  // Background: finish what nobody is watching any more (the kiosk moved on,
  // the tablet lost its connection), retry POS confirmations, forget old
  // orders. The POS's own 30 s sweep is a second safety net for "paid".
  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const o of this.orders.values()) {
        if (now - o.createdAt > 3 * 60 * 60_000) this.orders.delete(o.id);
        else if (o.state === 'waiting' || (o.state === 'paid' && !o.posConfirmed && now - (o.settledAt ?? now) < 30 * 60_000)) {
          this.refresh(o.id).catch((err) => console.error(`order ${o.id}: ${(err as Error).message}`));
        }
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// What the kiosk page gets to see about an order.
export function orderView(o: Order, reader?: ReaderStatus | null) {
  return {
    id: o.id,
    state: o.state,
    failure: o.failure,
    checkout_status: o.checkoutStatus,
    amount_local: o.amountLocal,
    currency: o.currency,
    amount_eur: o.amountEur,
    rate: o.rate,
    reference: o.saleId.slice(0, 8).toUpperCase(),
    card: o.card,
    pos_confirmed: o.posConfirmed,
    ...(reader !== undefined ? { reader } : {}),
  };
}
