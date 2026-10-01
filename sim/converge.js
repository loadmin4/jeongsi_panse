#!/usr/bin/env node
/* 반복 보정 — 가상 시뮬레이션을 계속 돌려 2026학년도 실제 입시 결과에 수렴시킨다.
   node sim/converge.js [--iters 12] [--eta 0.6] [--students 300000] [--seed N] [--alpha 0.7] [--minGap -3] [--holdout 0.2]
   → sim/out/adjust.json (학과별 지원층 보정 δ, 군별 선호 π, 수렴 기록). 이후 `npm run sim`이 자동으로 쓴다.

   한 바퀴:
     ① 현재 δ로 학과 인기도 θ를 2026 경쟁률(일부 반영)에 다시 맞춘다       (calibrate)
     ② 30만 명 모의 지원 → 합격·추가합격, 모형 밖 합격 확률 q는 전체 추가합격 비율에 맞춘다
     ③ 학과별 70% 컷 차이(시뮬레이션 등록자 70% 컷 − 실측 합격선, 환산 %p), 다군 추가합격 비율을 잰다
     ④ 학습 학과: δ += eta × 차이   (차이 +면 실제보다 강한 학생이 몰림 → 더 낮은 성적대가 노리게)
        검증·미공개 학과: 학습 학과 δ를 학과 특성으로 회귀한 예측값만 받는다 (자기 합격선 미사용)
        π[다] += eta × log(실제 다군 추가합격 / 시뮬레이션)   (다군을 덜 선호 → 다군 합격자가 가·나군으로 빠짐)
   학습 학과 70% 컷 차이의 중앙값·평균 절대값이 충분히 작아지면 멈춘다. ⚠ 결과는 시뮬레이션 기반이다. */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./model');
const R = require('./run');

const a = process.argv.slice(2), o = {};
for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
const cfg = Object.assign({}, M.CONFIG, { pi: [0, 0, 0] });
// 학습·평가가 같은 설정(특히 seed → 학습/검증 학과 분할)을 써야 검증이 새지 않는다 → adjust.json에 기록
for (const k of ['students', 'seed', 'alpha', 'minGap', 'holdout', 'calibSample']) if (o[k] !== undefined) cfg[k] = +o[k];
const ITERS = +(o.iters || 12), ETA = +(o.eta || 0.6);

const t0 = Date.now();
const lap = msg => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
const quiet = () => {};

const prep = M.prepareDepts('latest'), { depts, profKeys } = prep, D = depts.length;
const role = M.splitHoldout(depts, cfg, M.makeRng(cfg.seed + 99));   // run.js와 같은 분할
const students = M.makePopulation(cfg, M.makeRng(cfg.seed));
const sample = M.makePopulation(Object.assign({}, cfg, { students: cfg.calibSample }), M.makeRng(cfg.seed + 7));
const capAll = depts.reduce((s, d) => s + d.cap, 0);
const extraTarget = depts.reduce((s, d) => s + (d.extra || 0), 0) / capAll;
const gunIdx = g => depts.map((_, i) => i).filter(i => depts[i].gi === g);
const realExtraGun = [0, 1, 2].map(g => { const ix = gunIdx(g);
  return ix.reduce((s, i) => s + (depts[i].extra || 0), 0) / ix.reduce((s, i) => s + depts[i].cap, 0); });
const feat = M.featurizer(depts);
const delta = new Float64Array(D);
const history = [];
lap(`학과 ${D}개 · 수험생 ${cfg.students.toLocaleString()}명 · 최대 ${ITERS}회 · 보정 속도 ${ETA}`);
lap(`목표: 학과별 2026 경쟁률 · 70% 컷 차이 0 · 추가합격 전체 ${(extraTarget * 100).toFixed(1)}% / 다군 ${(realExtraGun[2] * 100).toFixed(1)}%`);

