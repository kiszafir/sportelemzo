#!/usr/bin/env node
// Backtest runner.
//   npm run backtest                      -> simulated history (mock), 120 days
//   npm run backtest -- --file data/history.json   -> archived real results
//   npm run backtest -- --save            -> store fitted NBA/NHL coefficients in data/models.json
//                                            (only if they beat the current ones out of sample)
import fs from 'node:fs';
process.env.DATA_MODE = process.env.DATA_MODE || 'mock';
const { runBacktest } = await import('../server/engine/backtest.js');
const { mockHistory } = await import('../server/providers/mock.js');
const { saveTrained } = await import('../server/engine/models/logistic.js');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const file = arg('--file');
const days = Number(arg('--days', 120));

let matches;
if (file) {
  matches = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Történeti adat: ${file} (${matches.length} meccs)`);
} else {
  matches = mockHistory({ days, sparse: 2 });
  console.log(`Szimulált (MINTA) előzmények: ${days} nap, ${matches.length} meccs`);
}

const t0 = Date.now();
const res = runBacktest(matches);
const pct = (x) => (x == null ? '–' : (x * 100).toFixed(1).replace('.', ',') + '%');
const f3 = (x) => (x == null ? '–' : x.toFixed(3).replace('.', ','));
const SP = { nba: 'NBA', nhl: 'NHL', tennis: 'Tenisz', football: 'Labdarúgás', handball: 'Kézilabda' };

console.log(`\nKiértékelt meccsek: ${res.n}  (${Date.now() - t0} ms)\n`);
console.log('Sportág       n   Pontosság  Hazai alap  Brier   LogLoss  Értéktippek  Találat  ROI');
for (const [s, m] of Object.entries({ ...res.bySport, összes: res.overall })) {
  console.log(`${(SP[s] || s).padEnd(12)} ${String(m.n).padStart(4)}   ${pct(m.accuracy).padStart(7)}    ${pct(m.homeBaseline).padStart(7)}   ${f3(m.brier)}   ${f3(m.logLoss)}   ${String(m.valueTips).padStart(6)}     ${pct(m.valueHitRate).padStart(6)}  ${pct(m.valueRoi)}`);
}
console.log('\nLogisztikus regresszió újrabecslése (70/30 időrendi bontás):');
for (const [s, r] of Object.entries(res.logistic)) {
  if (r.skipped) { console.log(`  ${SP[s]}: kihagyva – ${r.reason}`); continue; }
  console.log(`  ${SP[s]}: tanító ${r.train}, teszt ${r.test} | log loss jelenlegi ${f3(r.logLossCurrent)}, alap ${f3(r.logLossDefault)}, újrabecsült ${f3(r.logLossFitted)}`);
  if (args.includes('--save')) {
    if (r.logLossFitted < r.logLossCurrent) { saveTrained(s, r.coef, { logLoss: r.logLossFitted, n: r.train }); console.log('    → mentve: data/models.json'); }
    else console.log('    → nem mentve (nem javított a teszthalmazon)');
  }
}
if (!file) console.log('\nMegjegyzés: szimulált adatokon mért eredmény – a valós teljesítményt nem bizonyítja.');
