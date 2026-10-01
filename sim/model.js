/* 가상 수험생 모의 지원 시뮬레이터 — 모델
   ─────────────────────────────────────────────────────────────
   목적: 앱의 합격확률은 격차(%p)를 임의의 로지스틱 σ(격차)에 넣은 값이다.
   가상 수험생 N명이 앱과 같은 엔진으로 계산한 격차를 보고 가·나·다군에 지원하고,
   실제 모집인원으로 합격·추가합격(연쇄 이동)을 돌린 뒤,
   「격차 → 실제로 합격했는가」를 로지스틱 회귀로 학습한다.

   ⚠ 여기서 나온 확률은 아래 CONFIG의 가정(성적 분포, 지원 행동)에 따라 달라지는
     '시뮬레이션 기반' 값이다. 실제 입시 결과로 검증된 값이 아니다.

   구성
     makeRng            시드 고정 난수 (재현 가능)
     makePopulation     성적표 생성 (국·수·탐 백분위, 영어 등급, 계열)
     prepareDepts       학과별 합격선 환산총점 (앱 엔진 그대로)
     scoreStudent       한 학생의 프로필별 환산총점 (앱 엔진 그대로)
     chooseApplications 학생마다 가·나·다군 1곳씩 지원 (크게 미달하는 학과 제외)
     calibrate          경쟁률 예측 회귀 + 학과 인기도 θ 학습 (2026 경쟁률 일부 반영, holdout 검증)
     deferredAcceptance 모집인원 기준 합격·추가합격 (학생 제안 Gale–Shapley)
     fitLogistic        P(합격) = σ(a + b·격차) 학습 (뉴턴법)
   ───────────────────────────────────────────────────────────── */
'use strict';
const E = require('../tests/_load'); // 빌드·테스트와 같은 방식으로 합친 data+univs+engine

/* ── 가정 (결과 리포트에 그대로 기록된다) ─────────────────── */
const CONFIG = {
  students: 300000,
  seed: 20261119,
  // 성적: 공통 능력 z0 + 과목 고유 요인. 과목 간 상관 ≈ rho²
  rho: 0.85,
  // 영어(절대평가) 등급 비율 1~9등급 — 가정값. 최근 수능 1등급 비율 대략 4~7%대
  engShare: [0.06, 0.16, 0.22, 0.20, 0.14, 0.10, 0.06, 0.04, 0.02],
  engRho: 0.80,         // 영어와 공통 능력의 상관
  natShare: 0.5,        // 자연계(미적분·과탐) 비율
  // 지원 행동: 세 원서의 목표 격차(%p). 안정·적정·상향 한 장씩을 군에 무작위 배정
  targets: [1.5, 0.3, -1.2],
  riskSd: 0.7,          // 학생별 성향(목표 격차 전체를 위아래로 이동)
  choiceSd: 0.8,        // 목표 격차 주변에서 고르는 폭
  window: 3.0,          // 목표에서 이보다 먼 학과는 고려하지 않음
  minGap: -3.0,         // 격차가 이보다 낮으면(합격선에 크게 미달) 원서를 쓰지 않음 (%p)
  perceiveSd: 0,        // 수험생이 체감하는 격차의 오차 표준편차 (%p). 0 = 앱 격차를 정확히 안다
  popPower: 1.0,        // 모집인원이 큰 학과일수록 더 많이 고름 (weight ∝ 모집인원^popPower)
  outside: 1.0,         // '모형 밖 대학' 선택지의 무게 ω (학습된 θ가 상대적으로 맞춰진다)
  // 2026 경쟁률 학습
  calibSample: 60000,   // 학습에 쓰는 표본 학생 수 (기대 지원자 수는 students/표본으로 확대)
  calibIters: 40,
  alpha: 0.7,           // 학습 학과에서 2026 실제 경쟁률을 반영하는 비율 (1 = 2026 그대로, 0 = 예측 모델만)
  ridge: 3.0,           // 경쟁률 예측 회귀의 릿지 벌점
  holdout: 0.2,         // 검증용으로 학습에서 빼는 학과 비율
  runs: 3,              // 시드를 바꿔 돌리는 횟수 (예상 경쟁률·합격선 분포)
  extraTarget: null,    // 모형 밖 대학 이탈 확률 q를 맞출 전체 추가합격 비율 (null = 2026 실측 충원인원/모집인원)
};

