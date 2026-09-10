'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSshAgent, classify, FILE_NAME } = require('../lib/ssh-agent');

function setup(t, { aiAssist = {}, dir: givenDir, initialFile } = {}) {
  const dir = givenDir || fs.mkdtempSync(path.join(os.tmpdir(), 'st-ssh-session-'));
  if (initialFile !== undefined) fs.writeFileSync(path.join(dir, FILE_NAME), initialFile);
  const agent = { tools: {}, proposals: [], kinds: {} }, audits = [], routes = {}, live = new Map(), ran = [];
  const settings = { aiAssist: { sshRead: true, sshWrite: true, sshDestructive: true, sshMemory: true, ...aiAssist } };
  const profiles = {
    p1: { id: 'p1', name: 'STAGING', ssh: { enabled: true, host: 'staging.local', user: 'dev', port: 22 } },
    p2: { id: 'p2', name: 'PRODUCTION', ssh: { enabled: true, host: 'production.local', user: 'deploy', port: 22 } },
  };
  let counter = 0;
  const terminals = {
    async open(profileId, { sessionId } = {}) {
      if (sessionId) {
        const existing = live.get(sessionId);
        if (!existing || existing.status !== 'open') throw Object.assign(new Error('Terminal is closed'), { status: 409 });
        if (existing.profileId !== profileId) throw Object.assign(new Error('Wrong profile'), { status: 409 });
        return { ...existing };
      }
      const s = { sessionId: `session-${++counter}`, profileId, status: 'open', control: 'user', revision: 0, output: 'shell ready\n', cursor: 12, busy: false };
      live.set(s.sessionId, s); return { ...s };
    },
    snapshot(id, { cursor = 0 } = {}) {
      if (!live.has(id)) throw Object.assign(new Error('Terminal not found'), { status: 404 });
      const s = live.get(id); return { ...s, output: s.output.slice(cursor) };
    },
    get: (id) => live.get(id),
    async sendCommand(id, cmd, { expectedRevision }) {
      const s = live.get(id);
      assert.equal(s.control, 'assistant'); assert.equal(s.revision, expectedRevision); assert.equal(s.busy, false);
      s.revision++; ran.push({ id, cmd });
      await new Promise((resolve) => setImmediate(resolve));
      return { stdout: `result for ${s.profileId}: ${cmd}\n`, stderr: '', code: 0, revision: s.revision };
    },
    async setControl(id, control) { const s = live.get(id); s.control = control; s.revision++; },
    close(id) { live.get(id).status = 'closed'; live.get(id).revision++; },
  };
  const api = createSshAgent({
    app: { get: (url, fn) => { routes[`GET ${url}`] = fn; }, post: (url, fn) => { routes[`POST ${url}`] = fn; } },
    DATA_DIR: dir, settings, profileById: (id) => profiles[id], terminals, agent,
    audit: (entry) => audits.push(entry), logEvent() {}, wrap: (fn) => fn,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
  });
  t.after(async () => { await api.flush(); if (!givenDir) fs.rmSync(dir, { recursive: true, force: true }); });
  return { api, agent, terminals, settings, profiles, live, ran, dir, audits, routes };
}

test('classifier uses narrow informational commands and refuses shell/interpreter bypasses', () => {
  for (const cmd of ['ls -la /var/www', 'cat /etc/hosts', 'df -h', 'free -m', 'uptime', 'whoami',
    'systemctl status nginx --no-pager', 'git -C /var/www/app log --oneline -5', 'git status',
    'ps aux | grep php', 'tail -n 50 /var/log/syslog | grep -i error', 'crontab -l', 'ss -tulpn',
    'find /var/log -name "*.log" -mtime -1', 'php -v']) assert.equal(classify(cmd).cls, 'read', cmd);
  for (const cmd of ['touch /tmp/x', 'mkdir -p /tmp/data', 'systemctl restart nginx', 'git -c alias.s=touch s',
    'git --git-dir=/tmp/repo reset --soft HEAD', 'systemctl --system restart nginx',
    'curl --config /tmp/options', 'curl https://example.com', 'find /tmp -fprint /tmp/out',
    'git log --output=/tmp/out', 'rg --pre=touch /tmp', 'echo hi > /tmp/out', 'echo hi > /dev/null', 'cat /etc/hosts 2>/dev/null']) {
    assert.equal(classify(cmd).cls, 'write', cmd);
  }
  for (const cmd of ['rm /tmp/file', 'rm -rf /var/www/old', 'git -C /tmp/repo reset --hard HEAD',
    'docker system prune -af', 'find /tmp -delete', 'mysql -e "drop database shop"', 'crontab -r', 'reboot',
    "r''m /tmp/x", 'curl -X DELETE https://example.com']) assert.equal(classify(cmd).cls, 'destructive', cmd);
  for (const cmd of ['echo $(touch /tmp/x)', 'echo `touch /tmp/x`', 'awk \'BEGIN {system("touch /tmp/x")}\'',
    'sed -n \'1e touch /tmp/x\' /etc/hosts', 'xargs -I x sh -c x', 'python3 -c "print(1)"',
    'node --version --eval "process.exit(0)"', 'env FOO=1 cat /tmp/x', 'sudo -u root ls',
    'bash -c "ls"', 'cat x | sh', 'ls\nrm /tmp/x', 'vi /etc/hosts', 'sleep 60 &', '']) {
    assert.equal(classify(cmd).cls, 'blocked', cmd);
  }
  assert.equal(classify('sudo ls').sudo, true);
  assert.equal(classify("su''do touch /tmp/x").sudo, true);
  assert.equal(classify('x'.repeat(2100)).cls, 'blocked');
});

