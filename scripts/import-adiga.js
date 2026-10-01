#!/usr/bin/env node
/* data/adiga/raw/*.json (scripts/fetch-adiga.js 결과) → src/univs.js

   node scripts/import-adiga.js

   규칙
   · 정시 일반전형만 쓴다. 농어촌·기회균형·특성화·특수교육·실기·지역인재 등 특별전형은 제외.
   · 합격선 = 최종등록자 70% 컷의 국·수·탐 평균백분위 (앱의 cut 정의와 같음).
     「어디가」가 평균백분위를 0으로 두고 과목별 70% 컷만 준 경우에는
     (국 + 수 + 탐구평균) / 3 으로 계산하고 그 연도는 추정('e')으로 표시한다.
     과목별 70% 컷은 서로 다른 학생의 값이라 평균백분위와 같지 않기 때문이다.
   · 모집단위 이름은 최신 학년도 것을 쓴다. 이전 학년도는 같은 이름일 때만 이어 붙인다.
   · 계열(인문/자연/의약)은 「어디가」에 없어 모집단위 이름으로 분류한다 → classify().
   · 반영비율 프로필은 기존 src/data.js의 PROFILES를 그대로 쓴다 (새 숫자를 만들지 않는다). */
const fs = require('fs');
const path = require('path');
const { UNIV_CODES } = require('./fetch-adiga');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data/adiga/raw');
const OUT = path.join(ROOT, 'src/univs.js');
const YEARS = [2023, 2024, 2025, 2026];

// 앱의 대학 표기·지역 (id → [이름, 지역])
const META = {
  snu: ['서울대', '서울'], yon: ['연세대', '서울'], kor: ['고려대', '서울'], skk: ['성균관대', '서울'],
  sog: ['서강대', '서울'], han: ['한양대', '서울'], cau: ['중앙대', '서울'], khu: ['경희대', '서울'],
  ewh: ['이화여대', '서울'], uos: ['서울시립대', '서울'], hufs: ['한국외대', '서울'], kku: ['건국대', '서울'],
  dgu: ['동국대', '서울'], hong: ['홍익대', '서울'], sook: ['숙명여대', '서울'], ssu: ['숭실대', '서울'],
  sej: ['세종대', '서울'], kmu: ['국민대', '서울'], kw: ['광운대', '서울'], mju: ['명지대', '서울'],
  dku: ['단국대', '경기'], ssw: ['성신여대', '서울'], gch: ['가천대', '경기'], aju: ['아주대', '경기'],
  inh: ['인하대', '인천'], kgu: ['경기대', '경기'], pnu: ['부산대', '부산'], knu: ['경북대', '대구'],
  cnu: ['충남대', '대전'], jnu: ['전남대', '광주'], cbu: ['충북대', '청주'], jbu: ['전북대', '전주'],
  kwu: ['강원대', '춘천'], snue: ['서울교대', '서울'], gine: ['경인교대', '경기']
};

// 일반전형 = 특별전형이 아닌 수능위주 전형. 대학마다 이름이 달라서
// ('수능(일반전형)', '수능(수능전형)', '수능[정시(가군-수능위주전형)]', '수능(수능우수자전형)' …)
// 특별전형 키워드가 없는 전형을 일반전형으로 본다.
const SPECIAL = /농어촌|기회|균형|배려|특성화|특수교육|장애|기초|차상위|저소득|한부모|실기|예체능|체육|무용|미술|음악|성인|재직|북한|이웃|보훈|서해|만학|지역인재|교과우수|한마음|고른|정원외/;
const isGeneral = t => !SPECIAL.test(t);
// 예체능 계열은 앱 범위 밖 (CLAUDE.md §8) — 일반전형이어도 모집단위명으로 제외
const ARTS = /동양화|서양화|한국화|조각|연극|영화|무용|음악|성악|기악|작곡|국악|미술|회화|조소|조형|공예|디자인|체육|스포츠|패션|뮤지컬|연기|애니메이션|만화|사진|도예|예술/;

