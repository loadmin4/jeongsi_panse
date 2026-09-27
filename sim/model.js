/* ─────────────────────────────────────────────────────────────
   정시 모의지원 시뮬레이터 — 모델
   모의 수험생 집단을 만들고, 학과마다 「모집인원 × 경쟁률」만큼 지원하게 한 뒤
   대학별 환산점수 순으로 합격·추가합격을 돌려 최종 등록자의 70% 컷을 구한다.

   환산점수와 합격선 환산총점은 src/engine.js 를 그대로 쓴다(tests/_load.js 로 불러온다).
   속도 때문에 수험생 점수만 scoreOf() 로 따로 계산하는데, tests/sim.test.js 가
   engine 의 calcScore 와 같은 값인지 검사한다.
   노드 전용 — 페이지(dist/)에는 실리지 않는다.
   ───────────────────────────────────────────────────────────── */
const E = require('../tests/_load.js');

const DEFAULTS = {
  n: 300000,        // 모의 수험생 수
  active: 1,        // 정시에 원서를 쓰는 비율 (나머지는 수시 합격 등으로 빠진다)
  seed: 1,
  runs: 20,         // 지원·합격 과정을 다른 난수로 반복하는 횟수 (컷의 흔들림 구간)
  natShare: 0.45,   // 자연계열(미적분·기하 선택) 비율
  natShift: 0.2,    // 자연계열 평균 학력 이동 (표준편차 단위)
  load: 0.85,       // 영역 점수가 공통 학력을 따르는 정도 → 영역 간 상관 ≈ load²
  sciShare: 0.6,    // 자연계열 중 탐구 2과목이 모두 과탐인 비율
  geoShare: 0.1,    // 자연계열 중 기하 선택 비율
  multiple: null,   // null: 학과별 실제 경쟁률 / 숫자: 모든 학과에 같은 배수
  window: 6,        // 지원 후보로 보는 격차 범위 ±%p (앱의 「관심권」과 같은 폭)
  mu: 0,            // 지원 격차 분포의 중심 (합격선 대비 %p)
  muGroup: { 다: 2 },// 군별 중심 — 다군은 안정 지원(합격선보다 위)이 많다
  sigma: 2,         // 지원 격차 분포의 폭 (%p)
  crossToH: 0.3,    // 자연계열 수험생이 인문 모집단위를 고를 가중치 (교차지원)
  crossToN: 0,      // 인문계열 수험생이 자연·의약 모집단위를 고를 가중치
  taste: 1.5,       // 여러 곳에 붙었을 때 등록 선택에 섞이는 개인 선호 (백분위 점)
  outside: 0.7,     // 목록 밖 대학에 쓴 원서가 합격으로 이어질 확률 (군마다)
  outShift: 0,      // 그 합격의 선호 = min(내 평균백분위, outCap) + outShift (+ 개인 선호 잡음)
  outCap: Infinity, // 목록 밖 대학 수준의 상한 (최상위 대학은 대부분 목록 안에 있다)
  cutMode: 'latest',// 수험생이 참고하는 합격선: 'latest' | 'avg' (engine cutOf)
  ipfIters: 200,
  ipfTol: 0.005,
};
const GROUPS = ['가', '나', '다'];

/* ── 난수 ─────────────────────────────────────────────── */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/* ── 모의 수험생 ──────────────────────────────────────────
   공통 학력 z 에 영역별 잡음을 섞어 잠재 점수를 만들고,
   집단 안의 순위로 백분위를 매긴다(백분위의 정의 그대로).
   표준점수는 engine 의 대응 곡선(pctToStd), 영어 등급은 pctToGrade. */
function percentileRanks(x) {
  const n = x.length, idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => x[a] - x[b]);
  const pc = new Float64Array(n);
  for (let r = 0; r < n; r++) pc[idx[r]] = 100 * (r + 0.5) / n;
  return pc;
}

