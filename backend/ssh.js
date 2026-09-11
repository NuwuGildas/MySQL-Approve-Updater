'use strict';
/* One live ssh2 client per server profile, plus the VM metadata pulled from it.
 *
 * The credentials come from the host, one profile at a time, because this module
 * declared the "connections:secrets" capability and the user saw that before
 * installing it. Nothing is cached: a profile edited in Connections takes effect
 * on the next connect. */

const fs = require('node:fs');

const fail = (status, message) => Object.assign(new Error(message), { status });

/** ssh2 connect options for one profile's ssh config. Identical to the base
 *  application's, which still uses its own copy for database tunnels. */
function connectOptions(sshCfg, client) {
  const options = {
    host: sshCfg.host,
    port: sshCfg.port,
    username: sshCfg.user,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  };
  if (sshCfg.privateKeyPath) {
    options.privateKey = fs.readFileSync(sshCfg.privateKeyPath); // may throw; the caller reports it
    if (sshCfg.passphrase) options.passphrase = sshCfg.passphrase;
  } else if (sshCfg.password) {
    options.password = sshCfg.password;
    // Some servers only accept keyboard-interactive instead of plain password.
    options.tryKeyboard = true;
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => finish(prompts.map(() => sshCfg.password)));
  } else {
    throw new Error('SSH enabled but neither an SSH password nor a private key is configured');
  }
  return options;
}

/* One compound command → labelled key=value lines we can parse. */
const VM_META_CMD = [
  'echo "HOST=$(hostname 2>/dev/null)"',
  'echo "DISTRO=$( ( . /etc/os-release 2>/dev/null; printf %s "$PRETTY_NAME" ) )"',
  'echo "KERNEL=$(uname -sr 2>/dev/null)"',
  'echo "ARCH=$(uname -m 2>/dev/null)"',
  'echo "UPTIME=$(uptime -p 2>/dev/null | sed s/^up.//)"',
  'echo "CPUS=$(nproc 2>/dev/null)"',
  'echo "LOAD=$(cut -d\' \' -f1-3 /proc/loadavg 2>/dev/null)"',
  'echo "MEM=$(free -m 2>/dev/null | awk \'/Mem:/{print $3"/"$2}\')"',
  'echo "DISK=$(df -h / 2>/dev/null | awk \'NR==2{print $3"/"$2" "$5}\')"',
  'echo "USER=$(whoami 2>/dev/null)"',
].join('; ');

function createSshSessions({ host, SSHClient, log = () => {} }) {
  const sessions = new Map();   // profileId → { client, connectedAt, meta, host, user, name }

  /** Full profile including secrets. Only this module may ask for it. */
  const credentials = (id) => host.call('connections.credentials', { id });

  function clientFor(sshCfg) {
    return new Promise((resolve, reject) => {
      const client = new SSHClient();
      let options;
      try { options = connectOptions(sshCfg, client); }
      catch (error) { return reject(new Error(error.message)); }
      let settled = false;
      client.on('ready', () => { settled = true; resolve(client); });
      client.on('error', (error) => { if (!settled) { settled = true; reject(new Error(error.message)); } });
      client.connect(options);
    });
  }

  /**
   * Run one command and collect everything it produced.
   *
   * Unlike exec() this keeps stderr and the exit code, caps how much it will
   * hold, feeds stdin, and can be cancelled - which is what running a coding
   * agent on the server needs: it is slow, it is chatty, and the user must be
   * able to stop it. It never rejects on a non-zero exit: a CLI that failed has
   * something to say, and the caller decides what that means.
   */
  function execCapture(client, command, { timeoutMs = 60000, maxBytes = 256 * 1024, stdin = null, signal } = {}) {
    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let stdout = '', stderr = '', truncated = false, timedOut = false, done = false;
        const keep = (text, into) => (into.length >= maxBytes ? (truncated = true, into) : into + text);
        const finish = (extra = {}) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve({ stdout, stderr, truncated, timedOut, ...extra });
        };
        const stop = () => { try { stream.close(); } catch {} };
        const timer = setTimeout(() => { timedOut = true; stop(); finish(); }, timeoutMs);
        const onAbort = () => { stop(); finish({ cancelled: true }); };
        if (signal) {
          if (signal.aborted) { stop(); return finish({ cancelled: true }); }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        stream.on('data', (chunk) => { stdout = keep(chunk.toString('utf8'), stdout); if (truncated) stop(); });
        stream.stderr.on('data', (chunk) => { stderr = keep(chunk.toString('utf8'), stderr); });
        stream.on('close', (code, sig) => finish({ code: code ?? null, signal: sig ?? null }));
        stream.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); } });
        if (stdin !== null && stdin !== undefined) { try { stream.write(String(stdin)); } catch {} }
        try { stream.end(); } catch {}
      });
    });
  }

  function exec(client, command, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let out = '';
        const timer = setTimeout(() => { try { stream.close(); } catch {} resolve(out); }, timeoutMs);
        stream.on('data', (chunk) => { out += chunk.toString('utf8'); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { clearTimeout(timer); resolve(out); });
        stream.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
    });
  }

  async function pullMeta(client) {
    const out = await exec(client, VM_META_CMD);
    const meta = {};
    for (const line of out.split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) meta[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    meta.pulledAt = new Date().toISOString();
    return meta;
  }

  /** Connect if needed and return the live session for a profile. */
  async function connect(id) {
    const profile = await credentials(id);
    if (!profile?.ssh?.enabled || !profile.ssh.host) throw fail(400, 'That profile has no SSH configured');
    let session = sessions.get(id);
    if (!session) {
      let client;
      try { client = await clientFor(profile.ssh); }
      catch (error) { throw fail(400, `SSH connection failed: ${error.message}`); }
      session = { client, connectedAt: new Date().toISOString(), meta: null, host: profile.ssh.host, user: profile.ssh.user, name: profile.name };
      client.on('close', () => { if (sessions.get(id)?.client === client) sessions.delete(id); });
      sessions.set(id, session);
      log('info', `SSH session connected: ${profile.ssh.user}@${profile.ssh.host} ("${profile.name}")`);
      await host.audit({ action: 'ssh-session-connect', sshHost: profile.ssh.host, sshUser: profile.ssh.user, profile: profile.name });
    }
    return { profile, session };
  }

  function disconnect(id) {
    const session = sessions.get(id);
    if (!session) return false;
    try { session.client.end(); } catch {}
    sessions.delete(id);
    return true;
  }

  const view = (profile) => {
    const session = sessions.get(profile.id);
    return {
      id: profile.id, name: profile.name,
      host: profile.ssh.host, port: profile.ssh.port, user: profile.ssh.user,
      active: !!profile.active, sshOnly: !!profile.sshOnly,
      connected: !!session, connectedAt: session?.connectedAt || null, meta: session?.meta || null,
    };
  };

  return { sessions, connect, disconnect, exec, execCapture, pullMeta, view, credentials, clientFor, connectOptions };
}

module.exports = { createSshSessions, connectOptions, VM_META_CMD };
