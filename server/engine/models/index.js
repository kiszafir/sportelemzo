// Model registry. Models are pluggable: register() a new model object with
// { id, name, sports, predict(match, factors) -> { pHome, contributions } } and
// set its ensemble weight. ML models can be added the same way later.
import { weightedModel } from './weighted.js';
import { logisticModel } from './logistic.js';
import { poissonModel } from './poisson.js';
import { eloModel } from './elo.js';

const registry = new Map();
export const ENSEMBLE = {
  // weight of the sport-specific model vs. the weighted baseline for the main (winner) market
  nba: { specific: 'logistic', wSpecific: 0.6 },
  nhl: { specific: 'logistic', wSpecific: 0.6 },
  tennis: { specific: 'elo', wSpecific: 0.6 },
  football: { specific: 'poisson', wSpecific: 0.6 },
  handball: { specific: 'goalnormal', wSpecific: 0.6 },
};

export function register(model) { registry.set(model.id, model); }
export const getModel = (id) => registry.get(id);
export const listModels = () => [...registry.values()].map(({ id, name, sports }) => ({ id, name, sports }));

// Handball: normal approximation of goal margin and total (implemented in analyze.js).
const goalNormalModel = { id: 'goalnormal', name: 'Gólkülönbség-modell (normális közelítés)', sports: ['handball'] };
[weightedModel, logisticModel, poissonModel, eloModel, goalNormalModel].forEach(register);
