/* 모의 지원 시뮬레이터(sim/) 검증 — 매칭·학습·표본 생성이 의도대로 도는지, 앱 엔진과 같은 격차를 쓰는지 */
const M = require('../sim/model');
const { group, ok, info, done } = require('./harness');

group('[S1] 합격·추가합격 매칭 (지연수락) 안정성');
{
  // 작은 무작위 시장: 학생 400명, 학과 12개(정원 1~15), 학생마다 최대 3곳 지원
  const rng = M.makeRng(7), n = 400, D = 12;
  const depts = Array.from({ length: D }, (_, d) => ({ cap: 1 + Math.floor(rng.u() * 15), cutP: 80 + d }));
  const apps = new Int32Array(n * 3).fill(-1), sc = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let g = 0; g < 3; g++) if (rng.u() < 0.8) {
    apps[i * 3 + g] = Math.floor(rng.u() * D); sc[i * 3 + g] = rng.u() * 1000;
  }
  const { match, cutoff, held } = M.deferredAcceptance(n, depts, apps, sc);
  ok('정원 초과 없음', held.every((h, d) => h.length <= depts[d].cap));
  // 불안정 쌍: 학생 i가 등록 학과보다 선호(합격선 높은)하는 학과 d에 지원했고,
  // d에 빈자리가 있거나 d가 i보다 낮은 점수를 붙잡고 있으면 안정적이지 않다.
  let blocking = 0;
  for (let i = 0; i < n; i++) for (let g = 0; g < 3; g++) {
    const d = apps[i * 3 + g]; if (d < 0 || match[i] === d) continue;
    const better = match[i] < 0 || depts[d].cutP > depts[match[i]].cutP;
    const room = held[d].length < depts[d].cap || sc[i * 3 + g] > cutoff[d];
    if (better && room) blocking++;
  }
  ok('불안정 쌍 없음 (추가합격이 끝까지 돈 상태)', blocking === 0, `${blocking}쌍`);
  ok('미충원 학과의 합격선은 -∞ (지원자 전원 합격)',
    held.every((h, d) => h.length === depts[d].cap || cutoff[d] === -Infinity));
}

group('[S2] 로지스틱 학습');
{
  const rng = M.makeRng(11), x = [], y = [];
  for (let k = 0; k < 40000; k++) {
    const v = rng.normal() * 3; x.push(v);
    y.push(rng.u() < 1 / (1 + Math.exp(-(-1 + 2 * v))) ? 1 : 0);
  }
  const f = M.fitLogistic(x, y);
  ok('알려진 곡선 σ(-1 + 2x)를 복원', Math.abs(f.a + 1) < 0.1 && Math.abs(f.b - 2) < 0.1,
    `a=${f.a.toFixed(3)} b=${f.b.toFixed(3)}`);
}

group('[S3] 가상 수험생 표본');
{
  const cfg = Object.assign({}, M.CONFIG, { students: 30000 });
  const pop = M.makePopulation(cfg, M.makeRng(cfg.seed));
  const kor = pop.map(s => s.kor.pct);
  const top10 = kor.filter(p => p >= 90).length / kor.length;
  ok('백분위는 균등분포 (상위 10% ≈ 10%)', Math.abs(top10 - 0.105) < 0.015, `${(top10 * 100).toFixed(1)}%`);
  const share = cfg.engShare.map((_, g) => pop.filter(s => s.eng.grade === g + 1).length / pop.length);
  ok('영어 등급 비율이 가정과 일치 (±1%p)', share.every((v, g) => Math.abs(v - cfg.engShare[g]) < 0.01),
    share.map(v => (v * 100).toFixed(1)).join('/'));
  const again = M.makePopulation(cfg, M.makeRng(cfg.seed));
  ok('같은 시드면 같은 표본 (재현 가능)', JSON.stringify(pop.slice(0, 50)) === JSON.stringify(again.slice(0, 50)));
}

group('[S4] 앱 엔진과 같은 격차');
{
  // 시뮬레이터가 계산한 격차 = 앱 analyze()의 격차 (같은 학생·같은 학과)
  const cfg = Object.assign({}, M.CONFIG, { students: 200 });
  const rng = M.makeRng(3), pop = M.makePopulation(cfg, rng);
  const { depts, profKeys } = M.prepareDepts('latest');
  const { apps, appDiff } = M.chooseApplications(pop, depts, profKeys, cfg, rng);
  let worst = 0, n = 0;
  for (let i = 0; i < pop.length; i++) {
    const r = M.E.analyze(pop[i], M.E.DEF_TH);
    for (let g = 0; g < 3; g++) {
      const d = apps[i * 3 + g]; if (d < 0) continue;
      const x = r.find(row => row.key === depts[d].key);
      worst = Math.max(worst, Math.abs(x.diff - appDiff[i * 3 + g])); n++;
    }
  }
  // 수험생별 대응표 보정까지 같은 식으로 계산하므로 사실상 일치해야 한다
  ok('지원 시점 격차 = 앱 격차 (0.001%p 이내)', n > 50 && worst < 1e-3, `${n}건 최대 ${worst.toFixed(4)}%p`);
  info(`학과 ${depts.length}개 (모집인원 없는 단위 제외)`);
}


