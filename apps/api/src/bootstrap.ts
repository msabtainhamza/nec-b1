import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { correlationMiddleware } from './common/request-context.js';

export async function createApp(options: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(options), {
    logger: options.config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  app.use(helmet());
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}
