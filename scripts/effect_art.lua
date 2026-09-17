-- Authored, hard-edged spell motifs. All images are painted in Aseprite Lua.
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local C=P.color
local E={}
local PALETTES={
 fire={'da4421','ff832c','ffd278','fff1ba','fff9e9'},
 ice={'3978d9','58aeef','9fe0ff','e1fbff','ffffff'},
 lightning={'8650d7','b47eef','f8cc42','fff2b0','ffffff'},
 holy={'c38b36','e5b55e','ffe29a','fff6d7','ffffff'},
 nature={'369b48','5bbe56','a1e773','eaffc8','f6ffe9'},
 shadow={'8235b5','a650cf','c387ed','dec3ff','f3e6ff'},
 phys={'787d88','a8adb6','cdd0d7','edf0f3','ffffff'},
}
local function pal(name)local p={};for i,c in ipairs(PALETTES[name]) do p[i]=C(c) end;return p end
local function xy(cx,cy,r,a)return math.floor(cx+math.cos(a)*r+.5),math.floor(cy+math.sin(a)*r+.5)end
local function star(im,x,y,rx,ry,c)
  if math.min(rx,ry)<3 then
    P.line(im,x-rx,y,x+rx,y,c);P.line(im,x,y-ry,x,y+ry,c);return
  end
  P.poly(im,{{x,y-ry},{x+2,y-2},{x+rx,y},{x+2,y+2},{x,y+ry},{x-2,y+2},{x-rx,y},{x-2,y-2}},c)
end
local function diamond(im,x,y,r,p)
  P.poly(im,{{x,y-r},{x+math.max(1,math.floor(r*.6)),y},{x,y+r},{x-math.max(1,math.floor(r*.6)),y}},p[2])
  P.line(im,x,y-r+1,x,y+r-1,p[4]);P.dot(im,x,y-1,p[5])
end
local function arc(im,cx,cy,rx,ry,a,b,c,width)
  local lx,ly
  for t=0,40 do
    local q=a+(b-a)*t/40;local x=math.floor(cx+math.cos(q)*rx+.5);local y=math.floor(cy+math.sin(q)*ry+.5)
    if lx then P.line(im,lx,ly,x,y,c,width) end;lx,ly=x,y
  end
end
local function ray(im,cx,cy,a,r0,r1,thick,c)
  local x0,y0=xy(cx,cy,r0,a);local x1,y1=xy(cx,cy,r1,a)
  local xx,yy=-math.sin(a)*thick,math.cos(a)*thick
  P.poly(im,{{x0-xx,y0-yy},{x1,y1},{x0+xx,y0+yy}},c)
end
local function leaf(im,x,y,r,a,p)
  local tx,ty=xy(x,y,r,a);local bx,by=xy(x,y,r,a+math.pi)
  local px,py=-math.sin(a)*r*.5,math.cos(a)*r*.5
  P.poly(im,{{bx,by},{x-px,y-py},{tx,ty},{x+px,y+py}},p[2])
  P.poly(im,{{bx,by},{x-px,y-py},{tx,ty},{x,y}},p[3]);P.line(im,bx,by,tx,ty,p[4])
end
local function puff(im,x,y,r,p)
  P.ellipse(im,x,y,r,r*.72,p[1]);P.ellipse(im,x-1,y-1,math.max(1,r-1),math.max(1,r*.72-1),p[2])
  P.ellipse(im,x-r*.25,y-r*.25,math.max(1,r*.5),math.max(1,r*.3),p[3])
