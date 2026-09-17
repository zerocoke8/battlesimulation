-- docs/EFFECTS.md section 4, priority 1. Values are intentionally exact.
local list={}
local function add(key,w,n,fps,blend,loop,ax,ay)
  list[#list+1]={key=key,meta={frameW=w,frameH=w,frames=n,fps=fps,blend=blend,loop=loop,anchor={x=ax or w/2,y=ay or w/2}}}
end
for _,s in ipairs({'fire','ice','lightning','holy','nature','shadow','phys'}) do add('impact_'..s,64,6,20,s=='phys' and 'normal' or 'add',false) end
add('proj_arrow',32,4,12,'normal',true)
add('proj_bullet',32,4,12,'add',true)
for _,s in ipairs({'fire','ice','lightning','holy','nature','shadow'}) do add('proj_orb_'..s,32,4,12,'add',true) end
for _,s in ipairs({'light','heavy','pierce'}) do add('slash_'..s,64,4,24,'normal',false,16,32) end
add('heal_burst',48,5,15,'add',false)
add('death_poof',64,5,12,'normal',false)
add('crit_star',32,4,20,'add',false)
return list
