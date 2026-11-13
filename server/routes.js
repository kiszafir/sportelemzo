// HTTP API. All user-facing messages are Hungarian.
import { config, LEAGUES, SPORTS } from './config.js';
import { db, store } from './store.js';
import { httpError } from './lib/router.js';
import { jobStatus } from './lib/scheduler.js';
import { localDay, dayOffset } from './lib/time.js';
import { providerStatuses } from './providers/registry.js';
import { listModels } from './engine/models/index.js';
import { buildTickets, dayOptions, pickDay, MARKET_GROUPS, filterByGroups } from './engine/combos.js';
import { runBacktest } from './engine/backtest.js';
import { mockHistory } from './providers/mock.js';
import { state, refresh, matchSummary, matchDetail, legCandidates, reanalyse, onUpdate } from './services/ingest.js';
import { tipStats, filterTips } from './services/tips.js';
import { status as aiStatus, train as aiTrain } from './services/learn.js';
import { addBet, settleBet, deleteBet, updateSettings, bankrollView, kellySuggestion, usage, selfPause } from './services/bankroll.js';

const SSE_CLIENTS = new Set();
onUpdate((evt) => {
  const msg = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of SSE_CLIENTS) res.write(msg);
});
setInterval(() => { for (const res of SSE_CLIENTS) res.write(': ping\n\n'); }, 25e3).unref();

let backtestCache = null;

