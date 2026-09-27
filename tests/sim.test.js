/* 모의지원 시뮬레이터 검증 — 작은 집단으로 불변식만 본다 (합격선이 맞는지는 sim/mock-apply.js 가 보고한다) */
const { group, ok, eq, info, done } = require('./harness');
const M = require('../sim/model');
const E = M.E;

const OPTS = { n: 20000, seed: 7, ipfIters: 15 };
const P = M.makePopulation(OPTS);
const D = M.makeDepts(OPTS);

group('[S1] 모의 수험생');
{
  let bad = 0, nat = 0;
  for (let s = 0; s < P.n; s++) {
    if (!(P.korPct[s] >= 0 && P.korPct[s] <= 100 && P.mathPct[s] >= 0 && P.mathPct[s] <= 100)) bad++;
    if (!(P.eng[s] >= 1 && P.eng[s] <= 9)) bad++;
    if (!(P.korStd[s] > 0 && P.korStd[s] <= E.STD_MAX.kor && P.tamStd[s] <= E.STD_MAX.tam)) bad++;
    if (P.calc[s] !== P.nat[s] || (P.sci[s] && !P.nat[s])) bad++;
    nat += P.nat[s];
  }
  eq('백분위·표준점수·영어 등급이 범위 안', bad, 0);
  ok('자연계열 비율 ≈ natShare', Math.abs(nat / P.n - M.DEFAULTS.natShare) < 0.02, (nat / P.n * 100).toFixed(1) + '%');
  const mid = Array.from(P.korPct).sort((a, b) => a - b)[P.n >> 1];
  ok('백분위는 집단 안 순위 (중앙값 ≈ 50)', Math.abs(mid - 50) <= 1, '중앙값 ' + mid);
}

group('[S2] 빠른 환산점수 = engine calcScore');
{
  const rnd = M.mulberry32(3);
  let maxDiff = 0;
  const profs = Object.keys(E.PROFILES);
  for (let k = 0; k < 3000; k++) {
    const s = Math.floor(rnd() * P.n), prof = E.PROFILES[profs[k % profs.length]];
    const me = E.completeScores(M.studentOf(P, s));
    const ref = E.calcScore(prof, E.normalizeVals(E.meVals(me), prof.base),
      { engGrade: me.eng.grade, applyBonus: true, mathSel: me.math.sel, tamType: me.tamType }).total;
    maxDiff = Math.max(maxDiff, Math.abs(ref - M.scoreOf(P, s, prof)));
  }
  eq('3,000쌍 최대 차이', maxDiff, 0, 1e-9);
}

group('[S3] 모집단위');
{
  eq('UNIVS 모집단위 수와 같다', D.length, E.UNIVS.reduce((a, u) => a + u.depts.length, 0));
  ok('목표 지원자 = 모집 × 배수', D.every(d => Math.abs(d.target - d.cap * d.mult) < 1e-9));
  ok('배수가 모두 양수', D.every(d => d.mult > 0));
  const flat = M.makeDepts({ multiple: 4 });
  ok('--multiple 은 모든 학과에 같은 배수', flat.every(d => d.mult === 4 && d.rateSrc === 'flat'));
  // 합격선 환산총점은 앱과 같다 (보정값이 0인 수험생 기준)
  const me = { kor: { std: 0, pct: 90 }, math: { std: 0, pct: 90, sel: '확률과통계' }, eng: { grade: 1 },
    tam: [{ std: 0, pct: 90 }, { std: 0, pct: 90 }], tamType: '사탐' };
  const res = E.analyze(me, E.DEF_TH, null, 'latest');
  let md = 0;
  for (const r of res) md = Math.max(md, Math.abs(r.cutTotal - D.find(d => d.key === r.key).cutTotal));
  eq('합격선 환산총점 = analyze().cutTotal', md, 0, 1e-9);
}

const C = M.buildCandidates(P, D, OPTS);
const fit = M.fitAttraction(P, D, C, OPTS);
const choice = M.sampleChoices(P, D, C, fit.alpha, M.mulberry32(11));
const A = M.admit(P, D, C, choice, OPTS, M.mulberry32(12));

