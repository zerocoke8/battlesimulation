-- docs/EFFECTS.md section 4, priorities 1 and 2. Confirm rings with effects:list.
local list={}
local priority=1
local function add(key,w,n,fps,blend,loop,ax,ay)
  list[#list+1]={key=key,priority=priority,meta={frameW=w,frameH=w,frames=n,fps=fps,blend=blend,loop=loop,anchor={x=ax or w/2,y=ay or w/2}}}
end
for _,s in ipairs({'fire','ice','lightning','holy','nature','shadow','phys'}) do add('impact_'..s,64,6,20,s=='phys' and 'normal' or 'add',false) end
add('proj_arrow',32,4,12,'normal',true)
add('proj_bullet',32,4,12,'add',true)
for _,s in ipairs({'fire','ice','lightning','holy','nature','shadow'}) do add('proj_orb_'..s,32,4,12,'add',true) end
for _,s in ipairs({'light','heavy','pierce'}) do add('slash_'..s,64,4,24,'normal',false,16,32) end
add('heal_burst',48,5,15,'add',false)
add('death_poof',64,5,12,'normal',false)
add('crit_star',32,4,20,'add',false)
priority=2
for _,s in ipairs({'fire','ice','lightning','holy','nature','shadow','phys'}) do
  add('cast_'..s,48,4,10,s=='phys' and 'normal' or 'add',true)
  list[#list].school=s;list[#list].kind='cast'
end
-- Current game-data combinations, verified with npm run effects:list (25).
local rings={{'fire',{30,35,40}},{'ice',{30,35,40,45}},{'lightning',{30,40}},
 {'holy',{30,40}},{'nature',{25,30}},{'shadow',{30,50}},
 {'phys',{25,30,35,40,50,60}},{'neutral',{35,40,45,50}}}
for _,group in ipairs(rings) do
  local s=group[1]
  for _,tag in ipairs(group[2]) do
    add('zone_ring_'..s..'_r'..tag,math.floor(tag*6.4+.5),4,8,(s=='phys' or s=='neutral') and 'normal' or 'add',true)
    list[#list].school=s;list[#list].kind='ring';list[#list].radius=tag/10
  end
end
for _,s in ipairs({'fire','ice','lightning','holy','nature','shadow','phys','neutral'}) do
  add('zone_fill_'..s,32,4,8,(s=='phys' or s=='neutral') and 'normal' or 'add',true,0,0)
  list[#list].school=s;list[#list].kind='tile'
end
return list
