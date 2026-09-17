# 1·2순위 이펙트 · 배경 · 직업 문양 제작 기록

2026-09-17 제작. 규격의 기준은 [EFFECTS.md](EFFECTS.md) §4이다.

## 제작 범위

| 에셋 | 수량 | 방식 | 게임 파일 |
|---|---:|---|---|
| 피격 폭발 | 7종 / 42프레임 | Aseprite Lua + Steam CLI | `public/effects/impact_*.png` + JSON |
| 투사체 | 8종 / 32프레임 | 동일 | `public/effects/proj_*.png` + JSON |
| 베기 | 3종 / 12프레임 | 동일 | `public/effects/slash_*.png` + JSON |
| 회복·사망·치명타 | 3종 / 14프레임 | 동일 | `heal_burst`, `death_poof`, `crit_star` PNG + JSON |
| 시전 | 7종 / 28프레임 | Aseprite Lua + Steam CLI | `public/effects/cast_*.png` + JSON |
| 장판 테두리 | 25종 / 100프레임 | 동일, 반경별 실제 크기로 제작 | `public/effects/zone_ring_*.png` + JSON |
| 장판 내부 | 8종 / 32프레임 | 동일, 32px 반복 타일 | `public/effects/zone_fill_*.png` + JSON |
| 초원·어둠·사막·빙하 | 4종 | 내장 이미지 생성 도구 | `public/backgrounds/<map>.png` |
| 직업 문양 | 9종 | 내장 이미지 생성 도구 | `public/icons/<job>.png` |

이펙트 합계는 **61종 / 260프레임** (1순위 21종 + 2순위 40종). 프레임 크기, 수, fps, 앵커, blend, loop는 규격 표와 같다.
아직 제작하지 않은 3순위 7종(`status_*` 4종, `buff_ring`, `dodge_puff`, `summon_circle`)은 기존 로더의 임시 에셋을 사용한다.

## 원본과 재생성

- 편집 가능한 이펙트 원본: `art/aseprite/effects/<key>.aseprite`
- 각 원본: 궤적·파편 / 주 형태 / 밝은 중심의 **3레이어**, 키 이름의 애니메이션 태그 1개
- 규격 목록: `scripts/effect_catalog.lua`
- 픽셀 형태·팔레트·프레임 변화: `scripts/effect_art.lua`
- 시전·장판 도형과 타일 반복: `scripts/effect_area_art.lua`
- 생성·내보내기: `scripts/build_effects.lua`
- 저장된 Aseprite 원본과 PNG의 픽셀 일치 검사: `scripts/verify_effects.lua`

```powershell
npm run effects:build -- -Priority 2  # 시전·장판 40종만 재생성
npm run effects:verify               # 원본을 바꾸지 않고 저장 파일 검증
npm run effects:check
npm run typecheck
npm run build
```

`effects:build`는 Steam Aseprite CLI로 Lua를 실행하고 원본과 PNG를 다시 만든다.
`-Priority 1`은 21종, 옵션을 생략하면 완성된 61종 전체를 재생성한다.
**Aseprite에서 수동 편집한 원본도 덮어쓰므로**, 수동 수정은 먼저 보관하거나 Lua에도 반영한다.
직접 편집해서 내보낼 때는 1행 시트와 기존 JSON 규격을 유지한다.

모든 FX는 정수 픽셀·0/255 알파이며 AA·블러·디더링을 쓰지 않는다.
`add`는 검은 외곽선 없이 유색 외곽에서 밝은 중심으로 구성한다.
폭발 끝부분은 색과 파편 수를 줄여 사라지게 하고, 투사체는 머리를 고정한 채 꼬리만 작은 주기로 움직인다.
사망 연기는 중심을 비워 쓰러진 캐릭터를 가리지 않는다.

2순위의 시전은 발밑에 놓이는 납작한 마법진이며, 바깥쪽 장식을 4프레임으로 순환시킨다.
테두리는 160·192·224·256·288·320·384px 원본에 직접 그렸다. 밝은 1~2px 외곽선은 고정하고,
외곽에서 약 10px 이내의 불꽃·결정·번개·잎·기류 장식만 이동한다. 원본 확대나 회전으로 다른 반경을 만들지 않는다.
내부는 32px마다 이어지는 무늬에 방향·배치·움직임의 위상 차이를 주었다.
불투명 면적은 전체 프레임 기준 30.6~52.8%이며, PNG 알파는 모두 0 또는 255다.
`phys`와 `neutral`은 일반 합성, 나머지는 가산 합성이다.

## 이미지 생성 에셋

[imagegen-prompts.json](../art/imagegen-prompts.json)에 내장 도구 모드와 사용한 프롬프트를 저장했다.
생성 원본을 그대로 PNG로 복사했다. 배경은 **1484×1060(7:5)**, 직업 문양은 **1254×1254 투명 PNG**다.

