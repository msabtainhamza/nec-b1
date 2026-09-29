import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config.js';
import type { Mailer } from '../mail/mailer.js';
import { migrate, resetSchema } from './migrator.js';
import { seed } from './seed.js';

const discardMailer: Mailer = { send: async () => undefined };

async function main(command: string | undefined): Promise<void> {
  const config = loadConfig();
  switch (command) {
    case 'migrate': {
      const result = await migrate(config);
      console.log(JSON.stringify({ event: 'db.migrated', ...result }));
      return;
    }
    case 'reset': {
      await resetSchema(config);
      const result = await migrate(config);
      console.log(JSON.stringify({ event: 'db.reset', ...result }));
      return;
    }
    case 'seed': {
      const app = await NestFactory.createApplicationContext(AppModule.register({ config, mailer: discardMailer }), {
        logger: ['error'],
      });
      try {
        const summary = await seed(app, config);
        console.log(JSON.stringify({ event: 'db.seeded', ...summary }));
      } finally {
        await app.close();
      }
      return;
    }
    default:
      throw new Error('Usage: cli.js <migrate|reset|seed>');
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
