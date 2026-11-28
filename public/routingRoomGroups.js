'use strict';
// UI-only room assignment: persisted routing is never changed.
function mqttRoutingRoomId(ref, devices, routes, {knxDeviceId=null,name=null}={}) {
 const byId=new Map(devices.map(d=>[d.id,d])), linkedRooms=new Set();
 for(const route of routes){
  if(![route.from,route.to].some(endpoint=>endpoint.type===ref.type&&endpoint.id===ref.id))continue;
  for(const endpoint of [route.from,route.to]){
   if(endpoint.type!=='device')continue;
   const device=byId.get(endpoint.id);
   if(device)linkedRooms.add(device.roomId||'unassigned');
  }
 }
 if(linkedRooms.size>1)return 'cross-room';
 if(linkedRooms.size===1)return [...linkedRooms][0];
 const explicit=byId.get(knxDeviceId);
 if(explicit)return explicit.roomId||'unassigned';
 // Fallback names must be unique; a guess here would misrepresent routing.
 const matches=devices.filter(d=>d.name===name);
 return matches.length===1?matches[0].roomId||'unassigned':'unassigned';
}
function groupRoutingCardsByRoom(cards,rooms){
 const sorted=[...rooms].sort((a,b)=>a.name.localeCompare(b.name,'de',{sensitivity:'base'}));
 const knownIds=new Set(sorted.map(room=>room.id)),keyed=new Map();
 for(const card of cards){
  const id=card.roomId==='cross-room'?'cross-room':knownIds.has(card.roomId)?card.roomId:'unassigned';
  if(!keyed.has(id))keyed.set(id,[]);
  keyed.get(id).push(card);
 }
 return [...sorted,{id:'cross-room',name:'Raumübergreifend'},{id:'unassigned',name:'Ohne Raum'}]
  .filter(room=>keyed.has(room.id)).map(room=>({id:room.id,name:room.name,
   cards:keyed.get(room.id).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'de',{sensitivity:'base'}))}));
}
if(typeof module!=='undefined'&&module.exports)module.exports={mqttRoutingRoomId,groupRoutingCardsByRoom};
