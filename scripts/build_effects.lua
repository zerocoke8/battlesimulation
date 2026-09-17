-- Aseprite CLI: --batch --script-param root=. --script scripts/build_effects.lua
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local catalog=dofile(root..'/scripts/effect_catalog.lua')
local Art=dofile(root..'/scripts/effect_art.lua')
local pc=P.pc
local priority=app.params.priority or 'all'
local names={'01 Trails / particles','02 Main silhouette','03 Bright core'}
local report={passed=false,source='Aseprite Lua',effects={},frames=0,priority=priority}
local previous={}
local old=io.open(root..'/art/effects/manifest.json','r')
if old then local data=json.decode(old:read('*a'));old:close();for _,e in ipairs(data.effects) do previous[e.key]=e end end
local overview=P.image(6*64*3,21*64*3)
overview:clear(P.color('252a39'))
local function write(path,data)
  local file=assert(io.open(root..'/'..path,'w'));file:write(json.encode(data));file:close()
end
-- Review uses the same additive equation as Canvas lighter, on opaque backgrounds.
local function composite(src,bg,blend)
  local im=P.image(src.width,src.height);im:clear(bg)
  for y=0,src.height-1 do for x=0,src.width-1 do
    local c=src:getPixel(x,y)
    if pc.rgbaA(c)>0 then
      if blend=='add' then c=pc.rgba(math.min(255,pc.rgbaR(c)+pc.rgbaR(bg)),math.min(255,pc.rgbaG(c)+pc.rgbaG(bg)),math.min(255,pc.rgbaB(c)+pc.rgbaB(bg)),255) end
      im:drawPixel(x,y,c)
    end
  end end
  return im
end
for row,d in ipairs(catalog) do
 if priority=='all' or tostring(d.priority)==priority then
  local m=d.meta
  local spr=Sprite(m.frameW,m.frameH,ColorMode.RGB)
  local layers={spr.layers[1]};layers[1].name=names[1]
  for i=2,3 do layers[i]=spr:newLayer();layers[i].name=names[i] end
  local sheet=P.image(m.frameW*m.frames,m.frameH)
  local zoom=d.kind=='ring' and 2 or 4
  local review=P.image(m.frameW*m.frames*zoom,m.frameH*zoom*2)
  local tiled=d.kind=='tile' and P.image(96*m.frames*3,96*3) or nil
  local coverages={}
  for f=0,m.frames-1 do
    _G.SPRITE_CLIPPED_PIXELS=0
    local parts=Art.render(d,f)
    assert((_G.SPRITE_CLIPPED_PIXELS or 0)==0,d.key..' frame '..f..': clipped '..tostring(_G.SPRITE_CLIPPED_PIXELS)..' pixels')
    if f>0 then spr:newEmptyFrame() end
    spr.frames[f+1].duration=1/m.fps
    local flat=P.image(m.frameW,m.frameH)
    for li,im in ipairs(parts) do spr:newCel(layers[li],f+1,im,Point(0,0));P.blit(flat,im) end
    local count=0
    for y=0,m.frameH-1 do for x=0,m.frameW-1 do
      local a=pc.rgbaA(flat:getPixel(x,y))
      assert(a==0 or a==255,d.key..': nonbinary alpha')
      if a>0 then
        count=count+1
        if d.kind~='ring' and d.kind~='tile' then assert(x>0 and y>0 and x<m.frameW-1 and y<m.frameH-1,d.key..' frame '..f..': no clear border') end
      end
    end end
    assert(count>0,d.key..' frame '..f..': empty frame')
    coverages[#coverages+1]=count/(m.frameW*m.frameH)
    if d.kind=='tile' then assert(coverages[#coverages]>=.30 and coverages[#coverages]<=.60,d.key..' frame '..f..': coverage '..count..'/1024 outside 30-60%') end
    P.blit(sheet,flat,f*m.frameW,0)
    P.blit(review,P.zoom(composite(flat,P.color('252a39'),m.blend),zoom),f*m.frameW*zoom,0)
    P.blit(review,P.zoom(composite(flat,P.color('97a584'),m.blend),zoom),f*m.frameW*zoom,m.frameH*zoom)
    if d.priority==1 then P.blit(overview,P.zoom(composite(flat,P.color('252a39'),m.blend),3),f*64*3+(64-m.frameW)*1.5,(row-1)*64*3+(64-m.frameH)*1.5) end
    if tiled then
      local block=P.zoom(composite(flat,P.color('252a39'),m.blend),3)
      for ty=0,2 do for tx=0,2 do P.blit(tiled,block,f*288+tx*96,ty*96) end end
    end
  end
  local tag=spr:newTag(1,m.frames);tag.name=d.key;tag.aniDir=AniDir.FORWARD
  spr.data=json.encode({key=d.key,anchor=m.anchor,blend=m.blend,loop=m.loop,notes='Integer pixels, binary alpha, three editable layers. Export is a one-row strip.'})
  local source='art/aseprite/effects/'..d.key..'.aseprite'
  spr:saveAs(root..'/'..source);spr:close()
  sheet:saveAs(root..'/public/effects/'..d.key..'.png')
  write('public/effects/'..d.key..'.json',m)
  review:saveAs(root..'/art/effects/previews/'..d.key..'-'..zoom..'x.png')
  if tiled then tiled:saveAs(root..'/art/effects/previews/'..d.key..'-tiled-3x.png') end
  report.effects[#report.effects+1]={key=d.key,source=source,meta=m,priority=d.priority,kind=d.kind,binaryAlpha=true,clearBorder=d.kind~='ring' and d.kind~='tile',coverage=coverages}
  report.frames=report.frames+m.frames
  print(d.key..': '..m.frames..' frames, '..m.blend)
 end
end
if priority~='2' then overview:saveAs(root..'/art/effects/previews/all-3x.png') end
report.passed=true
write('art/effects/build-status.json',report)
if priority~='all' then write('art/effects/manifest-priority'..priority..'.json',report) end
for _,e in ipairs(report.effects) do previous[e.key]=e end
local complete={passed=true,source='Aseprite Lua',effects={},frames=0}
for _,d in ipairs(catalog) do
  local e=previous[d.key]
  if e then complete.effects[#complete.effects+1]=e;complete.frames=complete.frames+e.meta.frames else complete.passed=false end
end
write('art/effects/manifest.json',complete)
print('DONE: '..#report.effects..' effects, '..report.frames..' frames')
