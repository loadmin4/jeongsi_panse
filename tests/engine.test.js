/* 엔진 검증 — 과거에 실제로 터졌던 두 버그(E2 포화, E8 잣대 불일치)를 회귀 테스트로 고정 */
const E = require('./_load');
const { group, ok, info, done } = require('./harness');
const { STD_MAX, pctToStd, stdToPct, calibrate, tierOf, prob, analyze, cutOf, DEF_TH, TIER_ORDER } = E;

const student = (p, over) => Object.assign({
  kor:  { std: Math.round(pctToStd(p, 'kor')),  pct: p },
  math: { std: Math.round(pctToStd(p, 'math')), pct: p, sel: '미적분' },
  eng:  { grade: 2 },
  tam:  [{ std: Math.round(pctToStd(p, 'tam')), pct: p }, { std: Math.round(pctToStd(p, 'tam')), pct: p }],
  tamType: '과탐'
}, over);

const dist = r => r.reduce((a, x) => (a[x.tier] = (a[x.tier] || 0) + 1, a), {});
// 모집단위명은 「어디가」 표기(예: '경영학부(경영학전공)')라 접두어로 찾는다
const find = (r, u, d) => r.find(x => x.u === u && x.d === d) || r.find(x => x.u === u && x.d.startsWith(d));

group('[E1] 표준↔백분위 대응표');
{
  let bad = 0;
  for (const [a, p] of [['kor', 96], ['kor', 100], ['math', 97], ['math', 88], ['tam', 94], ['tam', 100]])
    if (Math.abs(stdToPct(pctToStd(p, a), a) - p) >= 1.5) bad++;
  ok('백분위 → 표준 → 백분위 왕복 오차 1.5 미만', bad === 0);
  ok('만점 표준점수를 넘지 않음',
    ['kor', 'math', 'tam'].every(a => pctToStd(100, a) <= STD_MAX[a]));
  ok('백분위가 오르면 표준점수도 오름 (단조)',
    ['kor', 'math', 'tam'].every(a =>
      [30, 50, 70, 90, 95, 99, 100].every((p, i, ar) => i === 0 || pctToStd(p, a) > pctToStd(ar[i - 1], a))));
}

group('[E2] 회귀: 상위권 커트 포화 (정규분포 근사 시절 버그)');
{
  const r = analyze(student(96), DEF_TH);
  ok('환산총점이 0~1000 안', r.every(x => x.score >= 0 && x.score <= 1000),
    `${Math.min(...r.map(x => x.score)).toFixed(1)} ~ ${Math.max(...r.map(x => x.score)).toFixed(1)}`);
  ok('합격선 환산총점이 1000에 붙지 않음', Math.max(...r.map(x => x.cutTotal)) < 995,
    `최대 ${Math.max(...r.map(x => x.cutTotal)).toFixed(1)}`);
  // 「어디가」 합격선은 정수라 (합격선, 프로필)이 같은 학과는 커트가 같은 게 정상이다.
  // 포화 버그는 '서로 다른 입력이 같은 커트로 뭉개지는' 것 → 입력 조합 수와 커트 고유값 수를 비교한다.
  const top = r.filter(x => x.cutP >= 98);
  const inputs = new Set(top.map(x => x.cutP + '|' + JSON.stringify(x.prof))).size;
  const uniq = new Set(top.map(x => x.cutTotal.toFixed(1))).size;
  ok('백분위 98 이상 학과들의 커트가 서로 구분됨', uniq >= inputs * 0.9,
    `입력 조합 ${inputs}개 → 커트 고유값 ${uniq}개`);
}

