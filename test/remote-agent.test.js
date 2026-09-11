'use strict';
/* The coding agent installed ON the server.
 *
 * It reads the box at full speed; anything it wants to CHANGE comes back as a
 * proposal and goes through the same approval path as every other command. No
 * real server and no real CLI: the exec is a fake that records what it was asked
 * to run and answers with whatever the test needs. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteAgents, readPlan, prose, briefing, AGENTS, AGENT_MARK } = require('../backend/remote-agent');

/** A fake ssh exec: every call recorded, answers driven by the test. */
function fakeExec(answers = {}) {
  const calls = [];
  const exec = async (client, command, options = {}) => {
    calls.push({ command, options });
    for (const [match, answer] of Object.entries(answers)) {
      if (!command.includes(match)) continue;
      if (typeof answer === 'function') return answer(command, options);
      return typeof answer === 'string' ? { stdout: answer, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0, ...answer };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  exec.calls = calls;
  return exec;
}

/** A detect() answer line for each agent. */
const present = (claude, codex) => ({
  'printf \'%s \' claude': `claude ${claude || 'MISSING'}\ncodex ${codex || 'MISSING'}\n`,
});

const plan = (summary, commands) => '```' + AGENT_MARK + '\n' + JSON.stringify({ summary, commands }) + '\n```';

test('the plan block is parsed, bounded, and never mistaken for prose', () => {
  const text = `I looked at the disk.\n\n${plan('/var/log is full', [{ cmd: 'journalctl --vacuum-size=200M', why: 'reclaim space' }])}`;
  const parsed = readPlan(text);
  assert.equal(parsed.summary, '/var/log is full');
  assert.deepEqual(parsed.commands, [{ cmd: 'journalctl --vacuum-size=200M', why: 'reclaim space' }]);
  assert.equal(prose(text), 'I looked at the disk.', 'the block itself is not shown to the operator twice');

  /* Only the last block counts, so an agent that "thinks out loud" in an earlier
     one cannot smuggle a command past the final answer. */
  const twice = `${plan('first', [{ cmd: 'rm -rf /', why: 'no' }])}\n${plan('second', [{ cmd: 'ls', why: 'yes' }])}`;
  assert.deepEqual(readPlan(twice).commands, [{ cmd: 'ls', why: 'yes' }]);

  /* Nothing usable is an empty plan, not a crash. */
  assert.deepEqual(readPlan('just prose'), { summary: null, commands: [] });
  assert.deepEqual(readPlan('```' + AGENT_MARK + '\nnot json\n```'), { summary: null, commands: [], unreadable: true });
  assert.deepEqual(readPlan(null), { summary: null, commands: [] });

  /* A flood of commands is capped, and empty ones dropped. */
  const many = readPlan(plan('x', Array.from({ length: 30 }, (_, i) => ({ cmd: `cmd${i}`, why: 'w' })).concat([{ cmd: '  ', why: 'empty' }])));
  assert.equal(many.commands.length, 10);
  assert.equal(many.commands.every((c) => c.cmd), true);

  /* Fields are strings of bounded length whatever the agent sent. */
  const hostile = readPlan('```' + AGENT_MARK + '\n' + JSON.stringify({ summary: 'x'.repeat(999), commands: [{ cmd: 'ls', why: 'y'.repeat(999) }] }) + '\n```');
  assert.equal(hostile.summary.length, 400);
  assert.equal(hostile.commands[0].why.length, 300);
});

test('the briefing tells the agent to propose rather than change, and carries the task verbatim', () => {
  const text = briefing({ task: 'why is / full?', serverName: 'STAGING', cwd: '/srv/app' });
  assert.match(text, /Do not modify anything/);
  assert.match(text, /TASK: why is \/ full\?/);
  assert.match(text, /STAGING/);
  assert.match(text, /\/srv\/app/);
  assert.match(text, new RegExp('```' + AGENT_MARK));
});

test('detection reports each agent and its version, and a missing one is an answer', async () => {
  const exec = fakeExec(present('1.2.3', null));
  const agents = createRemoteAgents({ exec });
  const found = await agents.detect({});
  assert.deepEqual(found.claude, { id: 'claude', label: 'Claude Code', installed: true, version: '1.2.3' });
  assert.deepEqual(found.codex, { id: 'codex', label: 'Codex CLI', installed: false, version: null });
  assert.equal(exec.calls.length, 1, 'one round trip for every agent');
  assert.match(exec.calls[0].command, /export PATH=/, 'a CLI in ~/.local/bin is still found');
});

test('installing skips an agent that is already there, and reports one that will not install', async () => {
  const already = createRemoteAgents({ exec: fakeExec(present('1.2.3', null)) });
  assert.deepEqual(await already.install({}, 'claude'), {
    ok: true, alreadyInstalled: true, agent: 'claude', version: '1.2.3', next: AGENTS.claude.login,
  });

  /* No installer on the box: say which one is missing rather than "failed". */
  const bare = createRemoteAgents({ exec: fakeExec({ ...present(null, null), 'claude.ai/install.sh': 'NOTOOL\n' }) });
  const refused = await bare.install({}, 'claude');
  assert.equal(refused.ok, false);
  assert.match(refused.next, /no installer/);

  await assert.rejects(bare.install({}, 'nonsense'), /Unknown agent/);
});

test('both agents are supported, and each is run in the mode that keeps it read-only', async () => {
  const exec = fakeExec(present('1.0', '1.0'));
  const agents = createRemoteAgents({ exec });

  await agents.ask({}, { agent: 'claude', task: 'look around', serverName: 'BOX' });
  const claudeRun = exec.calls.at(-1);
  assert.match(claudeRun.command, /claude -p --permission-mode plan/, 'plan mode is what stops Claude Code editing');
  assert.match(claudeRun.options.stdin, /TASK: look around/, 'the prompt goes over stdin');
  assert.equal(claudeRun.command.includes('look around'), false, 'nothing the user typed reaches the remote shell');

  await agents.ask({}, { agent: 'codex', task: 'look around', serverName: 'BOX' });
  const codexRun = exec.calls.at(-1);
  assert.match(codexRun.command, /codex exec --sandbox read-only/, 'the read-only sandbox is what stops Codex writing');
  assert.match(codexRun.options.stdin, /TASK: look around/);

  await assert.rejects(agents.ask({}, { agent: 'nonsense', task: 'x', serverName: 'BOX' }), /Unknown agent/);
});

test('asking returns prose and proposals separately, and refuses when the agent is not installed', async () => {
  const reply = `Disk is 98% full; /var/log/nginx holds 40G.\n\n${plan('rotate nginx logs', [{ cmd: 'logrotate -f /etc/logrotate.d/nginx', why: 'reclaim 40G' }])}`;
  const agents = createRemoteAgents({ exec: fakeExec({ ...present('1.0', null), 'claude -p': { stdout: reply, stderr: '', code: 0 } }) });

  const answer = await agents.ask({}, { agent: 'claude', task: 'why is / full?', serverName: 'STAGING', cwd: '/srv' });
  assert.equal(answer.reply, 'Disk is 98% full; /var/log/nginx holds 40G.');
  assert.equal(answer.summary, 'rotate nginx logs');
  assert.deepEqual(answer.commands, [{ cmd: 'logrotate -f /etc/logrotate.d/nginx', why: 'reclaim 40G' }]);
  assert.equal(answer.timedOut, false);
  assert.equal(answer.truncated, false);

  /* An agent that is not there is a 409 naming it, not a shell error. */
  await assert.rejects(agents.ask({}, { agent: 'codex', task: 'x', serverName: 'STAGING' }), (error) => error.status === 409 && /Codex CLI is not installed/.test(error.message));
  await assert.rejects(agents.ask({}, { agent: 'claude', task: '   ', serverName: 'STAGING' }), (error) => error.status === 400);
});

test('a run that times out, floods or fails still reports what it managed', async () => {
  const agents = createRemoteAgents({
    exec: fakeExec({ ...present('1.0', null), 'claude -p': { stdout: 'partial output', stderr: 'not logged in', code: 1, timedOut: true, truncated: true } }),
  });
  const answer = await agents.ask({}, { agent: 'claude', task: 'look', serverName: 'BOX' });
  assert.equal(answer.reply, 'partial output');
  assert.equal(answer.timedOut, true);
  assert.equal(answer.truncated, true);
  assert.equal(answer.exitCode, 1);
  assert.equal(answer.stderr, 'not logged in', 'the reason a CLI refused is the useful part');
  assert.deepEqual(answer.commands, [], 'a failed run proposes nothing');
});

test('the working directory is quoted, so a path cannot break out of the command', async () => {
  const exec = fakeExec(present('1.0', null));
  const agents = createRemoteAgents({ exec });
  const nasty = "/srv/app'; rm -rf /; echo '";
  await agents.ask({}, { agent: 'claude', task: 'x', serverName: 'BOX', cwd: nasty });

  // Exactly how POSIX sh escapes a single quote inside a single-quoted string.
  const quoted = "'" + nasty.split("'").join("'\\''") + "'";
  const command = exec.calls.at(-1).command;
  assert.ok(command.includes('cd ' + quoted), command);
  // What a shell would hand to cd is the path itself, unchanged.
  assert.equal(quoted.slice(1, -1).split("'\\''").join("'"), nasty);
});

test('a version is the number, because the label is already ours to add', async () => {
  /* `claude --version` prints "2.1.250 (Claude Code)", so prefixing the label
     said the name twice: "Claude Code 2.1.250 (Claude Code) on rbo-hosting". */
  const detect = async (stdout) => createRemoteAgents({ exec: async () => ({ stdout, stderr: '', code: 0 }) }).detect({});

  const claudeish = await detect('claude 2.1.250 (Claude Code)\ncodex MISSING\n');
  assert.equal(claudeish.claude.version, '2.1.250');
  assert.equal(claudeish.claude.installed, true);
  assert.equal(claudeish.codex.version, null);

  const codexish = await detect('claude 1.0.0\ncodex codex-cli 0.9.3\n');
  assert.equal(codexish.codex.version, '0.9.3');
  assert.equal(codexish.claude.version, '1.0.0');

  /* Something unparseable is still reported: a CLI that is there but whose
     version we cannot read is not the same as one that is missing. */
  const odd = await detect('claude some-weird-build\ncodex MISSING\n');
  assert.equal(odd.claude.installed, true);
  assert.equal(odd.claude.version, 'some-weird-build');

  const none = await detect('claude MISSING\ncodex MISSING\n');
  assert.deepEqual([none.claude.installed, none.claude.version], [false, null]);
});

test('a borrowed credential never reaches the command line, and nothing is left behind', async () => {
  /* The whole point of lending the assistant's sign-in to an agent elsewhere is
     that it leaves no trace to clean up. Two things make that true, and both are
     asserted here: the token is not in the command (so `ps` cannot show it) and
     it is not written anywhere (so there is nothing to delete afterwards). */
  const SECRET = 'sk-ant-oat-super-secret-value';
  const exec = fakeExec(present('2.1.250', '0.9.0'));
  const agents = createRemoteAgents({ exec });

  await agents.ask({}, {
    agent: 'claude', task: 'why is / full?', serverName: 'BOX',
    credential: { token: SECRET, kind: 'oauth' },
  });
  const call = exec.calls.at(-1);

  assert.equal(call.command.includes(SECRET), false, 'the token is not in argv, so ps cannot show it');
  assert.equal(/>|tee|cat\s*>/.test(call.command), false, 'nothing redirects it into a file');
  assert.match(call.command, /IFS= read -r __st_tok/, 'it is read from stdin by the wrapper');
  assert.match(call.command, /export CLAUDE_CODE_OAUTH_TOKEN="\$__st_tok"/, 'a setup-token goes in the OAuth variable');
  assert.match(call.command, /unset __st_tok/, 'and the shell variable is dropped before the CLI is exec-ed');
  assert.match(call.command, /exec claude -p --permission-mode plan/, 'the CLI replaces the wrapper, keeping the same stdin');

  /* The token is the FIRST line of stdin; the briefing follows it. */
  assert.equal(call.options.stdin.startsWith(SECRET + '\n'), true);
  assert.match(call.options.stdin, /TASK: why is \/ full\?/);

  /* An API key goes in the API-key variable instead. */
  await agents.ask({}, { agent: 'claude', task: 'x', serverName: 'BOX', credential: { token: 'sk-ant-api-key', kind: 'api-key' } });
  assert.match(exec.calls.at(-1).command, /export ANTHROPIC_API_KEY=/);

  await agents.ask({}, { agent: 'codex', task: 'x', serverName: 'BOX', credential: { token: 'oai-key', kind: 'api-key' } });
  assert.match(exec.calls.at(-1).command, /export OPENAI_API_KEY=/);
});

test('with no credential to lend, the run is exactly what it always was', async () => {
  const exec = fakeExec(present('1.0', null));
  const agents = createRemoteAgents({ exec });
  await agents.ask({}, { agent: 'claude', task: 'x', serverName: 'BOX' });
  const call = exec.calls.at(-1);
  assert.equal(/read -r __st_tok/.test(call.command), false, 'no wrapper when there is nothing to pass');
  assert.match(call.command, /&& claude -p --permission-mode plan$/);
  assert.equal(call.options.stdin.startsWith('You are investigating'), true, 'stdin is just the briefing');
});