end
local function impact(s,f,back,main,core)
  local p=pal(s);local cx,cy=32,32
  local r=({5,13,21,25,27,28})[f+1]
  local strength=({5,8,7,5,3,1})[f+1]
  if s=='fire' then
    if f<=2 then
      for i=0,6 do local a=i*math.pi*2/7-.3;local x,y=xy(cx,cy,r*.42,a)
        local rr=strength+(i%2);P.ellipse(back,x,y,rr,rr,p[1])
        P.poly(main,{{x-rr+2,y+2},{x-rr+3,y-rr+1},{x-2,y-rr-3},{x+1,y-rr+1},{x+rr-2,y-rr-1},{x+rr-1,y+2},{x+2,y+rr-1}},p[2])
        P.ellipse(core,x,y,math.max(2,rr-4),math.max(2,rr-3),p[3])
      end
      star(core,32,31,math.max(3,10-f*2),math.max(4,12-f*2),p[4])
    end
    for i=0,7 do local a=i*math.pi/4+.2;local x,y=xy(cx,cy,r,a)
      if f<5 or i%2==0 then
        local n=math.max(1,strength-2)
        P.poly(main,{{x-2,y+n},{x-3,y},{x,y-n},{x+2,y-1},{x+1,y+n}},f<4 and p[2] or p[1]);P.line(core,x,y,x,y-math.max(0,n-2),p[4])
      end
    end
  elseif s=='ice' then
    for i=0,7 do local a=i*math.pi/4-.18;local rr=f<2 and r or r-(i%3)*3
      local x,y=xy(cx,cy,rr,a);local len=math.max(1,8-f)
      local bx,by=xy(cx,cy,math.max(1,rr-len),a)
      local px,py=-math.sin(a)*math.max(1,3-f*.4),math.cos(a)*math.max(1,3-f*.4)
      P.poly(back,{{bx-px,by-py},{x,y},{bx+px,by+py},{bx,by}},p[1])
      P.poly(main,{{bx,by},{x,y},{bx+px,by+py}},p[3]);P.line(core,bx,by,x,y,p[5])
    end
    if f<=2 then star(core,32,32,13-f*3,15-f*3,p[5]) end
    if f==1 or f==2 then arc(back,32,32,r-2,r-2,.1,math.pi*1.8,p[2],1) end
    if f>=3 then for i=0,3 do local x,y=xy(32,32,21+i%2*5,i*1.57+.5);diamond(main,x,y,6-f,p) end end
  elseif s=='lightning' then
    local count=f<4 and 6 or 4
    for i=0,count-1 do local a=i*2*math.pi/count+.2*(f%2)
      local points={};for j=0,4 do
        local rr=(f>=3 and r*.45 or 1)+(r-(f>=3 and r*.45 or 1))*j/4
        local x,y=xy(cx,cy,rr,a+(j%2==0 and -.11 or .14));points[#points+1]={x,y}
      end
      for j=(f==5 and 4 or f==4 and 3 or 1),#points-1 do local a0,b0=points[j],points[j+1]
        P.line(back,a0[1],a0[2],b0[1],b0[2],p[1],f<3 and 4 or 2)
        P.line(main,a0[1],a0[2],b0[1],b0[2],p[3],f<3 and 2 or 1)
        if f<4 then P.line(core,a0[1],a0[2],b0[1],b0[2],p[5]) end
      end
    end
    if f<3 then star(core,32,32,6+f*2,9+f,p[5]) end
  elseif s=='holy' then
    if f<=3 then
      local h=({9,25,26,18})[f+1];local w=({4,10,7,3})[f+1]
      star(back,32,32,w+4,h,p[1]);star(main,32,32,w,h-1,p[3]);star(core,32,32,math.max(2,w-3),h-3,p[5])
      if f>0 then arc(main,32,32,r,r*.45,0,math.pi*2,p[2],1) end
    end
    for i=0,5 do local x,y=xy(32,32,r,i*math.pi/3+.5);star(main,x,y,math.max(1,4-math.floor(f/2)),math.max(2,6-f),f<4 and p[4] or p[2]) end
  elseif s=='nature' then
    for i=0,5 do local a=i*math.pi/3+.4
      local x,y=xy(32,32,r*.82,a)
      leaf(main,x,y,math.max(1,7-f),a+.7,p)
      if f<=3 then
        local ix,iy=xy(32,32,math.max(2,r-7),a-.12);local ox,oy=xy(32,32,r,a+.1)
        P.line(back,ix,iy,ox,oy,p[1],2);P.line(core,ix,iy,ox,oy,p[3])
      end
    end
    if f<3 then star(core,32,32,10-f*2,10-f*2,p[4]) end
    if f>=2 then for i=0,3 do local x,y=xy(32,32,r,i*math.pi/2);P.rect(core,x,y,2,2,p[4]) end end
  elseif s=='shadow' then
    for i=0,3 do
      local a=i*math.pi/2+.2*f
      local x,y=xy(32,32,r*.48,a)
      local length=f<4 and math.pi*1.1 or f==4 and 1.1 or .24
      arc(back,x,y,math.max(3,r*.45),math.max(3,r*.45),a+.1,a+.1+length,p[1],f<4 and 4 or 1)
      if f<5 then arc(main,x,y,math.max(3,r*.4),math.max(3,r*.4),a+.2,a+.2+length*.8,p[3],f<3 and 2 or 1) end
    end
    if f<3 then star(core,32,32,10-f*2,14-f*2,p[5]) end
    for i=0,5 do local x,y=xy(32,32,r,i*math.pi/3);diamond(core,x,y,math.max(1,4-f),p) end
  else
    if f<=2 then
      local pts={};for i=0,15 do local x,y=xy(32,32,i%2==0 and r or r*.36,i*math.pi/8);pts[#pts+1]={x,y} end
      P.poly(back,pts,p[2]);star(main,32,32,r-2,r-2,p[4]);star(core,32,32,math.max(2,r-7),math.max(2,r-7),p[5])
    end
    for i=0,7 do local a=i*math.pi/4+.1;ray(main,32,32,a,math.max(2,r-8+f),r,math.max(1,3-f*.4),p[f>3 and 2 or 4]) end
    if f>=2 then for i=0,3 do local x,y=xy(32,32,r-1,i*math.pi/2+.5);P.poly(back,{{x-2,y},{x,y-2},{x+2,y+1},{x,y+2}},p[2]);P.dot(core,x,y,p[4]) end end
  end
end
local function projectile(key,f,back,main,core)
  local phase=({0,1,0,-1})[f+1]
  if key=='proj_arrow' then
    P.line(back,4,16,26,16,C('65546b'),3);P.line(main,5,16,25,16,C('d6b17c'));P.line(core,7,15,22,15,C('fff0bd'))
    P.poly(back,{{23,11},{29,16},{23,21},{24,16}},C('5e6178'))
    P.poly(main,{{24,13},{28,16},{24,19},{25,16}},C('c5d4dd'));P.line(core,25,15,28,16,C('fff6df'))
    P.poly(main,{{4,12+phase},{8,14},{10,16},{5,16}},C('e6d5cc'));P.poly(main,{{4,20+phase},{8,18},{10,16},{5,16}},C('ac8b99'))
    return
  end
  if key=='proj_bullet' then
    P.poly(back,{{3,13+phase},{17,12},{26,14},{30,16},{26,18},{17,20},{3,18+phase},{9,16}},C('e7a868'))
    P.poly(main,{{7,15},{21,14},{28,16},{21,18},{7,17},{13,16}},C('ffe7a0'))
    P.line(core,17,16,27,16,C('fffdf0'),3);P.line(core,5,11+phase,12,11+phase,C('f5c381'))
    return
  end
  local s=key:sub(10);local p=pal(s)
  if s=='fire' then
    P.poly(back,{{2,10+phase},{11,12},{9,7},{20,11},{27,12},{30,16},{26,22},{16,23},{6,21},{11,18},{2,19-phase},{8,15}},p[1])
    P.poly(main,{{7,12+phase},{16,14},{13,11},{24,12},{28,16},{24,20},{14,21},{18,18},{8,18}},p[2]);P.ellipse(core,23,16,4,4,p[4]);P.dot(core,25,15,p[5])
  elseif s=='ice' then
    P.poly(back,{{5,15+phase},{22,9},{30,16},{22,23},{5,18-phase},{15,16}},p[1])
    P.poly(main,{{12,15},{22,10},{28,16},{22,21},{12,17}},p[3]);P.poly(core,{{19,15},{23,11},{28,16},{22,16}},p[5]);P.line(main,3,10+phase,10,11+phase,p[2]);P.line(main,5,23-phase,12,21-phase,p[2])
  elseif s=='lightning' then
    local pts={{2,12+phase},{10,15},{8,18},{17,16},{22,13},{29,16},{23,20},{19,18},{13,22-phase},{15,18},{4,20}}
    P.poly(back,pts,p[1]);P.line(main,3,13+phase,12,16,p[3],2);P.line(main,12,16,8,19,p[3],2);P.line(main,8,19,23,16,p[3],2);star(core,23,16,6,5,p[5])
  elseif s=='holy' then
    P.line(back,4,16+phase,21,16,p[1],3);P.line(main,9,16,24,16,p[3],2);star(main,23,16,7,7,p[2]);star(core,23,16,5,5,p[5]);P.spark(core,8,10+phase,p[4]);P.dot(main,6,22-phase,p[3])
  elseif s=='nature' then
    P.line(back,3,18+phase,24,16,p[1],2);leaf(main,22,16,7,-.1,p);leaf(main,10,13+phase,4,.45,p);P.line(core,18,17,28,15,p[4]);P.rect(core,5,21-phase,2,2,p[3])
  else
    P.poly(back,{{3,11+phase},{13,13},{10,9},{23,10},{29,14},{29,18},{23,23},{13,22},{4,24-phase},{10,18},{2,18}},p[1]);arc(main,21,16,7,6,-2.7,1.4,p[3],2);P.ellipse(core,24,16,3,4,p[4]);P.dot(core,25,15,p[5]);P.line(main,4,13+phase,12,16,p[2],2)
  end
end
local function slash(key,f,back,main,core)
  local p=pal('phys')
  if key=='slash_pierce' then
    local tip=({38,58,59,59})[f+1];local start=({16,14,31,45})[f+1];local half=({3,5,3,1})[f+1]
    P.poly(back,{{start,32-half},{tip,32},{start,32+half},{start+6,32}},p[f==3 and 2 or 1])
    P.poly(main,{{start+2,32-half+1},{tip,32},{start+2,32+half-1},{start+8,32}},p[3])
    if f<3 then P.line(core,start+4,32,tip-2,32,p[5]);P.line(main,start+4,25,start+17,28,p[3]);P.line(main,start+4,39,start+17,36,p[3]) end
  else
    local heavy=key=='slash_heavy'
    local a=({-1.25,-1.05,-.1,.65})[f+1];local b=({-.35,.72,1.25,1.25})[f+1]
    local rx=heavy and 42 or 38;local ry=heavy and 27 or 23
    arc(back,16,32,rx,ry,a,b,p[2],f==3 and 1 or (heavy and 7 or 4))
    arc(main,16,32,rx-1,ry-1,a+.02,b,p[4],f==3 and 1 or (heavy and 4 or 2))
    if f<3 then arc(core,16,32,rx,ry,a+.09,b,p[5],heavy and 2 or 1) end
    if heavy and f<=2 then arc(main,16,32,33,21,a+.12,b-.1,p[3],2) end
    if f==2 then P.line(main,51,45,55,49,p[3]);P.line(main,44,52,47,57,p[3]) end
  end
end
function E.render(d,f)
  local m=d.meta;local back,main,core=P.image(m.frameW,m.frameH),P.image(m.frameW,m.frameH),P.image(m.frameW,m.frameH)
  local key=d.key
  if key:sub(1,7)=='impact_' then impact(key:sub(8),f,back,main,core)
  elseif key:sub(1,5)=='proj_' then projectile(key,f,back,main,core)
  elseif key:sub(1,6)=='slash_' then slash(key,f,back,main,core)
  elseif key=='heal_burst' then
    local p=pal('nature');local r=({4,9,14,17,18})[f+1]
    if f<4 then arc(back,24,29-f,math.max(3,r),math.max(2,r*.36),.2,math.pi*1.8,p[2],2) end
    for i=0,4 do
      local a=i*math.pi*2/5-.5;local x,y=xy(24,25-f,r,a)
      local n=math.max(1,4-math.floor(f/2))
      P.rect(main,x-n,y-1,n*2+1,3,p[2]);P.rect(main,x-1,y-n,3,n*2+1,p[2]);P.line(core,x,y-n+1,x,y+n-1,p[4]);P.line(core,x-n+1,y,x+n-1,y,p[4])
    end
    if f<2 then star(core,24,24,5+f*2,8+f*2,p[5]) end
  elseif key=='death_poof' then
    local p={C('81788e'),C('b1a6b9'),C('e0d7e1')};local r=({5,11,17,23,27})[f+1];local n=({4,7,6,4,2})[f+1]
    -- Peripheral smoke leaves the collapsed character readable in the middle.
    for i=0,6 do local a=i*math.pi*2/7;local x,y=xy(32,32,r,a)
      if f<4 or i%2==0 then puff(main,x,y,n+(i%2==0 and 1 or 0),p) end
    end
    if f<2 then puff(core,32,32,3,p) end
  else
    local p=pal('holy');local r=({4,13,9,3})[f+1]
    star(back,16,16,r,r,p[2]);star(main,16,16,math.max(2,r-2),math.max(2,r-2),p[4]);star(core,16,16,math.max(1,r-4),math.max(1,r-4),p[5])
    if f==1 or f==2 then P.line(core,5,6,8,9,p[5]);P.line(core,25,24,28,27,p[5]) end
  end
  return {back,main,core}
end
return E