group('[E3] 단조성');
{
  const base = analyze(student(95), DEF_TH);
  const lo = analyze(student(95, { kor: { std: 114, pct: 90 } }), DEF_TH);
  const hi = analyze(student(95, { kor: { std: 137, pct: 100 } }), DEF_TH);
  ok('국어 성적이 오르면 어떤 학과에서도 격차가 줄지 않음',
    base.every((x, i) => lo[i].diff <= x.diff + 1e-9 && x.diff <= hi[i].diff + 1e-9));
  const e5 = analyze(student(95, { eng: { grade: 5 } }), DEF_TH);
  ok('영어 등급이 나빠지면 어떤 학과에서도 격차가 늘지 않음',
    base.every((x, i) => e5[i].diff <= x.diff + 1e-9));
}

group('[E4] 반영비율이 실제로 결과를 가르는가');
{
  const mathType = student(95, { kor: { std: 114, pct: 90 }, math: { std: 139, pct: 100, sel: '미적분' } });
  const korType  = student(95, { kor: { std: 137, pct: 100 }, math: { std: 116, pct: 90, sel: '확률과통계' } });
  const rm = analyze(mathType, DEF_TH), rk = analyze(korType, DEF_TH);
  const sg = find(rm, '서강대', '경영학부').diff - find(rk, '서강대', '경영학부').diff;
  const ss = find(rm, '숭실대', '경영학부').diff - find(rk, '숭실대', '경영학부').diff;
  ok('수학 43.3% 대학이 수학 20% 대학보다 수학형에게 유리', sg > ss,
    `서강대 우위 ${sg.toFixed(2)}%p vs 숭실대 우위 ${ss.toFixed(2)}%p`);
}

group('[E5] 영어 반영방식별 민감도');
{
  const a1 = analyze(student(95, { eng: { grade: 1 } }), DEF_TH);
  const a4 = analyze(student(95, { eng: { grade: 4 } }), DEF_TH);
  const drop = (u, d) => find(a4, u, d).diff - find(a1, u, d).diff;
  [['연세대', '경영학과'], ['고려대', '경영대학'], ['서강대', '경영학부'],
   ['중앙대', '경영학부'], ['건국대', '경영학과']].forEach(([u, d]) =>
    info(`${u} ${d}: ${drop(u, d).toFixed(2)}%p`));
  ok('영어 감점이 가파른 중앙대가 완만한 건국대보다 타격이 큼',
    drop('중앙대', '경영학부') < drop('건국대', '경영학과'));
  ok('모든 대학에서 영어 하락이 손해로만 작용',
    a1.every((x, i) => a4[i].diff <= x.diff + 1e-9));
}

group('[E6] 회귀: 표준점수형 vs 백분위형 잣대 불일치 (대응표 보정 이전 버그)');
{
  // 표준점수와 백분위가 서로 어긋나게 입력된 성적표 — 실제 성적표에서 흔함
  const skewed = {
    kor:  { std: 131, pct: 96 },
    math: { std: 135, pct: 97, sel: '미적분' },
    eng:  { grade: 2 },
    tam:  [{ std: 68, pct: 94 }, { std: 66, pct: 91 }],
    tamType: '과탐'
  };
  const cal = calibrate(skewed);
  ok('보정값이 0이 아님 (성적표가 대응표와 어긋남을 감지)',
    Math.abs(cal.kor) > 1 || Math.abs(cal.math) > 1,
    `국 ${cal.kor.toFixed(1)} 수 ${cal.math.toFixed(1)} 탐 ${cal.tam.toFixed(1)}`);

  const snap = {}; for (const k in E.PROFILES) snap[k] = E.PROFILES[k].base;
  const run = b => { for (const k in E.PROFILES) E.PROFILES[k].base = b; return analyze(skewed, DEF_TH); };
  const asStd = run('std'), asPct = run('pct');
  for (const k in E.PROFILES) E.PROFILES[k].base = snap[k];

  // 판정이 갈리는 관심권(격차 ±6%p)에서 본다. 합격선이 수험생보다 한참 낮은 학과(예: 백분위 70대)는
  // 표준점수·백분위 척도 차이로 격차가 벌어지지만 두 방식 모두 '하향'이라 판정에 영향이 없다.
  // (보정을 끄면 이 값이 약 5%p로 뛴다 — 회귀 감지력 확인함)
  const near = asStd.map((x, i) => [x, asPct[i]]).filter(([a, b]) => Math.abs(a.diff) <= 6 || Math.abs(b.diff) <= 6);
  const gaps = near.map(([a, b]) => Math.abs(a.diff - b.diff));
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const match = asStd.filter((x, i) => x.tier === asPct[i].tier).length / asStd.length;
  ok('같은 학과를 두 방식으로 계산한 격차가 평균 1.0%p 미만 (관심권)', avg < 1.0, `${near.length}개 학과 평균 ${avg.toFixed(2)}%p`);
  ok('두 방식의 5단계 판정 일치율 80% 이상', match >= 0.8, `${(match * 100).toFixed(0)}%`);
}

