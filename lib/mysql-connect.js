'use strict';

/**
 * Shared MySQL connection helper for CLI scripts.
 *
 * Resolves a connection profile from connections.json (falling back to .env),
 * opens an SSH tunnel when the profile needs one, and hands back a mysql2
 * promise connection plus a close() that tears both down.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const mysql = require('mysql2/promise');
const { Client: SSHClient } = require('ssh2');

const ROOT = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });

/** Resolve a profile by name or id; defaults to the active one. */
function loadProfile(wanted) {
  const file = path.join(ROOT, 'connections.json');
  if (fs.existsSync(file)) {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    const profiles = (store.profiles || []).filter((p) => !p.sshOnly);
    let p = null;
    if (wanted) {
      const w = String(wanted).toLowerCase();
      p = profiles.find((x) => x.id === wanted || String(x.name).toLowerCase() === w);
      if (!p) {
        throw new Error(`No connection profile "${wanted}". Available: ${profiles.map((x) => x.name).join(', ')}`);
      }
    } else {
      p = profiles.find((x) => x.id === store.activeId) || profiles[0];
    }
    if (p) return { name: p.name, db: p.db, ssh: p.ssh && p.ssh.enabled ? p.ssh : null };
  }

  return {
    name: '.env',
    db: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
    ssh: String(process.env.SSH_TUNNEL).toLowerCase() !== 'false' && process.env.SSH_HOST
      ? {
        host: process.env.SSH_HOST,
        port: Number(process.env.SSH_PORT || 22),
        user: process.env.SSH_USER,
        password: process.env.SSH_PASSWORD,
        privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH,
        passphrase: process.env.SSH_PASSPHRASE,
      }
      : null,
  };
}

function describeProfile(profile) {
  return `${profile.name} - ${profile.db.database} @ ${profile.db.host}:${profile.db.port}`
    + (profile.ssh ? ` via SSH ${profile.ssh.host}` : ' (direct)');
}

function openSshTunnel(sshCfg, dbCfg) {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    const opts = {
      host: sshCfg.host,
      port: sshCfg.port || 22,
      username: sshCfg.user,
      readyTimeout: 30000,
    };
    if (sshCfg.privateKeyPath) {
      opts.privateKey = fs.readFileSync(sshCfg.privateKeyPath);
      if (sshCfg.passphrase) opts.passphrase = sshCfg.passphrase;
    } else if (sshCfg.password) {
      opts.password = sshCfg.password;
      opts.tryKeyboard = true;
      ssh.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => sshCfg.password)));
    } else {
      return reject(new Error('SSH enabled but no password or private key configured'));
    }

    let settled = false;
    ssh.on('error', (err) => {
      if (!settled) { settled = true; reject(new Error(`SSH connection failed: ${err.message}`)); }
    });
    ssh.on('ready', () => {
      const server = net.createServer((socket) => {
        ssh.forwardOut(socket.localAddress || '127.0.0.1', socket.localPort || 0, dbCfg.host, dbCfg.port, (err, stream) => {
          if (err) { socket.destroy(); return; }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      server.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        resolve({
          localPort: server.address().port,
          close: () => { try { server.close(); } catch (e) {} try { ssh.end(); } catch (e) {} },
        });
      });
    });
    ssh.connect(opts);
  });
}

/** @returns {Promise<{conn: import('mysql2/promise').Connection, close: () => Promise<void>}>} */
async function connect(profile) {
  let host = profile.db.host;
  let port = profile.db.port;
  let tunnel = null;
  if (profile.ssh) {
    tunnel = await openSshTunnel(profile.ssh, profile.db);
    host = '127.0.0.1';
    port = tunnel.localPort;
  }
  const conn = await mysql.createConnection({
    host,
    port,
    user: profile.db.user,
    password: profile.db.password,
    database: profile.db.database,
    dateStrings: true,
    multipleStatements: false,
  });
  return {
    conn,
    close: async () => {
      try { await conn.end(); } catch (e) {}
      if (tunnel) tunnel.close();
    },
  };
}

module.exports = { loadProfile, describeProfile, openSshTunnel, connect };
