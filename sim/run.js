#!/usr/bin/env node
/* 가상 수험생 모의 지원 → 경쟁률 예측 + 합격확률 곡선 학습
   node sim/run.js [--students 300000] [--seed 20261119] [--runs 3] [--alpha 0.7] [--minGap -3] [--cut latest|avg]
   → sim/out/report.md, sim/out/report.json, sim/out/model.json (수험생 모의 지원 도구 sim/apply.js 용)
   앱은 건드리지 않는다. */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./model');

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  const cfg = Object.assign({}, M.CONFIG);
  for (const k of ['students', 'seed', 'runs', 'alpha', 'minGap', 'holdout', 'calibSample', 'perceiveSd']) if (o[k] !== undefined) cfg[k] = +o[k];
  return { cfg, cutMode: o.cut === 'avg' ? 'avg' : 'latest' };
}
// 학과별 70% 컷 차이 (환산 %p) — 역할별 중앙값·평균 절대값
function shiftStats(depts, role, shift) {
  const out = {};
  for (const w of ['train', 'test', 'none']) {
    const v = depts.map((_, i) => i).filter(i => role[i] === w && Number.isFinite(shift[i])).map(i => shift[i]);
    out[w] = { n: v.length, median: median(v), mae: mean(v.map(Math.abs)), within05: v.filter(x => Math.abs(x) <= 0.5).length / v.length };
  }
  return out;
}

const t0 = Date.now();
const lap = msg => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

// 한 번의 모의 지원: 지원 → 합격·추가합격 → 학과별 지원자 수·합격선·충원 인원, (격차, 합격 여부) 표본
// 주어진 원서로 합격·추가합격을 돌렸을 때의 전체 추가합격 비율
function extraRateFor(students, depts, A, q, seed, pi) {
  const outAdmit = M.drawOutside(students.length, A.apps, q, M.makeRng(seed));
  const { cutoff } = M.deferredAcceptance(students.length, depts, A.apps, A.appScore, { appPlan: A.appPlan, outAdmit, pi });
  let offers = 0;
  const per = new Int32Array(depts.length);
  for (let k = 0; k < A.apps.length; k++) { const d = A.apps[k]; if (d >= 0 && A.appScore[k] >= cutoff[d]) per[d]++; }
  depts.forEach((dp, d) => { offers += Math.max(0, per[d] - dp.cap); });
  return offers / depts.reduce((a, d) => a + d.cap, 0);
}
// 모형 밖 대학 이탈 확률 q를 이분 탐색 — 전체 추가합격 비율이 목표가 되도록 (원서는 고정)
function fitDecline(students, depts, A, target, seed, lap, pi) {
  let lo = 0, hi = 1;
  for (let it = 0; it < 14; it++) {
    const q = (lo + hi) / 2, r = extraRateFor(students, depts, A, q, seed, pi);
    if (r < target) lo = q; else hi = q;
  }
  const q = (lo + hi) / 2;
  lap(`모형 밖 대학 합격 확률 q = ${q.toFixed(3)} (추가합격 목표 ${(target * 100).toFixed(1)}%)`);
  return q;
}

function oneRun(students, prep, cfg, theta, seed, q, A) {
  const rng = M.makeRng(seed), { depts, profKeys } = prep, D = depts.length;
  A = A || M.chooseApplications(students, depts, profKeys, cfg, rng, theta);
  const { apps, appDiff, appScore, appPlan } = A;
  const outAdmit = M.drawOutside(students.length, apps, q, M.makeRng(seed + 1));
  const { cutoff, held, match } = M.deferredAcceptance(students.length, depts, apps, appScore, { appPlan, outAdmit, pi: cfg.pi });
  const nApp = new Int32Array(D), offers = new Int32Array(D);
  const xs = [], ys = [];
  let outside = 0;
  for (let i = 0; i < students.length; i++) for (let g = 0; g < 3; g++) {
    const d = apps[i * 3 + g]; if (d < 0) { outside++; continue; }
    nApp[d]++;
    const admit = appScore[i * 3 + g] >= cutoff[d];
    if (admit) offers[d]++;               // 최종 합격선 이상 = 최초·추가 합격 통지를 받은 지원자
    xs.push(appDiff[i * 3 + g]); ys.push(admit ? 1 : 0);
  }
  // 충원(추가합격) = 합격 통지 수 − 모집인원 (미충원 학과는 지원자 전원이 통지 → 지원자 − 모집인원, 최소 0)
  const extra = Int32Array.from(depts, (dp, d) => Math.max(0, offers[d] - dp.cap));
  // 70% 컷 차이: 시뮬레이션 등록자 70% 컷 − 실측 합격선 (환산 %p)
  const shift = new Float64Array(D).fill(NaN);
  for (let d = 0; d < D; d++) {
    const h = held[d]; if (h.length < 3) continue;
    const s = h.map(x => x.s).sort((a, b) => b - a);
    shift[d] = (s[Math.max(0, Math.ceil(0.7 * s.length) - 1)] - depts[d].cutTotal) / 10;
  }
  return { nApp, extra, cutoff, shift, xs, ys, outside, placed: held.reduce((a, h) => a + h.length, 0),
    declined: (() => { let c = 0; for (let i = 0; i < students.length; i++) {
      let o = false; for (let g = 0; g < 3; g++) if (outAdmit[i * 3 + g]) o = true;
      if (o && match[i] < 0) c++; } return c; })(),
    unfilled: Array.from(cutoff).filter(x => x === -Infinity).length };
}