/* ── 난수 ─────────────────────────────────────────────────── */
function makeRng(seed) {
  let a = seed >>> 0;
  const u = () => { // mulberry32
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, r;
    do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r === 0 || r >= 1);
    const f = Math.sqrt(-2 * Math.log(r) / r);
    spare = y * f; return x * f;
  };
  return { u, normal };
}

// 표준정규 누적분포 (Abramowitz–Stegun 7.1.26, 오차 < 1.5e-7)
function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/* ── 1. 성적표 ───────────────────────────────────────────── */
// 백분위는 정의상 전체 응시자에서 균등분포 → Φ(z)×100 을 정수로.
// 표준점수는 앱의 대응 곡선(pctToStd)으로 만든다 → 대응표 보정(calibrate)은 ≈0.
function makePopulation(cfg, rng) {
  const n = cfg.students, r = cfg.rho, e = Math.sqrt(1 - r * r);
  const er = cfg.engRho, ee = Math.sqrt(1 - er * er);
  const cum = []; cfg.engShare.reduce((a, x, i) => (cum[i] = a + x), 0);
  const pct = z => Math.max(0, Math.min(100, Math.round(phi(z) * 100)));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const z0 = rng.normal();
    const p = [0, 0, 0, 0].map(() => pct(r * z0 + e * rng.normal())); // 국, 수, 탐1, 탐2
    const ue = phi(er * z0 + ee * rng.normal());                        // 영어: 능력 높을수록 1등급 쪽
    let g = 1; while (g < 9 && 1 - ue > cum[g - 1]) g++;
    const nat = rng.u() < cfg.natShare;
    out[i] = {
      nat,
      kor: { pct: p[0], std: Math.round(E.pctToStd(p[0], 'kor')) },
      math: { pct: p[1], std: Math.round(E.pctToStd(p[1], 'math')), sel: nat ? '미적분' : '확률과통계' },
      eng: { grade: g },
      tam: [{ pct: p[2], std: Math.round(E.pctToStd(p[2], 'tam')) },
            { pct: p[3], std: Math.round(E.pctToStd(p[3], 'tam')) }],
      tamType: nat ? '과탐' : '사탐',
      avgPct: (p[0] + p[1] + (p[2] + p[3]) / 2) / 3
    };
  }
  return out;
}

/* ── 2. 학과 ─────────────────────────────────────────────── */
// 합격선 환산총점: 앱과 같은 cutOf/cutEngOf/calcScore.
// 앱은 수험생마다 대응표 보정(calibrate)을 합격선 표준점수에 더한다. 탐구는 두 과목을 평균한 뒤 보정하므로
// 과목마다 대응표와 일치하는 성적표도 보정값이 0이 아닐 수 있다(곡선이 비선형). 그래서 학생별로 다시 계산한다
// → cutTotalFor(). 표준점수 반영 학과만 해당하고, 보정 없는 값(cutTotal)은 선호 순서 등에 쓴다.
function prepareDepts(cutMode) {
  const profKeys = Object.keys(E.PROFILES);
  const pIndex = Object.fromEntries(profKeys.map((k, i) => [k, i]));
  const depts = [];
  for (const u of E.UNIVS) for (const d of u.depts) {
    if (!(d.final > 0)) continue; // 모집인원 없는 단위는 선발 불가
    const prof = E.PROFILES[d.p], c = E.cutOf(d, cutMode), ce = E.cutEngOf(d);
    const cut = E.calcScore(prof, E.normalizeVals(E.cutVals(c.v, null), prof.base),
      { engGrade: ce.grade, applyBonus: false });
    depts.push({ key: u.id + '·' + d.n, u: u.name, n: d.n, g: d.g, mg: d.mg, cap: d.final, rate: d.rate, extra: d.extra,
      cutP: c.v, cutTotal: cut.total, p: pIndex[d.p],
      gi: ['가', '나', '다'].indexOf(d.mg), std: prof.base === 'std', r: prof.ratio, engPart: cut.parts.eng,
      s0: { kor: E.pctToStd(c.v, 'kor'), math: E.pctToStd(c.v, 'math'), tam: E.pctToStd(c.v, 'tam') } });
  }
  return { depts, profKeys };
}

