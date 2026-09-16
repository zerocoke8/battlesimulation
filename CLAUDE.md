# battlesimulation

이능 판타지 4:4 관전형 전투 + 우마무스메식 육성 시뮬레이터 프로토타입. 기획서: docs/GDD.md (반드시 먼저 읽을 것).

## 스택
- TypeScript + Vite, Canvas 2D. 게임 엔진 없음. 서버 없음 (localStorage).
- `npm run typecheck` / `npm run dev` / `npm run build` / `npm run headless`.

## 절대 규칙
- 시뮬레이션·육성 로직에서 `Math.random`, `Date.now`, `new Date()` 금지. 난수는 `src/core/rng.ts` 의 `Rng` 만 사용.
- 결정론 보장: 같은 seed + 같은 입력 → 같은 결과. 유닛 순회는 항상 배열 순서 고정. Set/Map 순회는 삽입 순서에 의존하므로 삽입 순서도 결정론적이어야 함. 객체 키 순회 대신 `BASE_STAT_KEYS` 같은 상수 배열 사용.
- `src/core/**` 는 DOM 을 참조하지 않는다 (헤드리스 실행 가능해야 함).
- 공용 타입은 `src/core/types.ts` 에만 둔다. 다른 모듈은 타입을 새로 만들지 말고 import.
- UI 문자열은 한국어.
- 팀 인원을 숫자로 하드코딩하지 않는다. 플레이어 팀은 `TEAM_SIZE`, 몬스터 팀은 `MONSTER_TEAM_MIN`~`MONSTER_TEAM_MAX`.

## 모듈 구조
- `src/core/types.ts` 공용 타입 계약
- `src/core/rng.ts` 시드 난수
- `src/core/stats.ts` 파생 전투 수치 계산 (GDD 4.2)
- `src/core/data/jobs.ts` 직업 9종 × 세부 3종 정의
- `src/core/data/skills.ts` 스킬 정의 + `SKILLS` 맵, `getSkill(id)`
- `src/core/data/maps.ts` 맵 4종 정의 + `MAPS`
- `src/core/data/synergies.ts` 시너지 정의 생성기
- `src/core/data/monsters.ts` 몬스터 정의 12종 이상 (`MONSTERS`), 난이도별 조회 + 인카운터 생성
- `src/core/battle/sim.ts` 결정론 전투 시뮬레이션 (`createBattle(input): BattleSimulator`)
- `src/core/gen/charGen.ts` 캐릭터 풀 / 상대팀 랜덤 생성
- `src/core/growth/choices.ts` 로그라이크 선택지 생성·적용, 희귀도, `estimatePowerDelta`
- `src/core/growth/run.ts` 육성 상태 머신 (10일 × 5스텝)
- `src/ui/storage.ts` localStorage 저장(`SAVE_VERSION = 3`), 고스트 스냅샷
- `src/ui/app.ts` 화면 흐름, `src/ui/render.ts` 캔버스 렌더러, `src/ui/style.css`
- `tools/headless.ts` 대량 시뮬레이션 CLI

## 용어 (v0.4)
- 육성 단위는 **일(day)**. 예전 `cycle` 은 전부 `day` 로 바뀌었다: `TOTAL_CYCLES` → `TOTAL_DAYS(10)`, `CycleRecord` → `DayRecord`, `RunState.cycle` → `day`, `GhostSnapshot.cycle` → `day`.
- 하루는 5스텝 고정: 선택(1) · 선택(2) · 몬스터(3) · 선택(4) · 4:4 전투(5). 이후 하루 마무리(`day_end`)를 거쳐 다음 날로 간다. 자세한 내용은 GDD §7.

## v0.5 계약 (types.ts)
- `TEAM_SIZE = 4`: 플레이어 팀·4:4 상대팀·고스트·완성팀은 정확히 4명. 화면·코드의 '5:5' 표기는 전부 '4:4'.
- `MONSTER_TEAM_MIN = 1`, `MONSTER_TEAM_MAX = 8`: 몬스터 팀만 1~8명. sim 은 어느 쪽 팀이든 1~8명을 스폰한다. `MapDef.spawnA/spawnB` 는 대열 기준 열(anchor)일 뿐이고 실제 위치는 sim 이 인원 수에 맞는 대열(전열/후열, 세로 균등, 경계 안, 겹침 없음)을 결정론적으로 만든다.
- 광역 스킬 = Zone. `SkillDef.telegraphSec?`(예고), `SkillDef.linger?`(장판). 기본값 상수 `DEFAULT_TELEGRAPH_SEC 0.8` / `SHORT_TELEGRAPH_SEC 0.3` / `ALLY_AREA_FLASH_SEC 0.4` / `ZONE_FLASH_SEC 0.25`.
  시전 완료 시 즉시 적용 대신 Zone 생성 → 예고 0 되는 틱에 impact → linger 가 있으면 장판. 시전자가 죽어도 Zone 유지. 예고 시작 시 영역 안 적마다 회피 판정 1회 (공식은 GDD §4.4).
- `BattleFrame.zones: ZoneSnapshot[]` (`phase: 'telegraph' | 'active' | 'flash'`, `progress 0~1`, `remainingSec`). 렌더러는 이것만 보고 그린다.
- `BattleEvent` 에 `{ kind: 'zone'; from; skillId; x; y }`, `{ kind: 'dodge'; unit; skillId }` 추가. 렌더는 회피 성공 유닛 위에 '회피!'.
- 저장: `SAVE_VERSION = 3`. 인원이 `TEAM_SIZE` 가 아닌 저장 팀·고스트는 버전이 맞아도 버린다.

## v0.6 계약 (types.ts)
- 피해 출처 이벤트 (헤드리스 스킬 피해 비중 측정용. 렌더러는 `attack`/`heal`/`skill` 등만 그리고 나머지는 무시한다):
  - `attack` 에 `skillId?: string`. 있으면 스킬 피해 효과(즉시·광역 impact), 없으면 기본 공격.
  - `{ kind: 'zone_damage'; from; to; skillId; damage; school }` 장판 한 틱, `{ kind: 'dot'; from: string | null; to; status: 'burn' | 'poison'; damage }` 화상·중독 한 틱.
    이 둘은 **프레임 이벤트에만** 실리고 `BattleResult.events` 에는 넣지 않는다 (틱 단위라 결과 이벤트 상한 5000 을 채운다).
  - `{ kind: 'reflect'; from; to; damage }` 반사 (from = 반사한 피격자).
  - 피해를 주는 경로를 sim 에 새로 만들면 반드시 이 중 하나를 내야 한다. `tools/headless.ts` 는 '미분류' 가 10% 를 넘으면 경고한다.
- 스킬 데이터: `isZoneSkill(id)` (skills.ts) = enemy_area/line 이거나 예고·장판이 있는 스킬. UI 의 스킬명 외치기 말풍선 크기에 쓴다.
  모든 메인 직업 기본 풀에 광역 피해 스킬 1개 이상, 마법사 `starterSkills` 는 전부 광역 (`npm run headless -- --skills` 가 검사, 종료 코드 반영).
- 스킬 `desc` 는 손으로 쓰지 않는다. `describeActive`/`describePassive` 가 스펙 숫자로 문장을 만든다.