export function registerRoutes(app) {
  app.get('/api/health', (req, res) => res.json({ ok: true, lastUpdate: state.lastUpdate, matches: state.matches.size }));

  app.get('/api/meta', (req, res) => res.json({
    dataMode: config.dataMode, timezone: config.timezone, leagues: LEAGUES.map(({ id, sport, name, short }) => ({ id, sport, name, short })), sports: SPORTS,
    leagueStatus: state.leagueStatus, lastUpdate: state.lastUpdate, version: state.version,
    refresh: config.refresh, providers: providerStatuses(), models: listModels(), jobs: jobStatus(),
  }));

  app.get('/api/matches', (req, res) => {
    const { sport, league, day = 'all', status } = req.query;
    let list = [...state.matches.values()];
    if (sport && sport !== 'all') list = list.filter((m) => m.sport === sport);
    if (league && league !== 'all') list = list.filter((m) => m.league === league);
    if (status && status !== 'all') list = list.filter((m) => m.status === status);
    if (day !== 'all') {
      const off = { yesterday: -1, today: 0, tomorrow: 1, later: 2 }[day];
      if (off != null) list = list.filter((m) => (off === 2 ? dayOffset(Date.parse(m.startTime)) >= 2 : dayOffset(Date.parse(m.startTime)) === off) || (day === 'today' && m.status === 'live'));
    }
    const rank = { live: 0, pre: 1, post: 2 };
    list.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'post' ? Date.parse(b.startTime) - Date.parse(a.startTime) : Date.parse(a.startTime) - Date.parse(b.startTime)));
    res.json({ lastUpdate: state.lastUpdate, version: state.version, leagueStatus: state.leagueStatus, today: localDay(), matches: list.map(matchSummary) });
  });

  app.get('/api/matches/:id', (req, res) => {
    const d = matchDetail(req.params.id); if (!d) throw httpError(404, 'A meccs nem található (lehet, hogy kikerült az időablakból).');
    res.json(d);
  });

  // Manual odds: { market, selection, odds } — odds null/'' removes it.
  app.post('/api/matches/:id/odds', (req, res) => {
    const { id } = req.params; const { market, selection } = req.body; const odds = req.body.odds === '' || req.body.odds == null ? null : Number(String(req.body.odds).replace(',', '.'));
    if (!state.matches.has(id)) throw httpError(404, 'A meccs nem található.');
    if (!market || !selection) throw httpError(400, 'Hiányzó piac vagy kimenetel.');
    if (odds !== null && !(odds > 1 && odds < 1000)) throw httpError(400, 'A szorzó 1,01 és 1000 között legyen.');
    const all = db().manualOdds; all[id] = all[id] || {};
    if (odds === null) delete all[id][`${market}:${selection}`]; else all[id][`${market}:${selection}`] = odds;
    if (!Object.keys(all[id]).length) delete all[id];
    store.save();
    reanalyse(id);
    res.json(matchDetail(id));
  });

  app.post('/api/refresh', async (req, res) => {
    await refresh({ reason: 'manual' });
    res.json({ lastUpdate: state.lastUpdate, version: state.version });
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ version: state.version, lastUpdate: state.lastUpdate })}\n\n`);
    SSE_CLIENTS.add(res);
    req.on('close', () => SSE_CLIENTS.delete(res));
  });

  app.get('/api/combos/:mode', (req, res) => {
    const mode = req.params.mode === 'brutal' ? 'brutal' : req.params.mode === 'easy' ? 'easy' : null;
    if (!mode) throw httpError(404, 'Ismeretlen mix-típus.');
    const seed = Math.max(1, Number(req.query.seed) || 1);
    const locked = String(req.query.locked || '').split(',').filter(Boolean);
    const groups = String(req.query.markets || '').split(',').filter((g) => MARKET_GROUPS[g]);
    const allowMock = config.dataMode === 'mock';
    const legs = filterByGroups(legCandidates({ allowMock }), groups);
    const days = dayOptions(mode, legs);
    const day = days.some((d) => d.day === req.query.day) ? req.query.day : pickDay(mode, legs);
    const out = buildTickets(mode, legs, { seed, locked, day });
    const mockLeagues = Object.entries(state.leagueStatus).filter(([, v]) => v.source === 'mock').length;
    if (!allowMock && mockLeagues) out.warnings.push(`${mockLeagues} bajnokság most csak mintaadatot mutat (nem érhető el az élő forrás) – ezek meccsei nem kerülnek szelvényre.`);
    if (!allowMock && !legs.length) out.warnings = out.warnings.filter((w) => !w.startsWith('Nincs elég megfelelő tétel'));
    if (!allowMock && !legs.length) out.warnings.push('Jelenleg nincs valós (élő forrásból származó) közelgő meccs, ezért nem készül szelvény. Mintameccsekből a szelvényépítő nem dolgozik.');
    // with a market filter, fewer sports are expected (e.g. yellow cards = football only)
    if (groups.length) out.warnings = out.warnings.filter((w) => !w.startsWith('Ezen a napon'));
    if (groups.length && !out.tickets.length) out.warnings.push(mode === 'easy'
      ? 'A kiválasztott piactípusokon ezen a napon nincs elég nagy valószínűségű tétel a Könnyű mixhez (pl. a gólszerző tételek általában 50% alattiak). Vegyél hozzá más piacot, vagy próbáld a Brutális mixet.'
      : 'A kiválasztott piactípusokból ezen a napon nem áll össze 70,00 feletti szelvény. Vegyél hozzá más piacot vagy válassz másik napot.');
    res.json({ ...out, days, today: localDay(), seed, lastUpdate: state.lastUpdate, realOnly: !allowMock, markets: groups, marketGroups: Object.entries(MARKET_GROUPS).map(([id, g]) => ({ id, label: g.label })) });
  });

  app.get('/api/tips', (req, res) => {
    const list = filterTips(req.query).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    const limit = Math.min(500, Number(req.query.limit) || 200);
    res.json({ total: list.length, tips: list.slice(0, limit) });
  });
  app.get('/api/stats', (req, res) => res.json(tipStats(req.query)));

  app.get('/api/bankroll', (req, res) => res.json(bankrollView()));
  app.post('/api/bankroll/bets', (req, res) => res.json({ bet: addBet(req.body), ...bankrollView() }));
  app.post('/api/bankroll/bets/:id/settle', (req, res) => res.json({ bet: settleBet(req.params.id, req.body.status), ...bankrollView() }));
  app.delete('/api/bankroll/bets/:id', (req, res) => { deleteBet(req.params.id); res.json(bankrollView()); });
  app.get('/api/limits', (req, res) => res.json({ limits: db().settings.limits, pending: db().settings.pendingLimits || null, selfPauseUntil: db().settings.selfPauseUntil || null, usage: usage() }));
  app.post('/api/selfpause', (req, res) => res.json(selfPause(req.body.days)));
  app.put('/api/settings', (req, res) => res.json(updateSettings(req.body)));
  app.get('/api/kelly', (req, res) => {
    const p = Number(req.query.p); const odds = Number(req.query.odds);
    if (!(p > 0 && p < 1) || !(odds > 1)) throw httpError(400, 'Adj meg érvényes valószínűséget (0–1) és szorzót (>1).');
    res.json(kellySuggestion(p, odds));
  });

  app.get('/api/backtest', (req, res) => {
    if (!backtestCache || req.query.force) {
      const r = runBacktest(mockHistory({ days: 60, sparse: 2 }));
      backtestCache = { ...r, source: 'mock', ranAt: Date.now() };
    }
    res.json(backtestCache);
  });

  app.get('/api/providers', (req, res) => res.json(providerStatuses()));

  // AI-motor
  app.get('/api/ai', (req, res) => res.json({ ...aiStatus(), dataMode: config.dataMode }));
  app.post('/api/ai/train', async (req, res) => {
    const st = aiTrain({ reason: 'manual' });
    await refresh({ reason: 'ai-train' }).catch(() => {});
    res.json({ ...st, dataMode: config.dataMode });
  });
}
