-- Priority 2: fixed-size circles, floor casting glyphs and toroidal fill motifs.
-- Only integer raster primitives. No resized ring masters, alpha fades or dithering.
local P=dofile((app.params.root or '.')..'/scripts/pixel_art.lua')
local A={}
local TAU=math.pi*2
local function round(x)return math.floor(x+.5)end
local function xy(cx,cy,rx,ry,a)return round(cx+math.cos(a)*rx),round(cy+math.sin(a)*ry)end
local function line(im,a,b,c,w)P.line(im,a[1],a[2],b[1],b[2],c,w)end
local function arc(im,cx,cy,rx,ry,a,b,c,w)
  local steps=math.max(8,math.ceil(math.max(rx,ry)*(b-a)*2))
  local x,y=xy(cx,cy,rx,ry,a)
  for i=1,steps do local xx,yy=xy(cx,cy,rx,ry,a+(b-a)*i/steps);P.line(im,x,y,xx,yy,c,w);x,y=xx,yy end
end
local function diamond(im,x,y,rx,ry,c)
  P.poly(im,{{x,y-ry},{x+rx,y},{x,y+ry},{x-rx,y}},c)
end
local function plus(im,x,y,r,c,w)
  P.line(im,x-r,y,x+r,y,c,w);P.line(im,x,y-r,x,y+r,c,w)
end
local function leaf(im,x,y,a,p)
  local tx,ty=xy(x,y,4,4,a);local bx,by=xy(x,y,4,4,a+math.pi)
  local ux,uy=xy(x,y,2,2,a+math.pi/2)
  local vx,vy=xy(x,y,2,2,a-math.pi/2)
  P.poly(im,{{bx,by},{ux,uy},{tx,ty},{vx,vy}},p[2]);P.line(im,bx,by,tx,ty,p[3])
end
local function ring(d,f,back,main,core,p)
  local w=d.meta.frameW;local c=(w-1)/2;local r=(w-1)/2
  -- Constant 1–2 px bright closed contour. Symmetric pixel centers touch all 4 edges.
  for y=0,w-1 do for x=0,w-1 do
    local distance=math.sqrt((x-c)^2+(y-c)^2)
    if distance<=r+.02 and distance>=r-1.5 then P.dot(core,x,y,p[4]) end
  end end
  -- Same physical ornament size at every radius; density stays roughly constant.
  local count=math.max(16,math.floor(TAU*r/28/4+.5)*4)
  local spacing=TAU/count
  for i=0,count-1 do
    -- f=4 is exactly the next identical ornament: a cyclic quarter-step orbit.
    local a=(i+f/4)*spacing
    local x,y=xy(c,c,r-6,r-6,a)
    local function at(rad,angle)local xx,yy=xy(c,c,rad,rad,angle);return {xx,yy}end
    local s=d.school
    if s=='fire' then
      local outer=at(r-3,a-.027);local tip=at(r-9,a+.012)
      P.poly(back,{at(r-3,a-.05),at(r-5,a),tip,at(r-6,a+.043),at(r-3,a+.05)},p[1])
      line(main,outer,tip,p[2]);line(main,at(r-4,a),at(r-7,a+.015),p[3])
    elseif s=='ice' then
      P.poly(back,{at(r-3,a),at(r-6,a+.035),at(r-9,a),at(r-6,a-.035)},p[1])
      line(main,at(r-3,a),at(r-9,a),p[3]);line(main,at(r-6,a-.025),at(r-6,a+.025),p[2])
    elseif s=='lightning' then
      local pts={at(r-4,a-spacing*.35),at(r-4,a),at(r-8,a-.014),at(r-7,a+spacing*.35)}
      for j=1,3 do line(back,pts[j],pts[j+1],p[1],2);line(main,pts[j],pts[j+1],p[3]) end
    elseif s=='holy' then
      arc(back,c,c,r-5,r-5,a-spacing*.34,a+spacing*.34,p[2],1)
      line(main,at(r-3,a),at(r-8,a),p[3]);line(main,at(r-6,a-.016),at(r-6,a+.016),p[3])
    elseif s=='nature' then
      arc(back,c,c,r-5,r-5,a-spacing*.43,a+spacing*.43,p[1],1)
      leaf(main,x,y,a+.6,p)
    elseif s=='shadow' then
      arc(back,c,c,r-5,r-5,a-spacing*.37,a+spacing*.34,p[1],2)
      arc(main,c,c,r-7,r-7,a-spacing*.15,a+spacing*.32,p[3],1)
      P.dot(main,x,y,p[2])
    elseif s=='phys' then
      line(back,at(r-4,a-spacing*.3),at(r-4,a+spacing*.3),p[2])
      line(main,at(r-4,a-.018),at(r-8,a),p[3])
      line(main,at(r-8,a),at(r-4,a+.018),p[3])
    else
      plus(main,x,y,2,p[3])
      P.dot(back,x-2,y-2,p[1]);P.dot(back,x+2,y+2,p[1])
      arc(back,c,c,r-5,r-5,a+spacing*.18,a+spacing*.4,p[2],1)
    end
  end
