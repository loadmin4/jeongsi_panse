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

done();