function makePopulation(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const n = o.n, rnd = mulberry32(o.seed), e = Math.sqrt(1 - o.load * o.load);
  const nat = new Uint8Array(n), calc = new Uint8Array(n), sci = new Uint8Array(n), active = new Uint8Array(n);
  const lat = { kor: new Float64Array(n), math: new Float64Array(n), eng: new Float64Array(n),
    t1: new Float64Array(n), t2: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    nat[i] = rnd() < o.natShare ? 1 : 0;
    const z = gauss(rnd) + (nat[i] ? o.natShift : 0);
    for (const k in lat) lat[k][i] = o.load * z + e * gauss(rnd);
    calc[i] = nat[i];                                   // 미적분·기하 = 수학 가산 대상
    sci[i] = nat[i] && rnd() < o.sciShare ? 1 : 0;      // 과탐 2과목 = 탐구 가산 대상
    active[i] = rnd() < o.active ? 1 : 0;
  }
  const mathSel = new Array(n);
  for (let i = 0; i < n; i++) mathSel[i] = nat[i] ? (rnd() < o.geoShare ? '기하' : '미적분') : '확률과통계';

  const P = { n, nat, calc, sci, active, mathSel,
    korPct: new Float64Array(n), korStd: new Float64Array(n),
    mathPct: new Float64Array(n), mathStd: new Float64Array(n),
    tamPct: new Float64Array(n), tamStd: new Float64Array(n),
    t1Pct: new Float64Array(n), t1Std: new Float64Array(n),
    t2Pct: new Float64Array(n), t2Std: new Float64Array(n),
    eng: new Uint8Array(n), avg: new Float64Array(n) };
  const pc = {};
  for (const k in lat) pc[k] = percentileRanks(lat[k]);
  const std = (p, a) => Math.round(E.pctToStd(p, a));
  // 백분위는 1 이상으로 둔다 — engine 은 0 을 「미입력」으로 보고 탐구 평균에서 뺀다 [E12]
  const pct = p => Math.max(1, Math.round(p));
  for (let i = 0; i < n; i++) {
    P.korPct[i] = pct(pc.kor[i]);   P.korStd[i] = std(pc.kor[i], 'kor');
    P.mathPct[i] = pct(pc.math[i]); P.mathStd[i] = std(pc.math[i], 'math');
    P.t1Pct[i] = pct(pc.t1[i]);     P.t1Std[i] = std(pc.t1[i], 'tam');
    P.t2Pct[i] = pct(pc.t2[i]);     P.t2Std[i] = std(pc.t2[i], 'tam');
    P.tamPct[i] = (P.t1Pct[i] + P.t2Pct[i]) / 2;
    P.tamStd[i] = (P.t1Std[i] + P.t2Std[i]) / 2;
    P.eng[i] = E.pctToGrade(pc.eng[i]);
    P.avg[i] = (P.korPct[i] + P.mathPct[i] + P.tamPct[i]) / 3;   // 「어디가」 국·수·탐 평균백분위
  }
  return P;
}

// engine 이 받는 성적 객체 — 테스트와 개별 확인용
function studentOf(P, s) {
  return {
    kor: { std: P.korStd[s], pct: P.korPct[s] },
    math: { std: P.mathStd[s], pct: P.mathPct[s], sel: P.mathSel[s] },
    eng: { grade: P.eng[s] },
    tam: [{ std: P.t1Std[s], pct: P.t1Pct[s] }, { std: P.t2Std[s], pct: P.t2Pct[s] }],
    tamType: P.sci[s] ? '과탐' : '사탐',
  };
}

/* ── 환산점수 (engine calcScore 와 같은 식, 가산 적용) ─── */
function scoreOf(P, s, prof) {
  const r = prof.ratio;
  let k, m, t;
  if (prof.base === 'pct') { k = P.korPct[s]; m = P.mathPct[s]; t = P.tamPct[s]; }
  else { k = E.normStd(P.korStd[s], 'kor'); m = E.normStd(P.mathStd[s], 'math'); t = E.normStd(P.tamStd[s], 'tam'); }
  if (prof.mbonus && P.calc[s]) m = E.clamp(m * (1 + prof.mbonus / 100));
  if (prof.sbonus && P.sci[s]) t = E.clamp(t * (1 + prof.sbonus / 100));
  const g = P.eng[s];
  const eng = prof.engMode === 'ratio' ? prof.engT[g - 1] * r[2] / 10 : prof.engT[g - 1];
  return k * r[0] / 10 + m * r[1] / 10 + t * r[3] / 10 + eng;
}

/* ── 모집단위 ─────────────────────────────────────────────
   목표 지원자 수 = 최종 모집인원 × 배수.
   배수는 「어디가」 최신 경쟁률, 없으면 같은 대학 중앙값, 그것도 없으면 전체 중앙값. */
