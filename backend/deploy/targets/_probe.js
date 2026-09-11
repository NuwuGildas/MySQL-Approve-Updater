'use strict';
/* Remote environment probe (read-only): user, OS, toolchain versions, sudo,
   disk, existing releases. One compound command → key=value lines, the same
   idiom as VM_META_CMD in server.js. */

const { q } = require('../shell');

const TOOLS = { git: 'git --version', php: 'php -v', composer: 'composer --version --no-ansi 2>/dev/null', node: 'node -v', npm: 'npm -v', pnpm: 'pnpm -v', yarn: 'yarn -v', bun: 'bun -v', pm2: 'pm2 -v 2>/dev/null', docker: 'docker --version', nginx: 'nginx -v 2>&1', apache2: 'apache2 -v 2>/dev/null', httpd: 'httpd -v 2>/dev/null', systemctl: 'systemctl --version', curl: 'curl --version', tar: 'tar --version', python3: 'python3 --version', rsync: 'rsync --version' };

function probeCmd(root) {
  const parts = [
    'echo "USER=$(whoami 2>/dev/null)"', 'echo "HOME=$HOME"', 'echo "HOST=$(hostname 2>/dev/null)"',
    'echo "OS=$( ( . /etc/os-release 2>/dev/null; printf %s "$PRETTY_NAME" ) )"', 'echo "ARCH=$(uname -m 2>/dev/null)"',
    'echo "SUDO=$(sudo -n true 2>/dev/null && echo yes || echo no)"',
    'echo "SHELL_OK=yes"',
  ];
  for (const [t, v] of Object.entries(TOOLS)) parts.push(`if command -v ${t} >/dev/null 2>&1; then echo "TOOL_${t}=$(${v} 2>/dev/null | head -1 | tr -d '\\r')"; fi`);
  if (root) {
    parts.push(`echo "ROOT_EXISTS=$( [ -d ${q(root)} ] && echo yes || echo no)"`);
    parts.push(`echo "ROOT_WRITABLE=$( { [ -d ${q(root)} ] && [ -w ${q(root)} ]; } || { [ ! -e ${q(root)} ] && [ -w "$(dirname ${q(root)})" ]; } && echo yes || echo no)"`);
    parts.push(`echo "DISK=$(df -h ${q(root)} 2>/dev/null || df -h "$(dirname ${q(root)})" 2>/dev/null | awk 'NR==2{print $4" free of "$2}')"`);
    parts.push(`echo "CURRENT=$(readlink ${q(root + '/current')} 2>/dev/null)"`);
    parts.push(`echo "RELEASES=$(ls -1 ${q(root + '/releases')} 2>/dev/null | grep -E '^[0-9]{14}$' | tr '\\n' ' ')"`);
    parts.push(`echo "LOCK=$(cat ${q(root + '/.ship-lock/owner')} 2>/dev/null)"`);
    parts.push(`echo "SYMLINK_OK=$( t=${q(root)}/.st-probe-$$; ( [ -d ${q(root)} ] && ln -s . "$t" 2>/dev/null && rm -f "$t" && echo yes ) || echo unknown)"`);
  }
  return parts.join('; ');
}

function parseProbe(out) {
  const meta = { tools: {} };
  for (const line of out.split('\n')) {
    const i = line.indexOf('='); if (i <= 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (k.startsWith('TOOL_')) meta.tools[k.slice(5)] = v || 'present';
    else meta[k.toLowerCase()] = v;
  }
  meta.sudo = meta.sudo === 'yes';
  meta.releases = (meta.releases || '').split(' ').filter(Boolean);
  meta.rootWritable = meta.root_writable === 'yes';
  meta.rootExists = meta.root_exists === 'yes';
  meta.symlinkOk = meta.symlink_ok === 'yes' ? true : meta.symlink_ok === 'unknown' ? null : false;
  meta.current = (meta.current || '').replace(/^.*releases\//, '') || null;
  meta.pulledAt = new Date().toISOString();
  // normalized version strings
  const ver = (s) => (s && (s.match(/\d+\.\d+(\.\d+)?/) || [])[0]) || null;
  meta.versions = Object.fromEntries(Object.entries(meta.tools).map(([k, v]) => [k, ver(v)]));
  return meta;
}

async function probe(conn, root) {
  if (!conn.canExec) return { shell_ok: 'no', tools: {}, versions: {}, sudo: false, releases: [], rootWritable: null, symlinkOk: false, pulledAt: new Date().toISOString(), user: conn.user, home: conn.home || null };
  const { out } = await conn.exec(probeCmd(root), { timeoutMs: 60000 });
  return parseProbe(out);
}

module.exports = { probe, probeCmd, parseProbe, TOOLS };
