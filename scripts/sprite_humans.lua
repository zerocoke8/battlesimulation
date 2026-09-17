local P = dofile((app.params.root or '.')..'/scripts/pixel_art.lua')
local C,pc=P.color,P.pc
local H={}
local outline=C('373344'); local deep=C('524958')
local skin=C('ffe2ce'); local skinShade=C('e7b8ac'); local skinLight=C('fff0de')
local metal=C('a8b7ca'); local metalLight=C('e3e9ec'); local metalShade=C('66748c')
local gold=C('d9b777'); local goldHi=C('fff0b6'); local white=C('fff5df')
local roots=app.params.root or '.'
local refs={rose=Image{fromFile=roots..'/art/references/rose.png'},teal=Image{fromFile=roots..'/art/references/teal.png'}}
local cache={}
-- Exact eye pixels only. Cheeks, nose, mouth and face contour are never painted.
local eyeRows={
 rose={
  {31,27,30},{32,25,31},{33,25,25},{33,27,31},{34,28,31},{35,28,31},{36,28,31},
  {31,41,42},{32,40,44},{33,39,42},{34,39,43},{35,39,42},{36,39,41},
 },
 teal={
  {30,26,29},{31,25,31},{32,25,31},{33,25,31},{34,26,31},{35,27,29},
  {30,39,41},{31,38,42},{32,37,42},{33,37,42},{34,37,41},{35,38,39},
 },
}
H.eyeRows=eyeRows
local function closeEyes(im,ref)
  local lit=C(ref=='rose' and 'ffebdd' or 'fee9da')
  local shade=C(ref=='rose' and 'ffe2ca' or 'fde4d2')
  for _,r in ipairs(eyeRows[ref]) do
    for x=r[2],r[3] do P.dot(im,x,r[1],(x==r[2] or x==r[3]) and shade or lit) end
  end
  local lash=C('8b656d')
  if ref=='rose' then
    P.line(im,28,34,30,34,lash);P.dot(im,31,33,lash);P.line(im,39,34,41,34,lash);P.dot(im,42,33,lash)
  else
    P.line(im,27,33,30,33,lash);P.dot(im,26,32,lash);P.line(im,38,33,40,33,lash);P.dot(im,41,32,lash)
  end
end

