/**
 * Print the Postgres user and database from the server's own POSTGRES_URL, for kaki-backup.sh.
 *
 * The backup runs pg_dump inside the Postgres container, so it only needs the user and database
 * name from the same connection string the server uses. It never prints the password.
 */
const envFile = process.argv[2];

function fail(message) {
  process.stderr.write(`kaki-backup: ${message}\n`);
  process.exit(2);
}

if (!envFile) fail('no server env file path was given');

try {
  process.loadEnvFile(envFile);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  fail(`cannot read ${envFile}: ${reason}`);
}

const raw = process.env.POSTGRES_URL?.trim();
if (!raw) fail(`POSTGRES_URL is not set in ${envFile}`);

let parsed;
try {
  parsed = new URL(raw);
} catch {
  fail(`POSTGRES_URL in ${envFile} is not a valid URL`);
}

if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
  fail(`POSTGRES_URL in ${envFile} must start with postgres:// or postgresql://`);
}

let user;
let database;
try {
  user = decodeURIComponent(parsed.username);
  database = decodeURIComponent(parsed.pathname.split('/').filter(Boolean)[0] ?? '');
} catch {
  fail(`POSTGRES_URL in ${envFile} has a user or database name that cannot be decoded`);
}

if (!user || !database) {
  fail(`POSTGRES_URL in ${envFile} must name a user and a database`);
}

if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(database)) {
  fail(`POSTGRES_URL in ${envFile} has a user or database name the backup script cannot pass safely`);
}

process.stdout.write(`${user}\t${database}\n`);