// 수험생 보정값 cal을 반영한 합격선 환산총점 = 앱 analyze()의 cutTotal (engine.js cutVals·normStd와 같은 식)
function cutTotalFor(dp, cal) {
  if (!dp.std) return dp.cutTotal;
  const n = a => E.clamp(Math.min(E.STD_MAX[a], dp.s0[a] + cal[a]) / E.STD_MAX[a] * 100);
  return n('kor') * dp.r[0] / 10 + n('math') * dp.r[1] / 10 + n('tam') * dp.r[3] / 10 + dp.engPart;
}

// 계열 → 지원 가능 학과. 자연계는 자연·의약, 인문계는 인문.
const eligible = (st, d) => st.nat ? (d.g === '자연' || d.g === '의약') : d.g === '인문';

function scoreStudent(st, profKeys, buf) {
  const mv = E.meVals(st);
  const opt = { engGrade: st.eng.grade, applyBonus: true, mathSel: st.math.sel, tamType: st.tamType };
  for (let i = 0; i < profKeys.length; i++) {
    const prof = E.PROFILES[profKeys[i]];
    buf[i] = E.calcScore(prof, E.normalizeVals(mv, prof.base), opt).total;
  }
  return buf;
}

/* ── 3. 지원 ─────────────────────────────────────────────── */
// 학생마다 목표 격차 3개(안정·적정·상향 + 개인 성향)를 가·나·다군에 무작위로 배정한다.
// 군 g에서 학과 d를 고를 확률 (조건부 로짓, '모형 밖 대학' 선택지 포함):
//     P(d) = K(격차) · w_d / (ω + Σ K · w),   P(모형 밖) = ω / (ω + Σ K · w)
//   K(격차) = exp(-(격차 - 목표)² / 2σ²)      — 목표 격차에 가까울수록 크다
//           = 0   (격차 < minGap)            — 합격선에 크게 미달하면 원서를 쓰지 않는다
//           = 0   (|격차 - 목표| > window)    — 목표에서 너무 먼 학과는 고려하지 않는다
//   w_d = 모집인원^popPower · exp(θ_d)        — θ_d: 2026 경쟁률로 학습하는 학과 인기도 (calibrate)
// 실제로 수험생 원서 대부분은 이 35개 대학 밖으로 간다 → ω가 그 몫을 받는다.
const GUNS = ['가', '나', '다'];

// 한 학생의 지원 후보 — 군별 [학과 번호, K, 격차] 목록과 학과별 선발 점수
function candidates(st, depts, profKeys, cfg, buf, plan, rng) {
  scoreStudent(st, profKeys, buf);
  const cal = E.calibrate(st), s2 = 2 * cfg.choiceSd * cfg.choiceSd;
  // 수험생이 체감하는 격차 = 실제 격차 + 오차 (배치표·정보 차이). 원서 선택에만 쓰고, 기록·선발은 실제 값
  const noisy = cfg.perceiveSd > 0 && rng;
  const out = [[], [], []];
  for (let d = 0; d < depts.length; d++) {
    const dp = depts[d];
    if (!eligible(st, dp)) continue;
    const x = (buf[dp.p] - cutTotalFor(dp, cal)) / 10;
    const xp = noisy ? x + cfg.perceiveSd * rng.normal() : x;
    if (xp < cfg.minGap) continue;                      // (체감상) 크게 미달 → 지원하지 않음
    const g = dp.gi, dt = xp - (plan[g] + plan[3]);
    if (Math.abs(dt) > cfg.window) continue;
    out[g].push(d, Math.exp(-dt * dt / s2), x);
  }
  return out;
}
// 목표 격차 배정: plan = [가군 목표, 나군 목표, 다군 목표, 개인 성향]
function makePlan(cfg, rng) {
  const t = cfg.targets.slice();
  for (let k = 2; k > 0; k--) { const j = Math.floor(rng.u() * (k + 1)); [t[k], t[j]] = [t[j], t[k]]; }
  t.push(cfg.riskSd * rng.normal());
  return t;
}
const weightsOf = (depts, cfg, theta) =>
  Float64Array.from(depts, (d, i) => Math.pow(d.cap, cfg.popPower) * Math.exp(theta ? theta[i] : 0));