group('[S5] 크게 미달하는 학과에는 지원하지 않음');
{
  const cfg = Object.assign({}, M.CONFIG, { students: 3000 });
  const rng = M.makeRng(5), pop = M.makePopulation(cfg, rng);
  const { depts, profKeys } = M.prepareDepts('latest');
  const { apps, appDiff } = M.chooseApplications(pop, depts, profKeys, cfg, rng);
  let n = 0, low = 0;
  for (let k = 0; k < apps.length; k++) if (apps[k] >= 0) { n++; if (appDiff[k] < cfg.minGap) low++; }
  ok(`지원 시점 격차가 모두 minGap(${cfg.minGap}%p) 이상`, n > 500 && low === 0, `원서 ${n}장 중 미달 ${low}장`);
  ok('일부 원서는 모형 밖 대학으로 감 (35개 대학 밖 선택지)', apps.some(x => x < 0));
}

group('[S6] 2026 경쟁률 학습');
{
  const cfg = Object.assign({}, M.CONFIG, { students: 300000, calibIters: 60 });
  const { depts, profKeys } = M.prepareDepts('latest');
  const role = M.splitHoldout(depts, cfg, M.makeRng(99));
  const sample = M.makePopulation(Object.assign({}, cfg, { students: 4000 }), M.makeRng(1));
  const cal = M.calibrate(sample, depts, profKeys, cfg, M.makeRng(2), role, null);
  // 시뮬레이션 기대 지원자 수가 목표(학습 학과: 실제^α·예측^(1−α), 그 밖: 예측)를 재현
  const reach = depts.map((_, d) => d).filter(d => cal.predicted[d] > 0);
  const err = reach.map(d => Math.abs(Math.log(cal.predicted[d] / cal.target[d])));
  const med = err.slice().sort((a, b) => a - b)[Math.floor(err.length / 2)];
  ok('기대 지원자 수가 목표를 재현 (|log| 중앙값 < 0.05)', med < 0.05, `중앙값 ${med.toFixed(3)}`);
  // 검증 학과는 자기 경쟁률을 쓰지 않는다: 목표 = 회귀 예측값 그대로
  const test = depts.map((_, d) => d).filter(d => role[d] === 'test');
  ok('검증 학과의 목표는 회귀 예측값 (자기 경쟁률 미사용)',
    test.length > 0 && test.every(d => Math.abs(cal.target[d] - cal.predRate[d] * depts[d].cap) < 1e-9));
  const tr = depts.map((_, d) => d).filter(d => role[d] === 'train');
  ok('학습 학과 목표 = 실제와 예측의 가중 기하평균 (alpha)', tr.every(d => {
    const want = depts[d].cap * Math.exp(cfg.alpha * Math.log(depts[d].rate) + (1 - cfg.alpha) * Math.log(cal.predRate[d]));
    return Math.abs(cal.target[d] - want) < 1e-6; }));
}

group('[S7] 모형 밖 대학 합격은 덜 욕심낸 원서만 포기');
{
  // 학생 1명, 학과 2개(정원 각 1): 가군 상향(목표 -1) = 학과0, 나군 안정(목표 +1.5) = 학과1, 다군 = 모형 밖(목표 +0.3)
  const depts = [{ cap: 1, cutP: 95 }, { cap: 1, cutP: 80 }];
  const apps = Int32Array.from([0, 1, -1]), sc = Float32Array.from([500, 500, 0]);
  const appPlan = Float32Array.from([-1, 1.5, 0.3]);
  const r = M.deferredAcceptance(1, depts, apps, sc, { appPlan, outAdmit: Uint8Array.from([0, 0, 1]) });
  ok('모형 밖 적정 합격이 있어도 상향 원서(학과0)에는 등록', r.match[0] === 0);
  const r2 = M.deferredAcceptance(1, [{ cap: 0, cutP: 95 }, { cap: 1, cutP: 80 }], apps, sc,
    { appPlan, outAdmit: Uint8Array.from([0, 0, 1]) });
  ok('상향이 불합격이면 안정 원서(학과1) 대신 모형 밖 적정을 택함', r2.match[0] === -1 && r2.held[1].length === 0);
}

group('[S8] 모의 지원 도구의 합격 확률');
{
  const { admitProb } = require('../sim/apply');
  ok('매 회 미충원이면 1', admitProb(500, [null, null, null], 10) === 1);
  ok('합격선보다 훨씬 높으면 ≈1, 낮으면 ≈0', admitProb(600, [500, 502, 498], 10) > 0.999 && admitProb(400, [500, 502, 498], 10) < 0.001);
  ok('합격선 평균과 같으면 0.5', Math.abs(admitProb(500, [500, 502, 498], 10) - 0.5) < 1e-6);
}

done();
