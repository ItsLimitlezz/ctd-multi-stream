// Maintenance CLI for locked-out admins. Works while the server is running (SQLite WAL).
//   Docker:  docker exec -it <container> node dist/server/src/cli.js reset-password <username>
//   Source:  npm run cli -- reset-password <username>

import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createRepos } from './db/repos.js';
import { hashPassword } from './security/passwords.js';
import { createSecretBox, loadMasterKey } from './security/secretbox.js';

const USAGE = `Usage:
  cli list-users                 List users and roles
  cli reset-password <username>  Set a new random password, clear lockout and 2FA, sign the user out everywhere`;

async function run(args: string[]): Promise<number> {
  const [command, username] = args;
  const config = loadConfig();
  const db = openDatabase(path.join(config.dataDir, 'app.db'));
  const repos = createRepos(db, createSecretBox(loadMasterKey(config)));
  try {
    if (command === 'list-users') {
      const users = repos.users.list();
      if (users.length === 0) console.log('No users yet — finish setup in the web UI (the setup code is in the logs).');
      for (const u of users) console.log(`${u.username}\t${u.role}${u.totpEnabled ? '\t2FA' : ''}`);
      return 0;
    }
    if (command === 'reset-password' && username) {
      const user = repos.users.getByUsername(username);
      if (!user) {
        console.error(`No user named "${username}". Run "list-users" to see users.`);
        return 1;
      }
      const password = crypto.randomBytes(15).toString('base64url');
      repos.users.update(user.id, {
        passwordHash: await hashPassword(password),
        failedLogins: 0,
        lockedUntil: null,
        totpEnabled: false,
        totpSecret: null,
        totpPendingSecret: null,
      });
      repos.authSessions.deleteForUser(user.id);
      repos.audit.log({ userId: null, username: 'cli', action: 'user.update', detail: `${user.username}: password + 2FA reset via CLI` });
      console.log(`New password for ${user.username}: ${password}`);
      console.log('2FA was turned off. Log in and change the password under Profile.');
      return 0;
    }
    console.error(USAGE);
    return 2;
  } finally {
    db.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
