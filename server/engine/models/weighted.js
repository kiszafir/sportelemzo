// Baseline for every sport: transparent weighted scoring.
//   S = Σ(w_i · d_i) / Σ w_i       (only factors with data)
//   p_home = σ(k · S + h)          (σ = logistic function, h = home advantage in logits)
// Contribution of factor i (in logits): c_i = k · w_i · d_i / Σw
import { sigmoid } from '../mathutil.js';

export const WEIGHTED_PARAMS = {
  nba: { k: 2.4, h: 0.25 },
  nhl: { k: 1.4, h: 0.15 },
  tennis: { k: 2.6, h: 0 },
  football: { k: 1.8, h: 0.3 }, // two-way (home vs away, draw handled by the Poisson model)
  handball: { k: 2.2, h: 0.3 },
};

export const weightedModel = {
  id: 'weighted',
  name: 'Súlyozott pontozás',
  sports: ['nba', 'nhl', 'tennis', 'football', 'handball'],
  predict(match, factors) {
    const { k, h } = WEIGHTED_PARAMS[match.sport] || { k: 2, h: 0 };
    const used = factors.filter((f) => f.available && f.weight > 0);
    const W = used.reduce((s, f) => s + f.weight, 0) || 1;
    const S = used.reduce((s, f) => s + f.weight * f.diff, 0) / W;
    const contributions = used.map((f) => ({ key: f.key, label: f.label, c: (k * f.weight * f.diff) / W }));
    if (h) contributions.push({ key: 'homeAdv', label: 'Hazai pálya előnye', c: h });
    return { pHome: sigmoid(k * S + h), score: S, contributions };
  },
};
