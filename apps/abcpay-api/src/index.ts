import { serve } from '@hono/node-server';
import { createApp } from './routes';
import { envelopeService } from './services/envelope.service';
import { config } from './config';

const app = createApp();

console.log(`Chronik Wallet Service starting on port ${config.port}`);
console.log(
  `API base: http://localhost:${config.port}${config.basePath} (legacy alias ${config.legacyBasePath})`
);

const sweeper = setInterval(() => {
  envelopeService
    .sweepExpired()
    .then(deleted => {
      if (deleted > 0) console.log(`[cws] swept ${deleted} expired envelopes`);
    })
    .catch(err => console.warn('[cws] envelope sweep failed:', (err as Error).message));
}, 60_000);
sweeper.unref();

serve({ fetch: app.fetch, port: config.port });
