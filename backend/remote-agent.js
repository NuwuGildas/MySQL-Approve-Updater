'use strict';
/* The coding agent installed ON the server.
 *
 * The assistant's normal route to a server is one command at a time, each its
 * own approval card. That is safe and slow: answering "why is / full?" costs a
 * dozen round trips through a human. An agent running on the box can do that
 * investigation at full speed, because it is already there.
 *
 * So the split is: the remote agent READS, the app still APPROVES. It is run in
 * the mode each CLI provides for exactly this - Claude Code's plan mode, Codex's
 * read-only sandbox - and whatever it decides needs changing comes back as a
 * list of commands, which this module feeds into the SAME approval path as any
 * other proposal: classified, sealed to the terminal revision, and run in the
 * shared terminal only after the user accepts it.
 *
 * The trust boundary, stated plainly:
 *
 *   - the agent runs as the SSH user, on the user's own machine. The read-only
 *     enforcement is the CLI's, not ours, and a CLI flag is not a sandbox: an
 *     agent that ignored its own mode could do whatever that user can do. What
 *     this module guarantees is narrower and still worth having - that NOTHING
 *     it says becomes a command this application runs without an approval;
 *   - its output is untrusted text. It is parsed, never executed, and every
 *     command it proposes is classified and gated exactly like one the local
 *     model proposed. A proposal that asks for something the user's settings
 *     forbid is refused here, the same as anywhere else;
 *   - the prompt goes over stdin, so nothing the user typed is ever interpolated
 *     into a remote shell command.
 */

const AGENT_MARK = 'st-plan';

/** The CLIs this module knows how to install and run, and how each is kept read-only. */
const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    /* Installed by the official script; `claude` may land in ~/.local/bin. */
    install: 'if command -v curl >/dev/null 2>&1; then curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -n 8; '
      + 'elif command -v wget >/dev/null 2>&1; then wget -qO- https://claude.ai/install.sh | bash 2>&1 | tail -n 8; '
      + 'else echo "NOTOOL"; fi',
    /* Plan mode is what keeps it read-only: it investigates and reports, and
       makes no edit. Print mode with no interactive prompt cannot be granted
       anything it was not started with. */
    run: '-p --permission-mode plan',
    login: 'Open the server terminal and run "claude" once to sign in; the CLI keeps its own credentials on the server.',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    install: 'if command -v npm >/dev/null 2>&1; then npm install -g @openai/codex 2>&1 | tail -n 8; '
      + 'else echo "NOTOOL"; fi',
    /* `codex exec` is the non-interactive form; the read-only sandbox is what
       keeps it from writing. */
    run: 'exec --sandbox read-only --color never -',
    login: 'Open the server terminal and run "codex" once to sign in; the CLI keeps its own credentials on the server.',
  },
};

const ids = () => Object.keys(AGENTS);
const fail = (status, message) => Object.assign(new Error(message), { status });
const shellSingleQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Where a CLI may be without being on a non-interactive PATH. */
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"; ';

/**
 * What the remote agent is told. It is a prompt, not a permission: the block it
 * is asked for is a convenience for parsing, and the app assumes nothing about
 * whether it complies.
 */
function briefing({ task, serverName, cwd }) {
  return [
    `You are investigating the server "${serverName}" for an operator working in Server Tools.`,
    cwd ? `The operator's terminal is in ${cwd}.` : '',
    '',
    'RULES:',
    '- Investigate by reading. Do not modify anything, and do not attempt to.',
    '- The operator cannot see your terminal; explain what you found in prose.',
    '- If something needs changing, DO NOT do it. Propose it instead.',
    '',
    'Finish your reply with one fenced block, exactly:',
    '',
    '```' + AGENT_MARK,
    '{"summary":"one sentence","commands":[{"cmd":"the exact shell command","why":"why it is needed"}]}',
    '```',
    '',
    'Use an empty commands array when nothing needs changing. Every command you',
    'put there is shown to the operator as an approval card and runs only if they',
    'accept it, so propose the smallest, most specific command that does the job.',
    '',
    `TASK: ${task}`,
  ].filter((line) => line !== null).join('\n');
}

/** The last ```st-plan block in the agent's reply, if it produced one. */
function readPlan(text) {
  const fence = new RegExp('```' + AGENT_MARK + '\\s*\\n([\\s\\S]*?)```', 'g');
  let found = null;
  for (const match of String(text || '').matchAll(fence)) found = match[1];
  if (!found) return { summary: null, commands: [] };
  let parsed;
  try { parsed = JSON.parse(found); } catch { return { summary: null, commands: [], unreadable: true }; }
  const commands = Array.isArray(parsed?.commands) ? parsed.commands : [];
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 400) : null,
    commands: commands
      .map((entry) => ({ cmd: String(entry?.cmd || '').trim(), why: String(entry?.why || '').trim().slice(0, 300) }))
      .filter((entry) => entry.cmd)
      .slice(0, 10),
  };
}

