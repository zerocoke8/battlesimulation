local pc=app.pixelColor
for _,name in ipairs({'rose','teal'}) do
  local im=Image{fromFile='art/references/'..name..'.png'}
  print(name)
  for y=28,38 do
    local row={}
    for x=23,44 do
      local c=im:getPixel(x,y)
      row[#row+1]=string.format('%d:%02x%02x%02x',x,pc.rgbaR(c),pc.rgbaG(c),pc.rgbaB(c))
    end
    print(y..' '..table.concat(row,' '))
  end
end
