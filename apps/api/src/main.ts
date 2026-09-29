import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp({ config });
await app.listen(config.API_PORT, config.API_HOST);
console.log(JSON.stringify({ event: 'api.started', port: config.API_PORT }));
