// Creates the first administrator of a new installation (or rescues a lost
// password). Everything else is then done from the web panel.
//
//   pnpm --filter @mpf/api admin:create <username> [full name]
//   pnpm --filter @mpf/api admin:create <username> --reset-password
//
// The password is asked for without echo. For unattended use, pass it in the
// ADMIN_PASSWORD environment variable instead.
import { ADMIN_PASSWORD_MIN, UserInputSchema, hashPassword } from '@mpf/shared';
import * as v from 'valibot';
import { loadConfig } from '../config.ts';
import { connect } from '../db.ts';
import { createUser } from '../fixtures.ts';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('No terminal to ask for the password; set ADMIN_PASSWORD.');
  const first = await askHidden(`Password (at least ${ADMIN_PASSWORD_MIN} characters): `);
  if ((await askHidden('Repeat it: ')) !== first) throw new Error('The passwords do not match.');
  return first;
}

const args = process.argv.slice(2);
const reset = args.includes('--reset-password');
const [username, ...nameParts] = args.filter((a) => !a.startsWith('--'));
if (!username) {
  console.error('usage: admin:create <username> [full name] | admin:create <username> --reset-password');
  process.exit(1);
}

const sql = connect(loadConfig().DATABASE_URL);
try {
  const password = await readPassword();
  if (password.length < ADMIN_PASSWORD_MIN) throw new Error(`The password needs at least ${ADMIN_PASSWORD_MIN} characters.`);
  const input = v.parse(UserInputSchema, {
    username,
    name: nameParts.join(' ') || username,
    role: 'admin',
    storeId: null,
    password,
  });
  const [existing] = await sql`select 1 from users where username = ${input.username}`;
  if (reset) {
    if (!existing) throw new Error(`No user named "${input.username}".`);
    await sql`
      update users set password_hash = ${await hashPassword(password)}, role = 'admin', active = true
      where username = ${input.username}`;
    console.log(`Password of "${input.username}" replaced; the account is an active admin.`);
  } else {
    if (existing) throw new Error(`"${input.username}" already exists. Use --reset-password to replace its password.`);
    await createUser(sql, { username: input.username, name: input.name, role: 'admin', password, storeId: null });
    console.log(`Admin "${input.username}" created with access to every store.`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
