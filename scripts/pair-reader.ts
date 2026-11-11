import 'dotenv/config';
import { loadConfig } from '../src/config.ts';
import { SumUpClient } from '../src/sumup.ts';

// Pairs a SumUp Solo with the account.
//   1. On the Solo: menu → Connections → API → Connect. It shows a code.
//   2. npm run pair -- <code> "Kiosk Solo"
//   3. Confirm on the Solo, then put the printed id in SUMUP_READER_ID.
const [code, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ').trim() || 'Kiosk Solo';
if (!code || !/^[A-Za-z0-9]{8,9}$/.test(code)) {
  console.error('usage: npm run pair -- <8-9 character code from the Solo> "<name>"');
  process.exit(1);
}
const reader = await new SumUpClient(loadConfig().sumup).pairReader(code, name);
console.log(`Paired: ${reader.id}  ${reader.name}  (status ${reader.status})`);
console.log('Confirm on the Solo if it asks, then set:');
console.log(`  SUMUP_READER_ID=${reader.id}`);
