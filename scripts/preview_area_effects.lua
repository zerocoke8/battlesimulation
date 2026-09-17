-- Visual QA from the exported PNGs; this does not regenerate or edit assets.
-- Run with Steam Aseprite --batch --script-param root=. --script scripts/preview_area_effects.lua
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local catalog=dofile(root..'/scripts/effect_catalog.lua')
local pc=P.pc
local cache={}
local function read(path)
  if not cache[path] then cache[path]=Image{fromFile=root..'/'..path} end
  return cache[path]
end
local function colorAt(dst,x,y,src,blend,alpha)
  if pc.rgbaA(src)==0 then return end
  if x<0 or y<0 or x>=dst.width or y>=dst.height then return end
  local bg=dst:getPixel(x,y);local a=alpha or 1
  local function channel(get)
    return math.floor(math.min(255,get(src)*a+get(bg)*(blend=='add' and 1 or (1-a)))+.5)
  end
  dst:drawPixel(x,y,pc.rgba(channel(pc.rgbaR),channel(pc.rgbaG),channel(pc.rgbaB),255))
end
local function stamp(dst,im,sx,sy,w,h,dx,dy,blend,alpha)
  for y=0,h-1 do for x=0,w-1 do colorAt(dst,dx+x,dy+y,im:getPixel(sx+x,sy+y),blend,alpha) end end
end
local all=P.image(400*5,400*5);all:clear(P.color('252a39'))
local index=0
for _,d in ipairs(catalog) do if d.kind=='ring' then
  local w=d.meta.frameW;local x=(index%5)*400+math.floor((400-w)/2);local y=math.floor(index/5)*400+math.floor((400-w)/2)
  stamp(all,read('public/effects/'..d.key..'.png'),0,0,w,w,x,y,d.meta.blend)
  index=index+1
end end
all:saveAs(root..'/art/effects/previews/all-rings-native.png')
local examples={{'fire',35,'plains'},{'ice',35,'dark'},{'lightning',40,'desert'},{'holy',40,'glacier'},
 {'nature',30,'plains'},{'shadow',30,'dark'},{'phys',40,'desert'},{'neutral',35,'glacier'}}
local overview=P.image(1280,640)
for i,d in ipairs(examples) do
  local s,tag,map=d[1],d[2],d[3];local w=math.floor(tag*6.4+.5);local r=w/2
  local cx,cy=160,174
  local dst=P.image(320,320)
  local terrain=read('public/backgrounds/'..map..'.png')
  for y=0,319 do for x=0,319 do
    dst:drawPixel(x,y,terrain:getPixel(math.floor((x+192)*terrain.width/896),math.floor((y+100)*terrain.height/640)))
  end end
  local blend=(s=='phys' or s=='neutral') and 'normal' or 'add'
  local tile=read('public/effects/zone_fill_'..s..'.png')
  for y=cy-r,cy+r-1 do for x=cx-r,cx+r-1 do
    if (x-cx)^2+(y-cy)^2<(r-2)^2 then colorAt(dst,x,y,tile:getPixel(x%32,y%32),blend,.42) end
  end end
  stamp(dst,read('public/effects/zone_ring_'..s..'_r'..tag..'.png'),0,0,w,w,cx-r,cy-r,blend)
  if s~='neutral' then stamp(dst,read('public/effects/cast_'..s..'.png'),0,0,48,48,cx-24,cy-24,blend) end
  for _,unit in ipairs({{'mage',cx,cy},{'swordsman',cx-53,cy+56},{'healer',cx+55,cy+66}}) do
    stamp(dst,read('public/sprites/'..unit[1]..'.png'),0,0,64,64,unit[2]-32,unit[3]-58,'normal')
  end
  P.blit(overview,dst,((i-1)%4)*320,math.floor((i-1)/4)*320)
  P.zoom(dst,2):saveAs(root..'/art/effects/previews/area-'..s..'-2x.png')
end
overview:saveAs(root..'/art/effects/previews/area-schools.png')
print('PASS: 25 native-size rings and 8 scene composites exported')

