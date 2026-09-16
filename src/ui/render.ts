/**
 * 전투 관전 캔버스 렌더러 (FM 모바일 스타일).
 * 시뮬레이션 프레임(BattleFrame)만 받아서 그린다. 시뮬레이션 상태를 바꾸지 않는다.
 *
 * v0.5: 광역 영역(BattleFrame.zones)을 그린다 (GDD §6.5.5).
 *  - telegraph: 시전자 팀 색 점선 테두리 + 안쪽이 progress 만큼 채워지는 원/직사각형
 *  - flash: impact 직후 밝은 폭발 플래시
 *  - active: 장판. 반투명 채움 + 가장자리 흐름
 *  - 'dodge' 이벤트: 해당 유닛 위에 '회피!'
 * 한 팀이 6명 이상(몬스터 1~8인 대열)이면 이름 글씨와 HP 바를 줄여 겹침을 줄인다.
 *
 * v0.6: 스킬명 외치기 연출.
 *  - 'skill' 이벤트가 오면 시전자 머리 위에 말풍선(「메테오!」)을 띄운다. 시뮬레이션 시간 기준 SHOUT_LIFE_SEC 유지,
 *    처음 SHOUT_POP_SEC 동안 확대(팝) 후 서서히 위로 떠오르며 사라진다. 배속과 무관하게 sim 시간으로만 진행한다.
 *  - 흰 바탕 둥근 사각형 + 시전자 팀 색 테두리 + 굵은 글씨. 광역·장판 스킬은 글씨가 더 크고 테두리가 두껍다.
 *  - 시전자 원은 PULSE_SEC 동안 PULSE_MULT 배로 커졌다 돌아온다. 같은 유닛이 연속 시전하면 이전 말풍선을 즉시 교체한다.
 */
import type { BattleEvent, BattleFrame, BattleInput, MapDef, MonsterTier, StatusKind, Team, TeamSide, UnitSnapshot, ZoneSnapshot } from '../core/types';
import { JOB_GLYPH, MONSTER_GLYPH, isZoneSkillId, skillName } from './format';

/** 고정 순회 순서 */
const SIDES: readonly TeamSide[] = ['A', 'B'];

const TEAM_COLOR: Record<TeamSide, string> = { A: '#4f8cff', B: '#ff5a5a' };
const TEAM_COLOR_LIGHT: Record<TeamSide, string> = { A: '#a7c4ff', B: '#ffb0b0' };
const TEAM_COLOR_DARK: Record<TeamSide, string> = { A: '#1f3f80', B: '#802626' };

/** 몬스터 본체 색: 짙은 자주 → 검붉은색 (난이도가 올라갈수록 붉어진다) */
const MONSTER_COLOR: Record<MonsterTier, string> = { low: '#5f2a52', mid: '#75203f', high: '#8a1622' };
/** 몬스터 외곽선 색 */
const MONSTER_EDGE: Record<MonsterTier, string> = { low: '#c98fd0', mid: '#ef6f92', high: '#ffb347' };
/** 난이도별 반경 배율 (보스는 여기에 BOSS_RADIUS_MULT 를 더 곱한다) */
const MONSTER_RADIUS_MULT: Record<MonsterTier, number> = { low: 0.95, mid: 1.05, high: 1.15 };
const BOSS_RADIUS_MULT = 1.45;

/** 몬스터 렌더링 정보: 캐릭터 id → 난이도 */
export type MonsterTierMap = Record<string, MonsterTier>;

/** 팀 목록에서 몬스터 유닛(Character.monster)의 난이도 맵을 만든다 */
export function monsterTiersOfTeams(teams: readonly (Team | null | undefined)[]): MonsterTierMap {
  const out: MonsterTierMap = {};
  for (const t of teams) {
    if (!t) continue;
    for (const c of t.members) {
      if (c.monster) out[c.id] = c.monster.tier;
    }
  }
  return out;
}

/** 전투 입력에서 몬스터 난이도 맵을 만든다 */
export function monsterTiersOfInput(input: BattleInput): MonsterTierMap {
  return monsterTiersOfTeams([input.teamA, input.teamB]);
}

const STATUS_DOT: Partial<Record<StatusKind, string>> = {
  stun: '#ffd54a',
  burn: '#ff8c2a',
  poison: '#6ee06e',
  freeze: '#5ee7ff',
  slow: '#b0c4de',
  silence: '#c77dff',
  taunt: '#ff6ad5',
  regen: '#a4ff9c',
  lifesteal: '#ff4d6d',
  reflect: '#ffe08a',
  invuln: '#ffffff',
};

/** 이벤트 플로팅 텍스트 유지 시간 (시뮬레이션 초) */
const FLOAT_LIFE_SEC = 0.6;
const MAX_FLOATS = 80;

/** 한 팀의 (소환물 제외) 유닛 수가 이 값을 넘으면 이름·HP 바를 축소한다 */
const DENSE_UNIT_THRESHOLD = 5;
/** 이름 글씨 크기 (맵 단위 배율): 보통 / 밀집 */
const NAME_FONT_SCALE = 0.42;
const NAME_FONT_SCALE_DENSE = 0.32;
/** HP 바 폭 (맵 단위): 보통 / 밀집. 밀집 값은 8기 대열의 열 간격(1.4)보다 좁아야 이웃과 겹치지 않는다 */
const HP_BAR_W = 2.4;
const HP_BAR_W_DENSE = 1.3;
/** 밀집 대열의 열 간격 (맵 단위). 이름표를 열마다 한 줄씩 엇갈려 놓는 기준 */
const DENSE_COLUMN_GAP = 1.4;
/** 캐릭터 반경 (맵 단위): 보통 / 밀집 */
const UNIT_RADIUS = 0.9;
const UNIT_RADIUS_DENSE = 0.78;