for (let it = 1; it <= ITERS; it++) {
  depts.forEach((d, i) => { d.delta = delta[i]; });
  const cal = M.calibrate(sample, depts, profKeys, cfg, M.makeRng(cfg.seed + 8), role, null);
  const A = M.chooseApplications(students, depts, profKeys, cfg, M.makeRng(cfg.seed + 1000 + it), cal.theta);
  const q = R.fitDecline(students, depts, A, extraTarget, cfg.seed + 500, quiet, cfg.pi);
  const run = R.oneRun(students, prep, cfg, cal.theta, cfg.seed + 1000 + it, q, A);
  const ss = R.shiftStats(depts, role, run.shift);
  const simExtraGun = [0, 1, 2].map(g => { const ix = gunIdx(g);
    return ix.reduce((s, i) => s + run.extra[i], 0) / ix.reduce((s, i) => s + depts[i].cap, 0); });
  const rt = R.rateMetrics(depts, role, run.nApp, 'test');
  const h = { it, q, pi: cfg.pi.slice(), train: ss.train, test: ss.test, extraGun: simExtraGun,
    rateTest: { mape: rt.mape, within30: rt.within30 }, unfilled: run.unfilled };
  history.push(h);
  lap(`${String(it).padStart(2)}회 | 70% 컷 차이 학습 중앙 ${R.mean([ss.train.median]).toFixed(2)} 평균|${ss.train.mae.toFixed(2)}| ±0.5내 ${(ss.train.within05 * 100).toFixed(0)}%` +
    ` · 검증 중앙 ${ss.test.median.toFixed(2)} 평균|${ss.test.mae.toFixed(2)}|` +
    ` | 추가합격 가/나/다 ${simExtraGun.map(x => (x * 100).toFixed(0)).join('/')}%` +
    ` | 경쟁률 검증 오차 ${(rt.mape * 100).toFixed(1)}% | q ${q.toFixed(2)} π다 ${cfg.pi[2].toFixed(2)} | 미충원 ${run.unfilled}`);

  const done = Math.abs(ss.train.median) < 0.1 && ss.train.mae < 0.5 && Math.abs(Math.log(simExtraGun[2] / realExtraGun[2])) < 0.1;
  if (done) { lap('수렴 — 학습 학과 70% 컷 차이 중앙값 < 0.1, 평균 절대값 < 0.5, 다군 추가합격 ±10% 이내'); break; }
  if (it === ITERS) { lap('최대 반복 도달 (완전히 수렴하지 않음)'); break; }

  // ④ 갱신
  for (let i = 0; i < D; i++) if (role[i] === 'train' && Number.isFinite(run.shift[i]))
    delta[i] += ETA * Math.max(-2, Math.min(2, run.shift[i]));
  const tr = depts.map((_, i) => i).filter(i => role[i] === 'train');
  const beta = M.ridge(tr.map(i => feat(depts[i])), tr.map(i => delta[i]), cfg.ridge);
  for (let i = 0; i < D; i++) if (role[i] !== 'train') delta[i] = feat(depts[i]).reduce((s, x, k) => s + x * beta[k], 0);
  cfg.pi[2] = Math.max(-3, Math.min(6, cfg.pi[2] + ETA * Math.log(realExtraGun[2] / Math.max(simExtraGun[2], 1e-3))));
}

const out = { generatedAt: new Date().toISOString(), iterations: history.length, eta: ETA, pi: cfg.pi,
  config: { students: cfg.students, seed: cfg.seed, alpha: cfg.alpha, minGap: cfg.minGap, holdout: cfg.holdout, calibSample: cfg.calibSample },
  delta: Object.fromEntries(depts.map((d, i) => [d.key, +delta[i].toFixed(4)])), history };
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', 'adjust.json'), JSON.stringify(out, null, 1));
lap('✓ sim/out/adjust.json — 이제 `npm run sim`이 이 보정을 적용해 리포트·model.json을 만든다');