group('[S4] 지원');
{
  let wrongGroup = 0;
  for (let i = 0; i < choice.length; i++) if (choice[i] >= 0 && D[choice[i]].gi !== i % 3) wrongGroup++;
  eq('원서는 군마다 1장, 그 군의 학과에만', wrongGroup, 0);
  let outWin = 0;
  const inWin = new Set();
  for (const d of D) for (let k = C.start[d.i]; k < C.start[d.i + 1]; k++) inWin.add(C.stu[k] * 3 + d.gi + '_' + d.i);
  for (let i = 0; i < choice.length; i++) if (choice[i] >= 0 && !inWin.has(i + '_' + choice[i])) outWin++;
  eq('지원한 학과는 모두 격차 ±window 안', outWin, 0);
  ok('α 는 유한한 양수', Array.from(fit.alpha).every((a, i) => D[i].target > 0 ? a > 0 && Number.isFinite(a) : a === 0));
}

group('[S5] 합격·추가합격·등록');
{
  let over = 0, notApplied = 0, unstable = 0;
  const regCount = new Int32Array(P.n);
  for (const d of D) {
    if (A.holding[d.i] > d.cap) over++;
    let regs = 0;
    for (let k = A.start[d.i]; k < A.start[d.i + 1]; k++) {
      const i = A.list[k], s = (i / 3) | 0, pos = k - A.start[d.i];
      if (choice[i] !== d.i) notApplied++;
      if (A.held[s] === d.gi) { regs++; regCount[s]++; }
      // 합격을 못 받은 지원자가 있다면 그 학과는 꽉 찼어야 한다
      if (pos >= A.ptr[d.i] && A.holding[d.i] < d.cap) unstable++;
    }
    if (regs !== A.holding[d.i]) over++;
  }
  eq('등록자 ≤ 모집인원, 등록자 수 = holding', over, 0);
  eq('학과 명단은 그 학과 지원자만', notApplied, 0);
  eq('합격 못 받은 지원자가 있으면 학과는 꽉 참 (빈자리 방치 없음)', unstable, 0);
  ok('수험생은 많아야 한 곳에 등록', Array.from(regCount).every(c => c <= 1));
  let unsorted = 0;
  for (const d of D) for (let k = A.start[d.i] + 1; k < A.start[d.i + 1]; k++)
    if (A.score[A.list[k]] > A.score[A.list[k - 1]]) unsorted++;
  eq('학과 명단은 환산점수 내림차순', unsorted, 0);
}

group('[S5b] 목록 밖 합격이 없으면 합격을 버리는 이유는 더 나은 합격뿐');
{
  const A0 = M.admit(P, D, C, choice, Object.assign({}, OPTS, { outside: 0 }), M.mulberry32(12));
  let noReason = 0, offered = 0;
  for (const d of D) for (let k = A0.start[d.i]; k < A0.start[d.i] + A0.ptr[d.i]; k++) {
    const s = (A0.list[k] / 3) | 0;
    offered++;
    if (A0.held[s] < 0) noReason++;
  }
  eq('합격을 받은 수험생은 모두 어딘가에 등록', noReason, 0);
  info(`합격 통보 ${offered.toLocaleString()}건`);
}

group('[S6] 재현성');
{
  const a = M.admit(P, D, C, M.sampleChoices(P, D, C, fit.alpha, M.mulberry32(11)), OPTS, M.mulberry32(12));
  ok('같은 seed → 같은 결과', a.held.every((v, i) => v === A.held[i]) && a.ptr.every((v, i) => v === A.ptr[i]));
  const R = M.summarizeRun(P, D, A);
  const withCut = R.filter(r => r.cut70 != null);
  ok('70% 컷은 등록자가 있는 학과에서만, 0~100', withCut.every(r => r.regs > 0 && r.cut70 >= 0 && r.cut70 <= 100));
  info(`n=${P.n.toLocaleString()} 지원 후보 ${C.len.toLocaleString()}쌍, 등록 ${R.reduce((x, r) => x + r.regs, 0).toLocaleString()}명`);
}

done();
