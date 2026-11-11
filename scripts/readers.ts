import 'dotenv/config';
import { loadConfig } from '../src/config.ts';
import { SumUpClient } from '../src/sumup.ts';

// Lists the SumUp Solo readers paired with the account, with live status.
//   npm run readers
const sumup = new SumUpClient(loadConfig().sumup);
const readers = await sumup.listReaders();
if (readers.length === 0) console.log('No readers paired yet. Pair one with: npm run pair -- <code> "<name>"');
for (const r of readers) {
  const live = r.status === 'paired' ? await sumup.readerStatus(r.id) : null;
  console.log(`${r.id}  ${r.name}  (${r.device.model}, ${r.status}${live ? `, ${live.status}${live.battery_level != null ? `, battery ${Math.round(live.battery_level)}%` : ''}` : ''})`);
}
console.log('\nPut the id of the kiosk\'s Solo in SUMUP_READER_ID.');
