import { spawn } from 'node:child_process';

const run = (command, args, env = {}) =>
  spawn(command, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });

const build = run('npx', ['tsc', '-p', 'tsconfig.main.json', '&&', 'npx', 'tsc', '-p', 'tsconfig.preload.json']);
build.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  const vite = run('npx', ['vite']);
  const electron = run('npx', ['electron', '.'], { NEC_RENDERER_URL: 'http://127.0.0.1:5173' });
  electron.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
});
