import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

@Injectable()
export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.MAIL_HOST,
      port: config.MAIL_SMTP_PORT,
      secure: false,
      ignoreTLS: config.NODE_ENV !== 'production',
    });
    this.from = config.MAIL_FROM;
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...message });
  }
}

@Injectable()
export class MailDispatcher {
  private readonly logger = new Logger('MailDispatcher');

  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  async dispatch(message: MailMessage, correlationId: string | null): Promise<boolean> {
    try {
      await this.mailer.send(message);
      return true;
    } catch (error) {
      this.logger.warn(JSON.stringify({ correlationId, event: 'mail.failed', error: (error as Error).message }));
      return false;
    }
  }
}
