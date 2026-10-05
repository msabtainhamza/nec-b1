import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiUrl = process.env.NEC_API_URL ?? '';

let parsed;
try {
  parsed = new URL(apiUrl);
} catch {
  console.error('Set NEC_API_URL to the HTTPS address of the API, for example NEC_API_URL=https://erp-dev.example.com');
  process.exit(1);
}
if (parsed.protocol !== 'https:') {
  console.error('NEC_API_URL must use https:// because packaged builds refuse plain HTTP');
  process.exit(1);
}

const run = (command) => execSync(command, { cwd: desktopDir, stdio: 'inherit' });

run('pnpm run build');

const desktopPackage = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
const require = createRequire(join(desktopDir, 'package.json'));
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;

const stageDir = join(desktopDir, 'release', 'app');
rmSync(join(desktopDir, 'release'), { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const copyDist = (folder) =>
  cpSync(join(desktopDir, 'dist', folder), join(stageDir, 'dist', folder), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.js') && !source.endsWith('.map'),
  });
copyDist('main');
copyDist('preload');
copyDist('renderer');

writeFileSync(join(stageDir, 'app-config.json'), `${JSON.stringify({ apiUrl: parsed.origin }, null, 2)}\n`);
writeFileSync(
  join(stageDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'nec-erp',
      productName: 'NEC ERP',
      version: desktopPackage.version,
      description: 'NEC ERP desktop client',
      author: 'NEC ERP',
      type: 'module',
      main: 'dist/main/main.js',
    },
    null,
    2,
  )}\n`,
);

const builderConfig = {
  appId: 'com.nec.erp.desktop',
  productName: 'NEC ERP',
  electronVersion,
  directories: { app: stageDir, output: join(desktopDir, 'release', 'installer') },
  files: ['**/*'],
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'NEC-ERP-Setup-${version}.${ext}',
  },
};
const configPath = join(desktopDir, 'release', 'electron-builder.json');
writeFileSync(configPath, JSON.stringify(builderConfig, null, 2));

run(`pnpm exec electron-builder --win --config "${configPath}" --publish never`);
console.log(`Installer written to ${join(desktopDir, 'release', 'installer')} with API ${parsed.origin}`);