test('all shell input requires approval even with sshAuto, and output reads do not type commands', async (t) => {
  const { api, agent, terminals, settings, ran } = setup(t, { aiAssist: { sshAuto: true } });
  const s = await api.attach('p1', { projectId: 'project-a' });
  assert.equal(agent.tools.ssh_exec.enabled(), false, 'opening a terminal does not create ambient AI context');
  assert.equal(api.status().attached, false);
  await assert.rejects(agent.tools.ssh_exec.run({ cmd: 'ls' }), /terminal session/);
  await api.withSession(s.sessionId, async () => {
    assert.equal(agent.tools.ssh_exec.enabled(), true);
    const output = await agent.tools.ssh_terminal_read.run({ cursor: 0 });
    assert.match(output.output, /shell ready/); assert.equal(ran.length, 0);
    await assert.rejects(agent.tools.ssh_exec.run({ cmd: 'df -h' }), /Hand terminal control/);
    await terminals.setControl(s.sessionId, 'assistant');
    for (const cmd of ['df -h', 'touch /tmp/x', 'rm /tmp/x']) {
      const proposal = await agent.tools.ssh_exec.run({ cmd });
      assert.equal(proposal.status, 'pending_user_approval'); assert.equal(ran.length, 0);
    }
    const p = agent.proposals[0]; p.status = 'executing';
    const result = await agent.kinds['ssh-command'].approve(p);
    assert.equal(result.exitCode, 0); assert.equal(ran[0].cmd, 'df -h');
    assert.match(api.history(s.sessionId).at(-1).text, /Ran on "STAGING"/);
    assert.equal(api.status().guard.auto, false);
    settings.aiAssist.sshRead = false;
    assert.equal((await agent.tools.ssh_terminal_read.run({})).refused, true);
  });
});

test('concurrent turns, histories and memory remain exclusive even for two sessions on the same server', async (t) => {
  const { api, agent, terminals } = setup(t);
  const a = await api.attach('p1'), b = await api.attach('p1'), c = await api.attach('p2');
  await Promise.all([a, b, c].map(async (s, index) => {
    await terminals.setControl(s.sessionId, 'assistant');
    await api.withSession(s.sessionId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 8 - index));
      api.push(s.sessionId, { role: 'user', text: `private-${index}` });
      api.noteTurn(`private-${index}`, `reply-${index}`);
      await agent.tools.ssh_remember.run({ text: `memory-${index}` });
      const p = await agent.tools.ssh_exec.run({ cmd: 'df -h' });
      assert.equal(p.sessionId, s.sessionId); assert.equal(api.current().sessionId, s.sessionId);
      assert.match(api.promptFragment(), new RegExp(`memory-${index}`));
      const recall = await agent.tools.ssh_recall.run({});
      assert.equal(recall.notes.some((n) => n.text === `memory-${(index + 1) % 3}`), false);
    });
  }));
  assert.equal(api.current(), null);
  assert.equal(api.history(a.sessionId).some((m) => m.text === 'private-1'), false);
  assert.equal(api.history(b.sessionId).some((m) => m.text === 'private-0'), false);
  assert.equal(api.listForProfile('p1').length, 2);
  assert.equal(JSON.stringify(api.listForProfile('p1')).includes('private'), false);
  assert.equal(JSON.stringify(api.listForProfile('p1')).includes('memory'), false);
  await assert.rejects(api.attach('p2', { sessionId: a.sessionId }), /another server/);
});

