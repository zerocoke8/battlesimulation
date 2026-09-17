-- Aseprite CLI: inspect the user-supplied 64px sources without interpolation.
local root = app.params.root or '.'
local a = app.params.rose
local b = app.params.teal
local pc = app.pixelColor
local out = Image(1024, 512, ColorMode.RGB)
out:clear(pc.rgba(31, 35, 47, 255))
for i, path in ipairs({a, b}) do
  local src = Image{fromFile=path}
  print(path .. ' ' .. src.width .. 'x' .. src.height)
  local alpha = {}
  for y=0,src.height-1 do for x=0,src.width-1 do
    local c=src:getPixel(x,y)
    alpha[pc.rgbaA(c)] = true
    if pc.rgbaA(c)>0 then
      for yy=0,7 do for xx=0,7 do
        out:drawPixel((i-1)*512+x*8+xx,y*8+yy,c)
      end end
    end
  end end
  local n=0; for _ in pairs(alpha) do n=n+1 end
  print('alpha values: '..n)
end
out:saveAs(root..'/art/previews/references-8x.png')
