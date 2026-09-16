/**
 * 전투 관전 캔버스 렌더러 (FM 모바일 스타일).
 * 시뮬레이션 프레임(BattleFrame)만 받아서 그린다. 시뮬레이션 상태를 바꾸지 않는다.
 */
import type { BattleEvent, BattleFrame, BattleInput, MapDef, MonsterTier, StatusKind, Team, TeamSide, UnitSnapshot } from '../core/types';
import { JOB_GLYPH, MONSTER_GLYPH, skillName } from './format';

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
  private lastTick = -1;
  private summonIds = new Set<string>();
  /** 팀별 보스(몬스터 중 최대 HP) 유닛 id. 첫 draw 에서 한 번 계산한다 */
  private bossIds: Set<string> | null = null;

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

    if (frame.tick !== this.lastTick) {
      this.ingestEvents(frame.events, byId, frame.timeSec);
      this.lastTick = frame.tick;
    }
    // 오래된 플로팅 텍스트 제거
    this.floats = this.floats.filter((f) => frame.timeSec - f.born < FLOAT_LIFE_SEC);

    ctx.save();
    this.drawBackground(s);
    this.drawCapture(frame, s);
    this.drawVision(frame, s);

    // 죽은 유닛 → 소환물 → 캐릭터 순으로 그려서 캐릭터가 위에 오게 한다
    const dead = frame.units.filter((u) => !u.alive);
    const summons = frame.units.filter((u) => u.alive && u.job === 'summon');
    const chars = frame.units.filter((u) => u.alive && u.job !== 'summon');
    for (const u of dead) this.drawDead(u, s);
    for (const u of summons) this.drawUnit(u, s, frame, byId);
    for (const u of chars) this.drawUnit(u, s, frame, byId);

    this.drawFloats(frame.timeSec, s);
    this.drawOverlay(frame, s);
    ctx.restore();
  }

  // ───────────── 이벤트 → 플로팅 텍스트 ─────────────

  private ingestEvents(events: BattleEvent[], byId: Map<string, UnitSnapshot>, t: number): void {
    let n = 0;
    for (const e of events) {
      n++;
      const jitter = ((n * 37) % 11) / 10 - 0.5; // 결정적 좌우 흔들림 (표시 전용)
      switch (e.kind) {
        case 'attack': {
          const u = byId.get(e.to);
          if (!u) break;
          if (e.miss) {
            this.pushFloat(u.x, u.y, '회피', '#cfd8dc', false, t, jitter);
          } else {
            const txt = e.crit ? `${Math.round(e.damage)}!` : `${Math.round(e.damage)}`;
            const color = e.school === 'magic' ? '#c9a6ff' : '#ffffff';
            this.pushFloat(u.x, u.y, txt, e.crit ? '#ffd54a' : color, e.crit, t, jitter);
          }
          break;
        }
        case 'heal': {
          const u = byId.get(e.to);
          if (!u) break;
          this.pushFloat(u.x, u.y, `+${Math.round(e.amount)}`, '#7cf59a', false, t, jitter);
          break;
        }
        case 'skill': {
          const u = byId.get(e.from);
          const x = u ? u.x : e.x;
          const y = u ? u.y - 0.4 : e.y;
          this.pushFloat(x, y, skillName(e.skillId), '#ffe9a8', false, t, jitter);
          break;
        }
        case 'kill': {
          const u = byId.get(e.victim);
          if (!u) break;
          this.pushFloat(u.x, u.y - 0.8, '격파', '#ff8a80', true, t, 0);
          break;
        }
        case 'status': {
          if (!e.applied) break;
          const u = byId.get(e.to);
          if (!u) break;
          const label = STATUS_LABEL[e.status];
          if (label) this.pushFloat(u.x, u.y + 0.6, label, STATUS_DOT[e.status] ?? '#ffffff', false, t, jitter);
          break;
        }
        case 'summon': {
          const u = byId.get(e.unitId) ?? byId.get(e.owner);
          if (!u) break;
          this.pushFloat(u.x, u.y, '소환', '#b3e5fc', false, t, jitter);
          break;
        }
        default:
          break;
      }
    }
  }

  private pushFloat(x: number, y: number, text: string, color: string, big: boolean, born: number, jitter: number): void {
    this.floats.push({ x, y, text, color, born, big, jitter });
    if (this.floats.length > MAX_FLOATS) this.floats.splice(0, this.floats.length - MAX_FLOATS);
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
    const tier = this.tierOf(u);
    if (!tier) return 0.9 * s;
    const boss = this.bossIds?.has(u.id) ? BOSS_RADIUS_MULT : 1;
    return 0.9 * s * MONSTER_RADIUS_MULT[tier] * boss;
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
      ctx.font = `${Math.max(8, s * 0.42)}px sans-serif`;
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
    const r = this.radiusOf(u, s);

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

    // HP 바
    const barW = (isSummon ? 1.6 : isBoss ? 3.2 : 2.4) * s;
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
      ctx.font = `${Math.max(8, s * 0.42)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      ctx.fillText(u.name, x, y + r + s * 0.1);
      ctx.shadowBlur = 0;
    }

    ctx.restore();
    void frame;
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

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export { TEAM_COLOR, TEAM_COLOR_DARK };