/** 폭발 플래시의 심 색. 팀 색 테두리가 바깥으로 퍼진다 */
const ZONE_FLASH_CORE = '#ffffff';
/** 밀집 표시용 짧은 이름: 몬스터 개체 접미사('슬라임 A' → 'A')만 남긴다. 접미사가 없으면 그대로 */
function denseLabel(name: string): string {
  const m = /\s([A-Z])$/.exec(name);
  return m ? m[1] : name;
}

/** '회피!' 텍스트 색 */
const DODGE_COLOR = '#8ef0ff';

/** 스킬명 말풍선 유지 시간 (시뮬레이션 초) */
const SHOUT_LIFE_SEC = 1.2;
/** 말풍선 팝(확대) 구간 (시뮬레이션 초) */
const SHOUT_POP_SEC = 0.15;
/** 시전자 원 펄스 지속 시간 (시뮬레이션 초) 과 최대 배율 */
const PULSE_SEC = 0.2;
const PULSE_MULT = 1.25;
/** 말풍선 글씨 크기 (맵 단위 배율): 일반 / 광역 */
const SHOUT_FONT_SCALE = 0.5;
const SHOUT_FONT_SCALE_ZONE = 0.68;
/** 말풍선 테두리 두께 (맵 단위 배율): 일반 / 광역 */
const SHOUT_BORDER_SCALE = 0.08;
const SHOUT_BORDER_SCALE_ZONE = 0.16;
/** 말풍선이 떠오르는 거리 (맵 단위) */
const SHOUT_RISE = 1.1;
/** 말풍선 바탕 / 글씨 색 */
const SHOUT_BG = '#ffffff';
const SHOUT_TEXT = '#1a1f2b';

/** 시전자별 스킬명 외치기 상태. 한 시전자에 하나만 유지된다 */
interface Shout {
  casterId: string;
  skillId: string;
  text: string;
  /** 시전 시각 (시뮬레이션 초) */
  startTime: number;
  isZone: boolean;
  /** 시전자를 못 찾을 때 쓰는 위치 (맵 단위) */
  x: number;
  y: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number; // 시뮬레이션 시간
  big: boolean;
  jitter: number;
}

