import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

const skipInfra = process.argv.includes('--skip-infra');

function run(label, command, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nSetup stopped: ${label} failed.`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('Created .env from .env.example (local-only values).');
}

run('Install dependencies', 'pnpm', ['install']);
run('Build shared contracts', 'pnpm', ['--filter', '@nec/contracts', 'build']);
if (skipInfra) {
  console.log('\nSkipping Docker services; PostgreSQL must already be reachable as configured in .env.');
} else {
  run('Start PostgreSQL, Redis, object storage and mail sink', 'pnpm', ['infra:up']);
}
run('Reset and migrate the development database', 'pnpm', ['db:reset']);
run('Seed two tenants', 'pnpm', ['db:seed']);
console.log('\nSetup complete. Start the API with "pnpm dev:api" and the desktop app with "pnpm dev:desktop".');
