'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {mqttRoutingRoomId,groupRoutingCardsByRoom}=require('../public/routingRoomGroups');
const html=fs.readFileSync(path.join(__dirname,'../public/routing.html'),'utf8');
test('five lanes retain independent corridors for KNX, logic and MQTT',()=>{
 const ids=['devices','connections-knx-logic','logic','connections-logic-mqtt','mqtt'];
 let prev=-1;
 for(const id of ids){const pos=html.indexOf('<section id="'+id+'"');assert.ok(pos>prev,'missing or unordered '+id);prev=pos;}
 assert.match(html,/grid-template-columns:minmax\(265px,1fr\) minmax\(135px,\.52fr\) minmax\(250px,\.94fr\) minmax\(135px,\.52fr\) minmax\(265px,1fr\)/);
 assert.match(html,/gutterRect\.left\+gutterRect\.width\/2/);
 assert.match(html,/groupedMarkup\(deviceCards\)/);
 assert.match(html,/groupedMarkup\(mqttCards\)/);
 assert.match(html,/min-width:1320px/);
});
test('KNX cards group alphabetically and keep unassigned devices separate',()=>{
 const cards=[{id:'a',name:'Flurlicht',roomId:'flur'},{id:'b',name:'Küche',roomId:'kitchen'},{id:'c',name:'Sensor',roomId:null},{id:'d',name:'Antrieb',roomId:'flur'}];
 const groups=groupRoutingCardsByRoom(cards,[{id:'kitchen',name:'Küche'},{id:'flur',name:'Flur'}]);
 assert.deepEqual(groups.map(g=>g.name),['Flur','Küche','Ohne Raum']);
 assert.deepEqual(groups[0].cards.map(c=>c.id),['d','a']);
});
test('MQTT group derives from KNX connections and detects cross-room devices',()=>{
 const devices=[{id:'k1',name:'Schalter',roomId:'flur'},{id:'k2',name:'Dimmer',roomId:'kitchen'}];
 const routes=[
 {from:{type:'device',id:'k1'},to:{type:'mqttDevice',id:'m1'}},
 {from:{type:'mqttDevice',id:'m2'},to:{type:'device',id:'k1'}},
 {from:{type:'mqttDevice',id:'m2'},to:{type:'device',id:'k2'}},
 {from:{type:'device',id:'k2'},to:{type:'mqtt',id:'e1'}}];
 assert.equal(mqttRoutingRoomId({type:'mqttDevice',id:'m1'},devices,routes),'flur');
 assert.equal(mqttRoutingRoomId({type:'mqttDevice',id:'m2'},devices,routes),'cross-room');
 assert.equal(mqttRoutingRoomId({type:'mqtt',id:'e1'},devices,routes),'kitchen');
 assert.equal(mqttRoutingRoomId({type:'mqtt',id:'other'},devices,routes),'unassigned');
});
test('unique name and explicit KNX mapping are fallbacks, never ambiguous guesses',()=>{
 const devices=[{id:'k1',name:'Sonos Bad',roomId:'bad'},{id:'k2',name:'Sonos Bad',roomId:'kitchen'},{id:'k3',name:'Schlafzimmer',roomId:'sleep'}];
 const ref={type:'mqttDevice',id:'m1'};
 assert.equal(mqttRoutingRoomId(ref,devices,[],{name:'Sonos Bad'}),'unassigned');
 assert.equal(mqttRoutingRoomId(ref,devices,[],{knxDeviceId:'k1',name:'Sonos Bad'}),'bad');
 assert.equal(mqttRoutingRoomId(ref,devices,[],{name:'Schlafzimmer'}),'sleep');
});
