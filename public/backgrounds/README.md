# 전장 배경

`plains`(초원), `dark`(어둠), `desert`(사막), `glacier`(빙하) 4종.

**public 에는 표시 크기에 맞춘 그림을 둔다.** 여기 있는 PNG 는 **896×640** (8bit RGB, colortype 2) 이다 —
맵 28×20 유닛 × 32px (`MAP_DEFAULT_WIDTH/HEIGHT`) 로, `src/ui/pixel/terrain.ts` 가 맵 내부에 그리는 크기와 정확히 같다.
더 큰 그림을 두면 브라우저가 `imageSmoothingEnabled = false` 로 최근접 축소를 하면서 디테일이 뭉개지고 배포 용량만 커진다.
배경은 맵을 빈틈없이 덮으므로 알파 채널이 필요 없다 — RGB 로 내보내 픽셀당 1바이트를 아낀다.
도구는 알파가 255 아닌 픽셀이 하나라도 있으면 RGB 로 쓰지 않고 오류를 내므로, 투명한 배경을 실수로 밀어 넣을 수는 없다.

원본(1484×1060)은 `art/originals/backgrounds/` 에 있고, 여기 파일은 `npm run art:optimize` 로 다시 만든다.
축소는 박스 필터(면적 평균)라 최근접보다 디테일이 살아남는다. 목표 크기는 `tools/optimize-art.ts` 의 표에 있다.

```
npm run art:optimize            # 원본 → public 에 표시 크기로 다시 생성
npm run art:optimize -- --check # 파일을 쓰지 않고 현재·목표 크기와 절감량만 확인
```

원본을 새로 그렸으면 `art/originals/backgrounds/<맵id>.png` 를 갈아 끼우고 위 명령을 돌린다.

프롬프트: `art/imagegen-prompts.json`.
제작·검수 기록: [EFFECT_WORKFLOW.md](../../docs/EFFECT_WORKFLOW.md).