`src/ui/pixel/terrain.ts`는 배경을 비동기로 읽어 맵 안쪽에 최근접 방식으로 그린다.
중앙은 이동 가능한 바닥으로 비우고 환경 장식을 가장자리로 모았다. 로드 실패 시 기존 지형을 유지한다.

`src/ui/pixel/icons.ts`는 문양의 투명 여백을 제외하고 작은 진영 배지에 그린다.
7~12px 내부 영역에서는 불투명 면적을 계산해 픽셀을 켜거나 끄므로 가는 자루의 손실을 줄인다.
반투명 가장자리를 만들지 않고 정수 픽셀로 그린다. 로딩 중·실패 시 기존 직업 마스크를 사용한다.
시뮬레이션과 저장 데이터는 변경하지 않는다.

## 검수와 미리보기

- [통합 갤러리](../art/effects-gallery.html): 배경 전환, 이펙트 재생·일시정지·¼배속, 클릭 후 프레임별 확대, 원본 링크
- [시전·장판 갤러리](../art/areas-gallery.html): 8계열·25반경 조합, 실제 크기 합성, 테두리·내부·시전·캐릭터 표시 전환, 프레임 이동, 타일 경계 표시
- 개발 서버에서는 `/art/effects-gallery.html`로 연다. HTTP에서 HP바 문양은 실제 게임 아이콘 렌더러를 사용한다.
- 시전·장판은 `/art/areas-gallery.html`로 연다. 내부 밝기 42%는 게임 예고 표시의 합성값을 참고했으며, PNG 자체의 알파와는 별개다.
- 파일을 직접 열어도 기본 미리보기는 보인다. 브라우저의 로컬 파일 제한 때문에 문양의 투명 여백 제거는 HTTP에서 확인한다.
- `art/effects/previews/<key>-4x.png`: 어두운 바탕과 밝은 바탕에 실제 `add` / `normal` 방식으로 합성한 4배 시트
- 테두리의 확대 시트는 큰 원본 크기를 고려한 `<key>-2x.png`다.
- `art/effects/previews/zone_fill_<school>-tiled-3x.png`: 3×3 타일을 이어 붙인 3배 확대, 왼쪽부터 4프레임
- `art/effects/previews/all-rings-native.png`: 25종 첫 프레임을 배율 1로 배치. 순서는 `effect_catalog.lua`와 같으며 왼쪽→오른쪽, 위→아래다.
- `art/effects/previews/area-schools.png`: 캐릭터·배경·시전·장판 8계열 합성. 위 행은 화염·냉기·번개·신성, 아래 행은 자연·암흑·물리·눈보라다.
- `art/effects/previews/area-<school>-2x.png`: 위 합성의 계열별 최근접 2배 확대. `scripts/preview_area_effects.lua`로 만든 검수 이미지이며 게임 스크린샷은 아니다.
- `art/imagegen/scene-<map>.png`: 캐릭터·HP 배지·대표 이펙트를 896×640 맵에 합성한 정지 검수 이미지 (게임 스크린샷은 아님)
- `art/imagegen/icons-size-review.png`: 열은 검사→탱커→버서커→암살자→궁수→저격수→마법사→소환사→힐러, 행은 내부 7·8·10·12px의 8배 확대
- `scripts/preview_generated_art.lua`: 위 합성 검수 이미지를 만드는 보조 Lua. 배경·아이콘 원본은 수정하지 않는다.

검증 결과는 `art/effects/manifest.json`, `art/effects/manifest-priority2.json`, `art/effects/verification.json`, `art/imagegen/verification.json`에 남긴다.
`effects:check`에서 61종의 키·크기·메타데이터·알파와 내부 타일의 상하좌우 이음매를 통과했다.
원본 검사는 61개 파일의 3레이어·태그·프레임 수·시간과 260프레임의 PNG 픽셀 일치를 확인한다.
추가로 25개 테두리의 닫힘·고정 외곽선·4변 접촉·장식 범위, 8개 내부 타일의 면적,
40종의 인접 프레임 및 마지막→첫 프레임 변화량을 검사했다. 이 수치는 시각 검수와 함께 사용한다.
2순위 제작 전후 기존 1순위의 PNG·JSON·Aseprite 원본 63개 SHA-256이 동일함을 확인했다.
`npm run typecheck`와 `npm run build`도 통과했다.

몬스터는 캐릭터의 SD 체형에 맞추지 않는다. 색조를 맞추고 종에 맞는 비율과 형태를 사용한다는 사용자 기준은
[SPRITE_WORKFLOW.md](SPRITE_WORKFLOW.md)에 반영했다.