local function head(d)
  if cache[d.key] then return cache[d.key] end
  local src=refs[d.ref]; local im=P.image(); local ramp={}
  for i,h in ipairs(d.hair) do ramp[i]=C(h) end
  for y=0,43 do for x=0,63 do
    local keep=y<=39 or (y<=42 and (x<25 or x>40))
    if d.ref=='teal' then keep=y<=38 or (y<=43 and (x<23 or x>41)) end
    local col=src:getPixel(x,y)
    if keep and pc.rgbaA(col)>0 then
      local r,g,b=pc.rgbaR(col),pc.rgbaG(col),pc.rgbaB(col)
      local hair=(d.ref=='rose' and r>b*1.02 and b>g+5) or (d.ref=='teal' and g>r*1.2 and b>r*1.15)
      -- The eye/cheek/nose pixels are excluded from every hair operation.
      local face=(x>=24 and x<=43 and y>=27 and y<=39)
      if hair and not (face and ((d.ref=='teal' and y>=30) or (d.ref=='rose' and y>=32))) then
        local lum=(r*0.25+g*0.55+b*0.2)/255
        local idx=math.max(1,math.min(7,math.floor(lum*7)+1))
        col=ramp[idx]
      end
      P.dot(im,x,y,col)
    end
  end end
  -- Accessories change silhouette without scaling the underlying reference head.
  local s,m,l=C(d.cloth[1]),C(d.cloth[2]),C(d.cloth[3])
  if d.hat=='clip' then
    P.line(im,43,18,48,22,outline,3); P.line(im,43,18,48,22,gold,1); P.dot(im,45,19,goldHi)
  elseif d.hat=='band' then
    P.line(im,14,23,20,20,s,3); P.line(im,15,23,21,20,m)
    P.poly(im,{{15,22},{10,25},{9,30},{15,26}},s); P.line(im,11,26,14,24,l)
  elseif d.hat=='leaf' then
    P.poly(im,{{14,19},{11,6},{17,10},{18,18}},outline)
    P.poly(im,{{14,17},{13,9},{16,11},{17,17}},m); P.line(im,14,11,16,18,l)
    P.ellipse(im,17,21,3,2,gold); P.dot(im,17,20,goldHi)
  elseif d.hat=='circlet' then
    P.line(im,16,23,22,19,gold,2); P.line(im,22,19,28,18,gold,2)
    P.poly(im,{{18,18},{21,21},{18,25},{15,22}},outline)
    P.poly(im,{{18,19},{20,21},{18,23},{16,22}},m); P.dot(im,18,20,l)
  elseif d.hat=='helmet' then
    P.poly(im,{{13,19},{16,12},{25,8},{39,9},{47,15},{49,23},{43,22},{39,17},{22,17},{17,22}},outline)
    P.poly(im,{{15,18},{18,13},{26,10},{38,11},{45,16},{46,20},{40,16},{23,15},{17,20}},metalShade)
    P.poly(im,{{19,14},{27,11},{36,12},{40,15},{25,14}},metalLight)
    P.line(im,31,10,33,15,gold,2); P.dot(im,33,12,goldHi)
    P.poly(im,{{14,22},{18,21},{18,31},{15,33},{13,30}},metal); P.line(im,15,23,15,29,metalLight)
  elseif d.hat=='hood' then
    P.poly(im,{{10,22},{15,12},{29,6},{44,12},{51,24},{47,24},{41,16},{28,12},{17,19},{14,31},{11,30}},outline)
    P.poly(im,{{12,22},{17,14},{29,8},{42,14},{48,23},{44,19},{29,11},{17,18},{13,28}},s)
    P.line(im,17,14,28,9,m,2); P.line(im,29,9,41,14,m)
    P.dot(im,29,9,l)
  elseif d.hat=='cap' then
    P.poly(im,{{15,21},{15,13},{23,9},{37,10},{45,16},{45,21},{52,23},{49,25},{35,22}},outline)
    P.poly(im,{{17,19},{17,14},{24,11},{37,12},{43,17},{43,21},{32,19}},s)
    P.line(im,19,14,24,12,m,2); P.line(im,35,20,48,23,metalShade,2)
    P.rect(im,35,14,4,3,gold); P.dot(im,36,14,goldHi)
  elseif d.hat=='witch' then
    P.poly(im,{{8,20},{19,16},{26,3},{36,4},{38,9},{35,8},{36,17},{52,22},{51,25},{39,25},{18,23}},outline)
    P.poly(im,{{12,20},{22,17},{27,5},{34,5},{32,10},{34,19},{48,22},{39,23},{19,21}},s)
    P.poly(im,{{24,15},{28,6},{30,7},{28,15}},m)
    P.line(im,22,17,34,19,gold,2); P.dot(im,32,18,goldHi)
    P.spark(im,28,12,l)
  elseif d.hat=='nun' then
    P.poly(im,{{13,22},{17,14},{27,10},{38,12},{45,18},{47,24},{43,23},{37,17},{27,15},{19,20},{16,28}},outline)
    P.poly(im,{{15,22},{19,16},{27,12},{37,14},{43,19},{44,22},{37,16},{27,14},{19,19},{16,25}},white)
    P.line(im,24,13,28,12,gold); P.line(im,29,11,29,15,gold); P.line(im,27,13,31,13,gold)
  end
  cache[d.key]=im
  return im
end

