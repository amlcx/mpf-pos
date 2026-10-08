// Development data only. Refuses to run against a database that has stores.
import { loadConfig } from '../config.ts';
import { connect, migrate } from '../db.ts';
import { createProduct, createStore, createTerminal, createUser } from '../fixtures.ts';

const DEV_TOKENS = { A: 'mpf_dev_terminal_a', B: 'mpf_dev_terminal_b' };

const sql = connect(loadConfig().DATABASE_URL);
await migrate(sql);
const [existing] = await sql`select 1 from stores limit 1`;
if (existing) {
  console.log('Database already has data; nothing seeded.');
} else {
  const storeId = await createStore(sql, { code: 'MAIN', name: 'Tienda Principal', taxRateBps: 800 });
  for (const [code, token] of Object.entries(DEV_TOKENS)) {
    await createTerminal(sql, { storeId, code, name: `Caja ${code}`, token });
  }
  await createUser(sql, { username: 'admin', name: 'Administrador', role: 'admin', password: 'admin123' });
  await createUser(sql, { username: 'cashier', name: 'Cajero', role: 'cashier', password: '1234', storeId });
  // Prices in Colombian pesos, stored in minor units (18.000 pesos = 1_800_000).
  const desserts: [string, string, number, number | null][] = [
    ['Torta de chocolate', 'Tortas', 1_800_000, 12],
    ['Cheesecake', 'Tortas', 2_000_000, 8],
    ['Tres leches', 'Tortas', 1_600_000, 10],
    ['Flan', 'Vasos', 1_200_000, 15],
    ['Tiramisú', 'Vasos', 2_200_000, 6],
    ['Brownie', 'Horneados', 1_000_000, 20],
    ['Alfajor', 'Horneados', 800_000, 30],
    ['Café', 'Bebidas', 900_000, null],
  ];
  for (const [name, category, priceCents, quantity] of desserts) {
    await createProduct(
      sql,
      { name, category, priceCents, trackStock: quantity !== null },
      quantity === null ? undefined : { storeId, quantity },
    );
  }
  console.log('Seeded store MAIN.');
  console.log(`  terminal tokens: ${Object.values(DEV_TOKENS).join(', ')}`);
  console.log('  logins: admin / admin123, cashier / 1234');
}
await sql.end();
