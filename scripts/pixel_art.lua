-- Integer pixel primitives for Aseprite. No resampling, smoothing or dithering.
local P = {}
local pc = app.pixelColor
P.pc=pc
function P.color(hex)
  hex=hex:gsub('#','')
  return pc.rgba(tonumber(hex:sub(1,2),16),tonumber(hex:sub(3,4),16),tonumber(hex:sub(5,6),16),255)
end
function P.image(w,h) return Image(w or 64,h or 64,ColorMode.RGB) end
function P.dot(im,x,y,c)
  x=math.floor(x+0.5); y=math.floor(y+0.5)
  if x>=0 and y>=0 and x<im.width and y<im.height then im:drawPixel(x,y,c)
  elseif pc.rgbaA(c)>0 then _G.SPRITE_CLIPPED_PIXELS=(_G.SPRITE_CLIPPED_PIXELS or 0)+1 end
end
function P.rect(im,x,y,w,h,c)
  for yy=y,y+h-1 do for xx=x,x+w-1 do P.dot(im,xx,yy,c) end end
end
function P.line(im,x0,y0,x1,y1,c,width)
  x0=math.floor(x0+0.5); y0=math.floor(y0+0.5)
  x1=math.floor(x1+0.5); y1=math.floor(y1+0.5)
  local dx,dy=math.abs(x1-x0),-math.abs(y1-y0)
  local sx,sy=x0<x1 and 1 or -1,y0<y1 and 1 or -1
  local err=dx+dy
  while true do
    local n=width or 1; P.rect(im,x0-math.floor(n/2),y0-math.floor(n/2),n,n,c)
    if x0==x1 and y0==y1 then break end
    local e=2*err
    if e>=dy then err=err+dy; x0=x0+sx end
    if e<=dx then err=err+dx; y0=y0+sy end
  end
end
function P.poly(im,pts,c)
  local lo,hi=999,-999
  for _,p in ipairs(pts) do lo=math.min(lo,p[2]); hi=math.max(hi,p[2]) end
  for y=math.floor(lo),math.ceil(hi) do
    local xs={}
    for i,p in ipairs(pts) do
      local q=pts[i%#pts+1]
      if (p[2]<=y and q[2]>y) or (q[2]<=y and p[2]>y) then
        xs[#xs+1]=p[1]+(y-p[2])*(q[1]-p[1])/(q[2]-p[2])
      end
    end
    table.sort(xs)
    for i=1,#xs-1,2 do for x=math.ceil(xs[i]),math.floor(xs[i+1]) do P.dot(im,x,y,c) end end
  end
  for i,p in ipairs(pts) do local q=pts[i%#pts+1]; P.line(im,p[1],p[2],q[1],q[2],c) end
end
function P.ellipse(im,cx,cy,rx,ry,c)
  for y=math.floor(cy-ry),math.ceil(cy+ry) do
    for x=math.floor(cx-rx),math.ceil(cx+rx) do
      if ((x-cx)/rx)^2+((y-cy)/ry)^2<=1 then P.dot(im,x,y,c) end
    end
  end
end
function P.blit(dst,src,dx,dy)
  for y=0,src.height-1 do for x=0,src.width-1 do
    local c=src:getPixel(x,y)
    if pc.rgbaA(c)>0 then P.dot(dst,x+(dx or 0),y+(dy or 0),c) end
  end end
end
function P.shift(src,dx,dy) local im=P.image(); P.blit(im,src,dx,dy); return im end
function P.merge(parts)
  local im=P.image()
  for _,part in ipairs(parts) do P.blit(im,part) end
  return im
end
function P.bounds(im)
  local x0,y0,x1,y1=im.width,im.height,-1,-1
  for y=0,im.height-1 do for x=0,im.width-1 do if pc.rgbaA(im:getPixel(x,y))>0 then
    x0=math.min(x0,x); y0=math.min(y0,y); x1=math.max(x1,x); y1=math.max(y1,y)
  end end end
  return x0,y0,x1,y1
end
function P.zoom(src,k,bg)
  local im=P.image(src.width*k,src.height*k)
  if bg then im:clear(bg) end
  for y=0,src.height-1 do for x=0,src.width-1 do
    local c=src:getPixel(x,y)
    if pc.rgbaA(c)>0 then P.rect(im,x*k,y*k,k,k,c) end
  end end
  return im
end
-- A rigid 90-degree fall is a bijective pixel transform: zero lost pixels,
-- unchanged head/torso proportions, no pinholes from arbitrary rotations.
function P.fall(parts,offset)
  local whole=P.merge(parts)
  local x0,y0,x1,y1=P.bounds(whole)
  local h,w=y1-y0+1,x1-x0+1
  local left=math.floor((64-h)/2)
  local top=math.max(0,58-w+1-(offset or 0))
  local out={}
  for i,src in ipairs(parts) do
    local im=P.image()
    for y=y0,y1 do for x=x0,x1 do
      local c=src:getPixel(x,y)
      if pc.rgbaA(c)>0 then P.dot(im,left+y-y0,top+x1-x,c) end
    end end
    out[i]=im
  end
  return out
end
function P.spark(im,x,y,c)
  P.line(im,x-2,y,x+2,y,c); P.line(im,x,y-2,x,y+2,c)
end
return P
