/**
 * 전투 관전 캔버스 렌더러 — 간단 모드 (FM 모바일 스타일 원형 아이콘) + 두 렌더러가 공유하는 오버레이 헬퍼.
 * 시뮬레이션 프레임(BattleFrame)만 받아서 그린다. 시뮬레이션 상태를 바꾸지 않는다.
 *
 * v0.7:
 *  - `IBattleRenderer` 공통 인터페이스. 간단 모드(`BattleRenderer`, 이 파일)와 도트 모드(`pixel/pixelRenderer.ts`)가
 *    같은 BattleFrame 을 소비한다. app.ts 는 전투 중에도 두 렌더러를 즉시 바꿔 끼운다.
 *  - 맵 28×20 + 사방 MAP_MARGIN_UNITS(1.5) 여백 프레임. 캔버스 비율 = (w+3)/(h+3).
 *  - 맵 기믹 영역(side 'neutral')은 팀 색이 아닌 얼음빛 흰색으로 그린다. 라벨은 기믹 이름('눈보라').
 *  - 전장 붕괴(ATTRITION_START_SEC 이후): 상단 '전장 붕괴 — 초당 N%' 배너 + HP 바 붉은 테두리 깜빡임.
 *  - 플로팅 텍스트·말풍선·HP 바·상태 점·이름표·배너는 `BattleOverlay` 와 헬퍼 함수로 분리해 도트 렌더러가 재사용한다.
 *
 * v0.5: 광역 영역(BattleFrame.zones) — telegraph 점선 + 진행률 채움, flash 폭발, active 장판, 'dodge' → '회피!'.
 * v0.6: 스킬명 외치기 말풍선(SHOUT_*), 시전자 원 펄스(PULSE_*).
 */
import type {
  BattleEvent,
  BattleFrame,
  BattleInput,
  MapDef,
  MonsterTier,
  StatusKind,
  Team,
  TeamSide,
  UnitSnapshot,
  ZoneSide,
  ZoneSnapshot,
} from '../core/types';
import { MAP_MARGIN_UNITS } from '../core/types';
import { JOB_GLYPH, MONSTER_GLYPH, fmtRate, isZoneSkillId, skillName, zoneLabel } from './format';

// ───────────────────────── 공통 인터페이스 ─────────────────────────

/**
 * 전투 화면 렌더러 공통 인터페이스. 두 렌더러 모두 구현한다.
 *  - draw: 프레임 하나를 그린다. 같은 프레임을 여러 번 그려도 된다 (일시정지·리사이즈).
 *  - resize: 컨테이너 크기가 바뀌었을 때. 마지막 프레임을 다시 그린다.
 *  - setMap: 새 전투 시작 (맵 정의 교체 + 이전 전투의 애니메이션·이펙트·플로팅 텍스트·보스 표시 초기화).
 */
export interface IBattleRenderer {
  draw(frame: BattleFrame): void;
  resize(): void;
  setMap(map: MapDef): void;
}

/** 고정 순회 순서 */
export const SIDES: readonly TeamSide[] = ['A', 'B'];

export const TEAM_COLOR: Record<TeamSide, string> = { A: '#4f8cff', B: '#ff5a5a' };
export const TEAM_COLOR_LIGHT: Record<TeamSide, string> = { A: '#a7c4ff', B: '#ffb0b0' };
export const TEAM_COLOR_DARK: Record<TeamSide, string> = { A: '#1f3f80', B: '#802626' };

/** 맵 기믹(neutral) 영역 색: 얼음빛 흰색 / 더 밝은 심 */
export const ZONE_NEUTRAL_COLOR = '#cfeeff';
export const ZONE_NEUTRAL_LIGHT = '#ffffff';

/** 영역 소속 → 테두리 색 / 밝은 색 */
export function zoneColor(side: ZoneSide): string {
  return side === 'neutral' ? ZONE_NEUTRAL_COLOR : TEAM_COLOR[side];
}
export function zoneLightColor(side: ZoneSide): string {
  return side === 'neutral' ? ZONE_NEUTRAL_LIGHT : TEAM_COLOR_LIGHT[side];
}

/** 몬스터 본체 색: 짙은 자주 → 검붉은색 (난이도가 올라갈수록 붉어진다) */
export const MONSTER_COLOR: Record<MonsterTier, string> = { low: '#5f2a52', mid: '#75203f', high: '#8a1622' };
/** 몬스터 외곽선 색 */
export const MONSTER_EDGE: Record<MonsterTier, string> = { low: '#c98fd0', mid: '#ef6f92', high: '#ffb347' };
/** 난이도별 반경 배율 (보스는 여기에 BOSS_RADIUS_MULT 를 더 곱한다) */
export const MONSTER_RADIUS_MULT: Record<MonsterTier, number> = { low: 0.95, mid: 1.05, high: 1.15 };
export const BOSS_RADIUS_MULT = 1.45;

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