end
local function cast(d,f,back,main,core,p)
  local s=d.school;local cx,cy=24,24
  arc(back,cx,cy,21,12,0,TAU,p[1],1)
  arc(main,cx,cy,20,11,0,TAU,p[3],1)
  local n=(s=='holy' or s=='shadow' or s=='phys') and 4 or 8
  for i=0,n-1 do
    local a=(i+f/4)*TAU/n
    local x,y=xy(cx,cy,17,9,a)
    if s=='fire' then
      P.poly(back,{{x-2,y+2},{x-3,y},{x,y-4},{x+1,y-1},{x+3,y-2},{x+2,y+2}},p[2])
      P.line(core,x,y-1,x,y+1,p[4])
    elseif s=='ice' then
      diamond(back,x,y,3,4,p[1]);diamond(main,x,y,2,3,p[2]);P.line(core,x,y-2,x,y+2,p[4])
    elseif s=='lightning' then
      local pts={{x-3,y-2},{x+1,y-1},{x-1,y+1},{x+3,y+2}}
      for j=1,3 do line(back,pts[j],pts[j+1],p[1],2);line(core,pts[j],pts[j+1],p[3]) end
    elseif s=='holy' then
      plus(main,x,y,3,p[2]);plus(core,x,y,2,p[4])
      arc(back,cx,cy,16,8,a+.22,a+1.2,p[2],1)
    elseif s=='nature' then
      leaf(main,x,y,a+.6,p);P.dot(core,x,y,p[4])
    elseif s=='shadow' then
      arc(back,x,y,3,3,a,a+math.pi*1.6,p[1],2)
      arc(main,x,y,2,2,a+.2,a+math.pi*1.3,p[3],1)
    else
      arc(back,cx,cy,17,8,a,a+1.02,p[2],2)
      arc(core,cx,cy,17,8,a+.25,a+.9,p[4],1)
    end
  end
  -- Tiny fixed center marks are mostly hidden by the character, never a solid disc.
  if s=='holy' then diamond(back,24,24,5,3,p[1]);diamond(back,24,24,3,1,0)
  elseif s=='ice' then P.line(back,18,24,30,24,p[1]);P.line(back,24,21,24,27,p[2])
  elseif s=='phys' then P.line(back,20,25,28,25,p[1])
  end
