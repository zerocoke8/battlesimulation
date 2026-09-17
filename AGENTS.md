# Sprite production

For sprite creation or edits, read `docs/SPRITES.md` and `docs/SPRITE_WORKFLOW.md`.
These record the user's explicit art requirements. Use Aseprite Lua scripts under
`scripts/` and execute them with Aseprite CLI. Preserve editable layered sources
under `art/aseprite/`, and visually inspect enlarged exports before delivery.
Player characters share the user's cute SD proportions and rigid head/torso
sizes. Keep connected joints, stable facial features, original skin shading
and cheek blush. Edit only exact eye pixels for closed eyes. No antialiasing,
blur, dithering or squash/stretch. Monsters only need a compatible color tone:
use creative silhouettes and species-appropriate proportions, especially for
living armor and humanoid monsters; do not force oversized chibi heads on them.
Use Aseprite for characters and skill effects. The user explicitly requested
image generation for the four terrain backgrounds and allowed it for job icons.

For skill effect creation or edits (impact, projectile, cast, slash, zone, status
sheets under `public/effects/`), read `docs/EFFECTS.md` and verify with
`npm run effects:check`.

For gameplay architecture and deterministic simulation rules see `CLAUDE.md`.