/** Everything outside the plan block: what the operator actually reads. */
const prose = (text) => String(text || '').replace(new RegExp('```' + AGENT_MARK + '[\\s\\S]*?```', 'g'), '').trim();

function createRemoteAgents({ exec, log = () => {} }) {
  /**
   * Which agents this server has. One round trip for all of them; a missing CLI
   * is an answer, not an error.
   */
  async function detect(client, { timeoutMs = 20000 } = {}) {
    const parts = ids().map((id) => `printf '%s ' ${id}; if command -v ${id} >/dev/null 2>&1; then ${id} --version 2>/dev/null | head -1 | tr -d '\\n'; echo; else echo MISSING; fi`);
    const out = await exec(client, PATH_PREFIX + parts.join('; '), { timeoutMs });
    const agents = {};
    for (const id of ids()) {
      const line = (out.stdout || '').split('\n').find((l) => l.startsWith(id + ' '));
      const rest = line ? line.slice(id.length + 1).trim() : 'MISSING';
      /* `claude --version` prints "2.1.250 (Claude Code)" and `codex --version`
         its own preamble. The label is ours to add, so the version kept here is
         the number alone - otherwise the name is said twice. */
      const reported = rest && rest !== 'MISSING' ? rest.slice(0, 60) : null;
      const number = reported && (reported.match(/\d+(?:\.\d+)+(?:[-+][\w.]+)?/) || [])[0];
      agents[id] = {
        id, label: AGENTS[id].label,
        installed: !!reported,
        version: number || reported,
      };
    }
    return agents;
  }

  /** Install one agent. Returns what happened, never a credential. */
  async function install(client, agentId, { timeoutMs = 240000 } = {}) {
    const agent = AGENTS[agentId];
    if (!agent) throw fail(400, `Unknown agent "${agentId}". Known: ${ids().join(', ')}`);
    const before = (await detect(client))[agentId];
    if (before.installed) return { ok: true, alreadyInstalled: true, agent: agentId, version: before.version, next: agent.login };

    const out = await exec(client, PATH_PREFIX + agent.install, { timeoutMs });
    const after = (await detect(client))[agentId];
    const missingTool = /(^|\n)NOTOOL(\n|$)/.test(out.stdout || '');
    return {
      ok: after.installed,
      alreadyInstalled: false,
      agent: agentId,
      version: after.version,
      output: String(out.stdout || '').trim().slice(-1500),
      next: after.installed ? agent.login
        : missingTool ? `This server has no installer for ${agent.label} (curl/wget for Claude Code, npm for Codex).`
          : `${agent.label} did not install. Open the server's terminal to finish it; the output above is what it printed.`,
    };
  }

  /**
   * Ask the agent on the server. Returns its prose, and the commands it wants
   * run - which are proposals, nothing more: the caller puts them through the
   * approval path.
   */
  async function ask(client, { agent: agentId, task, serverName, cwd, known = null, timeoutMs = 180000, maxBytes = 256 * 1024, signal } = {}) {
    const agent = AGENTS[agentId];
    if (!agent) throw fail(400, `Unknown agent "${agentId}". Known: ${ids().join(', ')}`);
    const question = String(task || '').trim();
    if (!question) throw fail(400, 'Describe what the agent should look into.');

    // A caller that already probed the server passes what it found: asking twice
    // is a wasted round trip on a connection the user is waiting on.
    const present = (known || await detect(client))[agentId];
    if (!present.installed) throw fail(409, `${agent.label} is not installed on "${serverName}". Install it from the server's card first.`);

    const started = Date.now();
    const run = await exec(client, `${PATH_PREFIX}cd ${cwd ? shellSingleQuote(cwd) : '"$HOME"'} && ${agentId} ${agent.run}`, {
      timeoutMs, maxBytes, signal,
      stdin: briefing({ task: question, serverName, cwd }),
    });
    const text = String(run.stdout || '');
    const plan = readPlan(text);
    log(run.timedOut ? 'warn' : 'info',
      `${agent.label} on "${serverName}": ${Date.now() - started}ms, ${text.length} bytes${run.timedOut ? ' (timed out)' : ''}, ${plan.commands.length} proposed command(s)`);

    return {
      agent: agentId, label: agent.label,
      reply: prose(text),
      summary: plan.summary,
      commands: plan.commands,
      unreadablePlan: !!plan.unreadable,
      timedOut: !!run.timedOut,
      truncated: !!run.truncated,
      exitCode: run.code ?? null,
      stderr: String(run.stderr || '').trim().slice(-800) || null,
    };
  }

  return { detect, install, ask, AGENTS, ids };
}

module.exports = { createRemoteAgents, AGENTS, readPlan, prose, briefing, AGENT_MARK };
