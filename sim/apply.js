#!/usr/bin/env node
/* 수험생 모의 지원 — 내 성적으로 원서를 넣어 보면 예상 경쟁률과 모의 합격 결과를 보여준다.
   먼저 `npm run sim`으로 sim/out/model.json을 만들어 둔다.

   node sim/apply.js --kor 95 --math 96 --tam 96,94 --eng 2 [--track 자연|인문]
                     [--pick "연세대 경영학과"] [--pick "서강대 경제"] [--pick "중앙대 경영"]
     · 점수는 백분위. 표준점수를 알면 --kor-std 129 처럼 함께 넣는다 (앱과 같은 대응표 보정).
     · --pick 을 생략하면 군마다 상향·적정·안정 학과를 하나씩 추천한다.

   모의 합격 확률: 30만 명 모의 지원에서 나온 그 학과의 최종 합격선(추가합격까지 돈 뒤)을
   내 환산총점과 비교한다. 회차별 합격선의 평균·흔들림으로 정규분포를 만들고, 흔들림에는
   하한(합격선 환산 5점 = 0.5%p)을 둔다. ⚠ 시뮬레이션 기반 값이다 — report.md의 '70% 컷 차이'를 함께 볼 것.
   격차가 minGap(기본 −3%p)보다 낮은 학과는 모델이 지원하지 않는 학과라 확률을 매기지 않고, 추천에서도 뺀다. */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./model');
const E = M.E;

function parseArgs() {
  const a = process.argv.slice(2), o = { pick: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, ''), v = a[i + 1];
    if (k === 'pick') { o.pick.push(v); i++; } else if (v !== undefined && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true;
  }
  return o;
}

function student(o) {
  const tp = String(o.tam || '').split(',').map(Number), ts = String(o['tam-std'] || '').split(',').map(Number);
  const nat = o.track ? o.track === '자연' : true;
  return {
    kor: { pct: +o.kor || 0, std: +o['kor-std'] || 0 },
    math: { pct: +o.math || 0, std: +o['math-std'] || 0, sel: nat ? '미적분' : '확률과통계' },
    eng: { grade: +o.eng || 1 },
    tam: [{ pct: tp[0] || 0, std: ts[0] || 0 }, { pct: tp[1] || 0, std: ts[1] || 0 }],
    tamType: nat ? '과탐' : '사탐',
  };
}

// 표준정규 누적분포
const Phi = z => M.phi(z);

function admitProb(score, cutoffs, cap) {
  const c = cutoffs.map(x => x === null ? -Infinity : x);
  if (c.every(x => x === -Infinity)) return 1;          // 매 회 미충원 → 지원하면 합격
  const fin = c.filter(Number.isFinite);
  const m = fin.reduce((s, x) => s + x, 0) / fin.length;
  const sd = Math.sqrt(fin.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, fin.length - 1));
  const unfilled = (c.length - fin.length) / c.length;  // 미충원 회차 비율만큼은 무조건 합격
  return unfilled + (1 - unfilled) * Phi((score - m) / Math.sqrt(sd * sd + 25));
}

