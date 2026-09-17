# 직업 문양

메인 직업 9종의 투명 PNG. 파일 이름은 메인 직업 키와 같다.

**public 에는 표시 크기에 맞춘 그림을 둔다.** 여기 있는 PNG 는 **256×256** (8bit RGBA, colortype 6) 이다 —
여백을 잘라내는 판정이 알파를 보므로 배경과 달리 알파 채널을 유지한다.
`src/ui/pixel/icons.ts` 가 투명 여백을 잘라낸 뒤 128×128 캔버스에 담아 HP 바 옆 진영 배지(최대 20px)로 그리므로
256 이면 여유가 충분하다. 초소형 배지는 불투명 면적 기반 픽셀 표본화를 쓴다.

원본(1254×1254)은 `art/originals/icons/` 에 있고, 여기 파일은 `npm run art:optimize` 로 다시 만든다.
축소는 알파를 프리멀티플라이해서 평균하므로 가장자리에 검은 테두리가 생기지 않는다. 목표 크기는 `tools/optimize-art.ts` 의 표에 있다.

```
npm run art:optimize            # 원본 → public 에 표시 크기로 다시 생성
npm run art:optimize -- --check # 파일을 쓰지 않고 현재·목표 크기와 절감량만 확인
```

원본을 새로 그렸으면 `art/originals/icons/<직업키>.png` 를 갈아 끼우고 위 명령을 돌린다.

프롬프트: `art/imagegen-prompts.json`.
제작·검수 기록: [EFFECT_WORKFLOW.md](../../docs/EFFECT_WORKFLOW.md).
