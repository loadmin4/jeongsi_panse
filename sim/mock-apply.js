#!/usr/bin/env node
/* 정시 모의지원 실행
   node sim/mock-apply.js [옵션]

   --n 300000        모의 수험생 수
   --runs 20         지원·합격 과정을 다른 난수로 반복하는 횟수
   --seed 1
   --multiple 4      모든 학과 지원자 = 모집인원 × 4 (생략하면 학과별 실제 경쟁률)
   --outside 0.7     목록 밖 대학 원서가 합격으로 이어질 확률
   --me example      앱의 예시 성적으로 모의지원 합격확률을 계산 (JSON 파일 경로도 가능)
   --min-cap 10      오르내릴 후보 목록에 넣을 최소 모집인원 (작은 학과는 실제 컷 자체가 흔들린다)
   --out sim/out     결과 저장 폴더 (result.json, result.csv)

   모델과 가정은 sim/model.js 머리 주석과 README 「모의지원 시뮬레이션」 참조. */
const fs = require('fs');
const path = require('path');
const M = require('./model');

// 앱(src/app.html)의 예시 성적과 같은 값
const EXAMPLE = {
  kor: { std: 129, pct: 95 },
  math: { std: 130, pct: 96, sel: '미적분' },
  eng: { grade: 2 },
  tam: [{ std: 66, pct: 96 }, { std: 64, pct: 94 }],
  tamType: '과탐',
};

function parseArgs(argv) {
  const o = {}, num = ['n', 'runs', 'seed', 'multiple', 'outside', 'active', 'taste', 'sigma', 'mu'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { o[k] = true; continue; }
    o[k] = num.includes(k) ? Number(v) : v;
    i++;
  }
  return o;
}

// 한글은 터미널에서 두 칸을 차지한다
const width = s => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
const padR = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - width(s))); };
const padL = (s, n) => { s = String(s); return ' '.repeat(Math.max(0, n - width(s))) + s; };
const f1 = v => (v == null || !Number.isFinite(v)) ? '-' : v.toFixed(1);
const sg = v => (v == null || !Number.isFinite(v)) ? '-' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
const pctS = v => (v == null || !Number.isFinite(v)) ? '-' : Math.round(v * 100) + '%';
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const wmean = (xs, ws) => { const W = ws.reduce((a, b) => a + b, 0); return W ? xs.reduce((a, x, i) => a + x * ws[i], 0) / W : null; };

