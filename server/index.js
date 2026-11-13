// Entry point: one process serves the static frontend, the JSON API and SSE.
import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './logger.js';
import { store } from './store.js';
import { createRouter } from './lib/router.js';
import { lanGuard, lanSecrets, lanAddresses } from './lib/lan.js';
import { schedule, stopAll } from './lib/scheduler.js';
import { registerRoutes } from './routes.js';
import { refresh } from './services/ingest.js';
import { settleTips } from './services/tips.js';
import { state } from './services/ingest.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('Node.js 18 vagy újabb szükséges (talált: ' + process.versions.node + ').');
  process.exit(1);
}

const app = createRouter();
registerRoutes(app);
app.static(path.join(ROOT, 'public'));

const lanOn = config.lan || !['127.0.0.1', 'localhost', '::1'].includes(config.host);
const server = http.createServer((req, res) => {
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  if (lanOn && !lanGuard(req, res)) return;
  app.handle(req, res);
});

// Scheduled ingestion (stand-in for node-cron):
//  – full refresh (fixtures, standings, odds TTLs) every REFRESH_FIXTURES_SECONDS
//  – live refresh for leagues with live/imminent matches every REFRESH_LIVE_SECONDS
schedule('full-refresh', config.refresh.fixtures, () => refresh({ reason: 'schedule' }));
schedule('live-refresh', config.refresh.live, () => refresh({ liveOnly: true, reason: 'live' }), { runNow: false });
schedule('settle', 300, () => settleTips(state.matches), { runNow: false });

server.listen(config.port, config.host, () => {
  log.info('server started', { url: `http://localhost:${config.port}`, dataMode: config.dataMode, node: process.versions.node });
  console.log(`\n  Sportelemző fut: http://localhost:${config.port}  (adatmód: ${config.dataMode})`);
  if (lanOn) {
    const { pin } = lanSecrets();
    const ips = lanAddresses();
    console.log('\n  Telefonról (ugyanazon a Wi-Fi-hálózaton):');
    for (const ip of ips) console.log(`    http://${ip}:${config.port}`);
    if (!ips.length) console.log('    (nem található helyi hálózati cím – csatlakozz Wi-Fi-hez)');
    console.log(`  PIN-kód a telefonos belépéshez: ${pin}`);
    console.log('  Tipp: a telefonon a böngésző menüjében „Hozzáadás a kezdőképernyőhöz” – így alkalmazásként nyílik meg.');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`A ${config.port}-es port foglalt. Állítsd le a másik folyamatot, vagy indítsd így: PORT=3001 npm start`);
  else console.error(err);
  process.exit(1);
});

function shutdown() {
  log.info('shutting down');
  stopAll(); store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