const median = xs => { if (!xs.length) return null; const v = xs.slice().sort((a, b) => a - b); return v[v.length >> 1]; };

function makeDepts(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const all = [];
  for (const u of E.UNIVS) for (const d of u.depts) if (d.rate != null) all.push(d.rate);
  const gMed = median(all), out = [];
  for (const u of E.UNIVS) {
    const uMed = median(u.depts.filter(d => d.rate != null).map(d => d.rate));
    for (const d of u.depts) {
      const prof = E.PROFILES[d.p], c = E.cutOf(d, o.cutMode), ce = E.cutEngOf(d);
      const cutTotal = E.calcScore(prof, E.normalizeVals(E.cutVals(c.v, null), prof.base),
        { engGrade: ce.grade, applyBonus: false }).total;
      let mult, rateSrc;
      if (o.multiple != null) { mult = o.multiple; rateSrc = 'flat'; }
      else if (d.rate != null) { mult = d.rate; rateSrc = 'adiga'; }
      else if (uMed != null) { mult = uMed; rateSrc = 'univ-median'; }
      else { mult = gMed; rateSrc = 'global-median'; }
      const cap = d.final || 0;
      out.push({ i: out.length, key: u.id + '·' + d.n, uid: u.id, u: u.name, region: u.region, n: d.n,
        g: d.g, mg: d.mg, gi: GROUPS.indexOf(d.mg), p: d.p, prof, cut: c.v, cutConf: c.conf,
        cutTotal, cap, mult, rateSrc, target: cap * mult });
    }
  }
  return out;
}

/* ── 검증용 실제 추가합격 인원 ────────────────────────────
   src/univs.js 에는 없어서 「어디가」 원자료에서 직접 읽는다.
   import-adiga.js 와 같은 규칙: 일반전형, 모집단위명 일치, 같은 해 여러 행이면 모집인원이 큰 쪽. */
function actualExtra(D) {
  const fs = require('fs'), path = require('path');
  const { isGeneral } = require('../scripts/import-adiga');
  const code = {}, cy = {}, cache = {};
  for (const u of E.UNIVS) { code[u.id] = u.adiga; for (const d of u.depts) cy[u.id + '·' + d.n] = d.cy; }
  return D.map(d => {
    const f = path.join(__dirname, '..', 'data/adiga/raw', `${code[d.uid]}_${cy[d.key]}.json`);
    if (!(f in cache)) cache[f] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).rows : [];
    const rows = cache[f].filter(r => isGeneral(r.track) && r.unit.replace(/\s+/g, ' ').trim() === d.n);
    if (!rows.length) return null;
    const r = rows.reduce((a, b) => ((b.final || 0) > (a.final || 0) ? b : a));
    return r.extra == null ? null : r.extra;
  });
}

/* ── 지원 후보 ────────────────────────────────────────────
   학과마다 격차 |diff| ≤ window 인 수험생을 후보로 모은다(학과 순서로 저장).
   점수는 반영비율 프로필에만 달려 있으므로 프로필별로 한 번만 계산한다. */
function trackWeight(dept, nat, o) {
  if (dept.g === '인문') return nat ? o.crossToH : 1;
  return nat ? 1 : o.crossToN;
}

function buildCandidates(P, D, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const n = P.n, byProf = {};
  for (const d of D) if (!byProf[d.p]) {
    const sc = new Float64Array(n);
    for (let s = 0; s < n; s++) sc[s] = scoreOf(P, s, d.prof);
    byProf[d.p] = sc;
  }
  let cap = 1 << 22, stu = new Int32Array(cap), w = new Float32Array(cap), len = 0;
  const start = new Int32Array(D.length + 1), twoS2 = 2 * o.sigma * o.sigma;
  for (const d of D) {
    start[d.i] = len;
    if (d.target > 0) {
      const sc = byProf[d.p];
      const mu = o.muGroup && o.muGroup[d.mg] != null ? o.muGroup[d.mg] : o.mu;
      const tw = [trackWeight(d, 0, o), trackWeight(d, 1, o)];
      for (let s = 0; s < n; s++) {
        const t = P.active[s] ? tw[P.nat[s]] : 0;
        if (!t) continue;
        const df = (sc[s] - d.cutTotal) / 10;
        if (df < -o.window || df > o.window) continue;
        if (len === cap) {
          cap *= 2;
          const s2 = new Int32Array(cap); s2.set(stu); stu = s2;
          const w2 = new Float32Array(cap); w2.set(w); w = w2;
        }
        stu[len] = s;
        w[len] = t * Math.exp(-(df - mu) * (df - mu) / twoS2);
        len++;
      }
    }
  }
  start[D.length] = len;
  return { stu: stu.subarray(0, len), w: w.subarray(0, len), start, len, byProf };
}

