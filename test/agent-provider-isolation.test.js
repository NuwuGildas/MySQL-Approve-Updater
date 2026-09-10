'use strict';
/* The in-app assistant may only act through approval cards, so a CLI provider must never reach its
   own file/command/web/MCP tools. These tests assert the argv, environment, generated config and
   the refusal that replaces a turn when the installed CLI cannot be locked down. No CLI is spawned:
   the invocation builders are pure and the capability check is fed recorded --version/--help text. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const iso = require('../lib/agent-isolation');

const CODEX_HELP = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -m, --model <MODEL>              Model the agent should use
  -c, --config <key=value>         Override a configuration value
      --sandbox <SANDBOX_MODE>     Select the sandbox policy [possible values: read-only, workspace-write, danger-full-access]
      --skip-git-repo-check        Allow running outside a Git repository
      --output-last-message <FILE> Write the agent's last message to a file
`;

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                      Print response and exit
  --model <model>                  Model for the session
  --settings <file-or-json>        Path to a settings JSON file
  --mcp-config <configs...>        Load MCP servers from JSON files or strings
  --strict-mcp-config              Only use MCP servers from --mcp-config
  --allowedTools <tools...>        Comma or space-separated list of tool names to allow
  --disallowedTools <tools...>     Comma or space-separated list of tool names to deny
`;

/* ---------- codex argv + env ---------- */

test('codex argv pins the sandbox and repeats every restriction as a -c override', () => {
  const inv = iso.buildCodexInvocation({ home: '/managed/codex', model: 'gpt-5', lastFile: '/data/.agent-last.txt', baseEnv: { PATH: '/usr/bin' } });
  const argv = inv.args.join(' ');
  assert.equal(inv.cmd, 'codex');
  assert.match(argv, /--sandbox read-only/);
  assert.match(argv, /--skip-git-repo-check/);
  assert.match(argv, /-m gpt-5/);
  for (const o of iso.CODEX_OVERRIDES) assert.ok(inv.args.includes(o), `missing override ${o}`);
  // the four capabilities that would bypass the approval cards
  assert.match(argv, /mcp_servers=\{\}/);
  assert.match(argv, /tools\.web_search=false/);
  assert.match(argv, /approval_policy='never'/);
  assert.match(argv, /sandbox_mode='read-only'/);
  assert.equal(inv.args[inv.args.length - 1], '-'); // prompt still arrives on stdin
});

test('codex runs in the managed home, never in the app data directory', () => {
  const inv = iso.buildCodexInvocation({ home: '/managed/codex', lastFile: '/data/.agent-last.txt', baseEnv: { PATH: '/usr/bin' } });
  assert.equal(inv.cwd, '/managed/codex');
  assert.equal(inv.env.CODEX_HOME, '/managed/codex');
});

test('inherited redirects are stripped from the child environment, PATH survives', () => {
  const dirty = {
    PATH: '/usr/bin', TEMP: '/tmp', USERPROFILE: 'C:\\Users\\x',
    CODEX_HOME: 'C:\\Users\\x\\.codex', OPENAI_BASE_URL: 'http://evil', OPENAI_API_KEY: 'sk-x',
    ANTHROPIC_BASE_URL: 'http://evil', CLAUDE_CONFIG_DIR: 'C:\\Users\\x\\.claude',
    MCP_SERVERS: 'a', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--require ./pwn.js',
    NODE_EXTRA_CA_CERTS: 'C:\\ca.pem', XDG_CONFIG_HOME: '/home/x/.config',
  };
  const env = iso.buildCodexInvocation({ home: '/managed/codex', lastFile: '/x', baseEnv: dirty }).env;
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.TEMP, '/tmp');
  assert.equal(env.USERPROFILE, 'C:\\Users\\x');
  for (const k of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'MCP_SERVERS', 'HTTPS_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME']) {
    assert.equal(env[k], undefined, `${k} should have been stripped`);
  }
  assert.equal(env.CODEX_HOME, '/managed/codex'); // the one we set ourselves, not the inherited one
});

/* ---------- claude argv ---------- */

