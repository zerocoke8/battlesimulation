/**
 * 스킬 이펙트 에셋 목록 출력기 (v0.9). `npm run effects:list`
 *
 * 작가(사람이든 AI 든)가 **이 출력만 보고** 이펙트 시트를 만들 수 있게 필요한 키 전부를
 * 키 · 프레임 크기 · 시트 크기 · 프레임 수 · fps · 재생 시간 · blend · loop · anchor · 쓰임 으로 적어 준다.
 *
 * 값은 전부 코드(`src/ui/pixel/fx/fxTypes.ts` 의 `FX_KEYS` / `FX_DEFAULT_META`)에서 그대로 읽는다.
 * 장판 테두리(`zone_ring_<계열>_r<반경×10>`)는 게임 데이터(SKILLS · HAZARDS)에서 자동으로 만들어지므로,
 * 밸런싱으로 스킬 반경이 바뀌면 이 출력도 따라 바뀐다. **항상 이 출력이 최신 목록이다.**
 *
 * 사용법
 *   npm run effects:list            표로 출력 (기본)
 *   npm run effects:list -- --keys  키 이름만 한 줄에 하나씩 (스크립트용)
 *   npm run effects:list -- --json  JSON 배열 (도구용)
 *
 * 이 파일은 DOM 을 쓰지 않는다 (node 에서 그대로 실행된다). src/core 는 읽기만 한다.
 */
import {
  FX_DEFAULT_META,
  FX_KEYS,
  FX_PRIORITY_1,
  FX_PRIORITY_2,
  FX_PRIORITY_3,
  FX_RING_KEYS,
  fxDurationSec,
  fxKeyKind,
  fxSchoolOfMagic,
  parseRingFxKey,
  quantRingRadius,
  ringFxKeyOf,
  type FxKey,
  type FxMeta,
  type FxSchool,
  type FxZoneSchool,
} from '../src/ui/pixel/fx/fxTypes';
import { SKILLS } from '../src/core/data/skills';
import { HAZARDS } from '../src/core/data/maps';
import type { SkillDef } from '../src/core/types';

// ───────────────────────── 이름 ─────────────────────────

const SCHOOL_KO: Record<FxZoneSchool, string> = {
  fire: '화염',
  ice: '냉기',
  lightning: '전기',
  holy: '신성',
  nature: '자연',
  shadow: '암흑',
  phys: '무속성·물리',
  neutral: '맵 기믹(눈보라)',
};

/** 소수점 이하가 없으면 정수로 (3.0 → '3', 3.5 → '3.5') */
function radiusText(radius: number): string {
  return Number.isInteger(radius) ? String(radius) : radius.toFixed(1);
}

// ───────────────── 장판 테두리를 쓰는 스킬 모으기 ─────────────────

/**
 * 스킬 정의 → 이펙트 계열. `fxTypes.ts` 의 내부 함수 `ringSchoolOfSkill` 과 같은 규칙이다
 * (피해 효과가 있으면 그 효과의 계열, 물리 피해는 'phys', 아니면 스킬의 계열).
 * 여기서는 '어떤 스킬이 이 키를 쓰는가' 를 적기 위해서만 쓴다.
 */
function ringSchoolOfSkill(sk: SkillDef): FxSchool {
  for (let i = 0; i < sk.effects.length; i++) {
    const e = sk.effects[i];
    if (e.kind !== 'damage') continue;
    if (e.school === 'phys') return 'phys';
    return fxSchoolOfMagic(e.magic ?? sk.magic);
  }
  return fxSchoolOfMagic(sk.magic);
}

/** 테두리 키 → 그 키를 쓰는 스킬 이름들 (id 오름차순) */
function ringUsers(): Map<FxKey, string[]> {
  const out = new Map<FxKey, string[]>();
  const push = (key: FxKey, name: string): void => {
    const list = out.get(key);
    if (list) {
      if (list.indexOf(name) < 0) list.push(name);
    } else {
      out.set(key, [name]);
    }
  };

  const ids = Object.keys(SKILLS).sort();
  for (let i = 0; i < ids.length; i++) {
    const sk = SKILLS[ids[i]];
    if (!sk || (sk.target !== 'enemy_area' && sk.target !== 'ally_area')) continue;
    const r = sk.radius ?? 0;
    if (!(r > 0)) continue;
    push(ringFxKeyOf(ringSchoolOfSkill(sk), r), sk.name);
  }

  for (let i = 0; i < HAZARDS.length; i++) {
    const hz = HAZARDS[i];
    if (!(hz.radius > 0)) continue;
    const max = Math.max(hz.radius, hz.maxRadius ?? hz.radius);
    for (const key of FX_RING_KEYS) {
      const p = parseRingFxKey(key);
      if (!p || p.school !== 'neutral') continue;
      if (p.radius >= quantRingRadius(hz.radius) - 1e-9 && p.radius <= max + 1e-9) push(key, hz.name);
    }
  }
  return out;
}