/* ── 학과 인기도 맞추기 (IPF) ─────────────────────────────
   수험생 s 가 군 g 에서 학과 d 를 고를 확률 = α_d·w_sd / (1 + Σ_{d'∈g} α_d'·w_sd').
   분모의 1은 「이 목록 밖 대학에 쓰는 원서」. 기대 지원자 수가 목표(모집×배수)에
   맞도록 α 를 반복 보정한다. */
function denominators(C, D, alpha, n) {
  const den = new Float64Array(n * 3).fill(1);
  for (const d of D) {
    const a = alpha[d.i];
    if (!a) continue;
    for (let k = C.start[d.i]; k < C.start[d.i + 1]; k++) den[C.stu[k] * 3 + d.gi] += a * C.w[k];
  }
  return den;
}

function fitAttraction(P, D, C, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const alpha = new Float64Array(D.length);
  for (const d of D) alpha[d.i] = d.target > 0 ? 1 : 0;
  const expd = new Float64Array(D.length);
  let it = 0, maxErr = Infinity;
  for (; it < o.ipfIters; it++) {
    const den = denominators(C, D, alpha, P.n);
    expd.fill(0);
    for (const d of D) {
      const a = alpha[d.i];
      if (!a) continue;
      let e = 0;
      for (let k = C.start[d.i]; k < C.start[d.i + 1]; k++) e += a * C.w[k] / den[C.stu[k] * 3 + d.gi];
      expd[d.i] = e;
    }
    maxErr = 0;
    for (const d of D) {
      if (!(d.target > 0) || !(expd[d.i] > 0)) continue;
      const r = d.target / expd[d.i];
      if (alpha[d.i] < 1e8) maxErr = Math.max(maxErr, Math.abs(r - 1));
      alpha[d.i] = Math.min(1e8, alpha[d.i] * r);
    }
    if (maxErr < o.ipfTol) break;
  }
  return { alpha, expected: expd, iters: it, maxErr };
}

/* ── 지원 (군마다 1장) ─────────────────────────────────── */
function sampleChoices(P, D, C, alpha, rnd) {
  const den = denominators(C, D, alpha, P.n);
  const n3 = P.n * 3, u = new Float64Array(n3), cum = new Float64Array(n3);
  const choice = new Int32Array(n3).fill(-1);
  for (let i = 0; i < n3; i++) u[i] = rnd() * den[i];
  for (const d of D) {
    const a = alpha[d.i];
    if (!a) continue;
    for (let k = C.start[d.i]; k < C.start[d.i + 1]; k++) {
      const i = C.stu[k] * 3 + d.gi;
      if (choice[i] >= 0) continue;
      cum[i] += a * C.w[k];
      if (cum[i] > u[i]) choice[i] = d.i;
    }
  }
  return choice;   // choice[s*3+g] = 학과 번호, -1 = 목록 밖 대학(또는 지원 안 함)
}

/* ── 합격·추가합격·등록 ───────────────────────────────────
   학과는 자기 환산점수 순으로 모집인원만큼 합격을 준다.
   수험생은 받은 합격 중 가장 원하는 곳 하나만 붙잡고 나머지를 포기하고,
   포기한 자리는 다음 순위에게 추가합격으로 간다. 더 바뀌는 것이 없을 때까지 반복.
   (선호 = 그 학과 합격선 + 개인 선호 잡음)
   목록 밖 대학에 쓴 원서(choice = -1)는 확률 outside 로 합격하고, 그 선호는
   「min(내 평균백분위, outCap) + outShift」다. 그보다 못한 학과의 합격은 받지 않는다 → 추가합격이 생긴다. */
