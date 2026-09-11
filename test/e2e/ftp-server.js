'use strict';
/* Local FTP server for shared-hosting e2e tests.
   usage: node test/e2e/ftp-server.js [rootDir] [port]
   Serves rootDir (default: a temp dir) on 127.0.0.1:<port> (default 2121),
   user "acme" / password "ftp-secret". Prints the root dir and stays up. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FtpSrv } = require('ftp-srv');

const root = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'st-ftp-')));
const port = Number(process.argv[3]) || 2121;
fs.mkdirSync(path.join(root, 'public_html'), { recursive: true });
if (!fs.existsSync(path.join(root, 'public_html', 'index.html'))) fs.writeFileSync(path.join(root, 'public_html', 'index.html'), '<h1>old site</h1>');

const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 30050, anonymous: false, greeting: ['server-tools e2e ftp'] });
server.on('login', ({ username, password }, resolve, reject) => {
  if (username === 'acme' && password === 'ftp-secret') resolve({ root });
  else reject(new Error('bad credentials'));
});
server.on('client-error', ({ error }) => { if (!/ECONNRESET|EPIPE/.test(String(error))) console.error('ftp client error:', error.message); });
server.listen().then(() => {
  console.log(`FTP root: ${root}`);
  console.log(`ftp://acme:ftp-secret@127.0.0.1:${port}  (docroot /public_html)`);
});
process.on('SIGINT', () => { server.close(); process.exit(0); });