group('[E7] 5단계 경계값');
{
  const t = DEF_TH;
  ok('경계값 위는 상위 단계', tierOf(t.하향, t) === '하향' && tierOf(t.적정, t) === '적정');
  ok('경계값 바로 아래는 하위 단계',
    tierOf(t.하향 - 1e-6, t) === '적정' && tierOf(t.적정 - 1e-6, t) === '소신' &&
    tierOf(t.소신 - 1e-6, t) === '상향' && tierOf(t.상향 - 1e-6, t) === '위험');
  ok('극단값도 다섯 단계 안에 들어옴',
    TIER_ORDER.includes(tierOf(999, t)) && TIER_ORDER.includes(tierOf(-999, t)));
  ok('합격확률: 격차 0 → 50%', prob(0) === 50);
  ok('합격확률 단조증가', [-9, -3, -1, 0, 1, 3, 9].every((d, i, a) => i === 0 || prob(d) >= prob(a[i - 1])));
  ok('합격확률 0~100 범위', [-99, 99].every(d => prob(d) >= 0 && prob(d) <= 100));
}

group('[E8] 성적대별 분포가 합리적으로 이동');
{
  const rows = [99, 95, 90, 82].map(p => [p, dist(analyze(student(p), DEF_TH))]);
  rows.forEach(([p, d]) =>
    info(`백분위 ${p}: ` + TIER_ORDER.map(t => `${t} ${String(d[t] || 0).padStart(3)}`).join('  ')));
  const safe = rows.map(([, d]) => d.하향 || 0);
  ok('성적이 낮아질수록 안전(하향) 학과가 줄어듦',
    safe.every((v, i) => i === 0 || v <= safe[i - 1]), safe.join(' → '));
  const risk = rows.map(([, d]) => d.위험 || 0);
  ok('성적이 낮아질수록 위험 학과가 늘어남',
    risk.every((v, i) => i === 0 || v >= risk[i - 1]), risk.join(' → '));
}

group('[E9] 반영비율 덮어쓰기(override)');
{
  const me = student(95);
  const base = find(analyze(me, DEF_TH), '서강대', '경영학부');
  const key = base.key;
  const flat = find(analyze(me, DEF_TH, { [key]: [25, 25, 25, 25] }), '서강대', '경영학부');
  ok('override가 환산점수를 실제로 바꿈', Math.abs(base.score - flat.score) > 0.5,
    `${base.score.toFixed(1)} → ${flat.score.toFixed(1)}`);
  ok('override는 해당 학과에만 적용',
    find(analyze(me, DEF_TH, { [key]: [25, 25, 25, 25] }), '서강대', '경제학').score ===
    find(analyze(me, DEF_TH), '서강대', '경제학').score);
}

