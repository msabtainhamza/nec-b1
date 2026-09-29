import { spawn } from 'node:child_process';

const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit', shell: true });
const api = spawn(process.execPath, ['--watch', '--env-file=../../.env', 'dist/src/main.js'], { stdio: 'inherit' });

const stop = () => {
  tsc.kill();
  api.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