test('approval revalidates session, terminal revision, permissions, sudo, command integrity and single execution', async (t) => {
  const { api, agent, terminals, settings, live, ran } = setup(t, { aiAssist: { sshSudo: true } });
  const a = await api.attach('p1'), b = await api.attach('p2');
  await terminals.setControl(a.sessionId, 'assistant'); await terminals.setControl(b.sessionId, 'assistant');
  const propose = async (cmd) => api.withSession(a.sessionId, async () => {
    const r = await agent.tools.ssh_exec.run({ cmd }); return agent.proposals.find((p) => p.id === r.proposalId);
  });
  const approve = (p) => api.withSession(a.sessionId, () => agent.kinds['ssh-command'].approve(p));
  const p = await propose('touch /tmp/a');
  await assert.rejects(api.withSession(b.sessionId, () => agent.kinds['ssh-command'].approve(p)), /another terminal session/);
  settings.aiAssist.sshWrite = false;
  await assert.rejects(approve(p), /Write commands are disabled/);
  settings.aiAssist.sshWrite = true;
  live.get(a.sessionId).revision++;
  await assert.rejects(approve(p), /terminal changed/);
  const sudo = await propose('sudo touch /tmp/a'); settings.aiAssist.sshSudo = false;
  await assert.rejects(approve(sudo), /Allow sudo/);
  const read = await propose('ls'); settings.aiAssist.sshRead = false;
  await assert.rejects(approve(read), /Read-only commands are disabled/); settings.aiAssist.sshRead = true;
  const changed = await propose('touch /tmp/b'); changed.cmd = 'touch /tmp/c';
  await assert.rejects(approve(changed), /command changed/);
  const final = await propose('touch /tmp/d');
  const outcomes = await Promise.allSettled([approve(final), approve(final)]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(ran.length, 1); assert.equal(ran[0].id, a.sessionId);
});

test('session chats persist, reset one session only, and closed terminals expose history without tools', async (t) => {
  const { api, terminals, agent, dir } = setup(t);
  const a = await api.attach('p1'), b = await api.attach('p2');
  api.push(a.sessionId, { role: 'user', text: 'first secret' });
  api.push(b.sessionId, { role: 'user', text: 'second secret' });
  await api.flush();
  const restored = setup(t, { dir }).api;
  assert.equal(restored.history(a.sessionId).at(-1).text, 'first secret');
  assert.equal(restored.status(a.sessionId).terminal.status, 'closed');
  restored.withSession(a.sessionId, () => assert.equal(restored.isAttached(), false));
  terminals.close(a.sessionId);
  api.withSession(a.sessionId, () => assert.equal(agent.tools.ssh_exec.enabled(), false));
  api.reset(a.sessionId);
  assert.deepEqual(api.history(a.sessionId), []);
  assert.equal(api.history(b.sessionId).at(-1).text, 'second secret');
});

test('corrupt session history is never replaced, and profile-wide memory endpoints are absent', async (t) => {
  const { api, dir, routes } = setup(t, { initialFile: '{broken json' });
  assert.match(api.readOnly, /read-only/);
  await assert.rejects(api.attach('p1'), /read-only/);
  await api.flush();
  assert.equal(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'), '{broken json');
  assert.equal(Object.keys(routes).some((r) => r.includes('/memory/')), false);
});

test('read-file helper produces an approval for a capped, quoted absolute file path', async (t) => {
  const { api, agent, terminals, ran } = setup(t);
  const s = await api.attach('p1'); await terminals.setControl(s.sessionId, 'assistant');
  await api.withSession(s.sessionId, async () => {
    for (const filename of ['/etc/x"; rm /tmp/x', '/etc/$(touch x)', '../etc/hosts']) await assert.rejects(agent.tools.ssh_read_file.run({ path: filename }), /plain absolute path/);
    const r = await agent.tools.ssh_read_file.run({ path: '/etc/hosts', lines: 900 });
    assert.equal(r.status, 'pending_user_approval'); assert.equal(ran.length, 0);
    assert.equal(agent.proposals.at(-1).cmd, "head -n 400 -- '/etc/hosts' | tail -n 400");
  });
});
