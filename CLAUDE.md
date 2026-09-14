# battlesimulation

이능 판타지 5:5 관전형 전투 + 우마무스메식 육성 시뮬레이터 프로토타입. 기획서: docs/GDD.md (반드시 먼저 읽을 것).

## 스택
- TypeScript + Vite, Canvas 2D. 게임 엔진 없음. 서버 없음 (localStorage).
- `npm run typecheck` / `npm run dev` / `npm run build` / `npm run headless`.

## 절대 규칙
- 시뮬레이션·육성 로직에서 `Math.random`, `Date.now`, `new Date()` 금지. 난수는 `src/core/rng.ts` 의 `Rng` 만 사용.
- 결정론 보장: 같은 seed + 같은 입력 → 같은 결과. 유닛 순회는 항상 배열 순서 고정. Set/Map 순회는 삽입 순서에 의존하므로 삽입 순서도 결정론적이어야 함. 객체 키 순회 대신 `BASE_STAT_KEYS` 같은 상수 배열 사용.
- `src/core/**` 는 DOM 을 참조하지 않는다 (헤드리스 실행 가능해야 함).
- 공용 타입은 `src/core/types.ts` 에만 둔다. 다른 모듈은 타입을 새로 만들지 말고 import.
- UI 문자열은 한국어.

## 모듈 구조
- `src/core/types.ts` 공용 타입 계약
- `src/core/rng.ts` 시드 난수
- `src/core/stats.ts` 파생 전투 수치 계산 (GDD 4.2)
- `src/core/data/jobs.ts` 직업 9종 × 세부 3종 정의
- `src/core/data/skills.ts` 스킬 정의 + `SKILLS` 맵, `getSkill(id)`
- `src/core/data/maps.ts` 맵 4종 정의 + `MAPS`
- `src/core/data/synergies.ts` 시너지 정의 생성기
- `src/core/battle/sim.ts` 결정론 전투 시뮬레이션 (`createBattle(input): BattleSimulator`)
- `src/core/gen/charGen.ts` 캐릭터 풀 / 상대팀 랜덤 생성
- `src/core/growth/choices.ts` 로그라이크 선택지 생성·적용
- `src/core/growth/run.ts` 육성 상태 머신 (10사이클)
- `src/core/growth/storage.ts` localStorage 저장, 고스트 스냅샷
- `src/ui/app.ts` 화면 흐름, `src/ui/render.ts` 캔버스 렌더러, `src/ui/style.css`
- `tools/headless.ts` 대량 시뮬레이션 CLI
