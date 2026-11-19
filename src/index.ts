import 'dotenv/config';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const { app, orders, sumup, pos } = createApp(cfg);
orders.start();

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Olga's Cheese kiosk on http://${cfg.host}:${cfg.port}`);
  console.log(`  POS:   ${pos.configured ? cfg.pos.url : 'not configured (demo only)'}`);
  console.log(`  SumUp: ${sumup.mock ? 'virtual Solo (SUMUP_MOCK=true)' : sumup.configured ? `reader ${sumup.defaultReaderId ?? 'NOT CHOSEN'}` : 'not configured (demo only)'}`);
});

function shutdown(): void {
  orders.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
