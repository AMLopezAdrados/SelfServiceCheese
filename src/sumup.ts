import { randomUUID } from 'node:crypto';
import type { SumUpConfig } from './config.ts';
import { HttpError } from './http.ts';

// SumUp Cloud API for the SumUp Solo: this server puts an amount on the Solo
// next to the kiosk and reads back what happened. The tablet never talks to
// SumUp and never switches to a SumUp app.
//
// Endpoints and fields follow SumUp's own TypeScript SDK (@sumup/sdk):
//   POST /v0.1/merchants/{code}/readers                      pair a Solo
//   GET  /v0.1/merchants/{code}/readers                      list readers
//   GET  /v0.1/merchants/{code}/readers/{id}/status          online, battery, screen
//   POST /v0.1/merchants/{code}/readers/{id}/checkout        start a payment
//   GET  /v0.1/merchants/{code}/readers/{id}/checkout/{cid}  that payment's status
//   POST /v0.1/merchants/{code}/readers/{id}/terminate       stop the payment
//   GET  /v2.1/merchants/{code}/transactions?foreign_transaction_id=…
//
// Only the Solo works this way. The Air is a Bluetooth reader that talks to
// an app on the device and has no Cloud API.

const SUMUP_API_BASE = 'https://api.sumup.com';
export const MOCK_READER_ID = 'rdr_VIRTUALSOLO000000000000000';

export interface SumUpReader {
  id: string;
  name: string;
  status: string; // unknown | processing | paired | expired
  device: { identifier: string; model: string };
}

export interface ReaderStatus {
  status: 'ONLINE' | 'OFFLINE';
  state?: 'IDLE' | 'SELECTING_TIP' | 'WAITING_FOR_CARD' | 'WAITING_FOR_PIN' | 'WAITING_FOR_SIGNATURE' | 'UPDATING_FIRMWARE';
  battery_level?: number;
  connection_type?: string;
  firmware_version?: string;
}

export type CheckoutStatus = 'pending' | 'successful' | 'failed' | 'cancelled';

export interface ReaderCheckout {
  status: CheckoutStatus;
  failureReason: string | null;
}

export interface SumUpTransaction {
  id: string;
  status: string; // SUCCESSFUL | FAILED | CANCELLED | …
  amount: number;
  currency: string;
  code: string | null;
  cardType: string | null;
  last4: string | null;
}

export interface StartCheckoutInput {
  foreignId: string; // the POS sale id: how both systems find this payment
  amountEur: number;
  description: string;
  returnUrl?: string;
}

export type MockOutcome = 'successful' | 'declined' | 'timeout' | 'offline';

interface MockCheckout {
  id: string;
  readerId: string;
  foreignId: string;
  amountEur: number;
  outcome: Exclude<MockOutcome, 'offline'>;
  decidesAt: number;
  terminated: boolean;
}

interface Response_ {
  status: number;
  body: unknown;
}

export class SumUpClient {
  // --- virtual Solo (SUMUP_MOCK=true) ---------------------------------------
  private readonly mockReaders: SumUpReader[] = [
    { id: MOCK_READER_ID, name: 'Virtual Solo', status: 'paired', device: { identifier: 'VIRTUAL-0001', model: 'virtual-solo' } },
  ];
  private readonly mockCheckouts = new Map<string, MockCheckout>();
  private mockOutcomeOverride: MockOutcome | null = null;
  readonly sent: { path: string; body: unknown }[] = [];

  constructor(private readonly cfg: SumUpConfig) {}

  get mock(): boolean {
    return this.cfg.mock;
  }

  get configured(): boolean {
    return this.cfg.mock || !!(this.cfg.apiKey && this.cfg.merchantCode && this.cfg.affiliateKey && this.cfg.appId);
  }

  get defaultReaderId(): string | null {
    return this.cfg.readerId || (this.cfg.mock ? MOCK_READER_ID : null);
  }

  // Tests and local trials: how the next virtual payments end.
  setMockOutcome(outcome: MockOutcome | null): void {
    this.mockOutcomeOverride = outcome;
  }

  // What SumUp's transaction record would say about this payment — for a
  // stand-in POS in tests, which in real life asks SumUp itself.
  mockTransaction(foreignId: string): SumUpTransaction | null {
    const c = [...this.mockCheckouts.values()].reverse().find((m) => m.foreignId === foreignId);
    if (!c || c.terminated || Date.now() < c.decidesAt || c.outcome === 'timeout') return null;
    return {
      id: `tx-${c.id.slice(0, 8)}`,
      status: c.outcome === 'successful' ? 'SUCCESSFUL' : 'FAILED',
      amount: c.amountEur,
      currency: 'EUR',
      code: `TVIRT${c.id.slice(0, 5).toUpperCase()}`,
      cardType: 'VISA',
      last4: '4242',
    };
  }

