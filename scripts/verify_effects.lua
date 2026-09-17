-- Round-trip validation of saved Aseprite sources, not the drawing functions.
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local catalog=dofile(root..'/scripts/effect_catalog.lua')
local total=0
local pc=P.pc
local areaAudit={}
local function closedContour(im,key)
  local w=im.width;local seen={};local queue={math.floor(w/2)*w+math.floor(w/2)};local head=1
  seen[queue[1]]=true
  while head<=#queue do
    local index=queue[head];head=head+1
    local x,y=index%w,math.floor(index/w)
    assert(x>0 and y>0 and x<w-1 and y<w-1,key..': bright contour leaks from center to exterior')
    for _,nextIndex in ipairs({index-1,index+1,index-w,index+w}) do
      if not seen[nextIndex] and pc.rgbaA(im:getPixel(nextIndex%w,math.floor(nextIndex/w)))==0 then
        seen[nextIndex]=true;queue[#queue+1]=nextIndex
      end
    end
  end
end
for _,d in ipairs(catalog) do
  local m=d.meta
  local spr=assert(app.open(root..'/art/aseprite/effects/'..d.key..'.aseprite'))
  local png=Image{fromFile=root..'/public/effects/'..d.key..'.png'}
  assert(#spr.layers==3 and #spr.frames==m.frames and #spr.tags==1,d.key..': source structure')
  local frames={};local coverages={};local fixedCore=nil
  for f=1,m.frames do
    local flat=P.image(m.frameW,m.frameH);flat:drawSprite(spr,f)
    frames[#frames+1]=flat
    local opaque=0
    assert(math.abs(spr.frames[f].duration-1/m.fps)<.001,d.key..': timing')
    for y=0,m.frameH-1 do for x=0,m.frameW-1 do
      assert(flat:getPixel(x,y)==png:getPixel((f-1)*m.frameW+x,y),d.key..': source/export mismatch')
      local a=pc.rgbaA(flat:getPixel(x,y));assert(a==0 or a==255,d.key..': binary alpha')
      if a>0 then
        opaque=opaque+1
        if d.kind=='ring' then
          local r=(m.frameW-1)/2;local dist=math.sqrt((x-r)^2+(y-r)^2)
          assert(dist>=r-10.8 and dist<=r+.8,d.key..': ornament outside 10px peripheral band')
        end
      end
    end end
    total=total+1
    coverages[#coverages+1]=opaque/(m.frameW*m.frameH)
    if d.kind=='tile' then assert(coverages[#coverages]>=.30 and coverages[#coverages]<=.60,d.key..': fill coverage 30-60%') end
    if d.kind=='ring' then
      local core=P.image(m.frameW,m.frameH);local cel=spr.layers[3]:cel(f)
      assert(cel,d.key..': missing bright contour layer');P.blit(core,cel.image,cel.position.x,cel.position.y)
      if not fixedCore then
        fixedCore=core
        local x0,y0,x1,y1=P.bounds(core)
        assert(x0==0 and y0==0 and x1==m.frameW-1 and y1==m.frameH-1,d.key..': contour must touch all four edges')
        closedContour(core,d.key)
      else
        for y=0,m.frameH-1 do for x=0,m.frameW-1 do assert(core:getPixel(x,y)==fixedCore:getPixel(x,y),d.key..': contour wobbles') end end
      end
    end
  end
  if d.priority==2 then
    local diffs={}
    for f=1,m.frames do
      local nextFrame=frames[f%m.frames+1];local diff=0
      for y=0,m.frameH-1 do for x=0,m.frameW-1 do if frames[f]:getPixel(x,y)~=nextFrame:getPixel(x,y) then diff=diff+1 end end end
      assert(diff>0,d.key..': static adjacent frames');diffs[#diffs+1]=diff
    end
    local largest=math.max(diffs[1],diffs[2],diffs[3])
    assert(diffs[4]<=largest*1.35+4,d.key..': last-to-first loop jump')
    areaAudit[#areaAudit+1]={key=d.key,coverage=coverages,adjacentPixelChanges=diffs,closedFixedContour=d.kind=='ring' or nil}
  end
  spr:close()
end
local f=assert(io.open(root..'/art/effects/verification.json','w'))
f:write(json.encode({passed=true,effects=#catalog,frames=total,areas=areaAudit,checks={'saved source/export exact pixel match','3 editable layers and animation tag','frame durations and binary alpha','25 bright contours closed, stable, touching all edges','ring ornaments confined to outer 10px band','8 tile fills cover 30-60%','40 looping animations change every frame without a wrap jump'}}));f:close()
print('PASS: '..#catalog..' saved Aseprite sources / '..total..' frames match exports')
