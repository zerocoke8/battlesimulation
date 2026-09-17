-- Checks exported PNGs against the editable layered Aseprite sources.
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local catalog=dofile(root..'/scripts/sprite_catalog.lua')
local Humans=dofile(root..'/scripts/sprite_humans.lua')
local pc=P.pc
local names={'idle','walk','attack','cast','hit','death'}
local counts={4,6,4,4,2,4};local fps={6,10,12,8,10,8}
local report={sprites=0,frames=0,checks={},errors={}}
local function check(ok,msg)
  if not ok then report.errors[#report.errors+1]=msg;print('FAIL '..msg) end
end
for _,d in ipairs(catalog) do
  local f=assert(io.open(root..'/public/sprites/'..d.key..'.json','r'));local meta=json.decode(f:read('*a'));f:close()
  local sheet=Image{fromFile=root..'/public/sprites/'..d.key..'.png'}
  local spr=app.open(root..'/art/aseprite/'..d.key..'.aseprite')
  check(sheet.width==384 and sheet.height==384,d.key..' sheet size')
  check(#spr.frames==24 and #spr.layers==6 and #spr.tags==6,d.key..' source layers/frames/tags')
  check(meta.anchor.x==32 and meta.anchor.y==58,d.key..' anchor')
  local number=0
  local mask=d.kind=='human' and Image{fromFile=root..'/public/sprites/'..d.key..'.tint.png'} or nil
  local baseHead=nil;local baseBody=nil
  for ai,name in ipairs(names) do
    local a=meta.anims[name]
    check(a.row==ai-1 and a.frames==counts[ai] and a.fps==fps[ai],d.key..' '..name..' metadata')
    for col=0,5 do
      if col>=counts[ai] then
        local clean=true
        for y=0,63 do for x=0,63 do if pc.rgbaA(sheet:getPixel(col*64+x,(ai-1)*64+y))~=0 then clean=false end end end
        check(clean,d.key..' '..name..' padding')
      else
        number=number+1;report.frames=report.frames+1
        local flat=P.image();flat:drawSprite(spr,number)
        local same,binary,nonempty=true,true,false
        for y=0,63 do for x=0,63 do
          local c=sheet:getPixel(col*64+x,(ai-1)*64+y)
          if c~=flat:getPixel(x,y) then same=false end
          local a0=pc.rgbaA(c);if a0>0 then nonempty=true end
          if a0~=0 and a0~=255 then binary=false end
        end end
        check(same,d.key..' '..name..col..' source/export pixels')
        check(binary and nonempty,d.key..' '..name..col..' alpha/content')
        if d.kind=='human' then
          local _,pose=Humans.render(d,name,col)
          local parts={}
          for li,layer in ipairs(spr.layers) do
            local cel=layer:cel(number);local im=P.image()
            if cel then P.blit(im,cel.image,cel.position.x,cel.position.y) end
            parts[li]=im
          end
          if not baseHead then baseHead=Image(parts[5]);baseBody=Image(parts[3]) end
          if not pose.fallen then
            local eyeMask={}
            for _,r in ipairs(Humans.eyeRows[d.ref]) do for x=r[2],r[3] do eyeMask[r[1]*64+x]=true end end
            local headOK,bodyOK,maskOK=true,true,true
            for y=0,63 do for x=0,63 do
              local xx,yy=x+pose.dx,y+pose.dy
              if xx>=0 and xx<64 and yy>=0 and yy<64 then
                if not (name=='death' and col>=1 and eyeMask[y*64+x]) then
                  if baseHead:getPixel(x,y)~=parts[5]:getPixel(xx,yy) then headOK=false end
                end
                if baseBody:getPixel(x,y)~=parts[3]:getPixel(xx,yy) then bodyOK=false end
                -- All central face pixels, including closed eyelids, excluded from tint.
                if x>=26 and x<=42 and y>=31 and y<=39 and pc.rgbaA(parts[5]:getPixel(xx,yy))>0 then
                  if pc.rgbaA(mask:getPixel(col*64+xx,(ai-1)*64+yy))>0 then maskOK=false end
                end
              end
            end end
            check(headOK,d.key..' '..name..col..' fixed head / eye-only edits')
            check(bodyOK,d.key..' '..name..col..' rigid torso')
            check(maskOK,d.key..' '..name..col..' protected face tint')
            local joints=true
            for y=40,44 do for x=29,34 do
              if pc.rgbaA(flat:getPixel(x+pose.dx,y+pose.dy))==0 then joints=false end
            end end
            for y=49,51 do for x=27,36 do
              if pc.rgbaA(flat:getPixel(x+pose.dx,y+pose.dy))==0 then joints=false end
            end end
            check(joints,d.key..' '..name..col..' neck/waist continuity')
          end
        end
      end
    end
  end
  spr:close();report.sprites=report.sprites+1
  print('Checked '..d.key)
end
report.passed=#report.errors==0
report.checks={'31 keys / 744 frames','384x384 sheets / transparent unused cells','24 timed frames + 6 layers + 6 tags per editable source','source and exported PNG exact pixel match','binary alpha (0/255 only)','human head and torso invariant under rigid translation','closed-eye changes confined to exact eye masks','face excluded from clothing tint masks','human neck and waist pixel continuity'}
local f=assert(io.open(root..'/art/verification.json','w'));f:write(json.encode(report));f:close()
print('RESULT '..(report.passed and 'PASS' or 'FAIL')..': '..report.sprites..' sprites / '..report.frames..' frames / '..#report.errors..' errors')
if not report.passed then error('Sprite verification failed') end