group('[E10] 결측 입력 방어');
{
  const empty = { kor: { std: 0, pct: 0 }, math: { std: 0, pct: 0, sel: '확률과통계' },
    eng: { grade: 3 }, tam: [{ std: 0, pct: 0 }, { std: 0, pct: 0 }], tamType: '사탐' };
  let threw = false, r = [];
  try { r = analyze(empty, DEF_TH); } catch (e) { threw = true; }
  ok('성적이 비어도 예외 없이 계산', !threw);
  ok('NaN이 섞이지 않음', r.every(x => Number.isFinite(x.score) && Number.isFinite(x.diff)));
  ok('모든 학과가 다섯 단계 중 하나로 분류', r.every(x => TIER_ORDER.includes(x.tier)));
}

group('[E11] 회귀: 반영비율 추정인 학과의 추정 표시 누락');
{
  const r = analyze(student(95), DEF_TH);
  const miss = r.filter(x => x.prof.conf === 'e' && x.conf !== 'e');
  ok('반영비율 프로필이 추정이면 학과도 추정으로 표시', miss.length === 0,
    miss.slice(0, 3).map(x => `${x.u} ${x.d}`).join(' / '));
  ok('합격선·반영비율 출처가 각각 노출됨',
    r.every(x => x.cutConf === x.conf || x.ratioConf === x.conf) &&
    r.every(x => ['c', 'e'].includes(x.cutConf) && ['c', 'e'].includes(x.ratioConf)));
  info(`둘 다 확인 ${r.filter(x => x.conf === 'c').length}개 / ${r.length}개`);
}

group('[E12] 회귀: 탐구 한 과목만 입력 시 점수 반토막');
{
  const both = student(95);
  const one = student(95, { tam: [both.tam[0], { std: 0, pct: 0 }] });
  const rb = analyze(both, DEF_TH), ro = analyze(one, DEF_TH);
  ok('빈 탐구 과목은 평균에서 제외 (두 과목 같은 점수와 결과 동일)',
    rb.every((x, i) => Math.abs(x.diff - ro[i].diff) < 1e-9));
  const cal = calibrate(one);
  ok('빈 과목 때문에 탐구 보정값이 튀지 않음', Math.abs(cal.tam) < 3, `탐 ${cal.tam.toFixed(1)}`);
}

group('[E13] 합격선 기준 (최신 학년도 / 학년도 평균)');
{
  const me = student(95);
  const latest = analyze(me, DEF_TH), avg = analyze(me, DEF_TH, null, 'avg');
  const i = latest.findIndex(x => x.cuts && Object.keys(x.cuts).length >= 3 &&
    new Set(Object.values(x.cuts)).size > 1);
  const x = latest[i], ys = Object.keys(x.cuts);
  const mean = ys.reduce((a, y) => a + x.cuts[y], 0) / ys.length;
  ok('기본값은 최신 학년도 합격선', latest.every(r => r.cutP === (r.cuts ? r.cuts[Math.max(...Object.keys(r.cuts))] : r.cutP)));
  ok('평균 모드는 학년도 평균을 합격선으로 씀', Math.abs(avg[i].cutP - mean) < 0.051,
    `${x.u} ${x.d}: ${ys.map(y => x.cuts[y]).join('/')} → ${avg[i].cutP}`);
  ok('합격선이 높아지면 격차는 줄어듦 (평균 모드도 단조)',
    latest.every((r, k) => Math.sign(avg[k].cutP - r.cutP) * (avg[k].diff - r.diff) <= 1e-9));
  ok('한 해라도 계산값(e)이 섞인 평균은 추정으로 표시',
    avg.every(r => !r.cconf || !Object.values(r.cconf).includes('e') || r.cutConf === 'e'));
  ok('알 수 없는 모드는 최신 학년도로 처리', cutOf({ cut: 90, cy: 2026, conf: 'c' }, 'zzz').v === 90);
}