function rateMetrics(depts, role, pred, which) {
  const rows = depts.map((d, i) => ({ d, i })).filter(({ i }) => role[i] === which);
  const err = rows.map(({ d, i }) => Math.log(pred[i] / d.cap) - Math.log(d.rate));
  const ape = rows.map(({ d, i }) => Math.abs(pred[i] / d.cap - d.rate) / d.rate);
  // 로그 경쟁률 상관
  const a = rows.map(({ d, i }) => Math.log(pred[i] / d.cap)), b = rows.map(({ d }) => Math.log(d.rate));
  const ma = mean(a), mb = mean(b);
  const cov = mean(a.map((x, k) => (x - ma) * (b[k] - mb)));
  const corr = cov / Math.sqrt(mean(a.map(x => (x - ma) ** 2)) * mean(b.map(x => (x - mb) ** 2)));
  return { n: rows.length, mape: median(ape), within30: ape.filter(x => x <= 0.3).length / rows.length,
    logBias: mean(err), corr };
}

function main() {
  const { cfg, cutMode } = args();
  console.log(`가상 수험생 모의 지원 — ${cfg.students.toLocaleString()}명 × ${cfg.runs}회 · 크게 미달 기준 ${cfg.minGap}%p · 2026 반영 ${cfg.alpha}`);
  const prep = M.prepareDepts(cutMode), { depts } = prep, D = depts.length;
  // 반복 보정 결과(sim/converge.js → sim/out/adjust.json): 학과별 지원층 보정 δ, 군별 선호 π
  const adjFile = path.join(__dirname, 'out', 'adjust.json');
  let adjusted = false;
  if (fs.existsSync(adjFile) && !process.argv.includes('--no-adjust')) {
    const adj = JSON.parse(fs.readFileSync(adjFile, 'utf8'));
    // 학습 때와 다른 seed·holdout이면 학습/검증 학과 분할이 달라져 검증이 샌다 → 학습 설정을 그대로 쓴다
    for (const k of ['seed', 'holdout', 'alpha', 'minGap', 'students', 'calibSample'])
      if (adj.config && adj.config[k] !== undefined && cfg[k] !== adj.config[k]) {
        lap(`⚠ ${k}: 학습 설정(${adj.config[k]})으로 맞춤 (입력 ${cfg[k]})`); cfg[k] = adj.config[k]; }
    depts.forEach(d => { d.delta = adj.delta[d.key] || 0; });
    cfg.pi = adj.pi; adjusted = true;
    lap(`반복 보정 결과 적용 (${adj.iterations}회 보정, π = ${adj.pi.map(x => x.toFixed(2)).join('/')})`);
  }
  lap(`학과 ${D}개, 모집인원 합 ${depts.reduce((a, d) => a + d.cap, 0).toLocaleString()}명`);

  // 1. 2026 경쟁률로 학과 인기도 학습 (검증 학과 제외)
  const role = M.splitHoldout(depts, cfg, M.makeRng(cfg.seed + 99));
  const sample = M.makePopulation(Object.assign({}, cfg, { students: cfg.calibSample }), M.makeRng(cfg.seed + 7));
  const cal = M.calibrate(sample, depts, prep.profKeys, cfg, M.makeRng(cfg.seed + 8), role, lap);
  lap('학과 인기도 학습 완료');

  // 2. 30만 명 모의 지원 × runs
  const students = M.makePopulation(cfg, M.makeRng(cfg.seed));
  lap(`수험생 ${students.length.toLocaleString()}명 생성`);
  // 첫 회 원서로 이탈 확률 q를 맞춘 뒤 모든 회차에 같은 q를 쓴다
  const capAll0 = depts.reduce((a, d) => a + d.cap, 0);
  const extraTarget = cfg.extraTarget !== null ? cfg.extraTarget : depts.reduce((a, d) => a + (d.extra || 0), 0) / capAll0;
  const A0 = M.chooseApplications(students, depts, prep.profKeys, cfg, M.makeRng(cfg.seed + 1000), cal.theta);
  lap('첫 회 원서 완료');
  const q = fitDecline(students, depts, A0, extraTarget, cfg.seed + 500, lap, cfg.pi);
  const runs = [];
  for (let r = 0; r < cfg.runs; r++) {
    runs.push(oneRun(students, prep, cfg, cal.theta, cfg.seed + 1000 + r, q, r === 0 ? A0 : null));
    lap(`모의 지원 ${r + 1}/${cfg.runs}회`);
  }

  // 3. 예상 경쟁률 (여러 회 평균)
  const simApps = Float64Array.from(depts, (_, d) => mean(runs.map(x => x.nApp[d])));
  const simExtra = Float64Array.from(depts, (_, d) => mean(runs.map(x => x.extra[d])));
  const metrics = {
    train: rateMetrics(depts, role, simApps, 'train'),
    test: rateMetrics(depts, role, simApps, 'test'),
    testBaseline: rateMetrics(depts, role, cal.baseline, 'test'),
    testRegression: rateMetrics(depts, role, Float64Array.from(depts, (d, i) => cal.predRate[i] * d.cap), 'test'),
  };
  // 4. 합격확률 곡선 (모든 회차 표본)
  const xs = [].concat(...runs.map(r => r.xs)), ys = [].concat(...runs.map(r => r.ys));
  const fit = M.fitLogistic(xs, ys);
  lap(`합격확률 곡선: σ(${fit.a.toFixed(3)} + ${fit.b.toFixed(3)}·격차)`);

  // 5. 현실성 점검 — 총 원서·충원·70% 컷 차이 (군별)
  const real = depts.map(d => ({ apps: d.rate > 0 ? d.rate * d.cap : NaN }));
  const byGun = M.GUNS.map((g, gi) => {
    const ds = depts.map((d, i) => i).filter(i => depts[i].gi === gi);
    const withRate = ds.filter(i => depts[i].rate > 0);
    const cap = ds.reduce((a, i) => a + depts[i].cap, 0), capR = withRate.reduce((a, i) => a + depts[i].cap, 0);
    return { gun: g, depts: ds.length, cap,
      simRate: withRate.reduce((a, i) => a + simApps[i], 0) / capR,
      realRate: withRate.reduce((a, i) => a + real[i].apps, 0) / capR,
      simExtra: ds.reduce((a, i) => a + simExtra[i], 0) / cap,
      realExtra: ds.reduce((a, i) => a + (depts[i].extra || 0), 0) / cap,
      shift: median(ds.map(i => mean(runs.map(r => r.shift[i]))).filter(Number.isFinite)) };
  });
  const capAll = depts.reduce((a, d) => a + d.cap, 0);
  const totals = {
    simApps: simApps.reduce((a, x) => a + x, 0), realApps: real.reduce((a, x) => a + (x.apps || 0), 0),
    simExtraRate: simExtra.reduce((a, x) => a + x, 0) / capAll,
    realExtraRate: depts.reduce((a, d) => a + (d.extra || 0), 0) / capAll,
    shift: median(depts.map((_, i) => mean(runs.map(r => r.shift[i]))).filter(Number.isFinite)),
    outside: mean(runs.map(r => r.outside)), placed: mean(runs.map(r => r.placed)), declined: mean(runs.map(r => r.declined)),
    unfilled: mean(runs.map(r => r.unfilled)),
  };

  // 6. 저장
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const model = {
    generatedAt: new Date().toISOString(), cutMode, config: cfg, fit, declineQ: q,
    depts: depts.map((d, i) => ({ key: d.key, u: d.u, n: d.n, g: d.g, mg: d.mg, cap: d.cap, cutP: d.cutP,
      realRate: d.rate || null, role: role[i], theta: +cal.theta[i].toFixed(4), regRate: +cal.predRate[i].toFixed(3),
      predRate: +(simApps[i] / d.cap).toFixed(3), predExtra: +simExtra[i].toFixed(1),
      cutoffs: runs.map(r => Number.isFinite(r.cutoff[i]) ? +r.cutoff[i].toFixed(3) : null) })),
  };
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model));
  const shiftByRole = shiftStats(depts, role, Float64Array.from(depts, (_, i) => mean(runs.map(r => r.shift[i]))));
  const rep = { generatedAt: model.generatedAt, cutMode, config: cfg, metrics, fit, byGun, totals, declineQ: q, shiftByRole, adjusted,
    examples: examples(model.depts) };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rep, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), md(rep));
  console.log('\n' + md(rep).split('\n').slice(0, 45).join('\n'));
  console.log(`\n✓ sim/out/report.md · report.json · model.json  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// 검증 학과 중 예시 (실제 경쟁률 높은 순·낮은 순·중간)
function examples(ds) {
  const t = ds.filter(d => d.role === 'test').sort((a, b) => b.realRate - a.realRate);
  const pick = [...t.slice(0, 4), ...t.slice(Math.floor(t.length / 2) - 2, Math.floor(t.length / 2) + 2), ...t.slice(-4)];
  return pick.map(d => ({ u: d.u, n: d.n, mg: d.mg, cap: d.cap, real: d.realRate, pred: d.predRate }));
}

const p1 = v => (v * 100).toFixed(1) + '%';
const sg = v => !Number.isFinite(v) ? '–' : (v >= 0 ? '+' : '') + v.toFixed(2);
function md(o) {
  const L = [], m = o.metrics, c = o.config, tt = o.totals;
  L.push(`# 모의 지원 시뮬레이션 — 경쟁률 예측 · 합격확률 곡선`, '');
  L.push(`> ⚠ 가정(아래 표)과 2026학년도 경쟁률 학습에 기반한 **시뮬레이션 결과**다. 실제 입시 결과로 검증된 예측이 아니다.`, '');
  L.push(`- 수험생 ${c.students.toLocaleString()}명 × ${c.runs}회 · 합격선에 **${-c.minGap}%p 넘게 미달하는 학과에는 지원하지 않음** · 2026 경쟁률 반영 비율 ${c.alpha}`);
  L.push(`- 35개 대학 원서 ${Math.round(tt.simApps).toLocaleString()}장 (실제 2026 ${Math.round(tt.realApps).toLocaleString()}장) · 모형 밖 대학 원서 ${Math.round(tt.outside).toLocaleString()}장 · 등록 ${Math.round(tt.placed).toLocaleString()}명`, '');
  L.push(`## 경쟁률 예측`, '');
  L.push(`학과의 ${p1(c.holdout)}는 학습에서 빼고(검증 학과) 자기 경쟁률을 보지 않은 채 예측했다. 이 학과들의 성적이 **실제 예측력**이다.`, '');
  L.push(`| | 학과 수 | 오차 중앙값 | 오차 30% 이내 | 상관(로그) |`, `|---|---:|---:|---:|---:|`);
  const row = (name, x) => L.push(`| ${name} | ${x.n} | ${p1(x.mape)} | ${p1(x.within30)} | ${x.corr.toFixed(2)} |`);
  row('학습 학과 — 시뮬레이션 (실제 ' + c.alpha + ' 반영)', m.train);
  row('**검증 학과 — 시뮬레이션 (30만 명 모의 지원 결과)**', m.test);
  row('검증 학과 — 경쟁률 예측 회귀값', m.testRegression);
  row('검증 학과 — 2026 정보 없는 시뮬레이션 (기준선)', m.testBaseline);
  L.push('', `검증 학과는 자기 경쟁률을 보지 않았다: 회귀가 학과 특성으로 예측하고, 시뮬레이션은 그 예측을 30만 명의 원서로 재현한다.`,
    `학습 학과도 오차가 0이 아닌 것은 실제 경쟁률을 ${c.alpha}만 반영하고 나머지는 예측값을 쓰기 때문이다.`, '');
  L.push(`### 검증 학과 예시`, '', `| 학과 | 군 | 모집 | 실제 2026 | 예측 |`, `|---|---|---:|---:|---:|`);
  for (const e of o.examples) L.push(`| ${e.u} ${e.n} | ${e.mg} | ${e.cap} | ${e.real.toFixed(2)} | ${e.pred.toFixed(2)} |`);
  L.push('', `## 현실성 점검 — 군별`, '');
  L.push(`| 군 | 학과 | 모집 | 경쟁률 예측 | 경쟁률 실제 | 추가합격 예측 | 추가합격 실제 | 70% 컷 차이 |`, `|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const g of o.byGun) L.push(`| ${g.gun} | ${g.depts} | ${g.cap.toLocaleString()} | ${g.simRate.toFixed(2)} | ${g.realRate.toFixed(2)} | ${p1(g.simExtra)} | ${p1(g.realExtra)} | ${sg(g.shift)} |`);
  L.push(`| 전체 | | | ${(tt.simApps / o.byGun.reduce((a, g) => a + g.cap, 0)).toFixed(2)}* | | ${p1(tt.simExtraRate)} | ${p1(tt.realExtraRate)} | ${sg(tt.shift)} |`);
  L.push('', `- 추가합격 = 모집인원 대비 추가합격 인원 (어디가 충원인원). **전체 비율만** 모형 밖 대학 원서의 합격 확률 q = ${o.declineQ.toFixed(3)}로 맞췄고`,
    `  (모형 밖 대학으로 간 학생 ${Math.round(tt.declined).toLocaleString()}명), 군별 차이는 맞추지 않았다 → 군별 값이 검증 지표다.`,
    `  모형 밖 합격은 그 원서보다 덜 욕심낸 원서만 포기하게 한다 (안정 원서 합격 때문에 상향 원서를 포기하지 않는다).`,
    `- 미충원 학과 평균 ${tt.unfilled.toFixed(0)}개 (시뮬레이션이 지원자를 다 붙잡지 못한 학과).`,
    `- 70% 컷 차이 = 시뮬레이션 등록자 70% 컷 − 실측 합격선 (환산 %p). 0이면 경쟁 수준이 현실과 같다.`,
    `- *전체 경쟁률은 경쟁률 미공개 학과의 예측 원서도 포함한 값.`, '');
  if (o.shiftByRole) {
    const sb = o.shiftByRole;
    L.push(`### 학과별 70% 컷 차이 ${o.adjusted ? '(반복 보정 적용)' : '(반복 보정 없음)'}`, '',
      `검증 학과는 자기 합격선을 보지 않았다 — 학습 학과에서 배운 지원층 보정만 받는다.`, '',
      `| | 학과 수 | 중앙값 | 평균 절대값 | ±0.5%p 이내 |`, `|---|---:|---:|---:|---:|`);
    const nm = { train: '학습 학과', test: '**검증 학과**', none: '경쟁률 미공개 학과' };
    for (const w of ['train', 'test', 'none']) if (sb[w].n)
      L.push(`| ${nm[w]} | ${sb[w].n} | ${sg(sb[w].median)} | ${sb[w].mae.toFixed(2)} | ${p1(sb[w].within05)} |`);
    L.push('');
  }
  const warn = Math.abs(tt.shift) > 0.5;
  if (warn) L.push(`> ⚠ 70% 컷 차이가 ±0.5%p를 넘는다 — 아래 합격확률 곡선의 위치는 그만큼 믿기 어렵다.`, '');
  L.push(`## 합격확률 곡선`, '', `**P(합격) = σ(${o.fit.a.toFixed(3)} + ${o.fit.b.toFixed(3)} × 격차)** — 50% 지점 ${sg(-o.fit.a / o.fit.b)}%p (현재 앱 0)`, '');
  L.push(`## 가정`, '', '| 항목 | 값 |', '|---|---|');
  const desc = { students: '수험생 수', seed: '시드', rho: '과목 공통 능력 계수', engShare: '영어 1~9등급 비율', engRho: '영어-능력 상관',
    natShare: '자연계 비율', targets: '원서 3장의 목표 격차(안정·적정·상향, %p)', riskSd: '개인 성향 표준편차', choiceSd: '목표 주변 선택 폭',
    window: '고려 범위(목표 ±%p)', minGap: '크게 미달 기준 (이보다 낮은 격차는 지원 안 함)', popPower: '모집인원 가중 지수',
    outside: '모형 밖 대학 선택지 무게', calibSample: '학습 표본 학생 수', calibIters: '학습 반복', alpha: '2026 경쟁률 반영 비율',
    holdout: '검증 학과 비율', runs: '모의 지원 반복 횟수' };
  for (const [k, v] of Object.entries(c)) L.push(`| ${desc[k] || k} (\`${k}\`) | ${Array.isArray(v) ? v.join(', ') : v} |`);
  L.push('', `격차·환산총점은 앱 엔진(src/engine.js) 그대로. 선발은 환산총점 순, 등록은 합격한 곳 중 합격선이 가장 높은 곳`,
    `(학생 제안 지연수락 = 추가합격이 끝까지 돈 상태). 반영하지 않음: 수능 최저, 학생부, 모형 밖 대학과의 경쟁, 실제 성적표-대응표 불일치.`);
  return L.join('\n') + '\n';
}

if (require.main === module) main();
module.exports = { oneRun, rateMetrics, md, fitDecline, shiftStats, mean, median };
