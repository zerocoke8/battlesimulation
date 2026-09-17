# Aseprite Lua 도트 제작

제작 규칙, 참고 이미지 출처, 편집·재생성 방법은 [SPRITE_WORKFLOW.md](../docs/SPRITE_WORKFLOW.md)를 읽는다.

```powershell
npm run sprites:build   # Steam Aseprite CLI에서 Lua 실행, 31종 생성 + 검증
npm run sprites:verify  # 기존 원본과 PNG 검사
npm run sprites:check   # 게임 에셋 계약과 피부색 보존 틴트 검사
```

`build_sprites.lua`가 생성의 진입점이다. `sprite_catalog.lua`에서 색·장비를,
`sprite_humans.lua`와 `sprite_creatures.lua`에서 픽셀 도형과 동작을 수정한다.
`pixel_art.lua`는 정수 픽셀만 쓰며, 캔버스 밖에 그리는 시도는 빌드를 실패시킨다.

`inspect_sprite_references.lua`, `inspect_eye_pixels.lua`는 첨부 원본을 확대하거나
실제 눈의 픽셀 좌표·색을 확인할 때 쓴 보조 도구다.

## 1·2순위 스킬 이펙트

```powershell
npm run effects:build                 # Steam Aseprite Lua 실행, 61종 / 260프레임 + 저장 원본 검증
npm run effects:build -- -Priority 2  # 시전·장판 40종 / 160프레임만 재생성
npm run effects:verify                # 저장 원본과 PNG, 테두리 닫힘·반복·타일 면적 검사
npm run effects:check                 # 게임 계약과 타일 상하좌우 이음매 검사
```

`effect_catalog.lua`는 규격, `effect_art.lua`는 그림, `build_effects.lua`는 내보내기다.
2순위의 시전·반경별 테두리·반복 타일은 `effect_area_art.lua`에서 만든다.
편집 원본은 `art/aseprite/effects/`, PNG·JSON은 `public/effects/`에 남긴다.
`preview_area_effects.lua`는 저장된 PNG로 테두리 25종 원본 크기 비교와 8계열 배경·캐릭터 합성 이미지를 만든다.
배경·직업 문양은 이미지 생성 도구로 제작했다. `preview_generated_art.lua`는 이 원본들을 읽어
합성 검수 이미지만 만든다. 상세 기록: [EFFECT_WORKFLOW.md](../docs/EFFECT_WORKFLOW.md).