function chooseApplications(students, depts, profKeys, cfg, rng, theta) {
  const n = students.length;
  const apps = new Int32Array(n * 3).fill(-1);      // [학생*3 + 군] = 학과 번호, -1 = 모형 밖 대학
  const appDiff = new Float32Array(n * 3);          // 지원 시점 격차 (앱이 보여주는 값)
  const appScore = new Float32Array(n * 3);         // 그 학과 기준 환산총점 (선발 순위)
  const appPlan = new Float32Array(n * 3);          // 그 원서의 목표 격차 (낮을수록 욕심낸 원서 = 더 선호)
  const w = weightsOf(depts, cfg, theta), buf = new Float64Array(profKeys.length);
  for (let i = 0; i < n; i++) {
    const plan = makePlan(cfg, rng);
    for (let g = 0; g < 3; g++) appPlan[i * 3 + g] = plan[g];
    const cand = candidates(students[i], depts, profKeys, cfg, buf, plan, rng);
    for (let g = 0; g < 3; g++) {
      const c = cand[g]; let tot = cfg.outside;
      for (let k = 0; k < c.length; k += 3) tot += c[k + 1] * w[c[k]];
      let r = rng.u() * tot - cfg.outside;
      if (r < 0) continue;                             // 모형 밖 대학 선택
      for (let k = 0; k < c.length; k += 3) {
        r -= c[k + 1] * w[c[k]];
        if (r <= 0 || k + 3 >= c.length) {
          const d = c[k]; apps[i * 3 + g] = d; appDiff[i * 3 + g] = c[k + 2]; appScore[i * 3 + g] = buf[depts[d].p];
          break;
        }
      }
    }
  }
  return { apps, appDiff, appScore, appPlan };
}

/* ── 3-1. 경쟁률 예측 + 시뮬레이션 학습 (2026학년도 경쟁률 일부 반영) ──────── */
// ① 경쟁률 예측 모델: log(2026 경쟁률) ~ 학과 특성(대학·군·계열·모집인원·합격선) + 시뮬레이션 구조 경쟁률
//    을 학습 학과에 릿지 회귀로 적합한다. 검증 학과·미공개 학과는 이 예측값만 쓴다 (자기 경쟁률을 보지 않음).
// ② 시뮬레이션 목표 지원자 수
//      학습 학과: exp(alpha·log 실제 + (1−alpha)·log 예측) × 모집인원  — 2026 경쟁률을 '일부' 반영
//      그 밖:     예측 경쟁률 × 모집인원
// ③ 표본 학생의 후보 목록을 한 번 만들어 두고(CSR) 기대 지원자 수를 해석적으로 계산하며
//    학과 인기도 θ를 θ ← θ + log(목표/기대) 로 맞춘다 (조건부 로짓의 반복 비례 맞춤).
//    → 30만 명이 각자 성적으로 고른 원서의 합이 목표 경쟁률을 재현한다.
function splitHoldout(depts, cfg, rng) {
  return depts.map(d => !(d.rate > 0) ? 'none' : (rng.u() < cfg.holdout ? 'test' : 'train'));
}

function buildMarket(students, depts, profKeys, cfg, rng) {
  const idx = [], ker = [], start = [0], buf = new Float64Array(profKeys.length);
  for (let i = 0; i < students.length; i++) {
    const cand = candidates(students[i], depts, profKeys, cfg, buf, makePlan(cfg, rng), rng);
    for (let g = 0; g < 3; g++) { const c = cand[g];
      for (let k = 0; k < c.length; k += 3) { idx.push(c[k]); ker.push(c[k + 1]); }
      start.push(idx.length); }
  }
  const I = Int32Array.from(idx), K = Float64Array.from(ker), ST = Int32Array.from(start);
  const base = weightsOf(depts, cfg, null), scale = cfg.students / students.length, D = depts.length;
  // θ → 학과별 기대 지원자 수 (전체 수험생 규모로 확대)
  const expected = theta => {
    const e = new Float64Array(D), w = Float64Array.from(base, (b, d) => b * Math.exp(theta[d]));
    for (let q = 0; q + 1 < ST.length; q++) {
      let tot = cfg.outside;
      for (let k = ST[q]; k < ST[q + 1]; k++) tot += K[k] * w[I[k]];
      for (let k = ST[q]; k < ST[q + 1]; k++) e[I[k]] += scale * K[k] * w[I[k]] / tot;
    }
    return e;
  };
  return { expected };
}

