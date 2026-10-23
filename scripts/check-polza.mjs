import { resolve } from 'node:path';
import { PolzaClient } from '../generation.mjs';
try { process.loadEnvFile(resolve(import.meta.dirname, '../.env')); } catch { /* Checked below. */ }
if (!process.env.POLZA_API_KEY) {
  console.error('Добавьте POLZA_API_KEY в .env.'); process.exitCode = 1;
} else {
  try {
    const result = await new PolzaClient(process.env.POLZA_API_KEY).check();
    console.log(JSON.stringify({ connected: true, balanceRub: result.balance, availableRub: result.available,
      keyLimitRub: result.keyLimit, paidGenerationStarted: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
