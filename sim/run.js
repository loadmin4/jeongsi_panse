#!/usr/bin/env node
/* 가상 수험생 모의 지원 → 합격확률 곡선 학습
   node sim/run.js [--students 300000] [--seed 20261119] [--runs 1] [--cut latest|avg]
   → sim/out/report.md, sim/out/report.json  (앱은 건드리지 않는다) */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./model');

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  const cfg = Object.assign({}, M.CONFIG);
  if (o.students) cfg.students = +o.students;
  if (o.seed) cfg.seed = +o.seed;
  return { cfg, runs: +(o.runs || 1), cutMode: o.cut === 'avg' ? 'avg' : 'latest' };
}

const t0 = Date.now();
const lap = msg => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// 한 번의 시뮬레이션: 성적 생성 → 지원 → 합격·추가합격 → (격차, 합격여부) 표본
function simulate(cfg, cutMode, prep) {
  const rng = M.makeRng(cfg.seed);
  const students = M.makePopulation(cfg, rng); lap(`수험생 ${students.length.toLocaleString()}명 생성`);
  const { depts, profKeys } = prep;
  const { apps, appDiff, appScore } = M.chooseApplications(students, depts, profKeys, cfg, rng);
  lap('지원 완료');
  const { match, cutoff, held } = M.deferredAcceptance(students.length, depts, apps, appScore);
  lap('합격·추가합격(연쇄 이동) 완료');

  const xs = [], ys = [], caps = [];
  let nApps = 0, nOutside = 0;
  for (let i = 0; i < students.length; i++) for (let g = 0; g < 3; g++) {
    const d = apps[i * 3 + g];
    if (d < 0) { nOutside++; continue; }
    nApps++;
    xs.push(appDiff[i * 3 + g]);
    ys.push(appScore[i * 3 + g] >= cutoff[d] ? 1 : 0); // 최종 합격선 이상이면 (최초·추가) 합격
    caps.push(depts[d].cap);
  }
  // 현실성 점검 — 격차와 같은 단위(환산총점 %p)로 본다:
  //   shift = (시뮬레이션 등록자 70% 컷 환산총점 − 「어디가」 실측 합격선 환산총점) / 10
  //   0이면 시뮬레이션 경쟁이 실제와 같은 수준, +면 실제보다 치열(학습 곡선이 그만큼 오른쪽으로 밀림)
  //   경쟁률도 「어디가」 실측(최신 학년도)과 비교한다.
  const nApp = new Int32Array(depts.length);
  for (let k = 0; k < apps.length; k++) if (apps[k] >= 0) nApp[apps[k]]++;
  const cmp = [];
  for (let d = 0; d < depts.length; d++) {
    const h = held[d]; if (h.length < 3) continue;
    const s = h.slice().sort((a, b) => b.s - a.s);
    const at = s[Math.max(0, Math.ceil(0.7 * s.length) - 1)];
    cmp.push({ d, shift: (at.s - depts[d].cutTotal) / 10, real: depts[d].cutP,
      simRate: nApp[d] / depts[d].cap, realRate: depts[d].rate });
  }
  const placed = match.reduce((a, d) => a + (d >= 0 ? 1 : 0), 0);
  const unfilled = depts.filter((_, d) => cutoff[d] === -Infinity).length;
  return { xs, ys, caps, nApps, nOutside, placed, unfilled, cmp, n: students.length };
}

function bins(xs, ys, f, lo = -6, hi = 6, step = 0.5) {
  const out = [];
  for (let b = lo; b < hi; b += step) {
    let n = 0, k = 0, pf = 0;
    for (let i = 0; i < xs.length; i++) if (xs[i] >= b && xs[i] < b + step) { n++; k += ys[i]; pf += f(xs[i]); }
    if (n) out.push({ from: b, to: b + step, n, rate: k / n, fitted: pf / n, app: M.sigmoid(0, 1)(b + step / 2) });
  }
  return out;
}

function main() {
  const { cfg, runs, cutMode } = args();
  console.log(`가상 수험생 모의 지원 — ${cfg.students.toLocaleString()}명 × ${runs}회, 합격선 기준 ${cutMode}`);
  const prep = M.prepareDepts(cutMode);
  lap(`학과 ${prep.depts.length}개, 모집인원 합 ${prep.depts.reduce((a, d) => a + d.cap, 0).toLocaleString()}명`);

  const results = [];
  for (let r = 0; r < runs; r++) {
    const res = simulate(Object.assign({}, cfg, { seed: cfg.seed + r }), cutMode, prep);
    res.fit = M.fitLogistic(res.xs, res.ys);
    res.appLoss = M.fitLogistic.length && logLoss(res.xs, res.ys, M.sigmoid(0, 1));
    // 모집인원 규모별 곡선 (소규모 학과일수록 불확실성이 큰지)
    res.byCap = [[1, 10], [11, 30], [31, 1e9]].map(([lo, hi]) => {
      const x = [], y = [];
      res.xs.forEach((v, i) => { if (res.caps[i] >= lo && res.caps[i] <= hi) { x.push(v); y.push(res.ys[i]); } });
      return { lo, hi, n: x.length, ...M.fitLogistic(x, y) };
    });
    lap(`학습: P(합격) = σ(${res.fit.a.toFixed(3)} + ${res.fit.b.toFixed(3)}·격차)`);
    results.push(res);
  }
  report(cfg, cutMode, prep, results);
}