// 의약 = 의예·의학·치의·한의·약학(6년제)·수의. '식물의학', '바이오의약', '한약학'은 제외.
const MED = /의예|치의|한의예|한의학|약학부|약학과|약학전공|약학계열|수의|^의학과|의과대학/;
const NOT_MED = /식물의학|바이오의약|의약학과|한약학|의약바이오|의생명/;
const NATURAL = /공학|공과|(?<!사회|인문|정치|행정|언어|문헌정보|경영|교육|스포츠|문화)과학|자연|이과|컴퓨터|소프트웨어|전자|전기|기계|반도체|인공지능|AI|데이터|수학|수리|물리|(?<!문)화학|생명|생물|바이오|지구|환경|에너지|신소재|재료|건축|건설|토목|도시공학|산업공학|항공|우주|로봇|모빌리티|자동차|조선|해양|원자력|정보통신|정보보호|보안|사이버|통계|간호|식품|농|원예|산림|동물|식물|축산|의생명|의공|보건|임상|방사선|물리치료|치위생|스마트|IT|ICT|SW|시스템|디스플레이|화공|고분자|섬유|나노|(?<!관)광학|광공학|천문|대기|과학기술|이공|STEM|SCIENCE|정보|컴공/;
const HUMAN_FIRST = /경영|경제|인문|사회|어문|국어|영어|영문|중국|일본|불어|독어|사학|철학|정치|행정|법|미디어|언론|심리|교육|문화|국제|무역|회계|세무|관광|호텔|복지|아동|소비자|상경|문과|어학|문학|통번역|LD|LT|글로벌/;

