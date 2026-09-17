'use strict';

const path = require('node:path');
const { connectionOptions, createMysqlStore, lockName } = require('../lib/persistence/mysql');
const { inventory, importData, verifyData, exportData } = require('../lib/persistence/transfer');

async function main() {
  const [command = 'plan', destination, ...extra] = process.argv.slice(2);
  if (!['plan', 'init', 'import', 'verify', 'export'].includes(command) || extra.length ||
      (command === 'export' ? !destination : destination)) {
    throw new Error('Usage: npm run storage -- plan|init|import|verify|export <new-directory>');
  }
  const root = path.resolve(process.env.SERVER_TOOLS_DATA_DIR || path.join(__dirname, '..'));
  require('dotenv').config({ path: path.join(root, '.env') });
  if (command === 'plan') {
    console.log(JSON.stringify({ source: root, files: await inventory(root),
      excluded: ['.env and encryption/SSH keys (transfer separately)', 'installed module code and work/cache directories', 'browser localStorage'] }, null, 2));
    return;
  }
  const options = connectionOptions();
  const pool = require('mysql2/promise').createPool(options);
  let lock;
  try {
    lock = await pool.getConnection();
    const [[row]] = await lock.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName(options.database, 'host')]);
    if (Number(row.acquired) !== 1) throw new Error('Stop the application before running storage commands; this database has an active host writer');
    const store = createMysqlStore(pool);
    if (command === 'init') { await store.initialize(); console.log('Application storage schema initialized.'); }
    if (command === 'import') console.log(await importData(store, root, await inventory(root)));
    if (command === 'verify') console.log(await verifyData(store, await inventory(root)));
    if (command === 'export') console.log(await exportData(store, path.resolve(destination)));
  } finally { if (lock) lock.destroy(); await pool.end(); }
}

main().catch((error) => {
  // Do not print SQL errors: some contain bound credentials or stored content.
  console.error(error.sql ? `Storage command failed (${error.code || 'database error'})` : error.message);
  process.exitCode = 1;
});