function fitTheta(market, depts, cfg, target, log) {
  const D = depts.length, theta = new Float64Array(D);
  for (let it = 0; it < cfg.calibIters; it++) {
    const e = market.expected(theta);
    let err = 0;
    for (let d = 0; d < D; d++) {
      theta[d] = e[d] > 0 ? Math.max(-8, Math.min(8, theta[d] + Math.log(target[d] / e[d]))) : 8;
      err += Math.abs(Math.log((e[d] + 1e-9) / target[d]));
    }
    if (log && (it % 10 === 0 || it === cfg.calibIters - 1)) log(`  시뮬레이션 학습 ${it + 1}/${cfg.calibIters}: 평균 |log(기대/목표)| ${(err / D).toFixed(3)}`);
  }
  return theta;
}

// 학과 특성 벡터 — 대학 원-핫, 군·계열 원-핫, log 모집인원, 합격선(1·2차), 다군×log 모집인원
function featurizer(depts) {
  const unis = [...new Set(depts.map(d => d.u))];
  const f = d => {
    const lc = Math.log(d.cap), c = (d.cutP - 88) / 8;
    const v = [1, lc, c, c * c, d.gi === 1 ? 1 : 0, d.gi === 2 ? 1 : 0, d.g === '자연' ? 1 : 0, d.g === '의약' ? 1 : 0,
      d.gi === 2 ? lc : 0];
    for (const u of unis) v.push(d.u === u ? 1 : 0);
    return v;
  };
  return f;
}
// 릿지 회귀: (XᵀX + λI)β = Xᵀy  (절편은 벌점 제외), 가우스 소거
function ridge(X, y, lambda) {
  const p = X[0].length, A = Array.from({ length: p }, () => new Float64Array(p + 1));
  for (let r = 0; r < X.length; r++) for (let i = 0; i < p; i++) {
    A[i][p] += X[r][i] * y[r];
    for (let j = 0; j < p; j++) A[i][j] += X[r][i] * X[r][j];
  }
  for (let i = 1; i < p; i++) A[i][i] += lambda;
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) if (r !== c && A[c][c] !== 0) {
      const m = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= m * A[c][k];
    }
  }
  return Array.from({ length: p }, (_, i) => A[i][c0(A, i, p)]);
  function c0(A, i, p) { A[i][p] /= A[i][i]; return p; }
}

function calibrate(students, depts, profKeys, cfg, rng, role, log) {
  const market = buildMarket(students, depts, profKeys, cfg, rng);
  const baseline = market.expected(new Float64Array(depts.length)); // θ = 0 : 2026 정보 없는 시뮬레이션 구조
  // ① 경쟁률 예측 모델
  const feat = featurizer(depts);
  const x = (d, i) => [...feat(d), Math.log(baseline[i] / d.cap + 0.05)];
  const tr = depts.map((_, i) => i).filter(i => role[i] === 'train');
  const beta = ridge(tr.map(i => x(depts[i], i)), tr.map(i => Math.log(depts[i].rate)), cfg.ridge);
  const predRate = Float64Array.from(depts, (d, i) => Math.exp(x(d, i).reduce((s, v, k) => s + v * beta[k], 0)));
  // ② 시뮬레이션 목표
  const target = Float64Array.from(depts, (d, i) => d.cap * (role[i] === 'train'
    ? Math.exp(cfg.alpha * Math.log(d.rate) + (1 - cfg.alpha) * Math.log(predRate[i])) : predRate[i]));
  // ③ 학과 인기도 θ
  const theta = fitTheta(market, depts, cfg, target, log);
  return { theta, predRate, target, baseline, predicted: market.expected(theta), beta };
}

