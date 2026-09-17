# Sprite production

For sprite creation or edits, read `docs/SPRITES.md` and `docs/SPRITE_WORKFLOW.md`.
These record the user's explicit art requirements. Use Aseprite Lua scripts under
`scripts/` and execute them with Aseprite CLI. Preserve editable layered sources
under `art/aseprite/`, and visually inspect enlarged exports before delivery.
Keep the user's cute SD proportions, rigid head/torso sizes, connected joints,
stable facial features, original skin shading and cheek blush. Edit only exact
eye pixels for closed eyes. No antialiasing, blur, dithering or squash/stretch.
Do not replace this workflow with image generation or another raster editor.

For gameplay architecture and deterministic simulation rules see `CLAUDE.md`.
