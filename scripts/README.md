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