/* ── 4. 합격·추가합격 ────────────────────────────────────── */
// 학생 제안 지연수락(Gale–Shapley). 학과 선호 = 환산총점 순.
// 학생 선호 = 원서의 목표 격차가 낮은(더 욕심낸) 순 — appPlan이 없으면 합격선이 높은 학과부터.
// 결과는 추가합격이 끝까지 돌아 더 이상 빈자리가 채워지지 않는 상태와 같다.
// outAdmit[i*3+g] = 1 이면 학생 i가 g군에 낸 '모형 밖 대학' 원서가 합격 → 그보다 덜 욕심낸 원서는 포기한다
// (포기한 원서도 지원자로 집계되고, 최종 합격선 이상이면 합격 통지를 받은 것으로 센다 → 그 자리가 추가합격으로 넘어간다).
// 반환: 학생별 등록 학과(match), 학과별 최종 합격선 점수(cutoff; 미충원이면 -Infinity).
function deferredAcceptance(n, depts, apps, appScore, opt) {
  const D = depts.length, plan = opt && opt.appPlan, out = opt && opt.outAdmit;
  const prefs = new Array(n);
  for (let i = 0; i < n; i++) {
    let limit = Infinity;   // 이보다 목표 격차가 큰(덜 욕심낸) 원서는 모형 밖 합격에 밀린다
    if (out && plan) for (let g = 0; g < 3; g++) if (out[i * 3 + g]) limit = Math.min(limit, plan[i * 3 + g]);
    const list = [];
    for (let g = 0; g < 3; g++) { const d = apps[i * 3 + g];
      if (d >= 0 && !(plan && plan[i * 3 + g] > limit)) list.push(g); }
    if (plan) list.sort((a, b) => plan[i * 3 + a] - plan[i * 3 + b]);
    else list.sort((a, b) => depts[apps[i * 3 + b]].cutP - depts[apps[i * 3 + a]].cutP);
    prefs[i] = list; // 군 번호 순서
  }
  // 학과별 최소 힙 (보유 중인 학생 중 점수 최저가 맨 위)
  const heaps = Array.from({ length: D }, () => []);
  const scoreOf = (i, g) => appScore[i * 3 + g];
  const push = (h, item) => { h.push(item); let k = h.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (h[p].s <= h[k].s) break; [h[p], h[k]] = [h[k], h[p]]; k = p; } };
  const popMin = h => { const top = h[0], last = h.pop();
    if (h.length) { h[0] = last; let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < h.length && h[l].s < h[m].s) m = l; if (r < h.length && h[r].s < h[m].s) m = r;
        if (m === k) break; [h[m], h[k]] = [h[k], h[m]]; k = m; } }
    return top; };
  const next = new Int32Array(n);
  const free = []; for (let i = n - 1; i >= 0; i--) if (prefs[i].length) free.push(i);
  while (free.length) {
    const i = free.pop();
    if (next[i] >= prefs[i].length) continue;
    const g = prefs[i][next[i]++], d = apps[i * 3 + g], s = scoreOf(i, g), h = heaps[d];
    if (h.length < depts[d].cap) { push(h, { s, i }); continue; }
    if (h.length && s > h[0].s) { const out = popMin(h); push(h, { s, i }); free.push(out.i); }
    else free.push(i);
  }
  const match = new Int32Array(n).fill(-1);
  const cutoff = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    for (const { i } of heaps[d]) match[i] = d;
    cutoff[d] = depts[d].cap <= 0 ? Infinity : heaps[d].length >= depts[d].cap ? heaps[d][0].s : -Infinity;
  }
  return { match, cutoff, held: heaps };
}

// 모형 밖 대학 원서 한 장마다 확률 q로 합격 → 그 원서보다 덜 욕심낸 원서를 포기 (deferredAcceptance)
function drawOutside(n, apps, q, rng) {
  const out = new Uint8Array(n * 3);
  for (let k = 0; k < n * 3; k++) if (apps[k] < 0 && rng.u() < q) out[k] = 1;
  return out;
}

/* ── 5. 학습 ─────────────────────────────────────────────── */
// P(y=1) = σ(a + b·x). 뉴턴법(IRLS) — 파라미터 2개라 해석적으로 2×2 역행렬.
function fitLogistic(x, y, iters = 25) {
  let a = 0, b = 1;
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (let k = 0; k < x.length; k++) {
      const p = 1 / (1 + Math.exp(-(a + b * x[k]))), w = p * (1 - p), r = y[k] - p;
      ga += r; gb += r * x[k]; haa += w; hab += w * x[k]; hbb += w * x[k] * x[k];
    }
    const det = haa * hbb - hab * hab;
    if (!(det > 0)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) break;
  }
  let ll = 0;
  for (let k = 0; k < x.length; k++) {
    const p = 1 / (1 + Math.exp(-(a + b * x[k])));
    ll += y[k] ? Math.log(Math.max(p, 1e-12)) : Math.log(Math.max(1 - p, 1e-12));
  }
  return { a, b, logLoss: -ll / x.length };
}
const sigmoid = (a, b) => x => 1 / (1 + Math.exp(-(a + b * x)));

module.exports = { CONFIG, GUNS, makeRng, phi, makePopulation, prepareDepts, cutTotalFor, eligible, scoreStudent,
  candidates, makePlan, chooseApplications, drawOutside, splitHoldout, buildMarket, fitTheta, featurizer, ridge, calibrate, deferredAcceptance, fitLogistic, sigmoid, E };