/** 각 팀에서 최대 HP 를 가진 몬스터 = 보스. 첫 프레임에서 한 번 계산한다 */
export function findBossIds(frame: BattleFrame, monsters: MonsterTierMap): Set<string> {
  const ids = new Set<string>();
  for (const side of SIDES) {
    let best: UnitSnapshot | null = null;
    for (const u of frame.units) {
      if (u.side !== side || u.job === 'summon') continue;
      if (!monsters[u.id]) continue;
      if (!best || u.maxHp > best.maxHp) best = u;
    }
    if (best) ids.add(best.id);
  }
  return ids;
}

export const STATUS_DOT: Partial<Record<StatusKind, string>> = {
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

export const STATUS_LABEL: Partial<Record<StatusKind, string>> = {
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

/** 이벤트 플로팅 텍스트 유지 시간 (시뮬레이션 초) */
const FLOAT_LIFE_SEC = 0.6;
const MAX_FLOATS = 80;

/** 한 팀의 (소환물 제외) 유닛 수가 이 값을 넘으면 이름·HP 바를 축소한다 */
export const DENSE_UNIT_THRESHOLD = 5;
/** 이름 글씨 크기 (맵 단위 배율): 보통 / 밀집 */
export const NAME_FONT_SCALE = 0.42;
export const NAME_FONT_SCALE_DENSE = 0.32;
/** HP 바 폭 (맵 단위): 보통 / 밀집. 밀집 값은 8기 대열의 열 간격(1.4)보다 좁아야 이웃과 겹치지 않는다 */
export const HP_BAR_W = 2.4;
export const HP_BAR_W_DENSE = 1.3;
/** 밀집 대열의 열 간격 (맵 단위). 이름표를 열마다 한 줄씩 엇갈려 놓는 기준 */
export const DENSE_COLUMN_GAP = 1.4;
/** 캐릭터 반경 (맵 단위): 보통 / 밀집 */
const UNIT_RADIUS = 0.9;
const UNIT_RADIUS_DENSE = 0.78;

/** 폭발 플래시의 심 색. 팀 색 테두리가 바깥으로 퍼진다 */
const ZONE_FLASH_CORE = '#ffffff';

/** 여백 프레임 색 (두 렌더러 공통 톤) */
export const FRAME_COLOR = '#0b0e14';
export const FRAME_EDGE_COLOR = '#2c3547';

/** 밀집 표시용 짧은 이름: 몬스터 개체 접미사('슬라임 A' → 'A')만 남긴다. 접미사가 없으면 그대로 */
export function denseLabel(name: string): string {
  const m = /\s([A-Z])$/.exec(name);
  return m ? m[1] : name;
}

/** '회피!' 텍스트 색 */
export const DODGE_COLOR = '#8ef0ff';
/** 기믹 피해 숫자 색 (얼음빛) */
export const HAZARD_TEXT_COLOR = '#bfefff';

/** 스킬명 말풍선 유지 시간 (시뮬레이션 초) */
const SHOUT_LIFE_SEC = 1.2;
/** 말풍선 팝(확대) 구간 (시뮬레이션 초) */
const SHOUT_POP_SEC = 0.15;
/** 시전자 원 펄스 지속 시간 (시뮬레이션 초) 과 최대 배율 */
export const PULSE_SEC = 0.2;
export const PULSE_MULT = 1.25;
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

/** 전장 붕괴 배너 색 */
const ATTRITION_BANNER_BG = '#5a1414';
const ATTRITION_TEXT = '#ffe1e1';

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
  side: TeamSide;
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

// ───────────────────────── 공유 오버레이 (플로팅 텍스트 · 말풍선) ─────────────────────────

/**
 * 오버레이가 화면에 그릴 때 필요한 기하 정보. 각 렌더러가 자기 좌표계로 채운다.
 *  - toScreen: 맵 좌표 → 화면 캔버스 px
 *  - unitPx: 맵 1 유닛의 화면 px
 *  - floatLift: 플로팅 텍스트가 유닛 좌표 위로 떠오르기 시작하는 높이 (맵 단위)
 *  - bubbleAnchor: 말풍선 꼬리 끝이 놓일 화면 px (HP 바·상태 점 위)
 */
export interface OverlayGeom {
  toScreen(x: number, y: number): { x: number; y: number };
  unitPx: number;
  width: number;
  height: number;
  floatLift: number;
  bubbleAnchor(u: UnitSnapshot): { x: number; y: number };
}

/**
 * 이벤트 → 플로팅 텍스트(피해·회복·상태·회피)와 스킬명 말풍선. 두 렌더러가 같은 인스턴스 구조를 쓴다.
 * 시간은 전부 시뮬레이션 초 (배속·리플레이 동일).
 */
export class BattleOverlay {
  private floats: FloatText[] = [];
  /** 스킬명 말풍선. 시전자당 최대 1개. 배열 순서 = 최근 시전 순 (표시 전용) */
  private shouts: Shout[] = [];

  /** 이번 틱의 이벤트를 받아들인다 (틱당 한 번만 호출할 것) */
  ingest(events: readonly BattleEvent[], byId: Map<string, UnitSnapshot>): void {
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
          // 스킬명 외치기: 플로팅 텍스트 대신 시전자 머리 위 말풍선 + 펄스
          const u = byId.get(e.from);
          this.pushShout(e.from, e.skillId, u ? u.x : e.x, u ? u.y : e.y, u ? u.side : 'A', e.t);
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
        case 'hazard_damage': {
          // impact 만 숫자로. 장판 틱은 너무 잦아 숫자를 띄우지 않는다
          if (e.phase !== 'impact') break;
          const u = byId.get(e.to);
          if (!u) break;
          this.pushFloat(u.x, u.y, `${Math.round(e.damage)}`, HAZARD_TEXT_COLOR, false, e.t, jitter);
          break;
        }
        case 'attrition_start': {
          // 배너가 알린다. 플로팅 텍스트 없음
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

  /** 오래된(또는 미래 시각의 — 이전 전투 잔여) 플로팅 텍스트·말풍선 제거 (시뮬레이션 시간 기준) */
  prune(now: number): void {
    this.floats = this.floats.filter((f) => now - f.born < FLOAT_LIFE_SEC && now >= f.born);
    this.shouts = this.shouts.filter((sh) => now - sh.startTime < SHOUT_LIFE_SEC && now >= sh.startTime);
  }

  /** 새 전투 시작 시 전부 비운다 */
  clear(): void {
    this.floats = [];
    this.shouts = [];
  }

  private pushFloat(x: number, y: number, text: string, color: string, big: boolean, born: number, jitter: number): void {
    this.floats.push({ x, y, text, color, born, big, jitter });
    if (this.floats.length > MAX_FLOATS) this.floats.splice(0, this.floats.length - MAX_FLOATS);
  }

  /** 시전자의 말풍선을 새로 만든다. 같은 시전자의 이전 말풍선은 즉시 교체된다 */
  private pushShout(casterId: string, skillId: string, x: number, y: number, side: TeamSide, startTime: number): void {
    for (let i = this.shouts.length - 1; i >= 0; i--) {
      if (this.shouts[i].casterId === casterId) this.shouts.splice(i, 1);
    }
    this.shouts.push({ casterId, skillId, text: `${skillName(skillId)}!`, startTime, isZone: isZoneSkillId(skillId), x, y, side });
  }

  /** 시전 직후 펄스 배율 (1 → PULSE_MULT → 1, PULSE_SEC 동안). 시전 중이 아니면 1 */
  pulseOf(unitId: string, now: number): number {
    for (let i = this.shouts.length - 1; i >= 0; i--) {
      const sh = this.shouts[i];
      if (sh.casterId !== unitId) continue;
      const age = now - sh.startTime;
      if (age < 0 || age >= PULSE_SEC) return 1;
      return 1 + (PULSE_MULT - 1) * Math.sin(Math.PI * (age / PULSE_SEC));
    }
    return 1;
  }

  /** 플로팅 텍스트 + 말풍선을 화면 캔버스에 그린다 */
  draw(ctx: CanvasRenderingContext2D, now: number, byId: Map<string, UnitSnapshot>, geom: OverlayGeom): void {
    this.drawFloats(ctx, now, geom);
    this.drawShouts(ctx, now, byId, geom);
  }

  private drawFloats(ctx: CanvasRenderingContext2D, now: number, geom: OverlayGeom): void {
    if (this.floats.length === 0) return;
    const s = geom.unitPx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    for (const f of this.floats) {
      const age = Math.max(0, now - f.born) / FLOAT_LIFE_SEC;
      const rise = age * 1.4 * s;
      const p = geom.toScreen(f.x, f.y);
      ctx.globalAlpha = Math.max(0, 1 - age * age);
      ctx.fillStyle = f.color;
      ctx.font = `${f.big ? 'bold ' : ''}${Math.max(9, s * (f.big ? 0.75 : 0.55))}px sans-serif`;
      ctx.fillText(f.text, p.x + f.jitter * s, p.y - s * geom.floatLift - rise);
    }
    ctx.restore();
  }

  /**
   * 시전자 머리 위(HP 바·상태 점 위)에 스킬명 말풍선을 그린다.
   *  - 0 ~ SHOUT_POP_SEC: 작게 시작해 살짝 넘치게 커진다 (팝)
   *  - 이후: 위로 떠오르며 서서히 사라진다
   * 말풍선은 캔버스 안에 들어오도록 위치를 보정한다.
   */
  private drawShouts(ctx: CanvasRenderingContext2D, now: number, byId: Map<string, UnitSnapshot>, geom: OverlayGeom): void {
    if (this.shouts.length === 0) return;
    const s = geom.unitPx;
    const W = geom.width;
    const H = geom.height;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const sh of this.shouts) {
      const age = now - sh.startTime;
      if (age < 0 || age >= SHOUT_LIFE_SEC) continue;
      const u = byId.get(sh.casterId);
      const side: TeamSide = u ? u.side : sh.side;

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

      // 꼬리 끝: 유닛이 있으면 렌더러가 알려준 앵커(HP 바·상태 점 위), 없으면 좌표 기준
      let anchor: { x: number; y: number };
      if (u) {
        anchor = geom.bubbleAnchor(u);
      } else {
        const p = geom.toScreen(sh.x, sh.y);
        anchor = { x: p.x, y: p.y - s * 1.6 };
      }
      const anchorY = anchor.y - s * 0.08 - rise;
      const ux = anchor.x;
      let cx = ux;
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
      const tailX = Math.max(cx - bw / 2 + radius + tail, Math.min(cx + bw / 2 - radius - tail, ux));
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
}

// ───────────────────────── 공유 헬퍼: HP 바 · 상태 점 · 이름 · 배너 ─────────────────────────

/** 전장 붕괴 중 HP 바 테두리 깜빡임 0~1 (시뮬레이션 시간 기준) */
export function attritionPulse(now: number): number {
  return 0.5 + 0.5 * Math.sin(now * 7);
}

export interface UnitBarsOpts {
  /** HP 바 가운데 x, 위쪽 y (화면 px) */
  cx: number;
  top: number;
  barW: number;
  barH: number;
  u: UnitSnapshot;
  /** MP 바를 그릴지 (캐릭터만) */
  showMp: boolean;
  /** 0 이면 붕괴 전. 0 보다 크면 붉은 테두리 깜빡임 */
  attritionPct: number;
  now: number;
}

/**
 * HP 바(+보호막 띠) 와 MP 바를 그린다. 반환값은 상태 점을 놓을 기준 y (바 묶음의 맨 위 - 여유).
 * 두 렌더러가 같은 모양을 쓴다.
 */
export function drawUnitBars(ctx: CanvasRenderingContext2D, o: UnitBarsOpts): { dotsY: number; bottom: number } {
  const { u, barW, barH } = o;
  const bx = o.cx - barW / 2;
  const by = o.top;
  const shield = u.statuses.find((st) => st.kind === 'shield');
  const ratio = u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 0;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(bx, by, barW, barH);
  ctx.fillStyle = ratio > 0.5 ? '#5bd66b' : ratio > 0.25 ? '#ffc247' : '#ff5252';
  ctx.fillRect(bx, by, barW * ratio, barH);
  let shieldH = 0;
  if (shield && u.maxHp > 0) {
    const sh = Math.min(1, shield.value / u.maxHp);
    shieldH = Math.max(1, barH * 0.4);
    ctx.fillStyle = 'rgba(120,200,255,0.8)';
    ctx.fillRect(bx, by - shieldH, barW * sh, shieldH);
  }
  let bottom = by + barH;
  if (o.showMp && u.maxMp > 0) {
    const mh = Math.max(1, barH * 0.4);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx, by + barH, barW, mh);
    ctx.fillStyle = '#6fa8ff';
    ctx.fillRect(bx, by + barH, barW * Math.max(0, Math.min(1, u.mp / u.maxMp)), mh);
    bottom += mh;
  }
  // 전장 붕괴: 붉은 테두리 깜빡임
  if (o.attritionPct > 0) {
    const a = 0.35 + 0.65 * attritionPulse(o.now);
    ctx.strokeStyle = `rgba(255,70,70,${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, barH * 0.35);
    ctx.strokeRect(bx - 0.5, by - shieldH - 0.5, barW + 1, bottom - by + shieldH + 1);
  }
  return { dotsY: by - shieldH, bottom };
}

/** 상태 점을 가로로 나열해 그린다. y 는 점의 중심 */
export function drawStatusDots(ctx: CanvasRenderingContext2D, u: UnitSnapshot, cx: number, y: number, unitPx: number): void {
  const dots = u.statuses.filter((st) => STATUS_DOT[st.kind]);
  if (dots.length === 0) return;
  const dr = Math.max(1.5, unitPx * 0.16);
  const startX = cx - ((dots.length - 1) * dr * 2.4) / 2;
  for (let i = 0; i < dots.length; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * dr * 2.4, y, dr, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_DOT[dots[i].kind] ?? '#fff';
    ctx.fill();
  }
}

/** 상태 점 줄의 높이 (말풍선 앵커 계산용). 점이 없어도 같은 높이를 남긴다 */
export function statusDotsHeight(unitPx: number): number {
  return unitPx * 0.3 + Math.max(1.5, unitPx * 0.16);
}

/** 이름표 (그림자 포함). 밀집 시 접미사만 + 이웃 열과 엇갈림 */
export function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  u: UnitSnapshot,
  cx: number,
  top: number,
  unitPx: number,
  dense: boolean,
  color = '#ffffff',
): void {
  ctx.save();
  ctx.fillStyle = color;
  const fontPx = nameFontPx(unitPx, dense);
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 3;
  // 밀집 시: 개체 접미사('슬라임 A' → 'A')만 쓰고, 이웃 열과 이름줄을 엇갈려 놓아 겹치지 않게 한다 (종 이름은 전투 제목에 있다)
  const label = dense ? denseLabel(u.name) : u.name;
  const stagger = dense && Math.round(u.x / DENSE_COLUMN_GAP) % 2 !== 0 ? fontPx * 1.1 : 0;
  ctx.fillText(label, cx, top + stagger);
  ctx.restore();
}

/** 이름 글씨 크기 (px). 밀집 시 축소 */
export function nameFontPx(unitPx: number, dense: boolean): number {
  return Math.max(8, unitPx * (dense ? NAME_FONT_SCALE_DENSE : NAME_FONT_SCALE));
}

/** 전장 붕괴 배너: 캔버스 상단 가운데. attritionPct 가 0 이면 아무것도 그리지 않는다 */
export function drawAttritionBanner(ctx: CanvasRenderingContext2D, attritionPct: number, now: number, W: number, H: number, unitPx: number): void {
  if (attritionPct <= 0) return;
  const pulse = attritionPulse(now);
  ctx.save();
  // 화면 가장자리 붉은 기운
  ctx.strokeStyle = `rgba(255,60,60,${(0.25 + 0.35 * pulse).toFixed(3)})`;
  ctx.lineWidth = Math.max(3, unitPx * 0.35);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
  // 배너
  const fontPx = Math.max(11, unitPx * 0.7);
  ctx.font = `bold ${fontPx}px sans-serif`;
  const text = `전장 붕괴 — 초당 ${fmtRate(attritionPct)}`;
  const tw = ctx.measureText(text).width;
  const padX = fontPx * 0.7;
  const bw = tw + padX * 2;
  const bh = fontPx * 1.7;
  const bx = W / 2 - bw / 2;
  const by = Math.max(2, unitPx * 0.25);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = ATTRITION_BANNER_BG;
  ctx.beginPath();
  roundRectPath(ctx, bx, by, bw, bh, fontPx * 0.35);
  ctx.fill();
  ctx.lineWidth = Math.max(1, fontPx * 0.1);
  ctx.strokeStyle = `rgba(255,90,90,${(0.5 + 0.5 * pulse).toFixed(3)})`;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = ATTRITION_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, by + bh / 2 + fontPx * 0.04);
  ctx.restore();
}

/** 전투 종료 오버레이 */
export function drawFinishedOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, unitPx: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.max(14, unitPx * 1.6)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('전투 종료', W / 2, H / 2);
  ctx.restore();
}

/** 한 팀이라도 (소환물 제외) 유닛이 DENSE_UNIT_THRESHOLD 명을 넘으면 밀집 */
export function isDenseFrame(frame: BattleFrame): boolean {
  const n: Record<TeamSide, number> = { A: 0, B: 0 };
  for (const u of frame.units) {
    if (u.job === 'summon') continue;
    n[u.side] += 1;
  }
  return n.A > DENSE_UNIT_THRESHOLD || n.B > DENSE_UNIT_THRESHOLD;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * line 영역의 네 꼭짓점 (맵 단위). frac0~frac1 은 시전자(x,y)→끝점(x2,y2) 방향의 구간 비율.
 * 끝점이 없거나 길이가 0 이면 오른쪽 방향의 단위 길이로 대신한다.
 */
export function lineCorners(z: ZoneSnapshot, frac0: number, frac1: number): { x: number; y: number }[] {
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

/** 영역 중심 (라벨 위치, 맵 단위) */
export function zoneCenter(z: ZoneSnapshot): { x: number; y: number } {
  if (z.shape === 'circle' || z.x2 === undefined || z.y2 === undefined) return { x: z.x, y: z.y };
  return { x: (z.x + z.x2) / 2, y: (z.y + z.y2) / 2 };
}

/**
 * 영역 외곽 경로를 현재 path 에 만든다 (좌표 변환 콜백 사용).
 * circle: 중심 반경 radius × frac1. line: 선분의 frac0~frac1 구간을 width 폭으로 감싼 직사각형.
 */
export function traceZonePath(
  ctx: CanvasRenderingContext2D,
  z: ZoneSnapshot,
  toX: (x: number) => number,
  toY: (y: number) => number,
  unitPx: number,
  frac0 = 0,
  frac1 = 1,
): boolean {
  ctx.beginPath();
  if (z.shape === 'circle') {
    const r = Math.max(0, z.radius) * unitPx * Math.max(0, frac1);
    if (r <= 0) return false;
    ctx.arc(toX(z.x), toY(z.y), r, 0, Math.PI * 2);
    ctx.closePath();
    return true;
  }
  const c = lineCorners(z, frac0, frac1);
  ctx.moveTo(toX(c[0].x), toY(c[0].y));
  ctx.lineTo(toX(c[1].x), toY(c[1].y));
  ctx.lineTo(toX(c[2].x), toY(c[2].y));
  ctx.lineTo(toX(c[3].x), toY(c[3].y));
  ctx.closePath();
  return true;
}

/** 둥근 사각형 경로 (현재 path 에 추가). 브라우저 roundRect 지원에 의존하지 않는다 */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
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

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 컨테이너 폭·DPR 로 캔버스 내부 해상도를 맞춘다. 비율 = (맵 폭 + 2여백) : (맵 높이 + 2여백). 바뀌었으면 true */
export function fitCanvasToMap(canvas: HTMLCanvasElement, map: MapDef): boolean {
  const cssWidth = canvas.clientWidth || canvas.width || 640;
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const w = Math.max(200, Math.round(cssWidth * dpr));
  const hgt = Math.round((w * (map.height + MAP_MARGIN_UNITS * 2)) / (map.width + MAP_MARGIN_UNITS * 2));
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
    return true;
  }
  return false;
}

// ───────────────────────── 간단 모드 렌더러 ─────────────────────────

export class BattleRenderer implements IBattleRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private map: MapDef;
  private readonly overlay = new BattleOverlay();
  private lastTick = -1;
  private lastFrame: BattleFrame | null = null;
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
    map: MapDef,
    private readonly monsters: MonsterTierMap = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 만들 수 없습니다.');
    this.ctx = ctx;
    this.map = map;
    fitCanvasToMap(canvas, map);
  }

  /** 새 전투 시작: 맵 교체 + 전투별 상태(보스·플로팅 텍스트·마지막 프레임) 초기화 */
  setMap(map: MapDef): void {
    this.map = map;
    this.bossIds = null;
    this.dense = false;
    this.lastTick = -1;
    this.lastFrame = null;
    this.overlay.clear();
    fitCanvasToMap(this.canvas, map);
  }

  resize(): void {
    fitCanvasToMap(this.canvas, this.map);
    if (this.lastFrame) this.draw(this.lastFrame);
  }

  /** 이 유닛이 몬스터면 난이도, 아니면 null */
  private tierOf(u: UnitSnapshot): MonsterTier | null {
    if (u.job === 'summon') return null;
    return this.monsters[u.id] ?? null;
  }

  /** 화면 px / 맵 유닛 */
  private get scale(): number {
    return this.canvas.width / (this.map.width + MAP_MARGIN_UNITS * 2);
  }

  /** 맵 좌표 → 화면 px (여백 포함) */
  private X(x: number): number {
    return (x + MAP_MARGIN_UNITS) * this.scale;
  }
  private Y(y: number): number {
    return (y + MAP_MARGIN_UNITS) * this.scale;
  }

  draw(frame: BattleFrame): void {
    fitCanvasToMap(this.canvas, this.map);
    this.lastFrame = frame;
    const s = this.scale;
    const ctx = this.ctx;

    const byId = new Map<string, UnitSnapshot>();
    for (const u of frame.units) byId.set(u.id, u);

    if (!this.bossIds) this.bossIds = findBossIds(frame, this.monsters);
    this.dense = isDenseFrame(frame);

    if (frame.tick !== this.lastTick) {
      this.overlay.ingest(frame.events, byId);
      this.lastTick = frame.tick;
    }
    this.overlay.prune(frame.timeSec);

    ctx.save();
    this.drawBackground(s);
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

    this.overlay.draw(ctx, frame.timeSec, byId, this.geom(s));
    drawAttritionBanner(ctx, frame.attritionPctPerSec ?? 0, frame.timeSec, this.canvas.width, this.canvas.height, s);
    if (frame.finished) drawFinishedOverlay(ctx, this.canvas.width, this.canvas.height, s);
    ctx.restore();
  }

  private geom(s: number): OverlayGeom {
    return {
      toScreen: (x, y) => ({ x: this.X(x), y: this.Y(y) }),
      unitPx: s,
      width: this.canvas.width,
      height: this.canvas.height,
      floatLift: 1.2,
      bubbleAnchor: (u) => {
        // drawUnit 과 같은 기하: HP 바 위 → 상태 점 줄 위
        const r = this.radiusOf(u, s);
        const barH = Math.max(2, s * 0.28);
        const barY = this.Y(u.y) - r - barH - s * 0.25;
        const hasShield = u.statuses.some((st) => st.kind === 'shield');
        const dotsTop = barY - (hasShield ? barH * 0.4 : 0) - statusDotsHeight(s);
        return { x: this.X(u.x), y: dotsTop };
      },
    };
  }

  // ───────────── 배경 ─────────────

  private drawBackground(s: number): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const mx = this.X(0);
    const my = this.Y(0);
    const mw = this.map.width * s;
    const mh = this.map.height * s;

    // 여백 프레임
    ctx.fillStyle = FRAME_COLOR;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(mx, my, mw, mh);
    ctx.clip();
    switch (this.map.id) {
      case 'plains': {
        ctx.fillStyle = '#2f6b3a';
        ctx.fillRect(mx, my, mw, mh);
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        for (let i = 0; i < this.map.height; i += 4) ctx.fillRect(mx, this.Y(i), mw, 2 * s);
        break;
      }
      case 'dark': {
        ctx.fillStyle = '#10162b';
        ctx.fillRect(mx, my, mw, mh);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        for (let i = 0; i < 40; i++) {
          // 고정 패턴의 별 (표시 전용)
          const x = ((i * 977) % this.map.width) + 0.5;
          const y = ((i * 613) % this.map.height) + 0.5;
          ctx.fillRect(this.X(x), this.Y(y), Math.max(1, s * 0.08), Math.max(1, s * 0.08));
        }
        break;
      }
      case 'desert': {
        ctx.fillStyle = '#c9a25c';
        ctx.fillRect(mx, my, mw, mh);
        ctx.strokeStyle = 'rgba(120,80,20,0.18)';
        ctx.lineWidth = Math.max(1, s * 0.1);
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          const y0 = this.Y(i * 4 + 2);
          ctx.moveTo(mx, y0);
          for (let x = 0; x <= this.map.width; x += 2) {
            ctx.lineTo(this.X(x), y0 + Math.sin((x + i * 3) * 0.6) * s * 0.8);
          }
          ctx.stroke();
        }
        break;
      }
      case 'glacier': {
        ctx.fillStyle = '#a9d6e5';
        ctx.fillRect(mx, my, mw, mh);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = Math.max(1, s * 0.08);
        for (let i = 0; i < 7; i++) {
          ctx.beginPath();
          const x0 = this.X((i * 5 + 2) % this.map.width);
          ctx.moveTo(x0, my);
          ctx.lineTo(x0 + (i % 2 === 0 ? 4 : -3) * s, my + mh);
          ctx.stroke();
        }
        break;
      }
      default: {
        ctx.fillStyle = '#333';
        ctx.fillRect(mx, my, mw, mh);
      }
    }

    // 희미한 격자
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.map.width; x += 4) {
      ctx.moveTo(this.X(x), my);
      ctx.lineTo(this.X(x), my + mh);
    }
    for (let y = 0; y <= this.map.height; y += 4) {
      ctx.moveTo(mx, this.Y(y));
      ctx.lineTo(mx + mw, this.Y(y));
    }
    ctx.stroke();

    // 중앙선
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([s * 0.5, s * 0.5]);
    ctx.beginPath();
    ctx.moveTo(this.X(this.map.width / 2), my);
    ctx.lineTo(this.X(this.map.width / 2), my + mh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 맵 경계선 (여백과 구분)
    ctx.strokeStyle = FRAME_EDGE_COLOR;
    ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.strokeRect(mx, my, mw, mh);
  }

  // ───────────── 시야 (어둠 맵) ─────────────

  private drawVision(frame: BattleFrame, s: number): void {
    if (this.map.visionRadius <= 0) return;
    const ctx = this.ctx;
    const vr = this.map.visionRadius * s;
    for (const u of frame.units) {
      if (!u.alive) continue;
      ctx.beginPath();
      ctx.arc(this.X(u.x), this.Y(u.y), vr, 0, Math.PI * 2);
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

  private drawDead(u: UnitSnapshot, s: number): void {
    const ctx = this.ctx;
    const x = this.X(u.x);
    const y = this.Y(u.y);
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
      ctx.font = `${nameFontPx(s, this.dense)}px sans-serif`;
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
    const x = this.X(u.x);
    const y = this.Y(u.y);
    // 스킬 시전 직후 PULSE_SEC 동안 원이 커졌다 돌아온다 (시뮬레이션 시간 기준)
    const r = this.radiusOf(u, s) * this.overlay.pulseOf(u.id, frame.timeSec);

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
        ctx.lineTo(this.X(tgt.x), this.Y(tgt.y));
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

    // HP 바 (밀집 시 조금 좁게) + MP 바 + 붕괴 테두리
    const barW = (isSummon ? 1.6 : isBoss ? 3.2 : this.dense ? HP_BAR_W_DENSE : HP_BAR_W) * s;
    const barH = Math.max(2, s * 0.28);
    const by = y - r - barH - s * 0.25;
    const bars = drawUnitBars(ctx, {
      cx: x, top: by, barW, barH, u, showMp: !isSummon, attritionPct: frame.attritionPctPerSec ?? 0, now: frame.timeSec,
    });

    // 상태 점
    drawStatusDots(ctx, u, x, bars.dotsY - s * 0.3, s);

    // 이름
    if (!isSummon) drawNameLabel(ctx, u, x, y + r + s * 0.1, s, this.dense);

    ctx.restore();
  }

  // ───────────── 광역 영역 (Zone) ─────────────

  private traceZone(z: ZoneSnapshot, s: number, frac0 = 0, frac1 = 1): boolean {
    return traceZonePath(this.ctx, z, (x) => this.X(x), (y) => this.Y(y), s, frac0, frac1);
  }

  /** 예고: 팀 색(기믹은 얼음빛) 점선 테두리 + 안쪽이 진행률만큼 채워짐 */
  private drawTelegraph(z: ZoneSnapshot, s: number, now: number): void {
    const ctx = this.ctx;
    const color = zoneColor(z.side);
    const neutral = z.side === 'neutral';
    const p = clamp01(z.progress);
    ctx.save();

    // 바탕: 희미한 채움
    if (this.traceZone(z, s)) {
      ctx.fillStyle = hexToRgba(color, neutral ? 0.16 : 0.12);
      ctx.fill();
    }

    // 진행률만큼 차오르는 안쪽 채움 (원은 중심에서 커지고, 직선은 시전자 쪽에서 뻗어 나간다)
    if (p > 0 && this.traceZone(z, s, 0, p)) {
      ctx.fillStyle = hexToRgba(color, 0.22 + 0.2 * p);
      ctx.fill();
    }

    // 점선 테두리 (천천히 돌아간다). 기믹은 더 굵고 흰색
    if (this.traceZone(z, s)) {
      ctx.setLineDash(neutral ? [s * 0.3, s * 0.2] : [s * 0.4, s * 0.28]);
      ctx.lineDashOffset = -now * s * 1.6;
      ctx.lineWidth = Math.max(1.5, s * (neutral ? 0.16 : 0.13));
      ctx.strokeStyle = hexToRgba(neutral ? ZONE_NEUTRAL_LIGHT : color, 0.9);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 기믹: 안쪽에 떨어지는 입자 (흰·하늘색)
    if (neutral && z.shape === 'circle') this.drawBlizzardFlakes(z, s, now, 0.5 + 0.5 * p);

    // 라벨: 스킬/기믹 이름 (영역이 어느 정도 클 때만)
    const big = z.shape === 'circle' ? z.radius >= 1.6 : (z.width ?? 0) >= 1.2;
    if (big) {
      const c = zoneCenter(z);
      ctx.fillStyle = neutral ? 'rgba(20,40,60,0.9)' : 'rgba(255,255,255,0.9)';
      ctx.font = `${neutral ? 'bold ' : ''}${Math.max(8, s * 0.4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = neutral ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(zoneLabel(z.skillId), this.X(c.x), this.Y(c.y));
    }
    ctx.restore();
  }

  /** 눈보라 입자: 원 안에 고정 패턴으로 흩어진 점이 시뮬레이션 시간에 따라 아래로 흐른다 */
  private drawBlizzardFlakes(z: ZoneSnapshot, s: number, now: number, alpha: number): void {
    const ctx = this.ctx;
    const n = Math.min(60, Math.round(z.radius * z.radius * 3));
    ctx.save();
    for (let i = 0; i < n; i++) {
      const a = ((i * 137.508) % 360) * (Math.PI / 180);
      const rr = Math.sqrt(((i * 7919) % 1000) / 1000) * z.radius;
      const fall = ((now * (0.8 + ((i * 31) % 7) / 10) + i * 0.37) % 1.6) - 0.8;
      const px = z.x + Math.cos(a) * rr;
      const py = z.y + Math.sin(a) * rr * 0.85 + fall;
      if (Math.hypot(px - z.x, py - z.y) > z.radius) continue;
      ctx.fillStyle = i % 3 === 0 ? `rgba(255,255,255,${alpha})` : `rgba(180,230,255,${alpha})`;
      const sz = Math.max(1, s * (i % 4 === 0 ? 0.14 : 0.09));
      ctx.fillRect(this.X(px) - sz / 2, this.Y(py) - sz / 2, sz, sz);
    }
    ctx.restore();
  }

  /** 폭발: impact 직후 밝은 플래시. progress 0→1 동안 사라진다 */
  private drawFlash(z: ZoneSnapshot, s: number): void {
    const ctx = this.ctx;
    const color = zoneColor(z.side);
    const p = clamp01(z.progress);
    const fade = 1 - p;
    ctx.save();
    // 밝은 심
    if (this.traceZone(z, s)) {
      ctx.fillStyle = hexToRgba(ZONE_FLASH_CORE, 0.55 * fade);
      ctx.fill();
    }
    // 테두리가 바깥으로 퍼진다
    if (this.traceZone(z, s, 0, 1 + 0.35 * p)) {
      ctx.lineWidth = Math.max(2, s * 0.22 * fade);
      ctx.strokeStyle = hexToRgba(color, 0.9 * fade);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 장판: 반투명 채움 + 가장자리 흐름 */
  private drawLinger(z: ZoneSnapshot, s: number, now: number): void {
    const ctx = this.ctx;
    const color = zoneColor(z.side);
    const light = zoneLightColor(z.side);
    const neutral = z.side === 'neutral';
    const p = clamp01(z.progress);
    ctx.save();

    // 채움 (끝나갈수록 옅어진다)
    if (this.traceZone(z, s)) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 5);
      ctx.fillStyle = hexToRgba(color, (0.26 + 0.05 * pulse) * (1 - 0.5 * p));
      ctx.fill();
    }

    // 안쪽 흐름: 원은 중심에서 퍼져 나가는 고리, 직선은 따라 흐르는 띠
    ctx.lineWidth = Math.max(1, s * 0.08);
    for (let i = 0; i < 3; i++) {
      const f = (now * 0.7 + i / 3) % 1;
      let ok: boolean;
      if (z.shape === 'circle') {
        ok = this.traceZone(z, s, 0, f);
      } else {
        const w = 0.12;
        ok = this.traceZone(z, s, Math.max(0, f - w), f);
      }
      if (!ok) continue;
      ctx.strokeStyle = hexToRgba(light, 0.35 * (1 - f));
      ctx.stroke();
    }

    // 가장자리: 실선 + 흐르는 점선
    if (this.traceZone(z, s)) {
      ctx.lineWidth = Math.max(1.5, s * 0.12);
      ctx.strokeStyle = hexToRgba(color, 0.75);
      ctx.stroke();
    }
    if (this.traceZone(z, s)) {
      ctx.setLineDash([s * 0.25, s * 0.35]);
      ctx.lineDashOffset = now * s * 2.2;
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.strokeStyle = hexToRgba(light, 0.9);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (neutral && z.shape === 'circle') this.drawBlizzardFlakes(z, s, now, 0.8 * (1 - 0.5 * p));
    ctx.restore();
  }
}