function main() {
  const o = parseArgs();
  const file = path.join(__dirname, 'out', 'model.json');
  if (!fs.existsSync(file)) { console.error('sim/out/model.json 없음 — 먼저 `npm run sim` 실행'); process.exit(1); }
  const model = JSON.parse(fs.readFileSync(file, 'utf8'));
  const me = student(o);
  if (!me.kor.pct && !me.kor.std) { console.error('성적을 넣어 주세요: --kor 95 --math 96 --tam 96,94 --eng 2'); process.exit(1); }
  const res = E.analyze(me, E.DEF_TH, null, model.cutMode);
  const byKey = new Map(res.map(r => [r.key, r]));
  const nat = me.tamType === '과탐';
  const minGap = model.config.minGap;
  const rows = model.depts.map(d => {
    const r = byKey.get(d.key); if (!r) return null;
    // 모델 규칙: 합격선에 크게 미달하는 학과에는 원서를 쓰지 않는다 → 모의 합격 확률을 매기지 않는다
    const far = r.diff < minGap;
    return { d, r, far, p: far ? 0 : admitProb(r.score, d.cutoffs, d.cap) };
  }).filter(Boolean);

  const pc = v => (v * 100).toFixed(0).padStart(3) + '%';
  const line = ({ d, r, p, far }) =>
    `  ${d.mg}군 ${(d.u + ' ' + d.n).slice(0, 26).padEnd(26)}  모집 ${String(d.cap).padStart(3)}  ` +
    `경쟁률 예측 ${d.predRate.toFixed(1).padStart(5)}${d.realRate ? ` (2026 ${d.realRate.toFixed(1)})` : '            '}  ` +
    `격차 ${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(2)}%p  ${r.tier}  ` + (far ? `크게 미달 — 모델상 지원하지 않는 학과` : `모의 합격 ${pc(p)}`);

  console.log(`\n내 성적: 국 ${me.kor.pct} · 수 ${me.math.pct} · 탐 ${me.tam.map(t => t.pct).join('/')} · 영어 ${me.eng.grade}등급 · ${nat ? '자연' : '인문'}`);
  console.log(`(모델: 수험생 ${model.config.students.toLocaleString()}명 × ${model.config.runs}회 모의 지원, ${model.generatedAt.slice(0, 10)})\n`);

  if (o.pick.length) {
    const chosen = [];
    for (const q of o.pick) {
      const words = q.split(/\s+/).filter(Boolean);
      const hit = rows.filter(x => words.every(w => (x.d.u + ' ' + x.d.n).includes(w)))
        .sort((a, b) => b.d.cap - a.d.cap);
      if (!hit.length) { console.log(`  '${q}' — 해당 학과 없음`); continue; }
      if (hit.length > 1) console.log(`  '${q}' — ${hit.length}곳 일치, 모집인원이 가장 큰 곳: ${hit.slice(1, 4).map(x => x.d.n).join(', ')}${hit.length > 4 ? ' …' : ''} 도 있음`);
      chosen.push(hit[0]);
    }
    console.log('내 원서');
    chosen.forEach(x => console.log(line(x)));
    const guns = chosen.map(x => x.d.mg);
    if (new Set(guns).size < guns.length) console.log('  ⚠ 같은 군에 원서가 두 장 이상 — 정시는 군마다 1장만 지원할 수 있다');
    const none = chosen.reduce((s, x) => s * (1 - x.p), 1);
    console.log(`\n  최소 한 곳 모의 합격: ${pc(1 - none)}   (각 원서를 독립으로 본 근사)`);
  } else {
    console.log('군별 추천 (모의 합격 확률 기준 — 상향 20~50% · 적정 50~80% · 안정 80% 이상 중 합격선이 가장 높은 곳)');
    for (const g of ['가', '나', '다']) {
      const pool = rows.filter(x => !x.far && x.d.mg === g && (nat ? x.d.g !== '인문' : x.d.g === '인문'));
      for (const [name, lo, hi] of [['상향', 0.2, 0.5], ['적정', 0.5, 0.8], ['안정', 0.8, 1.01]]) {
        const best = pool.filter(x => x.p >= lo && x.p < hi).sort((a, b) => b.d.cutP - a.d.cutP || b.p - a.p)[0];
        console.log(best ? `${name} ${line(best)}` : `${name}   ${g}군 해당 학과 없음`);
      }
    }
  }
  console.log(`\n⚠ 시뮬레이션 기반 참고 수치다. 70% 컷 차이 등 현실성 점검은 sim/out/report.md 참고.`);
  console.log(`  이 도구는 진학 상담을 대체하지 않는다. 판단의 출발점이지 결론이 아니다.\n`);
}

if (require.main === module) main();
module.exports = { admitProb, student };