function H.render(d,anim,f)
  local rear,legs,body,arms,face,weapon=P.image(),P.image(),P.image(),P.image(),P.image(),P.image()
  local s,m,l=C(d.cloth[1]),C(d.cloth[2]),C(d.cloth[3])
  local dx,dy=0,0
  if anim=='walk' then dy=({0,-1,-1,0,-1,-1})[f+1]
  elseif anim=='idle' then dy=({0,0,-1,0})[f+1]
  elseif anim=='attack' then dx=({-1,0,2,1})[f+1];dy=({0,-1,0,0})[f+1]
  elseif anim=='cast' then dy=({0,-1,-1,0})[f+1]
  elseif anim=='hit' then dx=({-2,-1})[f+1]
  elseif anim=='death' and f==1 then dy=1 end
  local long=d.weapon=='staff' or d.weapon=='holy' or d.weapon=='book' or d.weapon=='rifle'
  -- Back cape/quiver: overlaps shoulder and waist by >= 2 px.
  P.poly(rear,{{25,40},{36,40},{40,53},{35,56},{30,52},{24,55},{22,48}},outline)
  P.poly(rear,{{25,42},{34,42},{37,52},{35,54},{30,50},{24,53}},s)
  P.line(rear,26,43,25,51,m)
  if d.weapon=='bow' then
    P.line(rear,22,33,19,48,outline,6);P.line(rear,22,34,20,46,C('94725b'),4)
    for i=0,2 do P.line(rear,20+i*2,30,19+i*2,38,gold); P.poly(rear,{{20+i*2,29},{21+i*2,32},{19+i*2,32}},white) end
  end
  local stride=anim=='walk' and ({-2,0,2,2,0,-2})[f+1] or 0
  for i,x in ipairs({28,35}) do
    local step=i==1 and stride or -stride
    local lift=(anim=='walk' and ((i==1 and f<3) or (i==2 and f>=3))) and 1 or 0
    P.line(legs,x,49,x+step,55-lift,outline,5)
    P.line(legs,x,50,x+step,54-lift,metal,3)
    P.rect(legs,x+step-2,55-lift,6,4,outline)
    P.rect(legs,x+step-1,55-lift,4,2,metalShade)
    P.dot(legs,x+step,55-lift,metalLight)
  end
  -- Rigid torso: identical pixel cluster in every animation.
  P.rect(body,28,37,8,8,outline);P.rect(body,29,38,6,7,skinShade);P.rect(body,30,39,4,4,skin)
  P.poly(body,{{26,41},{37,41},{39,47},{37,52},{26,52},{24,47}},outline)
  P.poly(body,{{27,42},{36,42},{37,47},{35,51},{27,51},{26,46}},m)
  P.rect(body,27,44,3,5,l);P.rect(body,34,44,3,6,s)
  if long then
    P.poly(body,{{26,47},{38,47},{40,55},{34,55},{31,52},{29,55},{24,54}},outline)
    P.poly(body,{{27,48},{37,48},{38,53},{34,53},{31,50},{28,53},{26,53}},d.weapon=='holy' and white or m)
    P.line(body,34,48,36,53,d.weapon=='holy' and gold or l)
  end
  if d.weapon=='sword' or d.weapon=='shield' then
    P.poly(body,{{26,42},{31,44},{37,42},{36,47},{32,49},{27,47}},metalShade)
    P.poly(body,{{27,43},{31,45},{35,43},{34,46},{31,47},{28,46}},metalLight)
    P.rect(body,27,49,10,2,s);P.rect(body,31,49,3,2,gold)
  elseif d.weapon=='axe' then
    P.rect(body,27,42,10,7,skinShade);P.rect(body,28,42,8,5,skin)
    P.line(body,26,42,35,48,s,2);P.rect(body,27,49,10,3,C('776358'));P.rect(body,31,49,3,2,gold)
  elseif d.weapon=='holy' then
    P.poly(body,{{27,42},{31,44},{36,42},{37,48},{33,51},{27,49}},white)
    P.line(body,31,44,31,49,gold);P.line(body,29,46,33,46,gold)
  else
    P.poly(body,{{27,41},{31,44},{29,46}},white);P.poly(body,{{36,41},{32,44},{34,46}},l)
    P.rect(body,30,46,3,2,gold);P.dot(body,31,46,goldHi)
    P.line(body,27,50,36,50,deep)
  end
  -- Both connected arms are redrawn as solid overlapping sleeve/hand clusters.
  local hy=47; local hx=42
  if anim=='attack' then hx=({39,43,46,43})[f+1];hy=({44,42,46,47})[f+1]
  elseif anim=='cast' then hx=42;hy=({43,41,40,42})[f+1]
  elseif anim=='walk' then hy=47+(f%3==0 and 1 or 0) end
  P.line(arms,26,43,23,48,outline,6);P.line(arms,26,43,23,47,d.weapon=='holy' and white or m,4)
  P.rect(arms,21,47,5,4,outline);P.rect(arms,22,48,3,2,skin);P.dot(arms,22,48,skinLight)
  P.line(arms,36,43,hx-2,hy,outline,6);P.line(arms,36,43,hx-2,hy,d.weapon=='holy' and white or m,4)
  P.line(arms,36,42,hx-2,hy-1,d.weapon=='holy' and gold or l)
  P.rect(arms,hx-2,hy-2,5,5,outline);P.rect(arms,hx-1,hy-1,3,3,skin);P.dot(arms,hx-1,hy-1,skinLight)
  local function rod(x1,y1,x2,y2)
    P.line(weapon,x1,y1,x2,y2,outline,3);P.line(weapon,x1,y1,x2,y2,gold)
  end
  local function sword(x,y,tx,ty,short)
    P.line(weapon,x,y,tx,ty,outline,5);P.line(weapon,x,y,tx,ty,metal,3)
    P.line(weapon,x-1,y-1,tx-1,ty,metalLight)
    P.line(weapon,x-3,y,x+3,y+2,gold,2); P.line(weapon,x,y+2,x-1,y+5,deep,2)
  end
  if d.weapon=='sword' then
    local tips=anim=='attack' and {{36,23},{53,22},{59,41},{53,33}} or {{50,29}}
    local t=tips[f+1] or tips[1];sword(hx,hy,t[1],t[2])
  elseif d.weapon=='shield' then
    sword(hx,hy,hx+9,hy-13)
    P.poly(weapon,{{13,39},{24,37},{27,41},{25,51},{20,56},{14,51}},outline)
    P.poly(weapon,{{15,40},{23,39},{25,42},{23,50},{20,53},{16,49}},metal)
    P.poly(weapon,{{17,41},{22,40},{23,43},{22,49},{20,51},{18,48}},m)
    P.line(weapon,20,42,20,49,gold);P.line(weapon,18,45,22,45,gold);P.dot(weapon,20,43,goldHi)
  elseif d.weapon=='axe' then
    local tx,ty=hx+7,hy-20
    if anim=='attack' and f==2 then tx,ty=53,hy-5 end
    rod(hx-4,hy+6,tx,ty)
    P.poly(weapon,{{tx-7,ty-2},{tx-1,ty+1},{tx+5,ty-3},{tx+7,ty+4},{tx+3,ty+9},{tx,ty+5},{tx-6,ty+6}},outline)
    P.poly(weapon,{{tx-6,ty},{tx-1,ty+3},{tx+4,ty-1},{tx+5,ty+4},{tx+3,ty+7},{tx,ty+4},{tx-5,ty+4}},metal)
    P.line(weapon,tx-5,ty+1,tx-4,ty+4,metalLight); P.line(weapon,tx+5,ty+1,tx+4,ty+5,metalLight)
  elseif d.weapon=='daggers' then
    sword(hx,hy,hx+10,hy-6);sword(23,49,13,43)
  elseif d.weapon=='bow' then
    local x=hx+5
    P.line(weapon,x-3,hy-17,x+2,hy-12,outline,3);P.line(weapon,x+2,hy-12,x+4,hy-4,outline,3);P.line(weapon,x+4,hy-4,x+1,hy+5,outline,3)
    P.line(weapon,x-3,hy-17,x+2,hy-12,gold);P.line(weapon,x+2,hy-12,x+4,hy-4,gold);P.line(weapon,x+4,hy-4,x+1,hy+5,gold)
    local pull=(anim=='attack' and f<2) and 5 or 0
    P.line(weapon,x-3,hy-17,x-pull,hy-3,white);P.line(weapon,x-pull,hy-3,x+1,hy+5,white)
    P.line(weapon,hx-3,hy-3,59,hy-3,gold);P.poly(weapon,{{59,hy-3},{56,hy-5},{56,hy-1}},metalLight)
  elseif d.weapon=='rifle' then
    local recoil=(anim=='attack' and f==2) and -2 or 0
    P.line(weapon,hx-7+recoil,hy+2,hx+15+recoil,hy-8,outline,5)
    P.line(weapon,hx-7+recoil,hy+2,hx+2+recoil,hy-2,C('9c7664'),3)
    P.line(weapon,hx+recoil,hy-1,hx+15+recoil,hy-8,metalShade,3)
    P.line(weapon,hx+1+recoil,hy-3,hx+14+recoil,hy-9,metal)
    P.line(weapon,hx+2+recoil,hy-6,hx+8+recoil,hy-8,outline,3);P.dot(weapon,hx+8+recoil,hy-8,goldHi)
  elseif d.weapon=='staff' or d.weapon=='holy' then
    local x=hx+5
    rod(x-3,56,x,25)
    if d.weapon=='holy' then
      P.line(weapon,x,21,x,34,outline,5);P.line(weapon,x-5,26,x+5,26,outline,5)
      P.line(weapon,x,22,x,33,gold,3);P.line(weapon,x-4,26,x+4,26,gold,3)
      P.line(weapon,x,23,x,29,goldHi);P.dot(weapon,x,26,white)
    else
      P.ellipse(weapon,x,24,6,7,outline);P.ellipse(weapon,x,23,5,6,gold)
      P.ellipse(weapon,x,23,3,4,m);P.ellipse(weapon,x-1,22,2,2,l);P.dot(weapon,x-1,20,white)
    end
  elseif d.weapon=='book' then
    P.poly(weapon,{{hx-10,hy-8},{hx-3,hy-7},{hx,hy-5},{hx+3,hy-8},{hx+10,hy-9},{hx+9,hy+1},{hx,hy+4},{hx-10,hy+1}},outline)
    P.poly(weapon,{{hx-8,hy-7},{hx-3,hy-6},{hx,hy-4},{hx+3,hy-7},{hx+8,hy-8},{hx+7,hy},{hx,hy+2},{hx-8,hy}},white)
    P.line(weapon,hx,hy-4,hx,hy+2,gold);P.line(weapon,hx+2,hy-4,hx+6,hy-5,m);P.line(weapon,hx+2,hy-1,hx+6,hy-2,m)
    P.line(weapon,hx-6,hy-4,hx-2,hy-3,metalShade);P.line(weapon,hx-6,hy-1,hx-2,hy,metalShade)
  end
  P.blit(face,head(d))
  if anim=='death' and f>=1 then closeEyes(face,d.ref) end
  local parts={rear,legs,body,arms,face,weapon}
  if anim=='death' and f>=2 then return P.fall(parts,f==2 and 2 or 0),{dx=0,dy=0,fallen=true} end
  for i,im in ipairs(parts) do
    -- Legs remain grounded while head + torso translate together.
    parts[i]=P.shift(im,dx,i==2 and 0 or dy)
  end
  return parts,{dx=dx,dy=dy,fallen=false}
end
return H
