-- Read-only artwork QA: composite generated originals, sprites and FX at game scale.
-- This writes review images only; public/backgrounds and public/icons remain untouched.
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua');local pc=P.pc
local function load(path)return Image{fromFile=root..'/public/'..path..'.png'}end
local function over(dst,x,y,c,add)
  if x<0 or y<0 or x>=dst.width or y>=dst.height then return end
  local a=pc.rgbaA(c)/255;if a==0 then return end
  local b=dst:getPixel(x,y)
  local function ch(f)return math.floor(math.min(255,f(c)*a+f(b)*(add and 1 or 1-a))+.5)end
  dst:drawPixel(x,y,pc.rgba(ch(pc.rgbaR),ch(pc.rgbaG),ch(pc.rgbaB),255))
end
local function nearest(src,w,h)
  local out=P.image(w,h)
  for y=0,h-1 do for x=0,w-1 do
    out:drawPixel(x,y,src:getPixel(math.min(src.width-1,math.floor((x+.5)*src.width/w)),math.min(src.height-1,math.floor((y+.5)*src.height/h))))
  end end
  return out
end
local function draw(dst,src,dx,dy,add)
  for y=0,src.height-1 do for x=0,src.width-1 do over(dst,dx+x,dy+y,src:getPixel(x,y),add) end end
end
local keys={'swordsman','tank','berserker','assassin','archer','sniper','mage','summoner','healer'}
local icons={};local audit={icons={},backgrounds={},passed=false}
local contact=P.image(9*96,4*96);contact:clear(P.color('252a39'))
for i,key in ipairs(keys) do
  local im=load('icons/'..key);local l,t,r,b=im.width,im.height,-1,-1;local empty=0
  for y=0,im.height-1 do for x=0,im.width-1 do
    local a=pc.rgbaA(im:getPixel(x,y));if a==0 then empty=empty+1 end
    if a>=128 then l=math.min(l,x);r=math.max(r,x);t=math.min(t,y);b=math.max(b,y) end
  end end
  assert(empty>0 and r>l and b>t,key..': transparent glyph required')
  local size=math.max(r-l+1,b-t+1);local trim=P.image(size,size)
  for y=t,b do for x=l,r do trim:drawPixel(x-l+math.floor((size-r+l-1)/2),y-t+math.floor((size-b+t-1)/2),im:getPixel(x,y)) end end
  icons[key]=nearest(trim,10,10)
  for row,n in ipairs({7,8,10,12}) do
    local small=P.image(12,12);small:clear(P.color('252a39'));draw(small,nearest(trim,n,n),math.floor((12-n)/2),math.floor((12-n)/2))
    P.blit(contact,P.zoom(small,8),(i-1)*96,(row-1)*96)
  end
  audit.icons[#audit.icons+1]={key=key,width=im.width,height=im.height,transparentPixels=empty}
end
contact:saveAs(root..'/art/imagegen/icons-size-review.png')
local units={{'tank',305,255,0},{'swordsman',352,374,0},{'mage',196,295,0},{'healer',235,445,0},{'berserker',575,267,1},{'assassin',538,391,1},{'archer',682,304,1},{'sniper',666,453,1}}
local fx={{'impact_fire',1,64,32,32,575,268,true},{'heal_burst',2,48,24,24,235,419,true},{'slash_light',1,64,16,32,362,350,false},{'crit_star',1,32,16,16,538,356,true},{'proj_orb_ice',1,32,16,16,437,286,true},{'proj_arrow',1,32,16,16,507,322,false}}
for _,map in ipairs({'plains','dark','desert','glacier'}) do
  local bg=load('backgrounds/'..map);local scene=nearest(bg,896,640)
  audit.backgrounds[#audit.backgrounds+1]={key=map,width=bg.width,height=bg.height}
  for _,u in ipairs(units) do
    local key,x,y,side=u[1],u[2],u[3],u[4];local sheet=load('sprites/'..key)
    for yy=0,63 do for xx=0,63 do
      over(scene,x-32+xx,y-58+yy,sheet:getPixel(side==1 and 63-xx or xx,yy),false)
    end end
    P.rect(scene,x-28,y-73,12,12,P.color(side==1 and 'e09191' or '83bcdd'))
    P.rect(scene,x-27,y-72,10,10,P.color('252d3c'));draw(scene,icons[key],x-27,y-72)
    P.rect(scene,x-13,y-70,43,6,P.color('19212e'));P.rect(scene,x-12,y-69,37,4,P.color(side==1 and 'ec929b' or '91dba8'))
  end
  for _,v in ipairs(fx) do
    local sheet=load('effects/'..v[1]);local frame=P.image(v[3],v[3])
    for y=0,v[3]-1 do for x=0,v[3]-1 do frame:drawPixel(x,y,sheet:getPixel(v[2]*v[3]+x,y)) end end
    draw(scene,frame,v[6]-v[4],v[7]-v[5],v[8])
  end
  scene:saveAs(root..'/art/imagegen/scene-'..map..'.png')
  print('Reviewed '..map..' / '..bg.width..'x'..bg.height..' -> 896x640')
end
audit.passed=true
local f=assert(io.open(root..'/art/imagegen/verification.json','w'));f:write(json.encode(audit));f:close()
print('PASS: 4 backgrounds / 9 transparent job glyphs')

