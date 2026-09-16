/**
 * 도트 모드 이펙트 (v0.7, 임시 도트). 전투 이벤트 → 짧은 픽셀 연출.
 *  - 원거리 기본 공격(거리 > RANGED_DIST): 투사체(화살·탄환·마력구)가 PROJECTILE_SEC(0.25초) 동안 날아가고 도착 시 작은 불꽃
 *  - 근접 기본 공격: 대상 위 짧은 베기 호
 *  - 스킬 피해(attack.skillId): 계열(fire/ice/lightning/holy/nature/shadow/none→물리)별 픽셀 파티클 폭발
 *  - skill 이벤트: 시전자 발밑 작은 시전 링
 *  - zone_damage / hazard_damage(linger) / dot: 작은 불꽃 (틱마다 오므로 시각 해시로 솎는다)
 *  - hazard_damage(impact): 얼음 파편 폭발
 *  - heal: 위로 떠오르는 초록 반짝임
 *
 * 모든 파티클의 위치는 (생성 시각, 인덱스) 의 순수 함수다. 상태를 갱신하지 않으므로 리플레이·배속에서 같은 그림이 나온다.
 * 좌표는 맵 단위로 보관하고 그릴 때 오프스크린 px 로 바꾼다. 픽셀 느낌을 위해 2px 격자에 맞춰 찍는다.
 */
import type { BattleEvent, MagicSchool, MainJob, UnitSnapshot } from '../../core/types';
import { getSkill } from '../../core/data/skills';
import { JOB_PALETTE, MAGIC_SCHOOL_COLOR, BLIZZARD_COLORS, type SchoolPalette } from './palette';
import { hashNoise } from './terrain';

/** 이 거리(맵 단위)보다 멀면 원거리 기본 공격 → 투사체 */
export const RANGED_DIST = 2.5;
/** 투사체 비행 시간 (시뮬레이션 초) */
export const PROJECTILE_SEC = 0.25;
/** 베기 호 지속 (초) */
const SLASH_SEC = 0.2;
/** 폭발 파티클 수명 (초) */
const BURST_SEC = 0.45;
/** 작은 불꽃 수명 (초) */
const SPARK_SEC = 0.3;
/** 시전 링 수명 (초) */
const CAST_RING_SEC = 0.3;
/** 회복 반짝임 수명 (초) */
const HEAL_SEC = 0.55;
/** 동시에 유지하는 이펙트 상한 (오래된 것부터 버린다) */
const MAX_EFFECTS = 160;

export type ProjectileKind = 'arrow' | 'bullet' | 'orb' | 'spark';

type Effect =
  | { kind: 'projectile'; born: number; life: number; x: number; y: number; tx: number; ty: number; proj: ProjectileKind; color: string; seed: number; hit: boolean }
  | { kind: 'slash'; born: number; life: number; x: number; y: number; angle: number; color: string; seed: number }
  | { kind: 'burst'; born: number; life: number; x: number; y: number; school: MagicSchool; count: number; speed: number; seed: number; blizzard: boolean }
  | { kind: 'spark'; born: number; life: number; x: number; y: number; school: MagicSchool; count: number; seed: number }
  | { kind: 'castRing'; born: number; life: number; x: number; y: number; school: MagicSchool; seed: number }
  | { kind: 'heal'; born: number; life: number; x: number; y: number; seed: number };

/** 스킬 id → 이능 계열. 물리 스킬·모르는 id 는 'none' */
export function schoolOfSkill(skillId: string | undefined | null): MagicSchool {
  if (!skillId) return 'none';
  try {
    const sk = getSkill(skillId);
    const dmg = sk.effects.find((e) => e.kind === 'damage');
    if (dmg && dmg.kind === 'damage') {
      if (dmg.school === 'phys') return 'none';
      return dmg.magic ?? sk.magic ?? 'none';
    }
    return sk.magic ?? 'none';
  } catch {
    return 'none';
  }
}

/** 공격자 직업 → 투사체 종류 */
function projectileKindOf(job: MainJob | 'summon'): ProjectileKind {
  switch (job) {
    case 'archer':
      return 'arrow';
    case 'sniper':
      return 'bullet';
    case 'mage':
    case 'summoner':
    case 'healer':
      return 'orb';
    case 'summon':
      return 'spark';
    default:
      return 'spark';
  }
}

function projectileColorOf(u: UnitSnapshot): string {
  if (u.job === 'summon') return '#ffffff';
  const pal = JOB_PALETTE[u.job];
  return pal ? pal.glow : '#ffffff';
}