const RING_USERS = ringUsers();

// ───────────────────────── 쓰임 문구 ─────────────────────────

const MISC_USE: Record<FxKey, string> = {
  proj_arrow: '궁수 계열의 원거리 기본 공격 화살',
  proj_bullet: '저격수 탄환. 무속성 투사체는 전부 이것을 쓴다 (proj_orb_phys 는 없다)',
  slash_light: '빠른 한 손 무기 근접 공격 (검사·암살자). 얇고 빠른 한 줄',
  slash_heavy: '양손 큰 동작 (버서커·대검사)과 물리 근접 스킬. 두껍고 넓은 반원',
  slash_pierce: '찌르기 (창·단검). 앞으로 뻗는 쐐기',
  status_stun: '기절. 유닛 머리 위에서 도는 별',
  status_burn: '화상. 유닛 머리 위의 작은 불길 (기절 별과 같은 높이)',
  status_freeze: '빙결·둔화. 유닛 발밑의 서리 (유닛 아래에 깔린다)',
  status_shield: '보호막. 유닛 발밑을 감싸는 얇은 막 (유닛 아래에 깔린다)',
  heal_burst: '회복. 대상의 발에서 0.8 유닛 위로 떠오르는 초록 빛',
  buff_ring: '이로운 지속 상태(재생·흡혈·반사·무적). 발밑에 도는 고리',
  crit_star: '치명타. 피격 지점에서 튀는 별 (impact 와 같이 나오므로 희고 날카롭게)',
  dodge_puff: "회피 성공. 발밑에서 중심 둘레로 퍼지는 먼지 ('회피!' 텍스트를 가리지 않게 낮게)",
  death_poof: '사망. 흩어지는 연기 (쓰러지는 몸을 완전히 가리지 않는다)',
  summon_circle: '소환물 등장. 바닥에서 솟는 소환진',
};

function useText(key: FxKey): string {
  const kind = fxKeyKind(key);
  if (kind === 'impact') {
    const s = key.slice('impact_'.length) as FxZoneSchool;
    return `${SCHOOL_KO[s] ?? s} 스킬 피해가 들어간 지점 (광역 폭발 0.25초 안에 전부 재생된다)`;
  }
  if (kind === 'cast') {
    const s = key.slice('cast_'.length) as FxZoneSchool;
    return `${SCHOOL_KO[s] ?? s} 스킬 시전 중 시전자 발밑 (유닛 아래에 깔린다)`;
  }
  if (kind === 'proj' && key.indexOf('proj_orb_') === 0) {
    const s = key.slice('proj_orb_'.length) as FxZoneSchool;
    return `${SCHOOL_KO[s] ?? s} 투사체 스킬. 오른쪽(진행 방향)으로 날아가는 기준으로 그린다`;
  }
  if (kind === 'zone_fill') {
    const s = key.slice('zone_fill_'.length) as FxZoneSchool;
    return `${SCHOOL_KO[s] ?? s} 장판 내부 채움 타일 (상하좌우로 이어 붙인다)`;
  }
  if (kind === 'zone_ring') {
    const p = parseRingFxKey(key);
    if (!p) return '장판 테두리';
    const users = RING_USERS.get(key) ?? [];
    const who = users.length > 0 ? ` — ${users.join(' · ')}` : '';
    return `${SCHOOL_KO[p.school] ?? p.school} 반경 ${radiusText(p.radius)} 광역 예고·장판 테두리${who}`;
  }
  return MISC_USE[key] ?? '';
}

// ───────────────────────── 표 만들기 ─────────────────────────

