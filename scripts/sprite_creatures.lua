local P=dofile((app.params.root or '.')..'/scripts/pixel_art.lua')
local C=P.color
local M={}
local O=C('353347');local W=C('fff4d9');local B=C('e5a7a4');local G=C('d8b576')
local palettes={
 mint={'245356','408887','72bab0','b4e5cf','e6ffdc'},
 blue={'36486a','557cab','82b3d3','b9e0e9','f0faed'},
 green={'425448','698265','9fb887','cfdbad','f6eaca'},
 violet={'473b63','796395','a88ebc','d6bfdf','fae6ed'},
 rose={'643e58','a35e78','d58b9a','f0bcc0','ffe5d7'},
 ochre={'58494c','8b6b59','bc9572','e5c398','ffeac3'},
 shadow={'282b43','43445e','68657d','aaa0b3','e1d7d9'},
 stone={'4b5260','747e8b','a1acb0','c6cfc4','e6e9d1'},
 fire={'603745','a34d45','de8553','f4be77','ffebac'},
}
local function colors(d) local p={};for i,h in ipairs(palettes[d.theme]) do p[i]=C(h) end;return p end
local function oval(im,x,y,rx,ry,p)
  P.ellipse(im,x,y,rx,ry,O);P.ellipse(im,x,y-1,rx-1,ry-1,p[2]);P.ellipse(im,x-1,y-2,rx-2,ry-3,p[3])
end
local function eyes(im,x,y,gap,p,closed)
  for _,ex in ipairs({x,x+gap}) do
    if closed then P.line(im,ex,y+2,ex+2,y+2,O)
    else
      P.rect(im,ex,y,3,5,O);P.dot(im,ex+1,y+3,p[1]);P.dot(im,ex+1,y+4,p[3]);P.dot(im,ex,y,W)
    end
  end
  P.rect(im,x-3,y+5,3,2,B);P.rect(im,x+gap+3,y+5,3,2,B)
  P.line(im,x+4,y+6,x+5,y+6,O)
end
local function gem(im,x,y,p)
  P.poly(im,{{x,y-5},{x+4,y},{x,y+5},{x-4,y}},O)
  P.poly(im,{{x,y-3},{x+2,y},{x,y+3},{x-2,y}},p[3]);P.dot(im,x-1,y-1,p[5])
