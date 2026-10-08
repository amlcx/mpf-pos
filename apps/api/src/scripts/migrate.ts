import { loadConfig } from '../config.ts';
import { connect, migrate } from '../db.ts';

const sql = connect(loadConfig().DATABASE_URL);
const ran = await migrate(sql);
console.log(ran.length > 0 ? `Applied: ${ran.join(', ')}` : 'Already up to date.');
await sql.end();
