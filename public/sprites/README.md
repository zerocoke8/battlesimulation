# public/sprites — 도트 스프라이트 에셋 폴더

여기에 `<key>.png` + `<key>.json` 을 넣으면 도트 모드가 코드 생성 임시 스프라이트 대신 그 시트를 쓴다.
파일이 없으면 자동으로 임시 스프라이트로 폴백하므로 이 폴더가 비어 있어도 게임은 정상 동작한다.

- 규격(64×64 프레임, 애니메이션당 1행, 앵커 (32,58), 애니메이션 6종)과 키 31개 목록: `docs/SPRITES.md`
- 메타데이터 JSON 은 규격대로 그렸다면 `_meta.example.json` 을 `<key>.json` 으로 복사하면 된다. (`_` 로 시작하는 파일은 로더가 읽지 않는다)
- 예: `public/sprites/mage.png` + `public/sprites/mage.json`, `public/sprites/monster_slime_swarm.png` + `.json`
- 세부 직업 시트는 만들지 않는다 (직업 시트에 코드가 팔레트 틴트를 적용). 팀 색도 시트에 넣지 않는다.

현재 31종의 Aseprite 제작 PNG·JSON이 들어 있다. 직업 9종의 `.tint.png`는 피부와 홍조를 보호하는 의상 마스크다.
원본: `art/aseprite/`. 제작 Lua: `scripts/`. 확대 미리보기: `art/gallery.html`.
재생성: `npm run sprites:build`. 자세한 규칙: `docs/SPRITE_WORKFLOW.md`.