/** 한글·한자·전각 문자는 터미널에서 두 칸을 차지한다 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number, right = false): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(s)));
  return right ? fill + s : s + fill;
}

interface Row {
  key: FxKey;
  frame: string;
  sheet: string;
  frames: string;
  fps: string;
  sec: string;
  blend: string;
  loop: string;
  anchor: string;
  use: string;
}

function rowOf(key: FxKey, meta: FxMeta): Row {
  return {
    key,
    frame: `${meta.frameW}×${meta.frameH}`,
    sheet: `${meta.frameW * meta.frames}×${meta.frameH}`,
    frames: String(meta.frames),
    fps: String(meta.fps),
    sec: fxDurationSec(meta).toFixed(3),
    blend: meta.blend,
    loop: meta.loop ? '반복' : '1회',
    anchor: `(${meta.anchor.x},${meta.anchor.y})`,
    use: useText(key),
  };
}

const HEADER: Row = {
  key: '키',
  frame: '프레임 크기',
  sheet: '시트 크기',
  frames: '프레임',
  fps: 'fps',
  sec: '초',
  blend: 'blend',
  loop: 'loop',
  anchor: 'anchor',
  use: '쓰임',
};

const COLUMNS: { field: keyof Row; right: boolean }[] = [
  { field: 'key', right: false },
  { field: 'frame', right: true },
  { field: 'sheet', right: true },
  { field: 'frames', right: true },
  { field: 'fps', right: true },
  { field: 'sec', right: true },
  { field: 'blend', right: false },
  { field: 'loop', right: false },
  { field: 'anchor', right: false },
  { field: 'use', right: false },
];

/** 전체 행을 같은 폭으로 맞춘다 (절이 달라도 표가 어긋나지 않는다) */
function widths(rows: Row[]): number[] {
  return COLUMNS.map((c) => {
    let w = displayWidth(HEADER[c.field]);
    for (const r of rows) w = Math.max(w, displayWidth(r[c.field]));
    return w;
  });
}

function renderRow(r: Row, w: number[]): string {
  const cells = COLUMNS.map((c, i) => pad(r[c.field], w[i], c.right));
  return cells.join('  ').replace(/\s+$/, '');
}

// ───────────────────────── 절 나누기 ─────────────────────────

interface Section {
  title: string;
  note: string;
  keys: FxKey[];
}

function sectionsOf(keys: readonly FxKey[]): Section[] {
  const pick = (fn: (k: FxKey) => boolean): FxKey[] => keys.filter(fn);
  return [
    {
      title: 'A. 피격 폭발 impact_<계열>',
      note: '중심 섬광(1~2) → 파편 확산(3~4) → 잔광 소멸(5~6) 3단 구성. 앵커가 폭발 지점에 놓인다.',
      keys: pick((k) => fxKeyKind(k) === 'impact'),
    },
    {
      title: 'B. 투사체 proj_*',
      note: '오른쪽(진행 방향) 기준으로 그린다. 코드가 앵커를 축으로 회전시킨다. 머리는 오른쪽, 꼬리는 왼쪽.',
      keys: pick((k) => fxKeyKind(k) === 'proj'),
    },
    {
      title: 'C. 시전 cast_<계열>',
      note: '시전자 발밑에 깔린다 (유닛 아래). 위로 솟는 그림이 아니라 바닥에 붙은 마법진·기류.',
      keys: pick((k) => fxKeyKind(k) === 'cast'),
    },
    {
      title: 'D. 근접 베기 slash_*',
      note: '앵커 (16,32) = 시전자의 손. 호가 이 점을 중심으로 돌고 칼날은 오른쪽으로 뻗는다. 위아래 대칭에 가깝게.',
      keys: pick((k) => fxKeyKind(k) === 'slash'),
    },
    {
      title: 'E-1. 장판 테두리 zone_ring_<계열>_r<반경×10>',
      note:
        '반경마다 그 크기 그대로 그린 원 한 장이다. 늘리지도 이어 붙이지도 않는다.\n' +
        '    프레임 한 변 = 반경 × 2 × 32 px 의 정사각형. 원의 중심이 프레임 중앙(앵커)이고 테두리가 프레임 가장자리에 닿는다.\n' +
        '    반경이 커져도 선 굵기는 그대로다 (1~2 px). 원이 길어질 뿐이다. 안쪽은 비워 둔다 (zone_fill 이 채운다).\n' +
        '    이 목록은 게임 데이터에서 자동으로 만들어진다 — 스킬 반경이 바뀌면 여기도 바뀐다.',
      keys: pick((k) => fxKeyKind(k) === 'zone_ring'),
    },
    {
      title: 'E-2. 장판 내부 타일 zone_fill_<계열>',
      note:
        '상하좌우로 이어 붙여도 이음매가 보이지 않아야 한다 (x=31 다음이 x=0, y=31 다음이 y=0).\n' +
        '    앵커는 (0,0) = 타일 원점. 덮인 면적 30~60% 로 성기게 그려 지형과 유닛 발이 비쳐 보이게 한다.',
      keys: pick((k) => fxKeyKind(k) === 'zone_fill'),
    },
    {
      title: 'F. 상태 status_*',
      note: 'stun·burn 은 머리 위(유닛 위), freeze·shield 는 발밑(유닛 아래). 1~8초 이어지므로 첫·마지막 프레임을 이어 준다.',
      keys: pick((k) => fxKeyKind(k) === 'status'),
    },
    {
      title: 'G. 기타',
      note: '단발 연출. crit_star 는 impact 와 겹쳐 나오므로 흰 계열의 작고 날카로운 형태로.',
      keys: pick((k) => fxKeyKind(k) === 'misc'),
    },
  ].filter((s) => s.keys.length > 0);
}