/** 2px 격자에 맞춘 사각형 */
function px2(ctx: CanvasRenderingContext2D, x: number, y: number, size = 2): void {
  ctx.fillRect(Math.floor(x / 2) * 2, Math.floor(y / 2) * 2, size, size);
}

export class EffectSystem {
  private effects: Effect[] = [];
  private seq = 0;

  clear(): void {
    this.effects = [];
  }

  /** 이번 틱 이벤트를 받아들인다 (틱당 한 번). byId 는 현재 프레임의 유닛 */
  ingest(events: readonly BattleEvent[], byId: Map<string, UnitSnapshot>): void {
    for (const e of events) {
      const seed = ++this.seq;
      switch (e.kind) {
        case 'attack': {
          const to = byId.get(e.to);
          if (!to) break;
          if (e.skillId) {
            if (!e.miss) {
              this.push({
                kind: 'burst', born: e.t, life: BURST_SEC, x: to.x, y: to.y, school: schoolOfSkill(e.skillId),
                count: e.crit ? 16 : 11, speed: e.crit ? 3.2 : 2.4, seed, blizzard: false,
              });
            }
            break;
          }
          const from = byId.get(e.from);
          if (!from) {
            if (!e.miss) this.push({ kind: 'spark', born: e.t, life: SPARK_SEC, x: to.x, y: to.y, school: 'none', count: 4, seed });
            break;
          }
          const dist = Math.hypot(to.x - from.x, to.y - from.y);
          if (dist > RANGED_DIST) {
            this.push({
              kind: 'projectile', born: e.t, life: PROJECTILE_SEC, x: from.x, y: from.y - 0.9, tx: to.x, ty: to.y - 0.7,
              proj: projectileKindOf(from.job), color: projectileColorOf(from), seed, hit: !e.miss,
            });
          } else {
            const angle = Math.atan2(to.y - from.y, to.x - from.x);
            this.push({ kind: 'slash', born: e.t, life: SLASH_SEC, x: to.x, y: to.y - 0.6, angle, color: e.crit ? '#ffd54a' : '#ffffff', seed });
            if (!e.miss) this.push({ kind: 'spark', born: e.t, life: SPARK_SEC, x: to.x, y: to.y - 0.6, school: 'none', count: e.crit ? 6 : 3, seed: seed + 1 });
          }
          break;
        }
        case 'skill': {
          const u = byId.get(e.from);
          const x = u ? u.x : e.x;
          const y = u ? u.y : e.y;
          this.push({ kind: 'castRing', born: e.t, life: CAST_RING_SEC, x, y, school: schoolOfSkill(e.skillId), seed });
          break;
        }
        case 'zone_damage': {
          if (Math.round(e.t * 20) % 4 !== 0) break; // 틱마다 오므로 0.2초에 한 번만
          const to = byId.get(e.to);
          if (!to) break;
          this.push({ kind: 'spark', born: e.t, life: SPARK_SEC, x: to.x, y: to.y - 0.5, school: schoolOfSkill(e.skillId), count: 3, seed });
          break;
        }
        case 'hazard_damage': {
          const to = byId.get(e.to);
          if (!to) break;
          if (e.phase === 'impact') {
            this.push({ kind: 'burst', born: e.t, life: BURST_SEC, x: to.x, y: to.y - 0.4, school: e.school, count: 12, speed: 2.6, seed, blizzard: e.school === 'ice' });
          } else if (Math.round(e.t * 20) % 5 === 0) {
            this.push({ kind: 'spark', born: e.t, life: SPARK_SEC, x: to.x, y: to.y - 0.5, school: e.school, count: 2, seed });
          }
          break;
        }
        case 'dot': {
          if (Math.round(e.t * 20) % 5 !== 0) break;
          const to = byId.get(e.to);
          if (!to) break;
          this.push({ kind: 'spark', born: e.t, life: SPARK_SEC, x: to.x, y: to.y - 0.8, school: e.status === 'burn' ? 'fire' : 'nature', count: 2, seed });
          break;
        }
        case 'reflect': {
          const to = byId.get(e.to);
          if (!to) break;
          this.push({ kind: 'spark', born: e.t, life: SPARK_SEC, x: to.x, y: to.y - 0.6, school: 'holy', count: 4, seed });
          break;
        }
        case 'heal': {
          const to = byId.get(e.to);
          if (!to) break;
          this.push({ kind: 'heal', born: e.t, life: HEAL_SEC, x: to.x, y: to.y, seed });
          break;
        }
        default:
          break;
      }
    }
  }

  private push(e: Effect): void {
    this.effects.push(e);
    if (this.effects.length > MAX_EFFECTS) this.effects.splice(0, this.effects.length - MAX_EFFECTS);
  }