  private mockActive(readerId: string): MockCheckout | undefined {
    return [...this.mockCheckouts.values()].find((c) => c.readerId === readerId && !c.terminated && Date.now() < c.decidesAt);
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new HttpError(503, 'SumUp is not configured (SUMUP_API_KEY, SUMUP_MERCHANT_CODE, SUMUP_AFFILIATE_KEY, SUMUP_APP_ID)');
    }
  }

  private merchantPath(rest: string): string {
    return `/v0.1/merchants/${encodeURIComponent(this.cfg.merchantCode)}${rest}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response_> {
    this.requireConfigured();
    let res: globalThis.Response;
    try {
      res = await fetch(`${SUMUP_API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new HttpError(502, `SumUp is unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }

  private rejected(action: string, r: Response_): HttpError {
    const errors = (r.body as { errors?: { type?: string; detail?: string } } | null)?.errors;
    const detail = errors && typeof errors === 'object'
      ? [errors.type, errors.detail].filter(Boolean).join(': ') || JSON.stringify(errors).slice(0, 300)
      : typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    const suffix = detail ? `: ${detail}` : '';
    if (r.status === 401 || r.status === 403) return new HttpError(503, `SumUp refused to ${action} (${r.status}); check SUMUP_API_KEY${suffix}`);
    if (r.status === 404) return new HttpError(404, `SumUp does not know this reader${suffix}`);
    // 422: reader offline, still busy (SumUp blocks a reader for 60 s after
    // accepting a checkout), or not waiting for a card when asked to stop.
    if (r.status === 422 || r.status === 409) return new HttpError(409, `SumUp could not ${action}${suffix}`);
    return new HttpError(502, `SumUp could not ${action} (${r.status})${suffix}`);
  }

  async listReaders(): Promise<SumUpReader[]> {
    this.requireConfigured();
    if (this.mock) return this.mockReaders;
    const r = await this.request('GET', this.merchantPath('/readers'));
    if (r.status >= 300) throw this.rejected('list the readers', r);
    return (r.body as { items?: SumUpReader[] })?.items ?? [];
  }

  // The Solo shows an 8–9 character code under menu → Connections → API.
  async pairReader(pairingCode: string, name: string): Promise<SumUpReader> {
    this.requireConfigured();
    if (this.mock) {
      const reader = { id: `rdr_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`, name, status: 'paired', device: { identifier: pairingCode, model: 'virtual-solo' } };
      this.mockReaders.push(reader);
      return reader;
    }
    const r = await this.request('POST', this.merchantPath('/readers'), { pairing_code: pairingCode, name });
    if (r.status >= 300) throw this.rejected('pair this reader', r);
    return r.body as SumUpReader;
  }

  // null when SumUp cannot tell (older Solo firmware, or the call failed).
  async readerStatus(readerId: string): Promise<ReaderStatus | null> {
    if (!this.configured) return null;
    if (this.mock) {
      if (!this.mockReaders.some((m) => m.id === readerId)) return null;
      return { status: 'ONLINE', state: this.mockActive(readerId) ? 'WAITING_FOR_CARD' : 'IDLE', battery_level: 87, connection_type: 'Wi-Fi' };
    }
    try {
      const r = await this.request('GET', this.merchantPath(`/readers/${encodeURIComponent(readerId)}/status`));
      if (r.status >= 300) return null;
      return ((r.body as { data?: ReaderStatus })?.data ?? null) as ReaderStatus | null;
    } catch {
      return null;
    }
  }

  // SumUp only ACCEPTS the checkout here; whether the customer pays is read
  // back afterwards with getCheckout / findTransaction.
  async startCheckout(readerId: string, input: StartCheckoutInput): Promise<{ checkoutId: string | null }> {
    const value = Math.round(input.amountEur * 100);
    if (!Number.isFinite(value) || value <= 0) throw new HttpError(422, 'nothing to charge on the card reader');
    const body = {
      total_amount: { currency: 'EUR', minor_unit: 2, value },
      description: input.description.slice(0, 120),
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      affiliate: {
        app_id: this.cfg.appId || 'virtual',
        key: this.cfg.affiliateKey || 'virtual',
        foreign_transaction_id: input.foreignId,
        tags: { source: 'olgas-cheese-kiosk' },
      },
    };
    const path = this.merchantPath(`/readers/${encodeURIComponent(readerId)}/checkout`);
    this.requireConfigured();

    if (this.mock) {
      this.sent.push({ path, body });
      if (!this.mockReaders.some((m) => m.id === readerId)) throw new HttpError(404, 'SumUp does not know this reader');
      const outcome = this.mockOutcomeOverride ?? (this.cfg.mockOutcome as MockOutcome);
      if (outcome === 'offline') throw new HttpError(409, 'SumUp could not start the payment: the reader is offline');
      if (this.mockActive(readerId)) throw new HttpError(409, 'SumUp could not start the payment: the reader is busy');
      const checkout: MockCheckout = {
        id: `virt-${randomUUID()}`,
        readerId,
        foreignId: input.foreignId,
        amountEur: value / 100,
        outcome: outcome === 'declined' || outcome === 'timeout' ? outcome : 'successful',
        decidesAt: Date.now() + this.cfg.mockDelayMs,
        terminated: false,
      };
      this.mockCheckouts.set(checkout.id, checkout);
      return { checkoutId: checkout.id };
    }

    const r = await this.request('POST', path, body);
    if (r.status >= 300) throw this.rejected('start the payment on the reader', r);
    return { checkoutId: (r.body as { data?: { checkout_id?: string } })?.data?.checkout_id ?? null };
  }

  // SumUp accepts this only while the Solo waits for the cardholder and does
  // not confirm it; the outcome is read back like any other.
  async terminate(readerId: string): Promise<void> {
    this.requireConfigured();
    if (this.mock) {
      const active = this.mockActive(readerId);
      if (!active) throw new HttpError(409, 'SumUp could not stop the payment: the reader is not waiting for a card');
      active.terminated = true;
      return;
    }
    const r = await this.request('POST', this.merchantPath(`/readers/${encodeURIComponent(readerId)}/terminate`), {});
    if (r.status >= 300) throw this.rejected('stop the payment on the reader', r);
  }

  async getCheckout(readerId: string, checkoutId: string): Promise<ReaderCheckout | null> {
    if (this.mock) {
      const c = this.mockCheckouts.get(checkoutId);
      if (!c) return null;
      if (c.terminated) return { status: 'cancelled', failureReason: 'terminated' };
      if (Date.now() < c.decidesAt) return { status: 'pending', failureReason: null };
      if (c.outcome === 'successful') return { status: 'successful', failureReason: null };
      if (c.outcome === 'declined') return { status: 'failed', failureReason: 'declined' };
      return { status: 'cancelled', failureReason: 'timeout' };
    }
    const r = await this.request('GET', this.merchantPath(`/readers/${encodeURIComponent(readerId)}/checkout/${encodeURIComponent(checkoutId)}`));
    if (r.status >= 300) return null;
    const data = (r.body as { data?: { status?: CheckoutStatus; payment_failure_reason?: string | null } })?.data;
    return data?.status ? { status: data.status, failureReason: data.payment_failure_reason ?? null } : null;
  }

  // SumUp's own transaction record for this payment (by our foreign id). A
  // successful one is the answer whenever it exists; otherwise the latest.
  async findTransaction(foreignId: string): Promise<SumUpTransaction | null> {
    if (this.mock) return this.mockTransaction(foreignId);
    const path = `/v2.1/merchants/${encodeURIComponent(this.cfg.merchantCode)}/transactions?foreign_transaction_id=${encodeURIComponent(foreignId)}`;
    const r = await this.request('GET', path);
    if (r.status === 404 || r.status >= 300) return null;
    type ApiTx = { id?: string; status?: string; simple_status?: string; amount?: number; currency?: string; transaction_code?: string; timestamp?: string; foreign_transaction_id?: string; card?: { type?: string; last_4_digits?: string } };
    const body = r.body as ApiTx | { items?: ApiTx[] };
    const list = ('items' in body && Array.isArray(body.items) ? body.items : [body as ApiTx])
      // Never another payment's record, whatever the endpoint returns.
      .filter((tx) => tx.foreign_transaction_id === foreignId);
    const pick = list.find((tx) => (tx.status ?? '').toUpperCase() === 'SUCCESSFUL')
      ?? [...list].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];
    if (!pick) return null;
    return {
      id: pick.id ?? '',
      status: (pick.status ?? pick.simple_status ?? '').toUpperCase(),
      amount: Number(pick.amount ?? 0),
      currency: pick.currency ?? '',
      code: pick.transaction_code ?? null,
      cardType: pick.card?.type ?? null,
      last4: pick.card?.last_4_digits ?? null,
    };
  }
}