export class BattleRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private floats: FloatText[] = [];
  /** 스킬명 말풍선. 시전자당 최대 1개. 배열 순서 = 최근 시전 순 (표시 전용) */
  private shouts: Shout[] = [];
  private lastTick = -1;
  private summonIds = new Set<string>();
  /** 팀별 보스(몬스터 중 최대 HP) 유닛 id. 첫 draw 에서 한 번 계산한다 */
  private bossIds: Set<string> | null = null;
  /** 어느 한 팀이 DENSE_UNIT_THRESHOLD 명을 넘는가 (이름·HP 바 축소). 매 draw 에서 갱신 */
  private dense = false;

  /**
   * @param monsters 캐릭터 id → 몬스터 난이도. 몬스터 전투에서만 채워 넣는다.
   *                 (UnitSnapshot 에는 몬스터 정보가 없으므로 밖에서 알려준다)
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MapDef,
    private readonly monsters: MonsterTierMap = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 만들 수 없습니다.');
    this.ctx = ctx;
    this.ensureSize();
  }

  /** 이 유닛이 몬스터면 난이도, 아니면 null */
  private tierOf(u: UnitSnapshot): MonsterTier | null {
    if (u.job === 'summon') return null;
    return this.monsters[u.id] ?? null;
  }

  /** 각 팀에서 최대 HP 를 가진 몬스터를 보스로 본다 */
  private ensureBosses(frame: BattleFrame): void {
    if (this.bossIds) return;
    const ids = new Set<string>();
    for (const side of SIDES) {
      let best: UnitSnapshot | null = null;
      for (const u of frame.units) {
        if (u.side !== side) continue;
        if (!this.tierOf(u)) continue;
        if (!best || u.maxHp > best.maxHp) best = u;
      }
      if (best) ids.add(best.id);
    }
    this.bossIds = ids;
  }

  /** 컨테이너 폭에 맞춰 내부 해상도를 40:30 비율로 맞춘다 */
  private ensureSize(): void {
    const cssWidth = this.canvas.clientWidth || this.canvas.width || 640;
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const w = Math.max(200, Math.round(cssWidth * dpr));
    const hgt = Math.round((w * this.map.height) / this.map.width);
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
  }

  private get scale(): number {
    return this.canvas.width / this.map.width;
  }

  draw(frame: BattleFrame): void {
    this.ensureSize();
    const s = this.scale;
    const ctx = this.ctx;

    const byId = new Map<string, UnitSnapshot>();
    for (const u of frame.units) {
      byId.set(u.id, u);
      if (u.job === 'summon') this.summonIds.add(u.id);
    }

    this.ensureBosses(frame);
    this.dense = isDenseFrame(frame);

    if (frame.tick !== this.lastTick) {
      this.ingestEvents(frame.events, byId);
      this.lastTick = frame.tick;
    }
    // 오래된 플로팅 텍스트·말풍선 제거 (시뮬레이션 시간 기준. 리플레이·배속에서도 동일)
    this.floats = this.floats.filter((f) => frame.timeSec - f.born < FLOAT_LIFE_SEC);
    this.shouts = this.shouts.filter((sh) => frame.timeSec - sh.startTime < SHOUT_LIFE_SEC && frame.timeSec >= sh.startTime);

    ctx.save();
    this.drawBackground(s);
    this.drawCapture(frame, s);
    this.drawVision(frame, s);

    // 광역 영역: 예고·장판은 유닛 아래, 폭발 플래시는 유닛 위에 그린다
    const zones: ZoneSnapshot[] = frame.zones ?? [];
    for (const z of zones) {
      if (z.phase === 'telegraph') this.drawTelegraph(z, s, frame.timeSec);
      else if (z.phase === 'active') this.drawLinger(z, s, frame.timeSec);
    }

    // 죽은 유닛 → 소환물 → 캐릭터 순으로 그려서 캐릭터가 위에 오게 한다
    const dead = frame.units.filter((u) => !u.alive);
    const summons = frame.units.filter((u) => u.alive && u.job === 'summon');
    const chars = frame.units.filter((u) => u.alive && u.job !== 'summon');
    for (const u of dead) this.drawDead(u, s);
    for (const u of summons) this.drawUnit(u, s, frame, byId);
    for (const u of chars) this.drawUnit(u, s, frame, byId);

    for (const z of zones) if (z.phase === 'flash') this.drawFlash(z, s);

    this.drawFloats(frame.timeSec, s);
    this.drawShouts(frame.timeSec, s, byId);
    this.drawOverlay(frame, s);
    ctx.restore();
  }

  // ───────────── 이벤트 → 플로팅 텍스트 ─────────────

  private ingestEvents(events: BattleEvent[], byId: Map<string, UnitSnapshot>): void {
    let n = 0;
    for (const e of events) {
      n++;
      const jitter = ((n * 37) % 11) / 10 - 0.5; // 결정적 좌우 흔들림 (표시 전용)
      switch (e.kind) {
        case 'attack': {
          const u = byId.get(e.to);
          if (!u) break;
          if (e.miss) {
            this.pushFloat(u.x, u.y, '회피', '#cfd8dc', false, e.t, jitter);
          } else {
            const txt = e.crit ? `${Math.round(e.damage)}!` : `${Math.round(e.damage)}`;
            const color = e.school === 'magic' ? '#c9a6ff' : '#ffffff';
            this.pushFloat(u.x, u.y, txt, e.crit ? '#ffd54a' : color, e.crit, e.t, jitter);
          }
          break;
        }
        case 'heal': {
          const u = byId.get(e.to);
          if (!u) break;
          this.pushFloat(u.x, u.y, `+${Math.round(e.amount)}`, '#7cf59a', false, e.t, jitter);
          break;
        }
        case 'skill': {
          // 스킬명 외치기: 플로팅 텍스트 대신 시전자 머리 위 말풍선 + 원 펄스
          const u = byId.get(e.from);
          this.pushShout(e.from, e.skillId, u ? u.x : e.x, u ? u.y : e.y, e.t);
          break;
        }
        case 'kill': {
          const u = byId.get(e.victim);
          if (!u) break;
          this.pushFloat(u.x, u.y - 0.8, '격파', '#ff8a80', true, e.t, 0);
          break;
        }
        case 'status': {
          if (!e.applied) break;
          const u = byId.get(e.to);
          if (!u) break;
          const label = STATUS_LABEL[e.status];
          if (label) this.pushFloat(u.x, u.y + 0.6, label, STATUS_DOT[e.status] ?? '#ffffff', false, e.t, jitter);
          break;
        }
        case 'summon': {
          const u = byId.get(e.unitId) ?? byId.get(e.owner);
          if (!u) break;
          this.pushFloat(u.x, u.y, '소환', '#b3e5fc', false, e.t, jitter);
          break;
        }
        case 'dodge': {
          const u = byId.get(e.unit);
          if (!u) break;
          this.pushFloat(u.x, u.y - 0.5, '회피!', DODGE_COLOR, true, e.t, 0);
          break;
        }
        case 'zone':
          // 영역 자체는 frame.zones 로 그린다. 스킬 이름은 'skill' 이벤트가 이미 띄운다
          break;
        default:
          break;
      }
    }
  }

  private pushFloat(x: number, y: number, text: string, color: string, big: boolean, born: number, jitter: number): void {
    this.floats.push({ x, y, text, color, born, big, jitter });
    if (this.floats.length > MAX_FLOATS) this.floats.splice(0, this.floats.length - MAX_FLOATS);
  }

  /** 시전자의 말풍선을 새로 만든다. 같은 시전자의 이전 말풍선은 즉시 교체된다 */
  private pushShout(casterId: string, skillId: string, x: number, y: number, startTime: number): void {
    for (let i = this.shouts.length - 1; i >= 0; i--) {
      if (this.shouts[i].casterId === casterId) this.shouts.splice(i, 1);
    }
    this.shouts.push({ casterId, skillId, text: `${skillName(skillId)}!`, startTime, isZone: isZoneSkillId(skillId), x, y });
  }

  /** 시전 직후 원 펄스 배율 (1 → PULSE_MULT → 1, PULSE_SEC 동안). 시전 중이 아니면 1 */
  private pulseOf(unitId: string, now: number): number {
    for (let i = this.shouts.length - 1; i >= 0; i--) {
      const sh = this.shouts[i];
      if (sh.casterId !== unitId) continue;
      const age = now - sh.startTime;
      if (age < 0 || age >= PULSE_SEC) return 1;
      return 1 + (PULSE_MULT - 1) * Math.sin(Math.PI * (age / PULSE_SEC));
    }
    return 1;
  }

  // ───────────── 배경 ─────────────

  private drawBackground(s: number): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    switch (this.map.id) {
      case 'plains': {
        ctx.fillStyle = '#2f6b3a';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        for (let i = 0; i < this.map.height; i += 4) ctx.fillRect(0, i * s, W, 2 * s);
        break;
      }
      case 'dark': {
        ctx.fillStyle = '#10162b';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        for (let i = 0; i < 40; i++) {
          // 고정 패턴의 별 (표시 전용)
          const x = ((i * 977) % this.map.width) + 0.5;
          const y = ((i * 613) % this.map.height) + 0.5;
          ctx.fillRect(x * s, y * s, Math.max(1, s * 0.08), Math.max(1, s * 0.08));
        }
        break;
      }
      case 'desert': {
        ctx.fillStyle = '#c9a25c';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(120,80,20,0.18)';
        ctx.lineWidth = Math.max(1, s * 0.1);
        for (let i = 0; i < 6; i++) {
          ctx.beginPath();
          const y0 = (i * 5 + 3) * s;
          ctx.moveTo(0, y0);
          for (let x = 0; x <= this.map.width; x += 2) {
            ctx.lineTo(x * s, y0 + Math.sin((x + i * 3) * 0.6) * s * 0.8);
          }
          ctx.stroke();
        }
        break;
      }
      case 'glacier': {
        ctx.fillStyle = '#a9d6e5';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = Math.max(1, s * 0.08);
        for (let i = 0; i < 7; i++) {
          ctx.beginPath();
          const x0 = ((i * 7 + 2) % this.map.width) * s;
          ctx.moveTo(x0, 0);
          ctx.lineTo(x0 + (i % 2 === 0 ? 4 : -3) * s, H);
          ctx.stroke();
        }
        break;
      }
      default: {
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, W, H);
      }
    }

    // 희미한 격자
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.map.width; x += 5) {
      ctx.moveTo(x * s, 0);
      ctx.lineTo(x * s, H);
    }
    for (let y = 0; y <= this.map.height; y += 5) {
      ctx.moveTo(0, y * s);
      ctx.lineTo(W, y * s);
    }
    ctx.stroke();

    // 중앙선
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([s * 0.5, s * 0.5]);
    ctx.beginPath();
    ctx.moveTo((this.map.width / 2) * s, 0);
    ctx.lineTo((this.map.width / 2) * s, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ───────────── 거점 ─────────────

  private drawCapture(frame: BattleFrame, s: number): void {
    const cap = this.map.capture;
    if (!cap) return;
    const ctx = this.ctx;
    const cx = cap.x * s;
    const cy = cap.y * s;
    const r = cap.radius * s;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = frame.capture?.holder ? hexToRgba(TEAM_COLOR[frame.capture.holder], 0.18) : 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, s * 0.15);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.stroke();

    if (frame.capture) {
      const ringR = r + s * 0.45;
      ctx.lineWidth = Math.max(2, s * 0.25);
      // A 진행: 위쪽에서 시계 방향
      if (frame.capture.progressA > 0) {
        ctx.beginPath();
        ctx.strokeStyle = TEAM_COLOR.A;
        ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frame.capture.progressA));
        ctx.stroke();
      }
      // B 진행: 위쪽에서 반시계 방향
      if (frame.capture.progressB > 0) {
        ctx.beginPath();
        ctx.strokeStyle = TEAM_COLOR.B;
        ctx.arc(cx, cy, ringR + ctx.lineWidth * 1.1, -Math.PI / 2, -Math.PI / 2 - Math.PI * 2 * Math.min(1, frame.capture.progressB), true);
        ctx.stroke();
      }
    }

    // 거점 표시 깃발
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `${Math.max(9, s * 0.7)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('거점', cx, cy);
  }

  // ───────────── 시야 (어둠 맵) ─────────────

  private drawVision(frame: BattleFrame, s: number): void {
    if (this.map.visionRadius <= 0) return;
    const ctx = this.ctx;
    const vr = this.map.visionRadius * s;
    for (const u of frame.units) {
      if (!u.alive) continue;
      ctx.beginPath();
      ctx.arc(u.x * s, u.y * s, vr, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(TEAM_COLOR[u.side], 0.05);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(TEAM_COLOR[u.side], 0.14);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ───────────── 유닛 ─────────────

  /** 유닛 반경 (맵 단위 × s). 몬스터는 난이도/보스 여부에 따라 커진다 */
  private radiusOf(u: UnitSnapshot, s: number): number {
    if (u.job === 'summon') return 0.55 * s;
    const base = this.dense ? UNIT_RADIUS_DENSE : UNIT_RADIUS;
    const tier = this.tierOf(u);
    if (!tier) return base * s;
    const boss = this.bossIds?.has(u.id) ? BOSS_RADIUS_MULT : 1;
    return base * s * MONSTER_RADIUS_MULT[tier] * boss;
  }

  /** 이름 글씨 크기 (px). 밀집 시 축소 */
  private nameFontPx(s: number): number {
    return Math.max(8, s * (this.dense ? NAME_FONT_SCALE_DENSE : NAME_FONT_SCALE));
  }

  private drawDead(u: UnitSnapshot, s: number): void {
    const ctx = this.ctx;
    const x = u.x * s;
    const y = u.y * s;
    const r = this.radiusOf(u, s);
    const tier = this.tierOf(u);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = tier ? MONSTER_EDGE[tier] : TEAM_COLOR[u.side];
    ctx.lineWidth = Math.max(1.5, s * 0.18);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, y - r * 0.7);
    ctx.lineTo(x + r * 0.7, y + r * 0.7);
    ctx.moveTo(x + r * 0.7, y - r * 0.7);
    ctx.lineTo(x - r * 0.7, y + r * 0.7);
    ctx.stroke();
    if (u.job !== 'summon') {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${this.nameFontPx(s)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(u.name, x, y + r * 0.95);
    }
    ctx.restore();
  }

  private drawUnit(u: UnitSnapshot, s: number, frame: BattleFrame, byId: Map<string, UnitSnapshot>): void {
    const ctx = this.ctx;
    const isSummon = u.job === 'summon';
    const tier = this.tierOf(u);
    const isBoss = tier !== null && !!this.bossIds?.has(u.id);
    const x = u.x * s;
    const y = u.y * s;
    // 스킬 시전 직후 PULSE_SEC 동안 원이 커졌다 돌아온다 (시뮬레이션 시간 기준)
    const r = this.radiusOf(u, s) * this.pulseOf(u.id, frame.timeSec);

    const stealthed = u.statuses.some((st) => st.kind === 'stealth');
    const shield = u.statuses.find((st) => st.kind === 'shield');
    const frozen = u.statuses.some((st) => st.kind === 'freeze');
    const stunned = u.statuses.some((st) => st.kind === 'stun');
    const invuln = u.statuses.some((st) => st.kind === 'invuln');

    ctx.save();
    if (stealthed) ctx.globalAlpha = 0.5;

    // 타겟 라인 (희미하게)
    if (u.targetId && !isSummon) {
      const tgt = byId.get(u.targetId);
      if (tgt && tgt.alive) {
        ctx.strokeStyle = hexToRgba(TEAM_COLOR[u.side], 0.18);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(tgt.x * s, tgt.y * s);
        ctx.stroke();
      }
    }

    // 보스 후광 (몬스터 팀에서 가장 HP 가 높은 개체)
    if (isBoss && tier) {
      ctx.beginPath();
      ctx.arc(x, y, r + s * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(MONSTER_EDGE[tier], 0.14);
      ctx.fill();
    }

    // 본체
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = tier ? MONSTER_COLOR[tier] : isSummon ? TEAM_COLOR_LIGHT[u.side] : TEAM_COLOR[u.side];
    ctx.fill();
    ctx.lineWidth = Math.max(1, s * (tier ? 0.16 : 0.12));
    ctx.strokeStyle = frozen ? '#5ee7ff' : stunned ? '#ffd54a' : tier ? MONSTER_EDGE[tier] : 'rgba(0,0,0,0.45)';
    ctx.stroke();

    // 보스 표시: 바깥 점선 링
    if (isBoss && tier) {
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([s * 0.3, s * 0.25]);
      ctx.arc(x, y, r + s * 0.3, 0, Math.PI * 2);
      ctx.strokeStyle = MONSTER_EDGE[tier];
      ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.stroke();
      ctx.restore();
    }

    // 방향 표시
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(u.facing) * r * 0.6, y + Math.sin(u.facing) * r * 0.6);
    ctx.lineTo(x + Math.cos(u.facing) * r * 1.15, y + Math.sin(u.facing) * r * 1.15);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(1, s * 0.1);
    ctx.stroke();

    // 보호막 / 무적 링
    if (shield || invuln) {
      ctx.beginPath();
      ctx.arc(x, y, r + s * 0.22, 0, Math.PI * 2);
      ctx.strokeStyle = invuln ? 'rgba(255,255,255,0.9)' : 'rgba(120,200,255,0.9)';
      ctx.lineWidth = Math.max(1, s * 0.12);
      ctx.stroke();
    }

    // 시전 아크
    if (u.casting) {
      ctx.beginPath();
      ctx.arc(x, y, r + s * 0.38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, u.casting.progress)));
      ctx.strokeStyle = '#ffe082';
      ctx.lineWidth = Math.max(1.5, s * 0.16);
      ctx.stroke();
    }

    // 직업(또는 몬스터) 글리프
    const glyph = tier ? MONSTER_GLYPH[tier] : u.job === 'summon' ? '·' : JOB_GLYPH[u.job] ?? '?';
    ctx.fillStyle = tier ? '#ffe3ef' : '#ffffff';
    ctx.font = `bold ${Math.max(9, r * 1.05)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, x, y + (isSummon ? 0 : r * 0.02));

    // HP 바 (밀집 시 조금 좁게)
    const barW = (isSummon ? 1.6 : isBoss ? 3.2 : this.dense ? HP_BAR_W_DENSE : HP_BAR_W) * s;
    const barH = Math.max(2, s * 0.28);
    const bx = x - barW / 2;
    const by = y - r - barH - s * 0.25;
    const ratio = u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = ratio > 0.5 ? '#5bd66b' : ratio > 0.25 ? '#ffc247' : '#ff5252';
    ctx.fillRect(bx, by, barW * ratio, barH);
    if (shield && u.maxHp > 0) {
      const sh = Math.min(1, shield.value / u.maxHp);
      ctx.fillStyle = 'rgba(120,200,255,0.8)';
      ctx.fillRect(bx, by - Math.max(1, barH * 0.4), barW * sh, Math.max(1, barH * 0.4));
    }
    // MP 바 (캐릭터만, 얇게)
    if (!isSummon && u.maxMp > 0) {
      const mh = Math.max(1, barH * 0.4);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(bx, by + barH, barW, mh);
      ctx.fillStyle = '#6fa8ff';
      ctx.fillRect(bx, by + barH, barW * Math.max(0, Math.min(1, u.mp / u.maxMp)), mh);
    }

    // 상태 점
    const dots = u.statuses.filter((st) => STATUS_DOT[st.kind]);
    if (dots.length > 0) {
      const dr = Math.max(1.5, s * 0.16);
      const startX = x - ((dots.length - 1) * dr * 2.4) / 2;
      const dy = by - s * 0.3 - (shield ? barH * 0.4 : 0);
      for (let i = 0; i < dots.length; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * dr * 2.4, dy, dr, 0, Math.PI * 2);
        ctx.fillStyle = STATUS_DOT[dots[i].kind] ?? '#fff';
        ctx.fill();
      }
    }

    // 이름
    if (!isSummon) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${this.nameFontPx(s)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      // 밀집 시: 개체 접미사('슬라임 A' → 'A')만 쓰고, 이웃 열과 이름줄을 엇갈려 놓아 겹치지 않게 한다 (종 이름은 전투 제목에 있다)
      const label = this.dense ? denseLabel(u.name) : u.name;
      const stagger = this.dense && Math.round(u.x / DENSE_COLUMN_GAP) % 2 !== 0 ? this.nameFontPx(s) * 1.1 : 0;
      ctx.fillText(label, x, y + r + s * 0.1 + stagger);
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // ───────────── 광역 영역 (Zone) ─────────────

  /**
   * 영역 외곽 경로를 현재 path 에 만든다.
   * circle: 중심(x,y) 반경 radius × frac1. line: (x,y)→(x2,y2) 선분의 frac0~frac1 구간을 width 폭으로 감싼 직사각형.
   */
  private traceZone(z: ZoneSnapshot, s: number, frac0 = 0, frac1 = 1): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (z.shape === 'circle') {
      const r = Math.max(0, z.radius) * s * Math.max(0, frac1);
      if (r <= 0) return;
      ctx.arc(z.x * s, z.y * s, r, 0, Math.PI * 2);
      ctx.closePath();
      return;
    }
    const c = lineCorners(z, frac0, frac1);
    ctx.moveTo(c[0].x * s, c[0].y * s);
    ctx.lineTo(c[1].x * s, c[1].y * s);
    ctx.lineTo(c[2].x * s, c[2].y * s);
    ctx.lineTo(c[3].x * s, c[3].y * s);
    ctx.closePath();
  }

  /** 영역 중심 (라벨 위치) */
  private zoneCenter(z: ZoneSnapshot): { x: number; y: number } {
    if (z.shape === 'circle' || z.x2 === undefined || z.y2 === undefined) return { x: z.x, y: z.y };
    return { x: (z.x + z.x2) / 2, y: (z.y + z.y2) / 2 };
  }

  /** 예고: 팀 색 점선 테두리 + 안쪽이 진행률만큼 채워짐 */
  private drawTelegraph(z: ZoneSnapshot, s: number, now: number): void {
    const ctx = this.ctx;
    const color = TEAM_COLOR[z.side];
    const p = clamp01(z.progress);
    ctx.save();

    // 바탕: 희미한 채움
    this.traceZone(z, s);
    ctx.fillStyle = hexToRgba(color, 0.12);
    ctx.fill();

    // 진행률만큼 차오르는 안쪽 채움 (원은 중심에서 커지고, 직선은 시전자 쪽에서 뻗어 나간다)
    if (p > 0) {
      this.traceZone(z, s, 0, p);
      ctx.fillStyle = hexToRgba(color, 0.22 + 0.2 * p);
      ctx.fill();
    }

    // 점선 테두리 (천천히 돌아간다)
    this.traceZone(z, s);
    ctx.setLineDash([s * 0.4, s * 0.28]);
    ctx.lineDashOffset = -now * s * 1.6;
    ctx.lineWidth = Math.max(1.5, s * 0.13);
    ctx.strokeStyle = hexToRgba(color, 0.9);
    ctx.stroke();
    ctx.setLineDash([]);

    // 라벨: 스킬 이름 (영역이 어느 정도 클 때만)
    const big = z.shape === 'circle' ? z.radius >= 1.6 : (z.width ?? 0) >= 1.2;
    if (big) {
      const c = this.zoneCenter(z);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `${Math.max(8, s * 0.4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(skillName(z.skillId), c.x * s, c.y * s);
    }
    ctx.restore();
  }

  /** 폭발: impact 직후 밝은 플래시. progress 0→1 동안 사라진다 */
  private drawFlash(z: ZoneSnapshot, s: number): void {
    const ctx = this.ctx;
    const color = TEAM_COLOR[z.side];
    const p = clamp01(z.progress);
    const fade = 1 - p;
    ctx.save();
    // 밝은 심
    this.traceZone(z, s);
    ctx.fillStyle = hexToRgba(ZONE_FLASH_CORE, 0.55 * fade);
    ctx.fill();
    // 팀 색 테두리가 바깥으로 퍼진다
    this.traceZone(z, s, 0, 1 + 0.35 * p);
    ctx.lineWidth = Math.max(2, s * 0.22 * fade);
    ctx.strokeStyle = hexToRgba(color, 0.9 * fade);
    ctx.stroke();
    ctx.restore();
  }

  /** 장판: 반투명 채움 + 가장자리 흐름 */
  private drawLinger(z: ZoneSnapshot, s: number, now: number): void {
    const ctx = this.ctx;
    const color = TEAM_COLOR[z.side];
    const light = TEAM_COLOR_LIGHT[z.side];
    const p = clamp01(z.progress);
    ctx.save();

    // 채움 (끝나갈수록 옅어진다)
    this.traceZone(z, s);
    const pulse = 0.5 + 0.5 * Math.sin(now * 5);
    ctx.fillStyle = hexToRgba(color, (0.26 + 0.05 * pulse) * (1 - 0.5 * p));
    ctx.fill();

    // 안쪽 흐름: 원은 중심에서 퍼져 나가는 고리, 직선은 따라 흐르는 띠
    ctx.lineWidth = Math.max(1, s * 0.08);
    for (let i = 0; i < 3; i++) {
      const f = (now * 0.7 + i / 3) % 1;
      if (z.shape === 'circle') {
        this.traceZone(z, s, 0, f);
      } else {
        const w = 0.12;
        this.traceZone(z, s, Math.max(0, f - w), f);
      }
      ctx.strokeStyle = hexToRgba(light, 0.35 * (1 - f));
      ctx.stroke();
    }

    // 가장자리: 실선 + 흐르는 점선
    this.traceZone(z, s);
    ctx.lineWidth = Math.max(1.5, s * 0.12);
    ctx.strokeStyle = hexToRgba(color, 0.75);
    ctx.stroke();
    this.traceZone(z, s);
    ctx.setLineDash([s * 0.25, s * 0.35]);
    ctx.lineDashOffset = now * s * 2.2;
    ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.strokeStyle = hexToRgba(light, 0.9);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ───────────── 플로팅 텍스트 ─────────────

  private drawFloats(now: number, s: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    for (const f of this.floats) {
      const age = Math.max(0, now - f.born) / FLOAT_LIFE_SEC;
      const rise = age * 1.4 * s;
      ctx.globalAlpha = Math.max(0, 1 - age * age);
      ctx.fillStyle = f.color;
      ctx.font = `${f.big ? 'bold ' : ''}${Math.max(9, s * (f.big ? 0.75 : 0.55))}px sans-serif`;
      ctx.fillText(f.text, f.x * s + f.jitter * s, f.y * s - s * 1.2 - rise);
    }
    ctx.restore();
  }

  // ───────────── 스킬명 말풍선 ─────────────

  /**
   * 시전자 머리 위(HP 바·상태 점 위)에 스킬명 말풍선을 그린다.
   *  - 0 ~ SHOUT_POP_SEC: 작게 시작해 살짝 넘치게 커진다 (팝)
   *  - 이후: 위로 떠오르며 서서히 사라진다
   * 말풍선은 캔버스 안에 들어오도록 위치를 보정한다.
   */
  private drawShouts(now: number, s: number, byId: Map<string, UnitSnapshot>): void {
    if (this.shouts.length === 0) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const sh of this.shouts) {
      const age = now - sh.startTime;
      if (age < 0 || age >= SHOUT_LIFE_SEC) continue;
      const u = byId.get(sh.casterId);
      const ux = u ? u.x : sh.x;
      const uy = u ? u.y : sh.y;
      const side: TeamSide = u ? u.side : 'A';
      const r = u ? this.radiusOf(u, s) : UNIT_RADIUS * s;

      // 팝: 0.55 → 약 1.12 → 1.0. 이후 1.0 유지
      let scale: number;
      if (age < SHOUT_POP_SEC) {
        const p = age / SHOUT_POP_SEC;
        scale = 0.55 + 0.45 * Math.sin((Math.PI / 2) * p) + 0.12 * Math.sin(Math.PI * p);
      } else {
        scale = 1;
      }
      // 떠오름·페이드: 팝 뒤부터 남은 시간 동안
      const driftP = age <= SHOUT_POP_SEC ? 0 : (age - SHOUT_POP_SEC) / (SHOUT_LIFE_SEC - SHOUT_POP_SEC);
      const rise = SHOUT_RISE * s * driftP;
      const alpha = driftP < 0.45 ? 1 : Math.max(0, 1 - ((driftP - 0.45) / 0.55) ** 1.5);
      if (alpha <= 0) continue;

      const fontPx = Math.max(10, s * (sh.isZone ? SHOUT_FONT_SCALE_ZONE : SHOUT_FONT_SCALE)) * scale;
      const border = Math.max(1, s * (sh.isZone ? SHOUT_BORDER_SCALE_ZONE : SHOUT_BORDER_SCALE)) * scale;
      ctx.font = `bold ${fontPx}px sans-serif`;
      const textW = ctx.measureText(sh.text).width;
      const padX = fontPx * 0.5;
      const padY = fontPx * 0.28;
      const bw = textW + padX * 2;
      const bh = fontPx + padY * 2;
      const tail = Math.max(2, s * 0.22) * scale;
      const radius = Math.min(bh / 2, fontPx * 0.45);

      // 말풍선 바닥(꼬리 끝)이 HP 바·보호막 바·상태 점 위에 오게. drawUnit 과 같은 기하로 계산한다
      // (HP 바 위치·상태 점 줄 높이는 밀집 모드에서도 바뀌지 않으므로 dense 와 무관하게 같은 값).
      const barH = Math.max(2, s * 0.28);
      const barY = uy * s - r - barH - s * 0.25;
      const hasShield = u ? u.statuses.some((st) => st.kind === 'shield') : false;
      const dotsTop = barY - s * 0.3 - (hasShield ? barH * 0.4 : 0) - Math.max(1.5, s * 0.16);
      const anchorY = dotsTop - s * 0.08 - rise;
      let cx = ux * s;
      let bottom = anchorY - tail;
      let top = bottom - bh;
      // 캔버스 안으로 보정
      const margin = border + 1;
      if (cx - bw / 2 < margin) cx = margin + bw / 2;
      if (cx + bw / 2 > W - margin) cx = W - margin - bw / 2;
      if (top < margin) {
        top = margin;
        bottom = top + bh;
      }
      if (bottom + tail > H - margin) {
        bottom = H - margin - tail;
        top = bottom - bh;
      }

      ctx.globalAlpha = alpha;
      const color = TEAM_COLOR[side];

      // 바탕 (그림자 포함) + 테두리
      ctx.beginPath();
      roundRectPath(ctx, cx - bw / 2, top, bw, bh, radius);
      ctx.fillStyle = SHOUT_BG;
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.max(2, s * 0.25);
      ctx.shadowOffsetY = Math.max(1, s * 0.06);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = border;
      ctx.strokeStyle = color;
      ctx.stroke();

      // 꼬리: 아래로 향하는 작은 삼각형 (시전자 쪽을 가리킨다). 바탕과 이어지도록 위쪽 변은 그리지 않는다
      const tailX = Math.max(cx - bw / 2 + radius + tail, Math.min(cx + bw / 2 - radius - tail, ux * s));
      ctx.beginPath();
      ctx.moveTo(tailX - tail, bottom - border);
      ctx.lineTo(tailX, bottom + tail);
      ctx.lineTo(tailX + tail, bottom - border);
      ctx.closePath();
      ctx.fillStyle = SHOUT_BG;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(tailX - tail, bottom);
      ctx.lineTo(tailX, bottom + tail);
      ctx.lineTo(tailX + tail, bottom);
      ctx.stroke();

      // 글씨
      ctx.fillStyle = SHOUT_TEXT;
      ctx.fillText(sh.text, cx, top + bh / 2 + fontPx * 0.04);
    }
    ctx.restore();
  }

  // ───────────── 오버레이 ─────────────

  private drawOverlay(frame: BattleFrame, s: number): void {
    const ctx = this.ctx;
    if (frame.finished) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(14, s * 1.6)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('전투 종료', this.canvas.width / 2, this.canvas.height / 2);
    }
  }
}

const STATUS_LABEL: Partial<Record<StatusKind, string>> = {
  stun: '기절',
  burn: '화상',
  poison: '중독',
  freeze: '빙결',
  slow: '둔화',
  stealth: '은신',
  taunt: '도발',
  shield: '보호막',
  silence: '침묵',
  invuln: '무적',
};

/** 한 팀이라도 (소환물 제외) 유닛이 DENSE_UNIT_THRESHOLD 명을 넘으면 밀집 */
function isDenseFrame(frame: BattleFrame): boolean {
  const n: Record<TeamSide, number> = { A: 0, B: 0 };
  for (const u of frame.units) {
    if (u.job === 'summon') continue;
    n[u.side] += 1;
  }
  return n.A > DENSE_UNIT_THRESHOLD || n.B > DENSE_UNIT_THRESHOLD;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * line 영역의 네 꼭짓점 (맵 단위). frac0~frac1 은 시전자(x,y)→끝점(x2,y2) 방향의 구간 비율.
 * 끝점이 없거나 길이가 0 이면 오른쪽 방향의 단위 길이로 대신한다.
 */
function lineCorners(z: ZoneSnapshot, frac0: number, frac1: number): { x: number; y: number }[] {
  const x2 = z.x2 ?? z.x;
  const y2 = z.y2 ?? z.y;
  let dx = x2 - z.x;
  let dy = y2 - z.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 1;
    dy = 0;
    len = 1;
  }
  const ux = dx / len;
  const uy = dy / len;
  const half = Math.max(0, z.width ?? z.radius * 2) / 2;
  const nx = -uy * half;
  const ny = ux * half;
  const a0 = len * frac0;
  const a1 = len * frac1;
  const sx = z.x + ux * a0;
  const sy = z.y + uy * a0;
  const ex = z.x + ux * a1;
  const ey = z.y + uy * a1;
  return [
    { x: sx + nx, y: sy + ny },
    { x: ex + nx, y: ey + ny },
    { x: ex - nx, y: ey - ny },
    { x: sx - nx, y: sy - ny },
  ];
}

/** 둥근 사각형 경로 (현재 path 에 추가). 브라우저 roundRect 지원에 의존하지 않는다 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export { TEAM_COLOR, TEAM_COLOR_DARK };