function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = {};
  for (const k of ['n', 'runs', 'seed', 'multiple', 'outside', 'active', 'taste', 'sigma', 'mu']) if (args[k] !== undefined) opts[k] = args[k];
  const quiet = !!args.quiet, log = quiet ? () => {} : m => console.log('  · ' + m);

  console.log(`\n정시 모의지원 — 모의 수험생 ${(opts.n || M.DEFAULTS.n).toLocaleString()}명, ${opts.runs || M.DEFAULTS.runs}회 반복`);
  const sim = M.simulate(opts, log);
  const o = sim.opts, D = sim.depts, real = M.actualExtra(sim.D);
  D.forEach((d, i) => { d.realExtra = real[i]; });
  const live = D.filter(d => d.cap > 0 && d.sim70 != null);

  /* 지원 */
  const target = D.reduce((a, d) => a + d.target, 0), seats = D.reduce((a, d) => a + d.cap, 0);
  const [, c1, c2, c3] = sim.participants;
  console.log(`\n[지원]  모집 ${seats.toLocaleString()}명 × 경쟁률 → 원서 ${Math.round(target).toLocaleString()}장` +
    (o.multiple != null ? ` (모든 학과 ${o.multiple}배)` : ' (학과별 「어디가」 경쟁률)'));
  console.log(`        목록 안 대학에 원서를 쓴 수험생 ${(c1 + c2 + c3).toLocaleString()}명 — 1장 ${c1.toLocaleString()} · 2장 ${c2.toLocaleString()} · 3장 ${c3.toLocaleString()}`);
  console.log(`        학과 인기도 보정 ${sim.fit.iters}회, 목표 대비 최대 오차 ${(sim.fit.maxErr * 100).toFixed(1)}%`);

  /* 검증 */
  const err = live.map(d => d.sim70 - d.cut);
  console.log(`\n[검증]  70% 컷(국·수·탐 평균백분위) — 모의 vs 실제 ${live.length}개 학과`);
  console.log(`        편향 ${sg(mean(err))} · 평균 오차 ${mean(err.map(Math.abs)).toFixed(2)} · ±2 이내 ${Math.round(mean(err.map(e => Math.abs(e) <= 2 ? 1 : 0)) * 100)}%`);
  const byG = M.GROUPS.map(g => {
    const s = D.filter(d => d.mg === g && d.cap > 0), cap = s.reduce((a, d) => a + d.cap, 0);
    return `${g}군 ${pctS(s.reduce((a, d) => a + d.extra, 0) / cap)} / ${pctS(s.reduce((a, d) => a + (d.realExtra || 0), 0) / cap)}`;
  });
  console.log(`        충원율(추가합격 ÷ 모집) 모의 / 실제: ${byG.join(' · ')}`);
  const unfilled = D.filter(d => d.cap > 0 && d.regs < d.cap);
  if (unfilled.length) console.log(`        미충원 ${unfilled.length}개 학과 (지원자 소진)`);

  /* 대학별 */
  console.log('\n[대학별]  모집인원 가중 평균');
  console.log('  ' + padR('대학', 12) + padL('모집', 7) + padL('실제컷', 8) + padL('모의컷', 8) + padL('차이', 7) + padL('모의충원', 10) + padL('실제충원', 10));
  const univs = [...new Set(D.map(d => d.uid))];
  for (const uid of univs) {
    const s = live.filter(d => d.uid === uid);
    if (!s.length) continue;
    const w = s.map(d => d.cap), cap = w.reduce((a, b) => a + b, 0);
    const rc = wmean(s.map(d => d.cut), w), sc = wmean(s.map(d => d.sim70), w);
    console.log('  ' + padR(s[0].u, 12) + padL(cap.toLocaleString(), 7) + padL(f1(rc), 8) + padL(f1(sc), 8) + padL(sg(sc - rc), 7) +
      padL(pctS(s.reduce((a, d) => a + d.extra, 0) / cap), 10) + padL(pctS(s.reduce((a, d) => a + (d.realExtra || 0), 0) / cap), 10));
  }

  /* 앱 합격선의 이동 (환산점수 %p)
     평균백분위 컷은 등록자의 영어 등급 구성에 따라 달라진다(70% 컷 수험생 한 명의 영어 등급이 학과마다 다르다).
     그래서 오르내릴 후보는 앱이 실제로 쓰는 단위 — 합격선 환산총점 대비 %p — 로 고른다.
     군 전체가 한쪽으로 치우치는 몫(모델 가정 탓)은 빼고, 반복 구간(10~90%) 전체가 한쪽에 있는 학과만. */
  const shifted = live.filter(d => d.shift != null);
  const gBias = {};
  for (const g of M.GROUPS) { const s = shifted.filter(d => d.mg === g); gBias[g] = s.length ? mean(s.map(d => d.shift)) : 0; }
  const rel = d => d.shift - gBias[d.mg];
  console.log(`\n[앱 합격선 이동]  모의 70% 등록자 환산점수 − 앱 합격선 (%p): ` +
    `평균 ${sg(mean(shifted.map(d => d.shift)))} · 절대값 평균 ${mean(shifted.map(d => Math.abs(d.shift))).toFixed(2)}`);
  console.log(`        군별 평균 ${M.GROUPS.map(g => `${g}군 ${sg(gBias[g])}`).join(' · ')}  (아래 두 목록은 군별 평균을 뺀 값)`);
  const row = d => '  ' + padR(`${d.mg} ${d.u} ${d.n}`, 44) + padL(d.cap, 5) + padL(f1(d.cut), 7) + padL(sg(rel(d)), 8) +
    padL(`${sg(d.shiftLo - gBias[d.mg])}~${sg(d.shiftHi - gBias[d.mg])}`, 14) + padL(d.mult.toFixed(1), 7) + padL(pctS(d.extra / d.cap), 7);
  const head = '  ' + padR('모집단위', 44) + padL('모집', 5) + padL('실제컷', 7) + padL('이동%p', 8) + padL('반복 구간', 14) + padL('경쟁률', 7) + padL('충원', 7);
  const N = Number(args.top) || 12, minCap = args['min-cap'] != null ? Number(args['min-cap']) : 10;
  const big = shifted.filter(d => d.cap >= minCap);
  const down = big.filter(d => d.shiftHi - gBias[d.mg] < 0).sort((a, b) => rel(a) - rel(b)).slice(0, N);
  const up = big.filter(d => d.shiftLo - gBias[d.mg] > 0).sort((a, b) => rel(b) - rel(a)).slice(0, N);
  console.log(`\n[내려갈 후보]  앱 합격선보다 모의 합격선이 낮은 학과 — 모집 ${minCap}명 이상`);
  console.log(head); down.forEach(d => console.log(row(d)));
  console.log(`\n[오를 후보]  앱 합격선보다 모의 합격선이 높은 학과 — 모집 ${minCap}명 이상`);
  console.log(head); up.forEach(d => console.log(row(d)));

  /* 내 성적 */
  let mine = null;
  if (args.me) {
    const ex = args.me === true || args.me === 'example';
    const me = ex ? EXAMPLE : JSON.parse(fs.readFileSync(args.me, 'utf8'));
    mine = M.myChances(sim, M.E.completeScores(me));
    console.log(`\n[내 성적]  ${ex ? '앱 예시 성적' : args.me} — 앱 확률(격차 → 로지스틱) vs 모의지원 합격률`);
    console.log('  ' + padR('판정', 6) + padL('학과', 6) + padL('앱 확률', 9) + padL('모의지원', 9));
    for (const t of M.E.TIER_ORDER) {
      const s = mine.filter(r => r.tier === t && Math.abs(r.diff) <= 6);
      if (!s.length) continue;
      console.log('  ' + padR(t, 6) + padL(s.length, 6) + padL(Math.round(mean(s.map(r => r.pLogit))) + '%', 9) + padL(Math.round(mean(s.map(r => r.pSim))) + '%', 9));
    }
    const near = mine.filter(r => r.tier === '소신' || r.tier === '상향').sort((a, b) => b.diff - a.diff);
    console.log(`\n  소신·상향 ${near.length}개 학과 (격차 순, 최대 ${Number(args.metop) || 30}개)`);
    console.log('  ' + padR('모집단위', 44) + padL('격차', 7) + padL('판정', 6) + padL('앱 확률', 9) + padL('모의지원', 9));
    for (const r of near.slice(0, Number(args.metop) || 30))
      console.log('  ' + padR(`${r.mg} ${r.u} ${r.n}`, 44) + padL(sg(r.diff), 7) + padL(r.tier, 6) + padL(r.pLogit + '%', 9) + padL(r.pSim + '%', 9));
    console.log('  (모의지원 = 추가합격까지 끝난 최종 합격선을 내 환산점수가 넘은 반복 비율)');
  }

  /* 저장 */
  const outDir = path.resolve(args.out || path.join(__dirname, 'out'));
  fs.mkdirSync(outDir, { recursive: true });
  const slim = D.map(({ lastScores, ...d }) => d);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    generated: new Date().toISOString(), opts: o, seconds: sim.seconds, participants: sim.participants,
    ipf: { iters: sim.fit.iters, maxErr: sim.fit.maxErr }, depts: slim, me: mine }, null, 1));
  const cols = ['key', 'u', 'n', 'g', 'mg', 'cap', 'mult', 'rateSrc', 'cut', 'sim70', 'sim70lo', 'sim70hi', 'sim50',
    'cutTotal', 'shift', 'shiftLo', 'shiftHi', 'applicants', 'regs', 'extra', 'realExtra'];
  const csv = [cols.join(',')].concat(slim.map(d => cols.map(c => {
    const v = d[c];
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? v : v.toFixed(2);
    return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')));
  fs.writeFileSync(path.join(outDir, 'result.csv'), '﻿' + csv.join('\n') + '\n');
  console.log(`\n저장: ${path.relative(process.cwd(), outDir)}/result.json, result.csv  (${sim.seconds.toFixed(0)}초)\n`);
}

main();