end
local function wing(im,x,y,flip,phase,p)
  local pts={{0,0},{9,-14-phase},{16,-18-phase},{15,-7},{20,-8},{18,1},{21,6},{13,7},{6,4}}
  local function shape(a) local t={};for _,v in ipairs(a) do t[#t+1]={x+v[1]*flip,y+v[2]} end;return t end
  P.poly(im,shape(pts),O)
  P.poly(im,shape({{2,0},{10,-11-phase},{14,-15-phase},{13,-4},{19,-5},{16,2},{19,5},{12,5},{6,2}}),p[2])
  P.poly(im,shape({{4,0},{10,-7-phase},{11,-4},{10,2}}),p[3])
  P.line(im,x+2*flip,y,x+14*flip,y-15-phase,p[4]);P.line(im,x+3*flip,y+1,x+17*flip,y+3,p[1])
end
local function foot(im,x,y,p)
  P.rect(im,x-3,y-8,6,9,O);P.rect(im,x-2,y-8,4,7,p[2]);P.line(im,x-2,y-1,x+3,y-1,p[3])
end
local function horn(im,x,y,flip)
  P.poly(im,{{x,y},{x-3*flip,y-7},{x-2*flip,y-11},{x+2*flip,y-6},{x+4*flip,y-1}},O)
  P.poly(im,{{x,y-2},{x-1*flip,y-7},{x+1*flip,y-5},{x+2*flip,y-2}},W)
end
function M.render(d,anim,f)
  local rear,legs,body,arms,head,gear=P.image(),P.image(),P.image(),P.image(),P.image(),P.image()
  local p=colors(d)
  local bob=0
  if anim=='idle' then bob=({0,-1,-1,0})[f+1]
  elseif anim=='walk' then bob=({0,-1,-1,0,-1,-1})[f+1]
  elseif anim=='cast' then bob=({0,-1,-2,-1})[f+1] end
  local lunge=anim=='attack' and ({-1,0,2,1})[f+1] or 0
  if anim=='hit' then lunge=-2+f end
  local stride=anim=='walk' and ({-2,0,2,2,0,-2})[f+1] or 0
  local armLift=anim=='attack' and ({-2,-5,0,-1})[f+1] or (anim=='cast' and -3-(f%2) or 0)
  local flap=(anim=='walk' or anim=='cast') and ({0,3,1,-2,0,2})[f+1] or (f%2)
  local closed=anim=='death' and f>=1
  if d.kind=='slime' then
    local rx=d.boss and 25 or 20;local ry=d.boss and 22 or 17;local cy=57-ry
    P.poly(body,{{32-rx,cy+4},{32-rx+2,53},{22,57},{42,58},{32+rx-1,53},{32+rx,cy+3}},O)
    oval(body,32,cy,rx,ry,p)
    P.ellipse(body,32,54,rx-4,3,p[2]);P.ellipse(body,26,cy-7,rx-8,6,p[4])
    P.line(body,32-rx+5,cy-3,32-rx+7,cy-8,p[5],2);P.rect(body,32-rx+10,cy-11,5,2,p[5])
    P.ellipse(body,43,cy+8,5,4,p[2]);P.line(body,22,54,30,55,p[4])
    eyes(head,29,cy+1,11,p,closed)
    if d.boss then
      P.poly(gear,{{22,18},{20,10},{27,13},{32,7},{36,13},{43,10},{41,19}},O)
      P.poly(gear,{{24,17},{23,13},{28,15},{32,10},{35,15},{40,13},{39,17}},G);gem(gear,32,16,p)
    else
      P.poly(gear,{{24,22},{19,18},{20,14},{25,16},{28,21}},p[1]);P.line(gear,21,16,26,21,p[4])
    end
    P.ellipse(arms,51+lunge,49+armLift,4,5,p[2]);P.line(arms,51+lunge,46+armLift,52+lunge,48+armLift,p[4])
  elseif d.kind=='beast' then
    P.poly(rear,{{18,40},{9,35},{6,28},{4,34},{7,43},{19,48}},O)
    P.poly(rear,{{17,42},{9,38},{7,33},{7,39},{11,44},{18,46}},p[2]);P.line(rear,7,36,10,41,p[4])
    oval(body,28,45,17,10,p)
    P.ellipse(body,31,45,9,6,p[4]);P.poly(body,{{16,40},{17,49},{23,49},{19,45},{23,39}},p[2])
    for i,x in ipairs({17,27,38,46}) do foot(legs,x+(i%2==0 and stride or -stride),58,p) end
    P.line(arms,42,43,47+lunge,53+armLift,O,7);P.line(arms,42,43,47+lunge,53+armLift,p[3],5)
    -- Oversized head with pointed ears and solid muzzle.
    P.poly(head,{{24,29},{20,12},{28,16},{33,26}},O);P.poly(head,{{25,26},{23,16},{27,19},{30,26}},p[3]);P.line(head,24,18,26,23,B,2)
    P.poly(head,{{40,25},{45,11},{51,14},{48,33}},O);P.poly(head,{{43,25},{46,15},{48,16},{47,28}},p[3]);P.line(head,46,17,45,23,B)
    oval(head,36,32,17,14,p)
    P.poly(head,{{21,30},{20,38},{25,38},{23,41},{31,41},{29,35}},p[4])
    P.ellipse(head,42,38,10,6,p[4]);P.ellipse(head,49,35,4,2,O);P.dot(head,48,34,p[4])
    P.line(head,43,40,47,40,O);P.dot(head,47,39,O)
    for _,ex in ipairs({30,41}) do
      P.rect(head,ex,28,3,5,O);P.dot(head,ex,28,W);P.dot(head,ex+1,32,d.horns and C('e78591') or p[3])
    end
    P.rect(head,26,35,3,2,B)
    P.poly(head,{{28,23},{31,19},{38,19},{36,22}},p[4])
    if d.horns then horn(gear,26,24,1);horn(gear,47,24,-1);gem(gear,36,24,{p[1],p[2],C('db7287'),p[4],W}) end
    if d.summon then P.line(gear,27,43,43,45,G,2);gem(gear,37,45,p) end
  elseif d.kind=='bat' then
    wing(rear,29,34,-1,flap,p);wing(rear,35,34,1,-flap,p)
    oval(body,32,43,9,12,p);P.ellipse(body,33,45,5,8,p[4])
    P.poly(head,{{20,27},{20,9},{27,14},{30,25}},O);P.poly(head,{{22,24},{22,13},{26,16},{28,24}},p[3])
    P.poly(head,{{35,24},{41,9},{46,10},{44,28}},O);P.poly(head,{{38,24},{42,13},{44,13},{42,25}},p[3])
    oval(head,32,30,15,13,p);P.poly(head,{{22,27},{29,29},{30,34},{24,37}},p[4]);P.poly(head,{{40,26},{35,30},{36,35},{43,34}},p[4])
    eyes(head,26,28,10,p,closed);P.dot(head,33,37,W);P.dot(head,36,36,W)
    P.line(legs,27,52,26,55,G,2);P.line(legs,37,52,39,55,G,2)
  elseif d.kind=='mushroom' then
    oval(body,32,45,12,13,{O,p[2],W,C('fff5df'),W});P.ellipse(body,38,48,3,6,C('e3c6b4'))
    P.ellipse(rear,32,32,25,9,p[1]);P.line(rear,15,34,25,38,p[4]);P.line(rear,40,35,36,38,p[4])
    P.poly(head,{{6,30},{10,20},{20,12},{32,9},{44,13},{52,22},{57,31},{54,34},{13,34}},O)
    P.poly(head,{{8,29},{12,21},{21,14},{32,11},{43,15},{50,23},{54,31},{15,32}},p[2])
    P.poly(head,{{12,26},{20,16},{30,13},{35,14},{31,21},{23,25}},p[3])
    P.ellipse(head,19,23,5,4,W);P.ellipse(head,37,18,5,3,W);P.ellipse(head,46,28,4,3,p[4]);P.ellipse(head,31,29,3,2,p[4])
    eyes(body,27,41,10,p,closed)
    P.line(arms,21,46,17,48+armLift,O,4);P.line(arms,21,46,17,48+armLift,W,2)
    P.line(arms,43,46,47,46+armLift,O,4);P.line(arms,43,46,47,46+armLift,W,2)
    P.ellipse(legs,26+stride,56,5,2,p[2]);P.ellipse(legs,39-stride,56,5,2,p[2])
  elseif d.kind=='goblin' or d.kind=='bandit' then
    local big=d.orc;local cx=33;local cy=27;local rx=big and 19 or 16
    for i,x in ipairs({26,39}) do foot(legs,x+(i==1 and stride or -stride),58,p) end
    oval(body,32,45,big and 14 or 11,11,p)
    P.poly(body,{{22,39},{26,39},{40,50},{42,55},{37,55},{23,43}},C('79635c'))
    P.rect(body,23,50,19,4,O);P.rect(body,25,51,16,2,C('997963'));P.rect(body,32,50,4,3,G)
    P.line(arms,21,42,17,49+armLift,O,7);P.line(arms,21,42,17,49+armLift,p[3],5)
    P.line(arms,42,42,47,47+armLift,O,8);P.line(arms,42,42,47,47+armLift,p[3],6)
    if d.kind=='goblin' then
      P.poly(head,{{17,23},{7,18},{12,30},{20,33}},O);P.poly(head,{{16,25},{10,21},{14,28},{18,29}},p[3])
      P.poly(head,{{46,23},{57,18},{52,30},{44,33}},O);P.poly(head,{{47,25},{54,22},{51,28},{46,30}},p[3])
    end
    oval(head,cx,cy,rx,16,p)
    P.poly(head,{{17,23},{20,13},{28,10},{39,11},{48,20},{43,18},{41,22},{35,18},{28,19},{26,23}},p[1])
    P.line(head,23,15,31,13,p[2],2);eyes(head,27,26,12,p,closed)
    if d.orc then P.poly(head,{{27,36},{28,32},{30,37}},W);P.poly(head,{{41,36},{42,32},{44,37}},W) end
    if d.boss then horn(gear,18,20,1);horn(gear,46,20,-1);P.line(gear,18,17,47,17,C('677384'),3);gem(gear,33,16,p) end
    if d.kind=='bandit' then
      P.poly(head,{{17,22},{18,12},{29,8},{41,11},{49,20},{44,21},{36,15},{24,18},{20,24}},O)
      P.poly(head,{{19,19},{20,13},{29,10},{40,13},{45,18},{36,14},{25,16}},p[2])
      P.poly(head,{{22,34},{30,35},{38,34},{46,32},{44,39},{33,42},{25,39}},O);P.line(head,28,38,40,36,p[2])
    end
    local x=48;local y=46+armLift
    if d.orc then
      P.line(gear,x,y+5,x+3,y-14,O,4);P.line(gear,x,y+4,x+3,y-14,C('986e55'),2)
      P.poly(gear,{{x-2,y-8},{x-1,y-20},{x+6,y-20},{x+9,y-14},{x+6,y-6}},O)
      P.poly(gear,{{x,y-9},{x+1,y-18},{x+5,y-18},{x+7,y-14},{x+4,y-8}},C('a17c61'));P.line(gear,x+2,y-16,x+3,y-10,G)
    else
      P.line(gear,x-1,y+3,x+8,y-12,O,4);P.line(gear,x,y+1,x+8,y-12,C('cedad5'),2);P.line(gear,x-2,y-1,x+3,y+2,G,2)
    end
  elseif d.kind=='harpy' or d.kind=='demon' then
    wing(rear,24,39,-1,flap,p);wing(rear,39,39,1,-flap,p)
    oval(body,32,46,10,9,p);P.poly(body,{{25,44},{30,46},{34,44},{38,52},{26,54}},p[4])
    P.line(legs,28,51,27+stride,57,O,4);P.line(legs,37,51,38-stride,57,O,4)
    P.line(legs,27+stride,54,27+stride,57,G,2);P.line(legs,38-stride,54,38-stride,57,G,2)
    P.line(legs,25+stride,58,30+stride,58,G);P.line(legs,36-stride,58,41-stride,58,G)
    oval(head,32,27,17,16,p)
    P.ellipse(head,34,30,13,11,C('f8dbc8'))
    P.poly(head,{{16,27},{18,14},{28,10},{39,11},{46,19},{47,29},{40,26},{36,19},{33,27},{29,23},{24,30}},p[1])
    P.poly(head,{{19,24},{21,16},{28,13},{34,13},{28,20},{26,25}},p[3]);P.line(head,23,17,28,15,p[4],2)
    eyes(head,27,29,11,p,closed)
    if d.kind=='demon' then
      horn(gear,20,18,1);horn(gear,43,18,-1);gem(gear,33,18,p)
      P.line(rear,39,51,48,55,p[2],3);P.line(rear,48,55,53,49,p[2],3);P.poly(rear,{{52,51},{51,44},{57,48}},p[2])
    else
      P.poly(gear,{{17,21},{11,9},{15,10},{22,20}},O);P.line(gear,14,13,19,21,p[4],2)
      P.poly(gear,{{43,19},{48,9},{53,11},{49,20}},O);P.line(gear,49,12,46,20,p[4],2)
    end
    P.line(arms,23,42,18,47+armLift,O,5);P.line(arms,23,42,18,47+armLift,p[4],3)
    P.line(arms,41,42,47,45+armLift,O,5);P.line(arms,41,42,47,45+armLift,p[4],3)
  elseif d.kind=='armor' then
    P.poly(rear,{{20,35},{40,34},{45,55},{24,57}},O);P.poly(rear,{{22,37},{39,36},{42,54},{26,54}},p[1])
    foot(legs,25+stride,58,p);foot(legs,39-stride,58,p)
    oval(body,32,45,13,10,p);P.poly(body,{{23,39},{32,43},{41,39},{39,49},{32,52},{25,48}},p[4]);P.line(body,32,43,32,51,p[2])
    P.line(arms,20,41,18,49+armLift,O,8);P.line(arms,20,41,18,49+armLift,p[3],6)
    P.line(arms,43,41,46,47+armLift,O,8);P.line(arms,43,41,46,47+armLift,p[3],6)
    oval(head,32,24,18,17,p)
    P.poly(head,{{18,26},{21,20},{43,20},{47,26},{42,36},{24,36}},p[1])
    P.line(head,23,27,30,28,C('b9f7e8'),2);P.line(head,34,28,42,26,C('b9f7e8'),2)
    P.poly(head,{{30,15},{34,15},{36,34},{32,39},{29,34}},p[4]);P.line(head,32,17,33,34,p[5])
    P.poly(gear,{{27,8},{26,4},{35,3},{39,9},{37,14},{34,8}},p[2]);P.line(gear,28,5,35,5,p[4])
    P.line(gear,46,51+armLift,52,23+armLift,O,6);P.line(gear,46,49+armLift,52,23+armLift,p[4],4);P.line(gear,48,45+armLift,52,25+armLift,p[5])
    P.line(gear,42,46+armLift,51,48+armLift,G,3)
  elseif d.kind=='ghost' or d.kind=='spirit' then
    local spirit=d.kind=='spirit'
    P.poly(body,{{19,30},{45,30},{45,47},{48,54},{41,52},{36,56},{29,52},{23,56},{17,52},{20,44}},O)
    P.poly(body,{{21,31},{43,31},{42,47},{44,51},{39,49},{35,53},{29,49},{24,53},{20,51},{23,43}},p[3])
    P.poly(body,{{22,37},{28,35},{27,45},{23,49},{22,48}},p[4]);P.poly(body,{{37,40},{41,38},{40,46},{37,49}},p[2])
    oval(head,32,27,18,17,p);P.ellipse(head,32,29,13,10,p[4]);eyes(head,26,27,12,p,closed)
    if spirit then
      P.poly(gear,{{25,13},{28,8},{34,5},{33,12},{37,9},{36,17}},p[3]);P.line(gear,29,11,32,8,p[5]);gem(body,33,43,p)
    else
      P.poly(gear,{{16,22},{20,12},{31,7},{43,13},{49,24},{43,22},{37,16},{32,18},{27,15},{21,21}},p[1]);P.line(gear,23,14,31,10,p[3],2)
      P.poly(gear,{{25,41},{31,43},{38,41},{35,46},{30,48}},p[1]);P.dot(gear,32,44,G)
    end
    P.line(arms,20,40,13,43+armLift,O,5);P.line(arms,20,40,13,43+armLift,p[4],3)
    P.line(arms,44,40,51,41+armLift,O,5);P.line(arms,44,40,51,41+armLift,p[4],3)
  elseif d.kind=='skeleton' then
    if d.lich then P.poly(rear,{{21,34},{43,34},{49,56},{36,55},{30,58},{17,54}},O);P.poly(rear,{{23,35},{41,35},{46,53},{36,53},{30,56},{20,52}},p[2]) end
    foot(legs,26+stride,58,p);foot(legs,38-stride,58,p)
    P.rect(body,25,39,15,13,O);P.rect(body,27,40,11,11,W);P.line(body,32,40,32,51,C('b6a6a0'))
    for y=43,49,3 do P.line(body,27,y,30,y,O);P.line(body,34,y,37,y,O) end
    P.line(arms,24,42,19,49+armLift,O,5);P.line(arms,24,42,19,49+armLift,W,3)
    P.line(arms,40,42,46,46+armLift,O,5);P.line(arms,40,42,46,46+armLift,W,3)
    oval(head,32,24,17,16,{O,C('b7aaa9'),C('e3d5c0'),W,W})
    P.ellipse(head,26,26,5,5,O);P.ellipse(head,40,26,5,5,O)
    P.dot(head,27,26,d.lich and C('bb8ade') or p[4]);P.dot(head,41,26,d.lich and C('bb8ade') or p[4])
    P.poly(head,{{33,28},{30,33},{35,33}},C('8c7d83'))
    P.rect(head,25,35,17,5,O);P.rect(head,26,35,15,4,W);P.line(head,29,35,29,37,C('b7aaa9'));P.line(head,36,35,36,37,C('b7aaa9'))
    P.line(head,21,17,29,13,W,2)
    if d.lich then
      P.poly(gear,{{16,20},{19,8},{26,11},{32,4},{39,11},{46,8},{48,21},{42,18},{32,13},{22,18}},O)
      P.poly(gear,{{19,18},{21,11},{26,14},{32,7},{38,14},{44,11},{45,18},{32,11}},p[2]);gem(gear,32,12,p)
      P.line(gear,49,56,51,26+armLift,O,4);P.line(gear,49,55,51,26+armLift,G,2);gem(gear,51,24+armLift,p)
    else
      P.line(gear,46,50+armLift,55,32+armLift,O,5);P.line(gear,47,47+armLift,55,32+armLift,C('bbb0a2'),3);P.dot(gear,51,39+armLift,C('a26e53'));P.line(gear,43,46+armLift,49,49+armLift,G,2)
    end
  elseif d.kind=='golem' then
    foot(legs,22+stride,58,p);foot(legs,43-stride,58,p)
    P.poly(body,{{18,32},{43,31},{49,43},{44,54},{22,54},{15,43}},O)
    P.poly(body,{{20,34},{42,34},{46,43},{41,51},{23,51},{18,43}},p[2])
    P.poly(body,{{21,35},{31,34},{30,43},{20,43}},p[4]);P.poly(body,{{34,35},{41,36},{44,42},{34,44}},p[3])
    P.line(body,31,35,30,44,p[1]);P.line(body,30,44,38,51,p[1]);gem(body,32,43,{p[1],p[2],d.fire and C('ffe9a4') or C('94dfc7'),p[4],W})
    for i,x in ipairs({11,51}) do
      local yy=41+(i==2 and armLift or 0)
      P.line(arms,i==1 and 21 or 42,38,x,yy,O,13);P.line(arms,i==1 and 21 or 42,38,x,yy,p[2],11)
      P.poly(arms,{{x-6,yy},{x+5,yy-2},{x+7,yy+8},{x+3,yy+13},{x-5,yy+11}},O)
      P.poly(arms,{{x-4,yy+1},{x+3,yy},{x+5,yy+7},{x+2,yy+10},{x-3,yy+9}},p[3]);P.line(arms,x-3,yy+2,x+2,yy+1,p[4])
      P.line(arms,x-2,yy+6,x-1,yy+9,p[1]);P.line(arms,x+2,yy+5,x+3,yy+8,p[1])
    end
    P.poly(head,{{15,17},{21,8},{42,8},{49,18},{46,34},{37,39},{22,35}},O)
    P.poly(head,{{17,18},{22,10},{41,10},{46,18},{43,32},{36,36},{24,33}},p[2])
    P.poly(head,{{20,17},{24,11},{32,11},{31,23},{19,24}},p[4]);P.poly(head,{{34,12},{40,12},{44,18},{42,22},{34,21}},p[3])
    P.line(head,32,11,32,22,p[1]);P.line(head,32,22,27,26,p[1])
    P.rect(head,23,25,7,4,O);P.rect(head,36,25,7,4,O)
    P.line(head,24,26,28,26,d.fire and W or C('adf4dc'));P.line(head,37,26,41,26,d.fire and W or C('adf4dc'))
    P.line(head,30,33,36,33,p[1])
    if d.fire then
      P.poly(rear,{{13,24},{10,15},{18,19},{17,5},{26,10},{31,2},{36,12},{43,5},{47,17},{54,11},{51,28}},p[2])
      P.poly(rear,{{19,19},{22,11},{28,15},{31,6},{35,15},{42,10},{44,21}},p[4])
    else
      P.poly(gear,{{19,14},{21,8},{29,8},{30,12},{25,15}},C('668b75'));P.line(gear,22,10,27,10,C('b8cc90'))
    end
  elseif d.kind=='dragon' then
    wing(rear,24,37,-1,flap,p);wing(rear,38,37,1,-flap,p)
    P.poly(rear,{{20,47},{12,49},{7,45},{4,37},{5,48},{13,55},{25,53}},O);P.poly(rear,{{20,49},{11,51},{7,47},{6,44},{7,49},{14,53},{24,51}},p[3])
    oval(body,33,45,13,12,p);P.ellipse(body,35,46,7,9,p[4]);P.line(body,31,44,39,44,p[2]);P.line(body,30,48,40,48,p[2]);P.line(body,31,52,39,52,p[2])
    foot(legs,25+stride,58,p);foot(legs,43-stride,58,p)
    P.line(arms,22,42,18,49+armLift,O,6);P.line(arms,22,42,18,49+armLift,p[3],4)
    P.line(arms,44,40,49,46+armLift,O,6);P.line(arms,44,40,49,46+armLift,p[3],4)
    horn(head,24,17,1);horn(head,44,17,-1)
    oval(head,33,26,18,15,p)
    P.ellipse(head,40,34,14,7,O);P.ellipse(head,40,33,13,6,p[3]);P.ellipse(head,42,35,10,3,p[4])
    P.rect(head,26,23,4,6,O);P.dot(head,26,23,W);P.dot(head,28,28,p[4])
    P.rect(head,40,23,4,5,O);P.dot(head,40,23,W);P.dot(head,42,27,p[4])
    P.dot(head,49,31,p[1]);P.line(head,42,36,49,36,p[1]);P.dot(head,45,36,W)
    P.poly(gear,{{27,14},{31,7},{35,14}},p[4]);P.poly(gear,{{33,15},{38,9},{41,18}},p[4])
    P.rect(head,22,31,3,2,B)
  elseif d.kind=='turret' then
    -- Stationary summon: walk is intentionally identical to idle.
    bob=0;stride=0
    P.poly(legs,{{18,49},{25,48},{21,58},{12,58}},O);P.poly(legs,{{40,48},{46,49},{53,58},{44,58}},O)
    P.poly(legs,{{20,50},{23,50},{19,56},{15,56}},p[3]);P.poly(legs,{{42,50},{45,51},{49,56},{45,56}},p[3])
    P.rect(body,23,28,19,27,O);P.rect(body,25,29,15,24,p[2]);P.rect(body,27,30,3,21,p[3]);P.rect(body,34,29,3,23,p[3])
    P.line(body,25,40,40,48,O,4);P.line(body,25,40,40,48,p[4],2);P.line(body,39,39,25,49,O,4);P.line(body,39,39,25,49,p[4],2)
    P.rect(head,16,22,33,10,O);P.rect(head,17,23,31,7,p[3]);P.rect(head,19,23,7,5,p[4]);P.line(head,18,29,46,29,p[1])
    for x=17,43,13 do P.rect(head,x,16,6,8,O);P.rect(head,x+1,17,4,6,p[3]);P.dot(head,x+1,17,p[5]) end
    local yy=anim=='attack' and ({0,-1,1,0})[f+1] or 0
    P.line(gear,31,24+yy,52,16+yy,O,5);P.line(gear,31,24+yy,52,16+yy,p[4],3)
    P.line(gear,43,12+yy,50,28+yy,O,3);P.line(gear,43,12+yy,50,28+yy,p[2])
    P.line(gear,43,12+yy,39,21+yy,W);P.line(gear,39,21+yy,50,28+yy,W)
    P.line(gear,33,22+yy,57,13+yy,C('bbc5ca'));P.poly(gear,{{57,13+yy},{53,13+yy},{55,17+yy}},W)
    P.rect(body,29,32,3,4,O);P.rect(body,35,32,3,4,O);P.dot(body,30,32,W);P.dot(body,36,32,W)
  end
  local parts={rear,legs,body,arms,head,gear}
  if anim=='death' and f>=2 then return P.fall(parts,f==2 and 2 or 0),{fallen=true,dx=0,dy=0} end
  if anim=='death' and f==1 then bob=1 end
  for i,im in ipairs(parts) do parts[i]=P.shift(im,lunge,i==2 and 0 or bob) end
  return parts,{fallen=false,dx=lunge,dy=bob}
end
return M