function logLoss(xs, ys, f) {
  let ll = 0;
  for (let i = 0; i < xs.length; i++) { const p = Math.min(1 - 1e-12, Math.max(1e-12, f(xs[i]))); ll += ys[i] ? Math.log(p) : Math.log(1 - p); }
  return -ll / xs.length;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0;

function report(cfg, cutMode, prep, results) {
  const R = results[0];
  const A = results.map(r => r.fit.a), B = results.map(r => r.fit.b);
  const a = mean(A), b = mean(B), f = M.sigmoid(a, b);
  const table = bins(R.xs, R.ys, f);
  const x50 = -a / b; // P=50% 가 되는 격차
  const cmp = R.cmp, shifts = cmp.map(c => c.shift);
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const rates = cmp.filter(c => c.realRate > 0);
  const byReal = [[0, 85], [85, 90], [90, 95], [95, 101]].map(([lo, hi]) => {
    const g = cmp.filter(c => c.real >= lo && c.real < hi);
    const gr = g.filter(c => c.realRate > 0);
    return { lo, hi, n: g.length, shift: med(g.map(c => c.shift)),
      simRate: med(gr.map(c => c.simRate)), realRate: med(gr.map(c => c.realRate)) };
  });
  const out = {
    generatedAt: new Date().toISOString(), cutMode, config: cfg, runs: results.length,
    depts: prep.depts.length, seats: prep.depts.reduce((s, d) => s + d.cap, 0),
    fit: { a, b, aSd: sd(A), bSd: sd(B), x50, logLoss: mean(results.map(r => r.fit.logLoss)),
      appLogLoss: mean(results.map(r => r.appLoss)) },
    byCap: R.byCap, bins: table,
    stats: { applications: R.nApps, outside: R.nOutside, placed: R.placed, unfilledDepts: R.unfilled },
    realism: { depts: cmp.length, shift: med(shifts), shiftMean: mean(shifts),
      simRate: med(rates.map(c => c.simRate)), realRate: med(rates.map(c => c.realRate)), byReal }
  };
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), md(out));
  console.log('\n' + md(out).split('\n').slice(0, 40).join('\n'));
  console.log(`\n✓ sim/out/report.md, sim/out/report.json  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const p1 = v => (v * 100).toFixed(1) + '%';
function md(o) {
  const L = [];
  L.push(`# 모의 지원 시뮬레이션 — 합격확률 곡선 학습`, '');
  L.push(`> ⚠ 가정(아래 표)에 따라 달라지는 **시뮬레이션 기반** 값이다. 실제 입시 결과로 검증된 확률이 아니다.`, '');
  L.push(`- 수험생 ${o.config.students.toLocaleString()}명 × ${o.runs}회 · 학과 ${o.depts}개 · 모집인원 ${o.seats.toLocaleString()}명 · 합격선 기준 \`${o.cutMode}\``);
  L.push(`- 원서 ${o.stats.applications.toLocaleString()}장 (모형 밖 대학 지원 ${o.stats.outside.toLocaleString()}장) · 등록 ${o.stats.placed.toLocaleString()}명 · 미충원 학과 ${o.stats.unfilledDepts}개`, '');
  L.push(`## 학습된 곡선`, '');
  L.push(`**P(합격) = σ(${o.fit.a.toFixed(3)} + ${o.fit.b.toFixed(3)} × 격차)**` +
    (o.runs > 1 ? `  (±${o.fit.aSd.toFixed(3)}, ±${o.fit.bSd.toFixed(3)}, ${o.runs}회)` : ''), '');
  L.push(`- 합격확률 50%가 되는 격차: **${o.fit.x50 >= 0 ? '+' : ''}${o.fit.x50.toFixed(2)}%p** (현재 앱: 0.00%p)`);
  L.push(`- 기울기 ${o.fit.b.toFixed(2)} (현재 앱: 1.00) — 작을수록 격차가 커도 결과가 덜 확실`);
  L.push(`- log loss: 학습 곡선 ${o.fit.logLoss.toFixed(4)} vs 현재 앱 σ(격차) ${o.fit.appLogLoss.toFixed(4)} (낮을수록 좋음)`, '');
  L.push(`| 격차(%p) | 원서 수 | 시뮬레이션 합격률 | 학습 곡선 | 현재 앱 |`, `|---|---:|---:|---:|---:|`);
  for (const r of o.bins) L.push(`| ${r.from >= 0 ? '+' : ''}${r.from.toFixed(1)} ~ ${r.to >= 0 ? '+' : ''}${r.to.toFixed(1)} | ${r.n.toLocaleString()} | ${p1(r.rate)} | ${p1(r.fitted)} | ${p1(r.app)} |`);
  L.push('', `### 모집인원 규모별`, '', `| 모집인원 | 원서 수 | a | b | 50% 격차 |`, `|---|---:|---:|---:|---:|`);
  for (const c of o.byCap) L.push(`| ${c.lo}~${c.hi > 1e8 ? '' : c.hi}명 | ${c.n.toLocaleString()} | ${c.a.toFixed(3)} | ${c.b.toFixed(3)} | ${(-c.a / c.b).toFixed(2)} |`);
  const sg = v => v === null ? '–' : (v >= 0 ? '+' : '') + v.toFixed(2);
  L.push('', `## 현실성 점검 — 시뮬레이션 경쟁 vs 「어디가」 실측`, '');
  L.push(`**shift** = 시뮬레이션 등록자 70% 컷 − 실측 합격선 (환산총점 %p, 격차와 같은 단위).`,
    `0이면 시뮬레이션 경쟁이 실제와 같은 수준이다. +이면 실제보다 치열해서 학습 곡선의 50% 지점이 대략 그만큼 오른쪽으로 밀린다.`, '');
  const warn = Math.abs(o.realism.shift) > 0.5;
  L.push(`- 비교 학과 ${o.realism.depts}개 · **shift 중앙값 ${sg(o.realism.shift)}%p** (평균 ${sg(o.realism.shiftMean)})` +
    ` · 경쟁률 중앙값 시뮬레이션 ${o.realism.simRate.toFixed(2)} vs 실측 ${o.realism.realRate.toFixed(2)}`);
  if (warn) L.push('', `> ⚠ shift가 ±0.5%p를 넘는다. 지원 행동 가정이 현실과 어긋나 있어 학습 곡선의 **위치(50% 격차)는 믿기 어렵다.**`,
    `> 기울기(격차 1%p당 확률 변화)는 상대적으로 덜 민감하다. 지원 행동을 실측 합격선·경쟁률에 맞추는 보정이 먼저 필요하다.`);
  L.push('', `| 실측 합격선 | 학과 수 | shift 중앙값 | 경쟁률 시뮬레이션 | 경쟁률 실측 |`, `|---|---:|---:|---:|---:|`);
  for (const r of o.realism.byReal) L.push(`| ${r.lo}~${r.hi > 100 ? 100 : r.hi} | ${r.n} | ${sg(r.shift)} | ${r.simRate === null ? '–' : r.simRate.toFixed(2)} | ${r.realRate === null ? '–' : r.realRate.toFixed(2)} |`);
  L.push('', `## 가정`, '', '| 항목 | 값 |', '|---|---|');
  const desc = { rho: '과목 공통 능력 계수', engShare: '영어 1~9등급 비율', engRho: '영어-능력 상관', natShare: '자연계 비율',
    targets: '원서 3장의 목표 격차(안정·적정·상향)', riskSd: '개인 성향 표준편차', choiceSd: '목표 주변 선택 폭',
    window: '고려 범위(목표 ±)', popPower: '모집인원 가중 지수', students: '수험생 수', seed: '시드' };
  for (const [k, v] of Object.entries(o.config)) L.push(`| ${desc[k] || k} (\`${k}\`) | ${Array.isArray(v) ? v.join(', ') : v} |`);
  L.push('', `모델: 성적은 공통 능력 요인으로 상관된 백분위(정의상 균등), 표준점수는 앱 대응 곡선. 격차·환산총점은 앱 엔진(src/engine.js) 그대로.`,
    `선발은 학과별 환산총점 순, 등록은 합격한 곳 중 합격선이 가장 높은 곳 — 학생 제안 지연수락으로 추가합격 연쇄까지 반영.`,
    `반영하지 않음: 수능 최저, 학생부, 전형별 세부 규칙, 모형 밖 대학(모집인원 밖)과의 경쟁.`);
  return L.join('\n') + '\n';
}

if (require.main === module) main();
module.exports = { simulate, bins, md };