group('[E14] 회귀: 합격선 수험생을 영어 1등급으로 가정하던 편향');
{
  // 「어디가」 70% 컷 수험생의 실제 영어 등급은 대부분 2~3등급이다.
  // 1등급으로 가정하면 영어 2등급 이하 학생은 모든 학과에서 체계적으로 불리하게 나왔다.
  const r = analyze(student(95, { eng: { grade: 3 } }), DEF_TH);
  const withEng = r.filter(x => !x.cutEngAssumed);
  ok('합격선 수험생 영어 등급 = 「어디가」 70% 컷 실측 등급',
    withEng.length > r.length * 0.9 && withEng.every(x => Object.values(x.eng70).includes(x.cutEng)),
    `${withEng.length}/${r.length}개 실측`);
  const same = r.filter(x => x.cutEng === 3 && x.prof.engMode === 'ratio');
  ok('내 영어 등급이 합격선 수험생과 같으면 영어 점수 차가 0',
    same.length > 0 && same.every(x => Math.abs(x.parts.eng - x.cutParts.eng) < 1e-9), `${same.length}개 학과`);
  ok('영어 자료가 없는 학과는 1등급 가정으로 계산하고 표시',
    r.filter(x => x.cutEngAssumed).every(x => x.cutEng === 1));
  // 「어디가」는 70% 컷 영어 등급을 2026학년도에만 공개한다 → 평균 모드도 같은 실측 등급을 쓴다
  const avg = analyze(student(95, { eng: { grade: 3 } }), DEF_TH, null, 'avg');
  ok('평균 모드도 실측 영어 등급 사용', avg.every((x, i) => x.cutEng === r[i].cutEng));
}


group('[E15] 회귀: 표준점수·백분위 중 하나만 입력하면 빈 쪽이 0점 처리');
{
  // 「빈칸 자동 추정」 버튼을 없애면서, 빈 쪽을 엔진이 대응 곡선으로 채운다.
  // 채우지 않으면 백분위만 넣은 학생은 표준점수 반영 대학에서 그 영역이 0점이 된다.
  const full = student(95);
  const pctOnly = { ...full, kor: { std: 0, pct: 95 }, math: { std: 0, pct: 95, sel: '미적분' },
    tam: [{ std: 0, pct: 95 }, { std: 0, pct: 95 }] };
  const stdOnly = { ...full, kor: { std: full.kor.std, pct: 0 }, math: { std: full.math.std, pct: 0, sel: '미적분' },
    tam: [{ std: full.tam[0].std, pct: 0 }, { std: full.tam[1].std, pct: 0 }] };
  const rf = analyze(full, DEF_TH), rp = analyze(pctOnly, DEF_TH), rs = analyze(stdOnly, DEF_TH);
  const gap = (a, b) => Math.max(...a.map((x, i) => Math.abs(x.diff - b[i].diff)));
  ok('백분위만 입력해도 둘 다 입력한 것과 격차 차이 0.5%p 이내', gap(rf, rp) < 0.5, `최대 ${gap(rf, rp).toFixed(2)}%p`);
  ok('표준점수만 입력해도 둘 다 입력한 것과 격차 차이 0.5%p 이내', gap(rf, rs) < 0.5, `최대 ${gap(rf, rs).toFixed(2)}%p`);
}


group('[E16] 5단계 경계는 고정값 (사용자 결정)');
{
  ok('하향 +2.0 · 적정 −0.2 · 소신 −1.5 · 상향 −2.0',
    DEF_TH.하향 === 2.0 && DEF_TH.적정 === -0.2 && DEF_TH.소신 === -1.5 && DEF_TH.상향 === -2.0, JSON.stringify(DEF_TH));
  ok('경계 사이 값의 판정', tierOf(2.0, DEF_TH) === '하향' && tierOf(1.99, DEF_TH) === '적정' && tierOf(-0.2, DEF_TH) === '적정' &&
    tierOf(-0.21, DEF_TH) === '소신' && tierOf(-1.5, DEF_TH) === '소신' && tierOf(-1.51, DEF_TH) === '상향' &&
    tierOf(-2.0, DEF_TH) === '상향' && tierOf(-2.01, DEF_TH) === '위험');
}

done();
