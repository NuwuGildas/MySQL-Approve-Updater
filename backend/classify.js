'use strict';
/* Classifying one command line as read / write / destructive / blocked.
 *
 * This is an informational, conservative allowlist and never an authorization
 * to type into a shell: the terminal is a real, user-controlled shell where even
 * "ls" can be a user-defined function. Every command the assistant proposes
 * needs the user's approval whatever this returns; the classification only
 * decides which Settings switch has to be on for it to be offered at all.
 *
 * Moved verbatim from the base application's lib/ssh-agent.js. */

const CMD_MAX = 2000;

// This is an informational, conservative allowlist, never an authorization to type into a shell.
const SIMPLE_READ = new Set(['cat', 'head', 'tail', 'ls', 'dir', 'stat', 'file', 'readlink', 'realpath',
  'dirname', 'basename', 'grep', 'egrep', 'fgrep', 'cut', 'tr', 'uniq', 'wc', 'cmp', 'od', 'md5sum',
  'sha1sum', 'sha256sum', 'df', 'du', 'free', 'uptime', 'uname', 'whoami', 'id', 'groups', 'who', 'w',
  'arch', 'nproc', 'ps', 'pgrep', 'pidof', 'lsof', 'netstat', 'ss', 'lsblk', 'lscpu', 'lsmem',
  'lsusb', 'lspci', 'which', 'whereis', 'printenv', 'true', 'false']);
const INTERACTIVE = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'ed', 'top', 'htop', 'tmux',
  'screen', 'ssh', 'scp', 'sftp', 'telnet', 'ftp', 'su', 'passwd', 'visudo', 'login']);

function tokens(segment) {
  const result = []; let word = '', quote = null, started = false;
  for (const char of segment) {
    if (quote) { if (char === quote) quote = null; else word += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) result.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

function classify(raw) {
  const line = String(raw || '').trim();
  const result = (cls, reason, sudo = false) => ({ cls, reason, sudo, segments: [line] });
  if (!line || line.length > CMD_MAX || /[\r\n\x00-\x1f\x7f]/.test(line)) return result('blocked', 'Use one command of at most 2000 characters, without control characters.');
  let sudo = /\bsudo\b/.test(line);
  // Shell expansion, escaped tokens, control constructs and wrappers cannot be proven read-only.
  // Refusing these also prevents hiding a destructive operation behind a write-only permission.
  if (/[$`\\(){}]/.test(line)) return result('blocked', 'Shell substitutions, escaping and control constructs require the user terminal.', sudo);
  if (/&\s*$/.test(line) || /\|\s*(?:sudo\s+)?(?:ba|da|z)?sh\b/.test(line)) return result('blocked', 'Background commands and piping into a shell require the user terminal.', sudo);
  const destructive = /\b(?:rm|rmdir|unlink|shred|truncate|wipefs|mkfs(?:\.\w+)?|fdisk|parted|dd|shutdown|reboot|halt|poweroff|userdel|groupdel|deluser|delgroup)\b|\b(?:drop|truncate)\s+(?:database|table|schema)\b|\b(?:flushall|flushdb)\b|\b(?:prune|purge|autoremove)\b|\breset\s+--hard\b|\bclean\s+-[^\s]*[fdx]|\bdelete\b|\binit\s+[06]\b|\bchmod\s+(?:-R\s+)?777\b|\bcrontab\s+-r\b|\bfind\b.*-delete\b/i;
  if (destructive.test(line)) return result('destructive', 'This command can remove data, permissions, services or system state.', sudo);
  // Split conservatively, including operators inside quotes: uncertain cases become write/blocked.
  const segments = line.split(/\s*(?:&&|\|\||[;|])\s*/);
  let cls = 'read', reason = 'Known informational command.';
  for (const segment of segments) {
    const words = tokens(segment);
    if (!words || !words.length) return result('blocked', 'Unbalanced quotes or empty shell segment.', sudo);
    let bin = words[0], args = words.slice(1);
    // Quoting may concatenate a command name (`su''do`, `r''m`). Classify decoded words too.
    if (bin.split('/').pop() === 'sudo') { sudo = true; bin = 'sudo'; }
    if (bin === 'sudo') {
      // Options can change sudo behavior; require a plain prefix with an identifiable command.
      if (!args[0] || args[0].startsWith('-')) return result('blocked', 'Use sudo followed directly by a command, without sudo options.', true);
      bin = args[0]; args = args.slice(1);
    }
    if (destructive.test([bin, ...args].join(' '))) return result('destructive', 'This command can remove data, permissions, services or system state.', sudo);
    if (INTERACTIVE.has(bin) || (['bash', 'sh', 'dash', 'zsh', 'python', 'python3', 'node', 'mysql', 'psql'].includes(bin) && !args.length)) return result('blocked', `${bin} requires the user-controlled terminal.`, sudo);
    if (['env', 'command', 'exec', 'eval', 'xargs', 'watch', 'timeout', 'nohup', 'bash', 'sh', 'dash', 'zsh', 'awk', 'gawk', 'sed', 'perl', 'python', 'python3', 'node', 'ruby', 'php'].includes(bin) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(bin)) {
      if (['python', 'python3', 'node', 'ruby', 'php'].includes(bin) && args.length === 1 && ['-v', '-V', '--version', '--help'].includes(args[0])) continue;
      return result('blocked', 'Command wrappers, scripts and interpreters must be run by the user in the terminal.', sudo);
    }
    let read = SIMPLE_READ.has(bin);
    if (bin === 'rg') read = !args.some((a) => /^(--pre(?:=|$)|--hostname-bin(?:=|$)|--search-zip$)/.test(a));
    if (bin === 'find') read = !args.some((a) => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls|delete)$/.test(a));
    if (bin === 'systemctl') read = ['status', 'is-active', 'is-enabled', 'is-failed', 'show', 'list-units', 'list-unit-files'].includes(args[0]) && !args.slice(1).some((a) => a.startsWith('-') && !['--no-pager', '--all', '--full', '--plain'].includes(a));
    if (bin === 'journalctl') read = args.every((a) => !a.startsWith('-') || /^(?:-u|-n|-b|-p|-f|--no-pager|--since|--until|--unit|--lines|--boot|--priority)(?:=|$)/.test(a));
    if (bin === 'git') {
      const gitArgs = args[0] === '-C' && args[1] ? args.slice(2) : args;
      read = ['status', 'log', 'show', 'diff', 'branch'].includes(gitArgs[0]) && gitArgs.slice(1).every((a) => /^(-[0-9]+|--oneline|--short|--stat|--name-only|--no-pager|--all|--list)$/.test(a));
    }
    if (bin === 'docker' || bin === 'podman') read = ['ps', 'logs', 'inspect', 'stats', 'version', 'info'].includes(args[0]) && !args.includes('--format');
    if (bin === 'crontab') read = args.length === 1 && args[0] === '-l';
    if (bin === 'date') read = args.length === 0 || args.every((a) => ['-u', '--utc', '--iso-8601'].includes(a) || a.startsWith('+'));
    if (bin === 'hostname') read = args.length === 0;
    if (bin === 'echo' || bin === 'printf') read = true;
    if (!read || /[<>]/.test(segment)) { cls = 'write'; reason = 'This command is not on the narrow informational allowlist or redirects output.'; }
  }
  return { cls, reason, sudo, segments };
}

module.exports = { classify, CMD_MAX };
