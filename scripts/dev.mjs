#!/usr/bin/env node
// Runs API, worker and web together with prefixed output. Ctrl+C stops all three.
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['run', 'dev', '-w', '@clipforge/api'], '\x1b[35m'],
  ['worker', ['run', 'dev', '-w', '@clipforge/worker'], '\x1b[33m'],
  ['web', ['run', 'dev', '-w', '@clipforge/web'], '\x1b[36m'],
];
const children = [];
let stopping = false;

for (const [name, args, color] of procs) {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${prefix}exited with code ${code}; stopping the others`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}

function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
