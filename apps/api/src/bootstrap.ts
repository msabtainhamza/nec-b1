import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { correlationMiddleware } from './common/request-context.js';

export async function createApp(options: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(options), {
    logger: options.config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
    bodyParser: false,
  });
  app.use(helmet());
  app.use(['/v1/fin/opening-balances/import', '/v1/inv/opening-balances/import', '/v1/bp/partners/import', '/v1/inv/items/import', '/v1/inv/price-lists/import'], json({ limit: '3mb' }));
  app.use(json({ limit: '100kb' }));
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}