end
local function tile(d,f,back,main,core,p)
  -- Paint a repeated plane, then cut its central 32 px. Off-edge motifs really
  -- continue in neighboring cells; no edge copying, blank gutters or checker masks.
  local plane={P.image(128,128),P.image(128,128),P.image(128,128)}
  local positions={{2,2},{21,7},{9,22},{27,24}}
  local s=d.school
  for gy=-2,3 do for gx=-2,3 do
    -- Four staggered positions and opposing phases avoid a 16px icon wallpaper.
    -- Every choice repeats at 32px, including motifs straddling the cut edges.
    local variant=1+gx%2+(gy%2)*2
    local phase=(f+variant-1)%4+1
    local dx=({0,1,0,-1})[phase];local dy=({-1,0,1,0})[phase]
    local ox=48+math.floor(gx/2)*32+positions[variant][1]+dx
    local oy=48+math.floor(gy/2)*32+positions[variant][2]+dy
    local a,b,c=P.image(32,32),P.image(32,32),P.image(32,32)
    local x,y=16,16
    if s=='fire' then
      P.poly(a,{{x-6,y+5},{x-5,y},{x-3,y-5},{x,y-7},{x,y-2},{x+4,y-5},{x+6,y},{x+5,y+5},{x+2,y+7},{x-3,y+7}},p[1])
      P.poly(b,{{x-3,y+4},{x-3,y},{x,y-4},{x+1,y},{x+3,y-2},{x+3,y+4},{x,y+6}},p[2])
      P.line(c,x,y+1,x,y+4,p[3],2)
    elseif s=='ice' then
      P.poly(a,{{x-7,y},{x,y-7},{x+7,y},{x+1,y+7}},p[1])
      P.poly(b,{{x,y-6},{x+6,y},{x+1,y+5},{x,y}},p[2])
      P.line(c,x,y-4,x,y+4,p[3]);P.line(b,x-5,y,x,y,p[2])
    elseif s=='lightning' then
      local pts={{x-7,y-5},{x+2,y-5},{x-1,y},{x+6,y+1},{x-2,y+7}}
      for j=1,4 do line(a,pts[j],pts[j+1],p[1],3);line(b,pts[j],pts[j+1],p[3],1) end
      P.rect(c,x-1,y-1,2,2,p[4])
    elseif s=='holy' then
      diamond(a,x,y,7,7,p[1]);diamond(a,x,y,4,4,0)
      plus(b,x,y,3,p[2],2);plus(c,x,y,1,p[3])
    elseif s=='nature' then
      P.poly(a,{{x-5,y},{x-3,y-5},{x+2,y-7},{x+6,y-4},{x+4,y+2},{x,y+6}},p[1])
      P.poly(b,{{x-3,y},{x,y-5},{x+4,y-4},{x+2,y+1},{x,y+4}},p[2])
      P.line(c,x-2,y+5,x+2,y-4,p[3])
      P.line(a,x-6,y+7,x+5,y-5,p[1],2)
      diamond(b,x+5,y+5,3,2,p[2])
    elseif s=='shadow' then
      P.ellipse(a,x,y,8,6,p[1]);P.ellipse(a,x+3,y-2,6,4,0)
      arc(b,x,y,6,4,.2,math.pi*1.2,p[2],2)
      P.line(c,x-3,y+3,x+1,y+4,p[3])
    elseif s=='phys' then
      P.poly(a,{{x-7,y+2},{x-3,y-3},{x+2,y-4},{x+7,y-2},{x+3,y},{x-2,y},{x-5,y+3},{x-1,y+5},{x-6,y+5}},p[1])
      P.line(b,x-4,y-1,x+3,y-2,p[2],2)
      P.poly(a,{{x,y+4},{x+7,y+3},{x+5,y+7},{x-1,y+7}},p[1])
      P.line(b,x+1,y+4,x+5,y+4,p[2])
      diamond(b,x+6,y-6,3,2,p[2])
    else
      P.line(a,x-7,y+3,x+5,y-3,p[1],2);P.line(b,x-5,y+2,x+5,y-3,p[2])
      plus(b,x-2,y-2,4,p[2],2);P.line(c,x-5,y-5,x+1,y+1,p[3]);P.line(c,x-5,y+1,x+1,y-5,p[3])
      plus(c,x+5,y+6,2,p[3],2)
    end
    for li,im in ipairs({a,b,c}) do
      for yy=7,25 do for xx=7,25 do
        local color=im:getPixel(xx,yy)
        if P.pc.rgbaA(color)>0 then
          local u,v=xx-16,yy-16
          if variant==2 or variant==3 then u=-u end
          if s=='ice' and variant%2==0 then u,v=v,u end
          -- Split directional gusts from the large shapes using small,
          -- integer shifts; this stays sharp and preserves all opaque pixels.
          if s=='fire' and v<0 then u=u+dx end
          P.dot(plane[li],ox+u,oy+v,color)
        end
      end end
    end
  end end
  for y=0,31 do for x=0,31 do
    back:drawPixel(x,y,plane[1]:getPixel(x+48,y+48))
    main:drawPixel(x,y,plane[2]:getPixel(x+48,y+48))
    core:drawPixel(x,y,plane[3]:getPixel(x+48,y+48))
  end end
end
function A.render(d,f,p)
  local w=d.meta.frameW;local parts={P.image(w,w),P.image(w,w),P.image(w,w)}
  if d.kind=='ring' then ring(d,f,parts[1],parts[2],parts[3],p)
  elseif d.kind=='cast' then cast(d,f,parts[1],parts[2],parts[3],p)
  elseif d.kind=='tile' then tile(d,f,parts[1],parts[2],parts[3],p)
  else error('Unknown area kind: '..tostring(d.kind)) end
  return parts
end
return A