function admit(P, D, C, choice, opts, rnd) {
  const o = Object.assign({}, DEFAULTS, opts);
  const n = P.n, nd = D.length, n3 = n * 3;
  const cnt = new Int32Array(nd);
  for (let i = 0; i < n3; i++) if (choice[i] >= 0) cnt[choice[i]]++;
  const start = new Int32Array(nd + 1);
  for (let d = 0; d < nd; d++) start[d + 1] = start[d] + cnt[d];
  const list = new Int32Array(start[nd]), fill = start.slice(0, nd);
  const score = new Float64Array(n3), pref = new Float64Array(n3), tie = new Float64Array(n3);
  for (let i = 0; i < n3; i++) {
    const d = choice[i];
    if (d < 0) continue;
    const s = (i / 3) | 0;
    score[i] = C.byProf[D[d].p][s];
    pref[i] = D[d].cut + o.taste * gauss(rnd);
    tie[i] = rnd();
    list[fill[d]++] = i;
  }
  for (let d = 0; d < nd; d++) {
    const seg = Array.from(list.subarray(start[d], start[d + 1]));
    seg.sort((a, b) => (score[b] - score[a]) || (tie[a] - tie[b]));
    list.set(seg, start[d]);
  }

  const outBest = new Float64Array(n).fill(-Infinity);  // 목록 밖 대학 합격 중 가장 원하는 곳의 선호
  if (o.outside > 0) for (let s = 0; s < n; s++) {
    const b = s * 3;
    if (choice[b] < 0 && choice[b + 1] < 0 && choice[b + 2] < 0) continue;   // 목록 안에 원서가 없으면 상관없다
    for (let g = 0; g < 3; g++) if (choice[b + g] < 0 && rnd() < o.outside)
      outBest[s] = Math.max(outBest[s], Math.min(P.avg[s], o.outCap) + o.outShift + o.taste * gauss(rnd));
  }

  const held = new Int8Array(n).fill(-1);        // 붙잡은 합격의 군 (-1 = 없음)
  const holding = new Int32Array(nd), ptr = new Int32Array(nd);
  const queued = new Uint8Array(nd), queue = [];
  for (let d = 0; d < nd; d++) if (cnt[d]) { queue.push(d); queued[d] = 1; }
  while (queue.length) {
    const d = queue.pop();
    queued[d] = 0;
    const cap = D[d].cap, g = D[d].gi;
    while (holding[d] < cap && ptr[d] < cnt[d]) {
      const i = list[start[d] + ptr[d]++], s = (i / 3) | 0, cur = held[s];
      if (pref[i] <= outBest[s]) continue;                   // 목록 밖 대학 합격이 더 낫다 → 포기
      if (cur < 0) { held[s] = g; holding[d]++; continue; }
      if (pref[i] <= pref[s * 3 + cur]) continue;          // 더 원하는 곳을 이미 붙잡고 있음 → 포기
      const old = choice[s * 3 + cur];
      holding[old]--;
      if (!queued[old]) { queued[old] = 1; queue.push(old); }
      held[s] = g; holding[d]++;
    }
  }
  return { list, start, cnt, ptr, holding, held, score };
}

/* ── 학과별 결과 ──────────────────────────────────────── */
function summarizeRun(P, D, A) {
  const out = [];
  for (const d of D) {
    const regs = [];
    for (let k = A.start[d.i]; k < A.start[d.i + 1]; k++) {
      const i = A.list[k], s = (i / 3) | 0;
      if (A.held[s] === d.gi) regs.push(i);
    }
    const m = regs.length, offers = A.ptr[d.i];
    const nth = f => regs[Math.max(0, Math.ceil(m * f) - 1)];
    const at = f => m ? P.avg[(nth(f) / 3) | 0] : null;
    // 마지막으로 합격을 받은 지원자의 환산점수 = 추가합격까지 포함한 최종 합격선.
    // 자리가 남았으면(지원자 소진) 누구든 붙으므로 -Infinity.
    const last = m < d.cap || !offers ? -Infinity : A.score[A.list[A.start[d.i] + offers - 1]];
    out.push({ applicants: A.cnt[d.i], offers, regs: m,
      extra: Math.max(0, offers - Math.min(d.cap, A.cnt[d.i])),
      cut70: at(0.7), cut50: at(0.5), score70: m ? A.score[nth(0.7)] : null, lastScore: last });
  }
  return out;
}

function quantile(xs, q) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