  /** 끝난 이펙트 제거. 투사체는 도착 후 불꽃까지 남긴다 */
  prune(now: number): void {
    this.effects = this.effects.filter((e) => {
      const extra = e.kind === 'projectile' ? SPARK_SEC : 0;
      return now - e.born < e.life + extra && now >= e.born;
    });
  }

  /**
   * 오프스크린 픽셀 캔버스에 그린다.
   * @param toX/toY 맵 좌표 → 오프스크린 px
   * @param px 1 유닛의 px
   */
  draw(ctx: CanvasRenderingContext2D, now: number, toX: (x: number) => number, toY: (y: number) => number, px: number): void {
    if (this.effects.length === 0) return;
    ctx.save();
    for (const e of this.effects) {
      const age = now - e.born;
      if (age < 0) continue;
      switch (e.kind) {
        case 'projectile':
          this.drawProjectile(ctx, e, age, toX, toY, px);
          break;
        case 'slash':
          this.drawSlash(ctx, e, age, toX, toY, px);
          break;
        case 'burst':
          this.drawBurst(ctx, e, age, toX, toY, px);
          break;
        case 'spark':
          this.drawSpark(ctx, e, age, toX, toY, px);
          break;
        case 'castRing':
          this.drawCastRing(ctx, e, age, toX, toY, px);
          break;
        case 'heal':
          this.drawHeal(ctx, e, age, toX, toY, px);
          break;
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawProjectile(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'projectile' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    if (age >= e.life) {
      // 도착: 작은 불꽃 (빗나가면 없음)
      if (!e.hit) return;
      const a2 = age - e.life;
      const pal = MAGIC_SCHOOL_COLOR.none;
      const cx = toX(e.tx);
      const cy = toY(e.ty);
      const n = 4;
      for (let i = 0; i < n; i++) {
        const ang = hashNoise(i, e.seed, 7) * Math.PI * 2;
        const d = (0.15 + a2 * 1.6) * px;
        ctx.globalAlpha = Math.max(0, 1 - a2 / SPARK_SEC);
        ctx.fillStyle = a2 < SPARK_SEC * 0.4 ? pal.core : pal.main;
        px2(ctx, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, 2);
      }
      return;
    }
    const t = age / e.life;
    const x = e.x + (e.tx - e.x) * t;
    const y = e.y + (e.ty - e.y) * t - Math.sin(Math.PI * t) * (e.proj === 'arrow' ? 0.5 : 0.15);
    const dx = e.tx - e.x;
    const dy = e.ty - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const cx = toX(x);
    const cy = toY(y);
    ctx.globalAlpha = 1;
    switch (e.proj) {
      case 'arrow': {
        // 화살: 나무 대 3칸 + 흰 촉
        ctx.fillStyle = '#8c5a2b';
        for (let k = 1; k <= 3; k++) px2(ctx, cx - ux * k * 2, cy - uy * k * 2, 2);
        ctx.fillStyle = '#ffffff';
        px2(ctx, cx, cy, 2);
        ctx.fillStyle = '#d0d0d0';
        px2(ctx, cx - ux * 8 - uy * 2, cy - uy * 8 + ux * 2, 2);
        break;
      }
      case 'bullet': {
        // 탄환: 노란 3×3 + 꼬리
        ctx.fillStyle = '#ffe94a';
        px2(ctx, cx - 1, cy - 1, 3);
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#ffb347';
        px2(ctx, cx - ux * 3, cy - uy * 3, 2);
        ctx.globalAlpha = 0.3;
        px2(ctx, cx - ux * 6, cy - uy * 6, 2);
        break;
      }
      case 'orb': {
        // 마력구: 십자 5×5 + 흔들리는 꼬리
        ctx.fillStyle = e.color;
        px2(ctx, cx - 2, cy, 6);
        px2(ctx, cx, cy - 2, 2);
        px2(ctx, cx, cy + 2, 2);
        ctx.fillStyle = '#ffffff';
        px2(ctx, cx, cy, 2);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = e.color;
        const wob = Math.sin(age * 40 + e.seed) * 2;
        px2(ctx, cx - ux * 5 - uy * wob, cy - uy * 5 + ux * wob, 2);
        px2(ctx, cx - ux * 9 + uy * wob, cy - uy * 9 - ux * wob, 2);
        break;
      }
      default: {
        ctx.fillStyle = '#ffffff';
        px2(ctx, cx, cy, 2);
        ctx.globalAlpha = 0.5;
        px2(ctx, cx - ux * 3, cy - uy * 3, 2);
      }
    }
  }

  private drawSlash(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'slash' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const cx = toX(e.x);
    const cy = toY(e.y);
    const r = px * 0.65;
    const sweep = Math.PI * 0.7;
    const n = 9;
    ctx.fillStyle = e.color;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      // 호가 순서대로 나타났다가 사라진다
      const show = f < p * 1.4 && f > (p - 0.45) * 1.4;
      if (!show) continue;
      const ang = e.angle - sweep / 2 + sweep * f;
      ctx.globalAlpha = 0.95 - 0.5 * f;
      px2(ctx, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, i % 2 === 0 ? 3 : 2);
    }
  }

  private drawBurst(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'burst' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const pal: SchoolPalette = MAGIC_SCHOOL_COLOR[e.school] ?? MAGIC_SCHOOL_COLOR.none;
    const cx = toX(e.x);
    const cy = toY(e.y);
    // 중심 섬광 (짧게)
    if (p < 0.25) {
      ctx.globalAlpha = 1 - p / 0.25;
      ctx.fillStyle = pal.core;
      const sz = 6 + Math.round(p * 20);
      px2(ctx, cx - sz / 2, cy - sz / 2, sz);
    }
    for (let i = 0; i < e.count; i++) {
      const ang = hashNoise(i, e.seed, 3) * Math.PI * 2;
      const spd = e.speed * (0.5 + hashNoise(i, e.seed, 5)) * px;
      // 감속 + 약한 중력
      const d = spd * age * (1 - 0.45 * p);
      const gx = cx + Math.cos(ang) * d;
      const gy = cy + Math.sin(ang) * d * 0.8 + (e.school === 'fire' ? -age * px * 0.6 : age * age * px * 1.4);
      ctx.globalAlpha = Math.max(0, 1 - p * p);
      let color: string;
      if (e.blizzard) {
        color = BLIZZARD_COLORS[i % BLIZZARD_COLORS.length];
      } else {
        color = p < 0.3 ? pal.core : p < 0.65 ? pal.main : pal.dark;
      }
      ctx.fillStyle = color;
      const big = e.school === 'lightning' ? (i % 3 === 0 ? 3 : 2) : i % 4 === 0 ? 3 : 2;
      px2(ctx, gx, gy, big);
      // 전기: 지그재그 꼬리
      if (e.school === 'lightning' && p < 0.5) {
        const zz = i % 2 === 0 ? 2 : -2;
        px2(ctx, gx - Math.cos(ang) * 4 + zz, gy - Math.sin(ang) * 4, 2);
      }
    }
  }

  private drawSpark(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'spark' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const pal: SchoolPalette = MAGIC_SCHOOL_COLOR[e.school] ?? MAGIC_SCHOOL_COLOR.none;
    const cx = toX(e.x);
    const cy = toY(e.y);
    for (let i = 0; i < e.count; i++) {
      const ang = hashNoise(i, e.seed, 9) * Math.PI * 2;
      const d = (0.1 + age * 1.8 * (0.5 + hashNoise(i, e.seed, 11))) * px;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.fillStyle = p < 0.4 ? pal.core : pal.main;
      px2(ctx, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d * 0.7 - age * px * 0.5, 2);
    }
  }

  private drawCastRing(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'castRing' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const pal: SchoolPalette = MAGIC_SCHOOL_COLOR[e.school] ?? MAGIC_SCHOOL_COLOR.none;
    const cx = toX(e.x);
    const cy = toY(e.y);
    const r = (0.35 + p * 0.9) * px;
    const n = 12;
    ctx.globalAlpha = Math.max(0, 1 - p);
    ctx.fillStyle = p < 0.4 ? pal.core : pal.main;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + e.seed;
      px2(ctx, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r * 0.45, 2);
    }
  }

  private drawHeal(
    ctx: CanvasRenderingContext2D,
    e: Extract<Effect, { kind: 'heal' }>,
    age: number,
    toX: (x: number) => number,
    toY: (y: number) => number,
    px: number,
  ): void {
    const p = Math.min(1, age / e.life);
    const cx = toX(e.x);
    const cy = toY(e.y);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const ox = (hashNoise(i, e.seed, 13) - 0.5) * 1.2 * px;
      const delay = hashNoise(i, e.seed, 17) * 0.3;
      const a = age - delay;
      if (a < 0) continue;
      const y = cy - a * px * 2.2 - 0.3 * px;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.fillStyle = i % 2 === 0 ? '#7cf59a' : '#ffffff';
      // 작은 십자
      px2(ctx, cx + ox, y, 2);
      if (i % 3 === 0) {
        px2(ctx, cx + ox - 2, y, 2);
        px2(ctx, cx + ox + 2, y, 2);
        px2(ctx, cx + ox, y - 2, 2);
        px2(ctx, cx + ox, y + 2, 2);
      }
    }
  }
}
