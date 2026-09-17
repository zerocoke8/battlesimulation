-- Round-trip validation of saved Aseprite sources, not the drawing functions.
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local catalog=dofile(root..'/scripts/effect_catalog.lua')
local total=0
for _,d in ipairs(catalog) do
  local m=d.meta
  local spr=assert(app.open(root..'/art/aseprite/effects/'..d.key..'.aseprite'))
  local png=Image{fromFile=root..'/public/effects/'..d.key..'.png'}
  assert(#spr.layers==3 and #spr.frames==m.frames and #spr.tags==1,d.key..': source structure')
  for f=1,m.frames do
    local flat=P.image(m.frameW,m.frameH);flat:drawSprite(spr,f)
    assert(math.abs(spr.frames[f].duration-1/m.fps)<.001,d.key..': timing')
    for y=0,m.frameH-1 do for x=0,m.frameW-1 do
      assert(flat:getPixel(x,y)==png:getPixel((f-1)*m.frameW+x,y),d.key..': source/export mismatch')
    end end
    total=total+1
  end
  spr:close()
end
local f=assert(io.open(root..'/art/effects/verification.json','w'))
f:write(json.encode({passed=true,effects=#catalog,frames=total,checks={'saved source/export exact pixel match','3 editable layers and animation tag','frame durations'}}));f:close()
print('PASS: '..#catalog..' saved Aseprite sources / '..total..' frames match exports')