const pctp = (score, cutTotal) => score == null ? null : (score - cutTotal) / 10;

/* ── 전체 실행 ────────────────────────────────────────── */
function simulate(opts, log) {
  const o = Object.assign({}, DEFAULTS, opts);
  log = log || (() => {});
  const t0 = Date.now(), lap = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const P = makePopulation(o);
  log(`모의 수험생 ${P.n.toLocaleString()}명 생성 (${lap()})`);
  const D = makeDepts(o);
  const C = buildCandidates(P, D, o);
  log(`지원 후보 ${C.len.toLocaleString()}쌍 (${lap()})`);
  const fit = fitAttraction(P, D, C, o);
  log(`학과 인기도 보정 ${fit.iters}회, 최대 오차 ${(fit.maxErr * 100).toFixed(2)}% (${lap()})`);
  const runs = [];
  let participants = null;
  for (let r = 0; r < o.runs; r++) {
    const rnd = mulberry32(o.seed * 7919 + r + 1);
    const choice = sampleChoices(P, D, C, fit.alpha, rnd);
    const A = admit(P, D, C, choice, o, rnd);
    runs.push(summarizeRun(P, D, A));
    if (r === 0) {
      const cards = new Uint8Array(P.n);
      for (let i = 0; i < P.n * 3; i++) if (choice[i] >= 0) cards[(i / 3) | 0]++;
      participants = [0, 0, 0, 0];
      for (let s = 0; s < P.n; s++) participants[cards[s]]++;
    }
    if ((r + 1) % 5 === 0 || r + 1 === o.runs) log(`모의지원 ${r + 1}/${o.runs} 완료 (${lap()})`);
  }
  const depts = D.map(d => {
    const rs = runs.map(R => R[d.i]);
    const pick = f => rs.map(f);
    return {
      key: d.key, u: d.u, uid: d.uid, n: d.n, g: d.g, mg: d.mg, cap: d.cap, mult: d.mult, rateSrc: d.rateSrc,
      cut: d.cut, cutConf: d.cutConf, cutTotal: d.cutTotal, target: d.target, expected: fit.expected[d.i], alpha: fit.alpha[d.i],
      applicants: quantile(pick(x => x.applicants), 0.5),
      regs: quantile(pick(x => x.regs), 0.5),
      extra: quantile(pick(x => x.extra), 0.5),
      sim70: quantile(pick(x => x.cut70), 0.5),
      sim70lo: quantile(pick(x => x.cut70), 0.1),
      sim70hi: quantile(pick(x => x.cut70), 0.9),
      sim50: quantile(pick(x => x.cut50), 0.5),
      // 앱 단위(환산점수 %p)로 본 합격선 이동 = (모의 70% 등록자 환산점수 − 앱의 합격선 환산총점) ÷ 10
      shift: pctp(quantile(pick(x => x.score70), 0.5), d.cutTotal),
      shiftLo: pctp(quantile(pick(x => x.score70), 0.1), d.cutTotal),
      shiftHi: pctp(quantile(pick(x => x.score70), 0.9), d.cutTotal),
      lastScores: pick(x => x.lastScore),
    };
  });
  return { opts: o, P, D, C, fit, runs, depts, participants, seconds: (Date.now() - t0) / 1000 };
}

/* ── 한 수험생의 모의지원 합격확률 ────────────────────────
   추가합격까지 끝난 뒤의 최종 합격선(마지막 합격자의 환산점수)을
   내 환산점수가 넘은 모의지원 회차의 비율. */
function myChances(sim, me) {
  const res = E.analyze(me, E.DEF_TH, null, sim.opts.cutMode);
  const byKey = {};
  for (const r of res) byKey[r.key] = r;
  return sim.depts.map(d => {
    const r = byKey[d.key];
    const hits = d.lastScores.filter(x => r.score >= x).length;
    return { key: d.key, u: d.u, n: d.n, g: d.g, mg: d.mg, diff: r.diff, tier: r.tier, pLogit: r.p,
      pSim: Math.round(100 * hits / d.lastScores.length) };
  });
}

module.exports = { DEFAULTS, GROUPS, mulberry32, gauss, makePopulation, studentOf, scoreOf, makeDepts,
  actualExtra, buildCandidates, fitAttraction, sampleChoices, admit, summarizeRun, quantile, simulate, myChances, E };
