'use strict';
/* The command classifier. It is an informational allowlist, never an
   authorization: every command still needs the user's approval. These are the
   base application's original cases, moved with the code. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../backend/classify');

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