test('claude argv keeps the caller flags and adds the isolation switches', () => {
  const inv = iso.buildClaudeInvocation({ home: '/managed/claude', args: ['-p', '--model', 'sonnet'], baseEnv: { PATH: '/usr/bin' } });
  const argv = inv.args.join(' ');
  assert.match(argv, /^-p --model sonnet /);
  assert.match(argv, /--strict-mcp-config/);
  assert.match(argv, /--mcp-config "[^"]*mcp-empty\.json"/);
  assert.match(argv, /--settings "[^"]*settings\.json"/);
  assert.match(argv, /--disallowedTools "Bash,/);
  assert.match(argv, /mcp__\*"/);
  assert.equal(inv.cwd, '/managed/claude');
  assert.equal(inv.env.CLAUDE_CONFIG_DIR, '/managed/claude');
});

test('claude uses whichever spelling of the deny flag the installed CLI advertises', () => {
  const inv = iso.buildClaudeInvocation({ home: '/managed/claude', disallowFlag: '--disallowed-tools', baseEnv: {} });
  assert.ok(inv.args.includes('--disallowed-tools'));
  assert.equal(iso.assessIsolation('claude', { version: '2.0.1', help: CLAUDE_HELP }).disallowFlag, '--disallowedTools');
  assert.equal(iso.assessIsolation('claude', { version: '2.0.1', help: CLAUDE_HELP.replace('--disallowedTools', '--disallowed-tools') }).disallowFlag, '--disallowed-tools');
});

/* ---------- capability check ---------- */

test('a CLI whose help advertises the switches is enforceable', () => {
  const a = iso.assessIsolation('codex', { version: 'codex-cli 0.44.0', help: CODEX_HELP });
  assert.equal(a.enforceable, true);
  assert.equal(a.version, '0.44.0');
  assert.equal(iso.assessIsolation('claude', { version: '2.0.1 (Claude Code)', help: CLAUDE_HELP }).enforceable, true);
});

test('a CLI missing a switch is unenforceable and names what is missing', () => {
  const a = iso.assessIsolation('codex', { version: 'codex-cli 0.44.0', help: CODEX_HELP.replace('      --sandbox <SANDBOX_MODE>     Select the sandbox policy [possible values: read-only, workspace-write, danger-full-access]\n', '') });
  assert.equal(a.enforceable, false);
  assert.deepEqual(a.missing, ['--sandbox']);
  assert.match(a.reason, /--sandbox/);

  const c = iso.assessIsolation('claude', { version: '1.2.3', help: CLAUDE_HELP.replace('  --strict-mcp-config              Only use MCP servers from --mcp-config\n', '') });
  assert.equal(c.enforceable, false);
  assert.deepEqual(c.missing, ['--strict-mcp-config']);
});

test('with no readable help the version decides, and an unknown version is a refusal', () => {
  assert.equal(iso.assessIsolation('codex', { version: 'codex-cli 0.44.0', help: '' }).enforceable, true);
  const old = iso.assessIsolation('codex', { version: 'codex-cli 0.9.0', help: '' });
  assert.equal(old.enforceable, false);
  assert.match(old.reason, /0\.9\.0 is older than the 0\.20\.0/);
  const unknown = iso.assessIsolation('codex', { version: 'codex (dev build)', help: '' });
  assert.equal(unknown.enforceable, false);
  assert.match(unknown.reason, /version could not be determined/);
});

test('an unenforceable provider is rejected with an actionable 409, never downgraded', () => {
  const a = iso.assessIsolation('codex', { version: 'codex-cli 0.9.0', help: '' });
  const e = iso.isolationRejection({ label: 'Codex CLI', cmd: 'codex' }, a);
  assert.equal(e.status, 409);
  assert.match(e.message, /Codex CLI cannot be isolated/);
  assert.match(e.message, /0\.9\.0/);          // which CLI version
  assert.match(e.message, /--sandbox/);        // what is missing
  assert.match(e.message, /Upgrade codex/);    // what to do about it
  assert.equal(e.isolation, a);
});

/* ---------- managed home ---------- */

test('the managed codex home is generated with a restrictive config', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-iso-'));
  try {
    const home = await iso.ensureProviderHome(dir, 'codex');
    assert.equal(home, path.join(dir, 'agent-home', 'codex'));
    const toml = await fsp.readFile(path.join(home, 'config.toml'), 'utf8');
    assert.match(toml, /approval_policy = "never"/);
    assert.match(toml, /sandbox_mode = "read-only"/);
    assert.match(toml, /web_search = false/);
    assert.match(toml, /\[mcp_servers\]\s*\n\s*\n?\[shell_environment_policy\]/);
    assert.match(toml, /inherit = "none"/);

    // a hand-edited config must not survive: the file is regenerated every time
    await fsp.writeFile(path.join(home, 'config.toml'), 'approval_policy = "never"\n[mcp_servers.evil]\ncommand = "sh"\n', 'utf8');
    await iso.ensureProviderHome(dir, 'codex');
    assert.equal(await fsp.readFile(path.join(home, 'config.toml'), 'utf8'), iso.CODEX_CONFIG_TOML);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('the managed claude home denies every built-in tool and declares no MCP servers', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-iso-'));
  try {
    const home = await iso.ensureProviderHome(dir, 'claude');
    const settings = JSON.parse(await fsp.readFile(path.join(home, 'settings.json'), 'utf8'));
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'mcp__*']) {
      assert.ok(settings.permissions.deny.includes(t), `${t} should be denied`);
    }
    assert.deepEqual(settings.permissions.allow, []);
    assert.equal(settings.enableAllProjectMcpServers, false);
    assert.equal(settings.disableAllHooks, true);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(home, 'mcp-empty.json'), 'utf8')), { mcpServers: {} });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
