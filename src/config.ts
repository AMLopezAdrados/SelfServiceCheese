// Everything the kiosk server needs, read once from the environment (.env).
// Secrets (SumUp API key, the POS kiosk PIN) stay on this server: the kiosk
// page in the browser never sees them.

export interface SumUpConfig {
  mock: boolean;
  apiKey: string;
  merchantCode: string;
  readerId: string;
  affiliateKey: string;
  appId: string;
  mockOutcome: string;
  mockDelayMs: number;
}

export interface PosConfig {
  url: string;
  username: string;
  pin: string;
  eventId: string | null;
}

export interface Config {
  port: number;
  host: string;
  accessKey: string | null;
  staffPin: string;
  publicUrl: string;
  dataDir: string | null;
  pos: PosConfig;
  sumup: SumUpConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const delay = Number(env.SUMUP_MOCK_DELAY_MS);
  return {
    port: Number(env.PORT ?? 8080),
    // 127.0.0.1 behind nginx on the VPS; 0.0.0.0 to reach it on a local network.
    host: env.HOST || '0.0.0.0',
    accessKey: env.KIOSK_ACCESS_KEY || null,
    staffPin: env.KIOSK_STAFF_PIN || '1234',
    publicUrl: (env.KIOSK_PUBLIC_URL || '').replace(/\/$/, ''),
    // Where the kiosk keeps its own settings (assortment). null = memory only.
    dataDir: env.KIOSK_DATA_DIR === '' ? null : env.KIOSK_DATA_DIR || 'data',
    pos: {
      url: (env.POS_URL || '').replace(/\/$/, ''),
      username: env.POS_USERNAME || '',
      pin: env.POS_PIN || '',
      eventId: env.POS_EVENT_ID || null,
    },
    sumup: {
      mock: env.SUMUP_MOCK === 'true',
      apiKey: env.SUMUP_API_KEY || '',
      merchantCode: env.SUMUP_MERCHANT_CODE || '',
      readerId: env.SUMUP_READER_ID || '',
      affiliateKey: env.SUMUP_AFFILIATE_KEY || '',
      appId: env.SUMUP_APP_ID || '',
      mockOutcome: env.SUMUP_MOCK_OUTCOME || 'successful',
      mockDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 6000,
    },
  };
}
