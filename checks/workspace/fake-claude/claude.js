'use strict';
/* A stand-in for the Claude Code CLI, only for the frontend checks in this folder.
   It speaks just enough of the real contract for server.js to accept it: a version, a help text
   listing the isolation flags Server Tools insists on, and stream-json output on -p.
   What it answers is read from script.json beside it, so a check can queue exact replies
   (a tool call, then prose) and get a deterministic turn without a model or a network. */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const scriptFile = path.join(__dirname, 'script.json');
const out = (s) => process.stdout.write(s + '\n');

if (args.includes('--version')) { out('1.9.9 (Server Tools check fixture)'); process.exit(0); }
if (args.includes('--help')) {
  out('Usage: claude [options]');
  out('  --strict-mcp-config   ignore all other MCP configuration');
  out('  --mcp-config <file>   load MCP servers from a file');
  out('  --settings <file>     load settings from a file');
  out('  --disallowed-tools <list>  tools the model may not use');
  out('  -p, --print           print mode');
  out('  --output-format <fmt> text | json | stream-json');
  process.exit(0);
}

// drain stdin (the prompt) so the parent's write never blocks, then answer
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch { queue = []; }
  if (!Array.isArray(queue)) queue = [queue];
  const step = queue.length ? queue.shift() : { reply: 'No scripted reply left for this turn.' };
  try { fs.writeFileSync(scriptFile, JSON.stringify(queue, null, 2)); } catch {}
  const reply = typeof step === 'string' ? step : String(step.reply ?? '');
  const delay = typeof step === 'object' && step ? Number(step.delayMs) || 0 : 0;
  const emit = () => {
    // deltas first (the app streams prose live), then the authoritative result line
    for (const chunk of reply.match(/[\s\S]{1,24}/g) || []) {
      out(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } }));
    }
    out(JSON.stringify({ type: 'result', is_error: false, result: reply }));
    process.exit(0);
  };
  if (delay) setTimeout(emit, delay); else emit();
});