// ───────────────────────── 실행 ─────────────────────────

const argv = process.argv.slice(2);
const wantJson = argv.indexOf('--json') >= 0;
const wantKeys = argv.indexOf('--keys') >= 0;
const wantHelp = argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0;

if (wantHelp) {
  console.log(
    [
      '사용법: npm run effects:list [-- --keys | --json]',
      '  (없음)   키마다 크기·프레임·fps·재생 시간·blend·loop·anchor·쓰임을 표로 출력한다',
      '  --keys   키 이름만 한 줄에 하나씩 출력한다 (스크립트용)',
      '  --json   JSON 배열로 출력한다 (도구용)',
    ].join('\n'),
  );
  process.exit(0);
}

if (wantKeys) {
  console.log(FX_KEYS.join('\n'));
  process.exit(0);
}

if (wantJson) {
  const out = FX_KEYS.map((key) => {
    const m = FX_DEFAULT_META[key];
    return {
      key,
      kind: fxKeyKind(key),
      frameW: m.frameW,
      frameH: m.frameH,
      sheetW: m.frameW * m.frames,
      sheetH: m.frameH,
      frames: m.frames,
      fps: m.fps,
      durationSec: Number(fxDurationSec(m).toFixed(3)),
      blend: m.blend,
      loop: m.loop,
      anchor: { x: m.anchor.x, y: m.anchor.y },
      use: useText(key),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const allRows = FX_KEYS.map((k) => rowOf(k, FX_DEFAULT_META[k]));
const w = widths(allRows);
const byKey = new Map<FxKey, Row>();
for (let i = 0; i < FX_KEYS.length; i++) byKey.set(FX_KEYS[i], allRows[i]);

const lines: string[] = [];
lines.push(`스킬 이펙트 에셋 목록 — 총 ${FX_KEYS.length}종 (장판 테두리 ${FX_RING_KEYS.length}종 포함)`);
lines.push('제작 규격 전문: docs/EFFECTS.md  ·  코드 계약: src/ui/pixel/fx/fxTypes.ts (FX_KEYS · FX_DEFAULT_META)');
lines.push('');
lines.push('공통 규칙');
lines.push('  · 1 맵 유닛 = 32 px (캐릭터 스프라이트와 같은 배율). 시트는 늘려 그리지 않는다 (1:1).');
lines.push('  · 시트는 한 줄(1행). 프레임을 왼쪽 → 오른쪽으로 나열한다. 시트 폭 = 프레임 폭 × 프레임 수, 남는 칸 없음.');
lines.push('  · 투명 PNG. 알파는 0 또는 255 만 (반투명·안티앨리어싱·블러 금지). 정수 픽셀.');
lines.push('  · anchor 는 프레임 안의 기준점이고, 이 점이 맵 좌표에 놓인다.');
lines.push("  · blend 'add' = 가산 합성(빛나는 것), 'normal' = 일반. 물리(phys)·중립(neutral)·연기·먼지는 normal.");
lines.push('  · 파일 두 개를 public/effects/ 바로 아래에 넣는다: <키>.png 와 <키>.json (JSON 값 = 이 표의 값).');
lines.push('  · 넣은 키만 제작 에셋으로 바뀌고 나머지는 코드 생성 임시 이펙트가 계속 나온다.');

for (const sec of sectionsOf(FX_KEYS)) {
  lines.push('');
  lines.push(`── ${sec.title} — ${sec.keys.length}종 ──`);
  lines.push(`    ${sec.note}`);
  lines.push('');
  lines.push(renderRow(HEADER, w));
  for (const k of sec.keys) lines.push(renderRow(byKey.get(k) as Row, w));
}

lines.push('');
lines.push('── 제작 우선순위 ──');
lines.push(`  1순위 ${FX_PRIORITY_1.length}종 (가장 자주 보인다): ${FX_PRIORITY_1.join(' ')}`);
lines.push(`  2순위 ${FX_PRIORITY_2.length}종 (광역기 연출): ${FX_PRIORITY_2.join(' ')}`);
lines.push(`  3순위 ${FX_PRIORITY_3.length}종 (있으면 좋은 것): ${FX_PRIORITY_3.join(' ')}`);
lines.push('');
lines.push('만든 뒤에는 npm run effects:check 로 규격을 검사한다.');

console.log(lines.join('\n'));
