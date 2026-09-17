/* What one audit entry MEANS, with no DOM in sight.
 *
 * The audit trail is a flat list of `{ts, action, ...whatever that action recorded}` - 67 distinct
 * actions at the time of writing, each with its own fields. Reading it should not require knowing
 * any of that, so everything here answers the same five questions about any entry:
 *
 *   what kind of thing is it   → category (and the badge that names it)
 *   what happened              → title
 *   to what                    → subject
 *   how did it turn out        → status
 *   how much                   → facts: the numbers that entry actually recorded
 *
 * An action nobody wrote a description for still produces all five, from its own field names. The
 * trail is written by the host and by every module, so unknown actions are the normal case rather
 * than an error, and the view must stay readable when one appears.
 *
 * Kept separate from the rendering so it can be tested directly: these summaries are the whole
 * point of the page, and a wrong one is worse than a missing one.
 */

/* ------------------------------------------------------------------ categories */

/** Ordered: the chips appear in this order. The colour of each is the stylesheet's business. */
export const CATEGORIES = [
  { id: 'ai', label: 'AI' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'rules', label: 'Rules' },
  { id: 'sql', label: 'SQL' },
  { id: 'ssh', label: 'SSH' },
  { id: 'deploy', label: 'Deployments' },
  { id: 'projects', label: 'Projects' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'other', label: 'Other' },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const APPROVAL_ACTIONS = new Set([
  'approve', 'approve-stale', 'reject', 'skip', 'edit',
  'agent-rule-approved', 'agent-rule-rejected',
  'agent-ssh-command-approved', 'agent-ssh-command-rejected', 'agent-ssh-command-failed',
  'agent-deploy-action-approved', 'agent-deploy-action-rejected',
]);
const RULE_ACTIONS = new Set(['preview', 'abort', 'clear', 'rule-add', 'rule-update', 'rule-remove']);
const SQL_ACTIONS = new Set(['ai-sql', 'console-write', 'console-read', 'console-query']);

/**
 * Which group an action belongs to.
 *
 * Order matters: an approval of an AI proposal is an APPROVAL, and a command the assistant ran over
 * SSH is SSH. The old version sent everything it did not recognise to "Rules", which is why SQL,
 * projects and connectors were all filed under a heading they had nothing to do with.
 */
export function categoryOf(action) {
  const a = String(action || '');
  if (!a) return 'other';
  if (APPROVAL_ACTIONS.has(a)) return 'approvals';
  if (SQL_ACTIONS.has(a)) return 'sql';
  if (RULE_ACTIONS.has(a)) return 'rules';
  if (a.startsWith('project-')) return 'projects';
  if (a.startsWith('connector-')) return 'connectors';
  if (a.startsWith('deploy-')) return 'deploy';
  if (a.startsWith('ai-ssh') || a.startsWith('ssh')) return 'ssh';
  if (a.startsWith('ai-') || a.startsWith('agent-')) return 'ai';
  return 'other';
}

/* The short label on the card. Falls back to the action itself, which is always something. */
const TYPE_LABEL = {
  'ai-chat': 'AI chat',
  'ai-chat-cancelled': 'AI stopped',
  'ai-sql': 'AI SQL',
  'ai-ssh-attach': 'AI joined',
  'ai-ssh-detach': 'AI left',
  'ai-ssh-proposed': 'AI proposed',
  'ai-ssh-exec': 'AI command',
  'ai-ssh-server-agent': 'AI agent',
  approve: 'Approved',
  'approve-stale': 'Stale',
  reject: 'Rejected',
  skip: 'Skipped',
  edit: 'Edited',
  preview: 'Rule preview',
  abort: 'Aborted',
  clear: 'Cleared',
  'console-write': 'SQL write',
  'console-read': 'SQL read',
};
export function typeLabel(action) {
  const a = String(action || 'event');
  if (TYPE_LABEL[a]) return TYPE_LABEL[a];
  // deploy-ship-success → "Ship success"; ssh-terminal-open → "Terminal open"
  const words = a.replace(/^(deploy|ssh|ai|agent|project|connector)-/, '').replace(/-/g, ' ').trim();
  return (words || a).replace(/^./, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ status */

/**
 * How it turned out, from what the entry actually recorded rather than from the wording alone.
 * `ok`, `exitCode`, `error`, `status` and `verdict` are the fields the writers use.
 */
export function statusOf(e) {
  if (!e || typeof e !== 'object') return 'info';
  if (e.error) return 'failed';
  if (e.ok === false) return 'failed';
  if (typeof e.exitCode === 'number') return e.exitCode === 0 ? 'success' : 'failed';
  const named = `${e.status || ''} ${e.verdict || ''}`.toLowerCase();
  if (/fail|error|refus|denied|block/.test(named)) return 'failed';
  if (/warn|caution/.test(named)) return 'warn';
  if (/ok|pass|success|clean|ready/.test(named)) return 'success';
  const a = String(e.action || '');
  if (/-failed$|^deploy-webhook-rejected$|-rejected$|^reject$/.test(a)) return 'failed';
  if (/rolled-back|cancel|stale|abort/.test(a)) return 'warn';
  if (/-success$|^approve$|-approved$|-ready$|^deploy-rollback$/.test(a)) return 'success';
  if (/-start$|^deploy-plan$|proposed$|-request$/.test(a)) return 'pending';
  if (e.ok === true) return 'success';
  return 'info';
}

/* ------------------------------------------------------------------ actor */

/**
 * Who set it off. The trail has no actor field, so this reads the evidence: a role on a chat turn,
 * a `by`/`trigger` that names an agent or a webhook, or the action's own prefix.
 */
export function actorOf(e) {
  if (!e || typeof e !== 'object') return 'system';
  if (e.role === 'user') return 'you';
  if (e.role === 'assistant') return 'ai';
  const by = String(e.by || e.trigger || '').toLowerCase();
  if (by.includes('agent') || by.includes('ai')) return 'ai';
  if (by.includes('webhook') || by.includes('poll')) return 'system';
  const a = String(e.action || '');
  if (a.startsWith('ai-') || a.startsWith('agent-')) return 'ai';
  if (a.startsWith('deploy-webhook')) return 'system';
  if (a.startsWith('deploy-cloud')) return 'system';
  return 'you';
}

/* ------------------------------------------------------------------ summaries */

const str = (v) => (v == null ? '' : String(v));
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fact = (label, value) => (value == null || value === '' ? null : { label, value: String(value) });
const short = (v, max = 90) => { const s = str(v); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const secs = (ms) => (n(ms) == null ? null : ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`);
const count = (v) => (n(v) == null ? null : v.toLocaleString());

/* One entry per action: the sentence, what it acted on, and the numbers it recorded.
   Anything missing falls through to the generic summary below, which is never empty. */
const SUMMARY = {
  /* The host strips what was actually said from every entry before it leaves the server (see
     AUDIT_CONTENT_FIELDS), leaving only its length. So a chat turn says that it happened and how
     big it was, and the card says plainly that the words themselves are not kept - which is better
     than the empty bubble this used to draw. */
  'ai-chat': (e) => ({
    title: e.role === 'user' ? 'You wrote to the assistant' : 'The assistant replied',
    subject: short(e.text, 160),
    facts: [fact('Tools', (e.tools || []).join(', ')), fact('Characters', count(e.chars ?? e.textChars))],
  }),
  'ai-chat-cancelled': (e) => ({ title: 'Reply stopped by the user', facts: [fact('Tools', (e.tools || []).join(', '))] }),
  'ai-sql': (e) => ({ title: 'The assistant wrote a query', subject: short(e.sql, 160), facts: [fact('Asked about', count(e.promptChars) ? `${count(e.promptChars)} characters` : null), fact('Schema', e.schemaAttached ? 'attached' : null)] }),

  preview: (e) => ({
    title: 'Previewed a rule', subject: ruleOn(e),
    facts: [fact('Matched', count(e.matchedRows)), fact('Would change', count(e.proposedChanges)), fact('Limit', count(e.limit))],
  }),
  approve: (e) => ({ title: 'Approved a change', subject: ruleOn(e), facts: rowFacts(e) }),
  'approve-stale': (e) => ({ title: 'Approved a change that had gone stale', subject: ruleOn(e), facts: rowFacts(e) }),
  reject: (e) => ({ title: 'Rejected a change', subject: ruleOn(e), facts: rowFacts(e) }),
  skip: (e) => ({ title: 'Skipped a change', subject: ruleOn(e), facts: rowFacts(e) }),
  edit: (e) => ({ title: 'Edited a proposed value by hand', subject: ruleOn(e), facts: [fact('Row', e.pk), fact('Column', e.column)] }),
  abort: (e) => ({ title: 'Aborted the session', subject: ruleOn(e), facts: [fact('Discarded', count(e.discardedPending))] }),
  clear: (e) => ({ title: 'Cleared the preview', subject: ruleOn(e), facts: [fact('Discarded', count(e.discardedPending))] }),
  'agent-rule-approved': (e) => ({ title: "Approved the assistant's rule proposal", subject: ruleOn(e) }),
  'agent-rule-rejected': (e) => ({ title: "Rejected the assistant's rule proposal", subject: ruleOn(e) }),
  'console-write': (e) => ({
    title: `Ran a ${str(e.kw) || 'write'} in the SQL console`, subject: short(e.sql, 160),
    facts: [fact('Affected', count(e.affectedRows)), fact('Changed', count(e.changedRows)), fact('Insert id', e.insertId || null)],
  }),

  'ssh-session-connect': (e) => ({ title: 'Connected to a server', subject: at(e) }),
  'ssh-session-cleanup': (e) => ({ title: 'Cleaned up a server connection', subject: str(e.sshHost), facts: [fact('Cleaned', (e.cleaned || []).join(', '))] }),
  'ssh-terminal-open': (e) => ({ title: 'Opened a terminal', subject: at(e) }),
  'ssh-terminal-close': (e) => ({ title: 'Closed a terminal', facts: [fact('Reason', e.reason)] }),
  'ssh-terminal-control': (e) => ({ title: `Terminal control went to ${e.control === 'assistant' ? 'the assistant' : 'you'}` }),
  'ssh-terminal-control-request': (e) => ({ title: `Asked for terminal control: ${str(e.control) || 'user'}` }),
  'ssh-terminal-ai': (e) => ({ title: 'Started a coding agent on the server', subject: at(e), facts: [fact('Agent', e.aiCli), fact('Session', e.sessionForwarded ? 'forwarded' : null)] }),
  'ssh-agent-detect': (e) => ({ title: 'Looked for a coding agent on the server', subject: str(e.profile) || str(e.sshHost), facts: foundFacts(e.found) }),
  'ssh-agent-install': (e) => ({ title: `Installed ${str(e.agent) || 'a coding agent'} on the server`, subject: str(e.profile) || str(e.sshHost) }),
  'ssh-console': (e) => ({ title: 'Ran a command in the console', subject: short(e.command, 160), facts: [fact('Exit', e.exitCode), fact('Directory', e.cwd)] }),
  'ai-ssh-attach': (e) => ({ title: 'The assistant joined a terminal', subject: str(e.profile) || at(e) }),
  'ai-ssh-detach': (e) => ({ title: 'The assistant left the terminal', subject: str(e.profile) }),
  'ai-ssh-proposed': (e) => ({ title: 'The assistant proposed a command', subject: short(e.cmd, 160), facts: [fact('Class', e.class)] }),
  'ai-ssh-exec': (e) => ({
    title: 'An approved command ran', subject: short(e.cmd, 160),
    facts: [fact('Exit', e.exitCode), fact('Took', secs(e.ms)), fact('Server', e.profile)],
  }),
  'ai-ssh-server-agent': (e) => ({ title: 'The assistant used the coding agent on the server', facts: [fact('Agent', e.agent)] }),
  'agent-ssh-command-approved': () => ({ title: 'Approved a command the assistant proposed' }),
  'agent-ssh-command-rejected': () => ({ title: 'Rejected a command the assistant proposed' }),
  'agent-ssh-command-failed': (e) => ({ title: 'An approved command failed', subject: short(e.error, 160), facts: [fact('Target', e.target)] }),

  'project-create': (e) => ({ title: 'Created a project', subject: str(e.project) }),
  'project-update': (e) => ({ title: 'Updated a project', subject: str(e.project) }),
  'project-delete': (e) => ({ title: 'Deleted a project', subject: str(e.project), facts: [fact('Resources', 'kept')] }),
  'project-link': (e) => ({ title: `Moved a ${str(e.kind) || 'resource'} into a project`, subject: str(e.project) }),
  'project-unlink': (e) => ({ title: `Returned a ${str(e.kind) || 'resource'} to every project`, subject: str(e.project) }),

  'connector-add': (e) => ({ title: 'Connected an account', subject: str(e.connector), facts: [fact('Kind', e.kind), fact('Verified', e.status)] }),
  'connector-update': (e) => ({ title: 'Updated an account', subject: str(e.connector), facts: [fact('Verified', e.status)] }),
  'connector-verify': (e) => ({ title: 'Verified an account', subject: str(e.connector), facts: [fact('Result', e.status)] }),
  'connector-remove': (e) => ({ title: 'Removed an account', subject: str(e.connector) }),

  'deploy-plan': (e) => ({ title: 'Planned a deploy', subject: str(e.target), facts: [fact('Ref', e.ref), fact('Trigger', e.trigger)] }),
  'deploy-ship-start': (e) => ({ title: 'Started shipping', subject: str(e.target), facts: [fact('Ref', e.ref), fact('Trigger', e.trigger)] }),
  'deploy-ship-success': (e) => ({
    title: 'Shipped', subject: str(e.target),
    facts: [fact('Release', e.release), fact('Commit', e.commit ? str(e.commit).slice(0, 8) : null), fact('Took', secs(e.ms)), fact('Built', e.buildMode)],
  }),
  'deploy-ship-failed': (e) => ({ title: 'A deploy failed', subject: str(e.target), facts: [fact('Stage', e.stage), fact('Error', short(e.error, 70)), fact('Release', e.release)] }),
  'deploy-ship-rolled-back': (e) => ({ title: 'A deploy failed and was rolled back', subject: str(e.target), facts: [fact('Stage', e.stage), fact('Back to', e.previousRelease)] }),
  'deploy-rollback-start': (e) => ({ title: 'Started a rollback', subject: str(e.target) }),
  'deploy-rollback': (e) => ({ title: 'Rolled back', subject: str(e.target), facts: [fact('To', e.release), fact('From', e.previousRelease)] }),
  'deploy-cancel': (e) => ({ title: 'Cancelled a deploy', subject: str(e.target), facts: [fact('Stage', e.stage)] }),
  'deploy-force-unlock': (e) => ({ title: 'Force-unlocked a target', subject: str(e.target) }),
  'deploy-repo-add': (e) => ({ title: 'Connected a repository', subject: str(e.repo), facts: [fact('Kind', e.kind)] }),
  'deploy-repo-update': (e) => ({ title: 'Updated a repository', subject: str(e.repo) }),
  'deploy-repo-remove': (e) => ({ title: 'Removed a repository', subject: str(e.repo) }),
  'deploy-target-add': (e) => ({ title: 'Added a deploy target', subject: str(e.target), facts: [fact('Type', e.type), fact('Auto-ship', e.autoShip ? 'on' : null)] }),
  'deploy-target-update': (e) => ({ title: 'Updated a deploy target', subject: str(e.target) }),
  'deploy-target-remove': (e) => ({ title: 'Removed a deploy target', subject: str(e.target) }),
  'deploy-manifest-save': (e) => ({ title: 'Saved a deploy manifest', subject: str(e.repo), facts: [fact('Stack', e.stack), fact('By', e.by === 'agent-proposal' ? 'AI proposal' : e.by)] }),
  'deploy-secret-set': (e) => ({ title: 'Stored a secret in the vault', subject: str(e.name) }),
  'deploy-secret-remove': (e) => ({ title: 'Removed a secret from the vault', subject: str(e.name) }),
  'deploy-webhook': (e) => ({ title: 'A push started a ship', subject: str(e.target), facts: [fact('Ref', e.ref)] }),
  'deploy-webhook-rejected': (e) => ({ title: 'Rejected a webhook call', subject: str(e.target), facts: [fact('Reason', e.reason), fact('From', e.ip)] }),
  'deploy-cloud-provision': (e) => ({ title: 'Provisioning a cloud server', subject: str(e.name), facts: [fact('Provider', e.provider), fact('Region', e.region), fact('Size', e.size)] }),
  'deploy-cloud-ready': (e) => ({ title: 'A cloud server is ready', subject: str(e.name), facts: [fact('Address', e.ip), fact('Provider', e.provider)] }),
  'deploy-cloud-failed': (e) => ({ title: 'Provisioning failed', subject: str(e.name), facts: [fact('Error', short(e.error, 70))] }),
  'deploy-cloud-destroy': (e) => ({ title: 'Destroyed a cloud server', subject: str(e.name), facts: [fact('Provider', e.provider)] }),
  'deploy-preship-review': (e) => ({ title: 'Reviewed a deploy before shipping', subject: str(e.target), facts: [fact('Verdict', e.verdict), fact('Findings', count(e.findings))] }),
  'deploy-ai-detect': (e) => ({ title: 'The assistant identified a stack', subject: str(e.repo), facts: [fact('Confidence', e.confidence), fact('In', e.wizard ? 'the wizard' : null)] }),
  'deploy-ai-explain': (e) => ({ title: 'The assistant explained a failed run', facts: [fact('Run', e.runId ? str(e.runId).slice(0, 8) : null), fact('Proposed', e.proposed ? 'an action' : null)] }),
  'deploy-log-to-chat': (e) => ({ title: 'Sent a run log to the chat', subject: str(e.target), facts: [fact('Lines', count(e.lines))] }),
  'deploy-agent-action': (e) => ({ title: `The assistant asked to ${str(e.deployAction) || 'act'}`, subject: str(e.target), facts: [fact('Release', e.release)] }),
  'agent-deploy-action-approved': (e) => ({ title: "Approved the assistant's deploy action", subject: str(e.target) }),
  'deploy-template-save': (e) => ({ title: 'Saved a target template', subject: str(e.template), facts: [fact('Type', e.type)] }),
  'deploy-wordpress-new': (e) => ({ title: 'Created a WordPress project', subject: str(e.name), facts: [fact('Theme', e.theme), fact('WordPress', e.version), fact('Files', count(e.files))] }),

  'ssh-server-edit': (e) => ({ title: 'Edited a server', subject: str(e.profile) }),
  'projects-proposed': (e) => ({ title: `The assistant proposed to ${str(e.change) || 'change a project'}`, subject: str(e.project) }),
};

const ruleOn = (e) => [e.rule ? `"${str(e.rule)}"` : '', e.table ? `on ${str(e.table)}` : ''].filter(Boolean).join(' ');
const at = (e) => (e.sshUser && e.sshHost ? `${str(e.sshUser)}@${str(e.sshHost)}` : str(e.sshHost) || str(e.profile));
const rowFacts = (e) => [fact('Row', e.pk), fact('Columns', Array.isArray(e.columns) ? e.columns.length : e.columns)];
const foundFacts = (found) => {
  if (!found || typeof found !== 'object') return [];
  const present = Object.entries(found).filter(([, v]) => v && v.installed).map(([k, v]) => `${k}${v.version ? ' ' + v.version : ''}`);
  return [fact('Found', present.length ? present.join(', ') : 'nothing')];
};

/* Fields never worth showing as a fact: identifiers, plumbing, and the ones already on the card. */
const NOT_A_FACT = new Set(['ts', 'action', '_n', '_raw', 'module', 'role', 'text', 'redacted', 'sessionId', 'turnId', 'profileId', 'targetId', 'runId', 'jobId', 'id']);

/** What the host kept out of this entry, said in words. A blank card would look like a bug. */
const WORD_FOR = { text: 'the message', reply: 'the reply', message: 'the message', alternative: 'the alternative', prompt: 'the prompt' };
export function redactionNote(e) {
  const fields = Array.isArray(e?.redacted) ? e.redacted.filter((f) => WORD_FOR[f]) : [];
  if (!fields.length) return '';
  const words = [...new Set(fields.map((f) => WORD_FOR[f]))];
  return `${words.join(' and ')} ${words.length > 1 ? 'are' : 'is'} not kept in the trail`.replace(/^./, (c) => c.toUpperCase());
}

/**
 * The summary for an action nobody described. Built from the entry's own fields, so a module that
 * starts recording something new is readable on the day it ships rather than on the day someone
 * remembers to add a case here.
 */
function genericSummary(e) {
  const subjectKey = ['name', 'target', 'repo', 'profile', 'project', 'connector', 'rule', 'template'].find((k) => e[k]);
  const facts = Object.entries(e)
    .filter(([k, v]) => !NOT_A_FACT.has(k) && k !== subjectKey && v != null && v !== '' && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => fact(k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), short(v, 40)));
  return { title: typeLabel(e.action), subject: subjectKey ? str(e[subjectKey]) : '', facts };
}

/**
 * Everything the view needs about one entry.
 * @param {object} entry one line of the audit trail
 */
export function classify(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  if (e._raw) return { cat: 'other', action: 'unreadable', type: 'Unreadable line', title: 'A line of the log could not be read', subject: short(e._raw, 120), facts: [], status: 'warn', actor: 'system', ts: '', relation: null, redacted: '', raw: e };
  let summary;
  try { summary = (SUMMARY[e.action] || genericSummary)(e) || {}; }
  catch { summary = genericSummary(e); }
  return {
    cat: categoryOf(e.action),
    action: str(e.action) || 'event',
    type: typeLabel(e.action),
    title: summary.title || typeLabel(e.action),
    subject: summary.subject || '',
    facts: (summary.facts || []).filter(Boolean),
    status: statusOf(e),
    actor: actorOf(e),
    ts: str(e.ts),
    relation: relationOf(e),
    redacted: redactionNote(e),
    raw: e,
  };
}

/**
 * What this entry belongs to, when the trail says so. These are real identifiers the writers
 * record - a deploy run, a terminal session, one assistant turn - not a guess at what looks
 * related, so a workflow can be pulled back together without inventing one.
 */
export function relationOf(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.runId) return { kind: 'run', key: 'runId', value: String(e.runId), label: 'this deploy run' };
  if (e.turnId) return { kind: 'turn', key: 'turnId', value: String(e.turnId), label: 'this assistant turn' };
  if (e.sessionId) return { kind: 'session', key: 'sessionId', value: String(e.sessionId), label: 'this session' };
  return null;
}

/** A one-line plain-text description, for the command palette and for screen readers. */
export function describePlain(entry) {
  const c = classify(entry);
  return [c.title, c.subject].filter(Boolean).join(' — ');
}

/* ------------------------------------------------------------------ filtering */

/** Does this entry match the filters? Every filter is "all" by default and narrows from there. */
export function matches(entry, filters = {}) {
  const c = classify(entry);
  if (filters.time && filters.time !== 'all') {
    const age = Date.now() - Date.parse(entry.ts || 0);
    const max = filters.time === 'today' ? 86400e3 : filters.time === '7d' ? 7 * 86400e3 : 30 * 86400e3;
    if (!(age >= 0 && age <= max)) return false;
  }
  if (filters.outcome && filters.outcome !== 'all') {
    if (filters.outcome === 'succeeded' && c.status !== 'success') return false;
    if (filters.outcome === 'failed' && !(c.status === 'failed' || c.status === 'warn')) return false;
  }
  if (filters.actor && filters.actor !== 'all' && c.actor !== filters.actor) return false;
  if (filters.action && filters.action !== 'all' && c.action !== filters.action) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const hay = `${c.title} ${c.subject} ${c.action} ${c.facts.map((f) => `${f.label} ${f.value}`).join(' ')} ${JSON.stringify(entry)}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export const EMPTY_FILTERS = { q: '', time: 'all', outcome: 'all', actor: 'all', action: 'all' };
export const isFiltering = (f) => Object.keys(EMPTY_FILTERS).some((k) => (f?.[k] ?? EMPTY_FILTERS[k]) !== EMPTY_FILTERS[k]);

/* ------------------------------------------------------------------ time */

/**
 * The heading an entry belongs under, or null when it carries no usable date - a line the writer
 * did not finish, say. Those sit where the trail put them and keep the heading above them, rather
 * than cutting a day in half with a heading of their own.
 */
export function dayLabel(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return null;
  const day = String(iso).slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return day;
}
export const hhmm = (iso) => String(iso || '').slice(11, 16);