// 계열 분류. 이름에 자연계 키워드가 있으면 자연, 인문계 키워드만 있으면 인문.
// 둘 다 없으면 2023·2024학년도 70% 컷의 탐구 유형(사탐/과탐)으로 판단한다
// (2025학년도부터는 자연계 모집단위도 사탐 응시자가 많아 신호가 흐려진다).
function classify(unit, rowsByYear) {
  if (MED.test(unit) && !NOT_MED.test(unit)) return '의약';
  // 모집단위명에 계열이 적혀 있으면 그대로 따른다 — '간호학과(인문)', '자유전공학부(자연)'
  if (/\(인문|인문계열\)|\[인문/.test(unit)) return '인문';
  if (/\(자연|자연계열\)|\[자연/.test(unit)) return '자연';
  // '자유전공학부'의 '전공학부'가 '공학'에 걸리지 않도록 '전공'을 지우고 본다
  const name = unit.replace(/전공/g, ' ');
  const nat = NATURAL.test(name), hum = HUMAN_FIRST.test(name);
  if (nat && !hum) return '자연';
  if (hum && !nat) return '인문';
  let s = 0, g = 0;
  for (const y of [2023, 2024]) {
    const r = rowsByYear[y]; if (!r || !r.p70) continue;
    for (const k of ['p50', 'p70']) { const p = r[k];
      if (p.t1s > 0 || p.t2s > 0) s++; if (p.t1g > 0 || p.t2g > 0) g++; }
  }
  if (g > s) return '자연';
  if (s > g) return '인문';
  return nat ? '자연' : '인문';
}

function profileOf(id, g, unit) {
  if (id === 'snue' || id === 'gine') return 'edu_p';
  if (g === '의약') {
    if (['snu', 'yon', 'kor'].includes(id)) return id + '_s';
    if (/의예|^의학과|의과대학/.test(unit) && !['gch', 'kwu'].includes(id)) return 'med_top';
    return 'med_mid';
  }
  return id + (g === '자연' ? '_s' : '_h');
}

const gunOf = s => (s.match(/[가나다]/) || [])[0];
const r1 = v => Math.round(v * 10) / 10;

function cutOfRow(r) {
  if (!r || !r.p70) return null;
  const p = r.p70;
  if (p.avg > 0) return { v: r1(p.avg), c: 'c' };
  const tams = [p.t1s, p.t1g, p.t1j, p.t2s, p.t2g, p.t2j].filter(x => x > 0);
  if (p.kor > 0 && p.math > 0 && tams.length) {
    const tam = tams.reduce((a, b) => a + b, 0) / tams.length;
    return { v: r1((p.kor + p.math + tam) / 3), c: 'e' };
  }
  return null;
}

function build() {
  const univs = [];
  const stats = { units: 0, derived: 0, dropped: 0 };
  for (const [id, code] of Object.entries(UNIV_CODES)) {
    const byUnit = new Map(); // unit → {gun, years:{y:row}}
    for (const y of YEARS) {
      const f = path.join(RAW, `${code}_${y}.json`);
      if (!fs.existsSync(f)) continue;
      const { rows } = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const r of rows) {
        if (!isGeneral(r.track)) continue;
        const unit = r.unit.replace(/\s+/g, ' ').trim();
        if (ARTS.test(unit)) { continue; }
        const cut = cutOfRow(r);
        if (!cut) continue;
        if (!byUnit.has(unit)) byUnit.set(unit, { years: {} });
        const e = byUnit.get(unit);
        // 같은 해에 한 모집단위가 여러 일반전형에 있으면 모집인원이 큰 쪽을 쓴다
        const prev = e.years[y];
        if (!prev || (r.final || 0) > (prev.row.final || 0)) e.years[y] = { row: r, cut };
      }
    }
    const depts = [];
    for (const [unit, e] of byUnit) {
      const ys = Object.keys(e.years).map(Number).sort();
      const last = ys[ys.length - 1];
      if (last < 2025) { stats.dropped++; continue; } // 최근 2개 학년도에 결과가 없으면 폐지·개편된 단위로 본다
      const lr = e.years[last];
      const mg = gunOf(lr.row.gun);
      if (!mg) { stats.dropped++; continue; }
      const rowsByYear = Object.fromEntries(ys.map(y => [y, e.years[y].row]));
      const g = classify(unit, rowsByYear);
      const cuts = {}, cconf = {}, eng = {};
      for (const y of ys) {
        cuts[y] = e.years[y].cut.v; cconf[y] = e.years[y].cut.c;
        const eg = e.years[y].row.p70.eng; if (eg >= 1 && eg <= 9) eng[y] = eg;
      }
      if (lr.cut.c === 'e') stats.derived++;
      depts.push({ n: unit, p: profileOf(id, g, unit), g, mg, cut: cuts[last], cy: last,
        conf: lr.cut.c, cuts, cconf, eng, rate: lr.row.rate, final: lr.row.final, extra: lr.row.extra });
    }
    depts.sort((a, b) => b.cut - a.cut || a.n.localeCompare(b.n, 'ko'));
    stats.units += depts.length;
    univs.push({ id, name: META[id][0], region: META[id][1], adiga: code, depts });
  }
  return { univs, stats };
}

function emit(univs) {
  const L = [];
  L.push('/* =========================================================================');
  L.push('   대학·모집단위·합격선  ―  자동 생성 파일. 직접 고치지 말 것.');
  L.push('   생성: node scripts/import-adiga.js   (원자료: data/adiga/raw, 출처 대교협 「어디가」)');
  L.push('');
  L.push('   n    : 모집단위명 (「어디가」 최신 학년도 표기)');
  L.push('   p    : 반영비율 프로필 키 (src/data.js PROFILES)');
  L.push('   g    : 계열 — 「어디가」에 없어 모집단위명으로 분류 (scripts/import-adiga.js classify)');
  L.push('   mg   : 모집군 (최신 학년도)');
  L.push('   cut  : 최신 학년도 합격선 = 최종등록자 70% 컷 국·수·탐 평균백분위');
  L.push('   cy   : cut의 학년도');
  L.push("   conf : cut 출처 — 'c' 「어디가」 평균백분위 그대로 / 'e' 과목별 70% 컷으로 계산한 값");
  L.push('   cuts : 학년도별 합격선 (2023~2026, 결과가 있는 해만)');
  L.push("   cconf: 학년도별 conf");
  L.push('   eng  : 학년도별 70% 컷 수험생의 영어 등급');
  L.push('   rate : 최신 학년도 경쟁률   final : 최신 학년도 최종 모집인원   extra : 최신 학년도 충원(추가합격) 인원');
  L.push('   ========================================================================= */');
  L.push('');
  L.push('const UNIVS = [');
  const j = o => JSON.stringify(o).replace(/"(\d{4})":/g, '$1:');
  for (const u of univs) {
    L.push(`  { id:'${u.id}', name:'${u.name}', region:'${u.region}', adiga:'${u.adiga}', depts:[`);
    for (const d of u.depts) {
      L.push(`    {n:${JSON.stringify(d.n)}, p:'${d.p}', g:'${d.g}', mg:'${d.mg}', cut:${d.cut}, cy:${d.cy}, conf:'${d.conf}', ` +
        `cuts:${j(d.cuts)}, cconf:${j(d.cconf)}, eng:${j(d.eng)}, rate:${d.rate}, final:${d.final}, extra:${d.extra}},`);
    }
    L.push('  ]},');
  }
  L.push('];');
  return L.join('\n') + '\n';
}

if (require.main === module) {
  const { univs, stats } = build();
  fs.writeFileSync(OUT, emit(univs));
  console.log(`✓ src/univs.js  대학 ${univs.length}개 · 모집단위 ${stats.units}개 ` +
    `(계산값 ${stats.derived}개, 제외 ${stats.dropped}개)`);
  for (const u of univs) if (!u.depts.length) console.log(`  ! ${u.name}: 모집단위 없음`);
}
module.exports = { build, classify, isGeneral, cutOfRow };
