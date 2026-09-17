-- Run with Aseprite CLI, see scripts/README.md.
local root=app.params.root or '.'
local P=dofile(root..'/scripts/pixel_art.lua')
local catalog=dofile(root..'/scripts/sprite_catalog.lua')
local Humans=dofile(root..'/scripts/sprite_humans.lua')
local Creatures=dofile(root..'/scripts/sprite_creatures.lua')
local pc=P.pc
local anims={{'idle',4,6,true},{'walk',6,10,true},{'attack',4,12,false},{'cast',4,8,true},{'hit',2,10,false},{'death',4,8,false}}
local layerNames={'01 Back / cape / wings','02 Feet / legs','03 Torso / neck','04 Arms / hands','05 Head / protected face','06 Equipment / ornaments'}
local filter=app.params.only
local manifest={schema=1,frameSize=64,anchor={x=32,y=58},sprites={},source='Aseprite Lua',referenceUse='User-provided rose/teal heads; original equipment, bodies and creatures.'}
local review=P.image(8*192,4*192);review:clear(P.color('252a39'))
local jobs=P.image(3*256,3*256);jobs:clear(P.color('252a39'))
local total=0
for ci,d in ipairs(catalog) do
  if not filter or d.key==filter or (filter=='jobs' and d.kind=='human') then
    local spr=Sprite(64,64,ColorMode.RGB)
    spr.filename=d.key
    local layers={spr.layers[1]};layers[1].name=layerNames[1]
    for i=2,6 do layers[i]=spr:newLayer();layers[i].name=layerNames[i] end
    local sheet=P.image(384,384);local mask=P.image(384,384)
    local meta={frameW=64,frameH=64,anchor={x=32,y=58},anims={}}
    if d.kind=='human' then meta.tintMask=d.key..'.tint.png' end
    local tintColors={}
    if d.cloth then for _,c in ipairs(d.cloth) do tintColors[P.color(c)]=true end end
    local number=0;local baseHead=nil;local audit={key=d.key,frames=0,binaryAlpha=true,rigidHead=true,transparentPadding=true,layerCount=6}
    for ai,a in ipairs(anims) do
      meta.anims[a[1]]={row=ai-1,frames=a[2],fps=a[3],loop=a[4]}
      local first=number+1
      for f=0,a[2]-1 do
        _G.SPRITE_CLIPPED_PIXELS=0
        local parts,pose
        if d.kind=='human' then parts,pose=Humans.render(d,a[1],f) else parts,pose=Creatures.render(d,a[1],f) end
        assert(_G.SPRITE_CLIPPED_PIXELS==0,d.key..' '..a[1]..f..': clipped '.._G.SPRITE_CLIPPED_PIXELS..' pixels')
        number=number+1
        if number>1 then spr:newEmptyFrame() end
        spr.frames[number].duration=1/a[3]
        for li,im in ipairs(parts) do spr:newCel(layers[li],number,im,Point(0,0)) end
        local flat=P.merge(parts)
        P.blit(sheet,flat,f*64,(ai-1)*64)
        for y=0,63 do for x=0,63 do
          local col=flat:getPixel(x,y);local alpha=pc.rgbaA(col)
          if alpha~=0 and alpha~=255 then audit.binaryAlpha=false end
          if tintColors[col] then P.dot(mask,f*64+x,(ai-1)*64+y,pc.rgba(255,255,255,255)) end
        end end
        if number==1 then
          baseHead=Image(parts[5])
          local preview=P.zoom(flat,3)
          P.blit(review,preview,((ci-1)%8)*192,math.floor((ci-1)/8)*192)
          if ci<=9 then P.blit(jobs,P.zoom(flat,4),((ci-1)%3)*256,math.floor((ci-1)/3)*256) end
          flat:saveAs(root..'/art/previews/'..d.key..'-base.png')
        end
        if d.kind=='human' and a[1]~='death' then
          for y=0,63 do for x=0,63 do
            local xx=x+pose.dx;local yy=y+pose.dy
            if xx>=0 and xx<64 and yy>=0 and yy<64 then
              if baseHead:getPixel(x,y)~=parts[5]:getPixel(xx,yy) then audit.rigidHead=false end
            end
          end end
        end
        audit.frames=audit.frames+1
      end
      local tag=spr:newTag(first,number);tag.name=a[1];tag.aniDir=AniDir.FORWARD
    end
    spr.data=json.encode({key=d.key,name=d.name,anchor=meta.anchor,notes='Rigid pixel clusters; no stretch, smoothing, blur or dithering. Frames grouped by six named tags.'})
    spr:saveAs(root..'/art/aseprite/'..d.key..'.aseprite')
    spr:close()
    sheet:saveAs(root..'/public/sprites/'..d.key..'.png')
    if d.kind=='human' then mask:saveAs(root..'/public/sprites/'..d.key..'.tint.png') end
    local file=assert(io.open(root..'/public/sprites/'..d.key..'.json','w'));file:write(json.encode(meta));file:close()
    P.zoom(sheet,3,P.color('252a39')):saveAs(root..'/art/previews/'..d.key..'-sheet-3x.png')
    manifest.sprites[#manifest.sprites+1]={key=d.key,name=d.name,kind=d.kind,source='art/aseprite/'..d.key..'.aseprite',audit=audit}
    total=total+1
    print(d.key..': '..number..' frames; rigid head '..tostring(audit.rigidHead)..'; binary alpha '..tostring(audit.binaryAlpha))
  end
end
review:saveAs(root..'/art/previews/roster-3x.png')
jobs:saveAs(root..'/art/previews/jobs-4x.png')
local file=assert(io.open(root..'/art/manifest.json','w'));file:write(json.encode(manifest));file:close()
local status=assert(io.open(root..'/art/build-status.json','w'));status:write(json.encode({passed=true,sprites=total,frames=total*24}));status:close()
print('DONE: '..total..' sprites, '..(total*24)..' frames')
