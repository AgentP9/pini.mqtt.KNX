'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const RoutingStore=require('../src/routingStore');
const {AstroDevice,CHANNELS,states}=require('../src/astroDevice');

const readPage=()=>fs.readFileSync(path.join(__dirname,'../public/routing.html'),'utf8');
const astroBlock=(overrides={})=>({id:'astro-1',name:'Astro',enabled:true,latitude:48.28,longitude:10.08,offsets:{day:0},...overrides});
const fixture=()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'internal-astro-'));
 const gas=[{address:'1/0/8',dpt:'1.001'}];
 const devices=[{id:'knx-1',name:'Switch',templateId:'switch',addresses:{command:'1/0/8'}}];
 const deviceStore={file:path.join(dir,'devices.json'),devices,templates:()=>[{id:'switch',objects:[{key:'command',dpt:'1.001'}]}]};
 return {dir,gas,deviceStore,file:path.join(dir,'routing.json'),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
};
test('Astro is rendered as a draggable internal logic node, not an MQTT template',()=>{
 const page=readPage();
 assert.match(page,/id="open-astro"/);
 assert.match(page,/id="astro-form"/);
 assert.match(page,/const astroSignals=/);
 assert.match(page,/class="node logic-node astro-node"/);
 assert.match(page,/type:'astro'/);
 assert.match(page,/id="astro-latitude"/);
 assert.match(page,/id="astro-offset-day"/);
 assert.doesNotMatch(page,/<option value="astro">Astro-Device<\/option>/);
 assert.equal(CHANNELS.length,5);
});
test('sunrise/sunset output channels and day value are computed without MQTT',()=>{
 const noon=states(new Date('2026-06-21T12:00:00Z'),48.28,10.08);
 const night=states(new Date('2026-06-21T23:00:00Z'),48.28,10.08);
 assert.equal(noon.day,true);
 assert.equal(night.day,false);
 assert.equal(noon.sunriseStart,true);
 assert.equal(night.sunsetEnd,true);
 for(const channel of CHANNELS)assert.equal(typeof noon[channel.key],'boolean');
 const now=new Date('2026-06-21T06:00:00Z');
 assert.equal(states(now,48.28,10.08,{day:120}).day,states(new Date(now.getTime()-7200000),48.28,10.08).day);
});
test('internal astro emits initial states and state changes without repeatedly emitting unchanged values',()=>{
 let now=new Date('2026-06-21T12:00:00Z');
 const sent=[],changes=[];
 const astro=new AstroDevice({blocks:()=>[astroBlock()],now:()=>now,emit:(...args)=>sent.push(args),onChange:s=>changes.push(s)});
 astro.tick();assert.equal(sent.length,5);
 assert.equal(astro.snapshot()['astro-1'].day,true);
 astro.tick();assert.equal(sent.length,5);
 now=new Date('2026-06-21T23:00:00Z');astro.tick();
 assert.deepEqual(sent.filter(x=>x[1]==='day'),[['astro-1','day',true],['astro-1','day',false]]);
 assert.equal(astro.snapshot()['astro-1'].day,false);
 assert.equal(changes.length,2);
});
test('Astro blocks persist in routing configuration and can drive KNX or MQTT directly',()=>{
 const f=fixture();
 try{
  const store=new RoutingStore(f.deviceStore,f.gas,f.file);
  const a=astroBlock();
  const routes=[{id:'astro-knx',from:{type:'astro',id:a.id,signal:'day'},to:{type:'device',id:'knx-1',signal:'command'},enabled:true},
   {id:'astro-mqtt',from:{type:'astro',id:a.id,signal:'sunsetEnd'},to:{type:'mqtt',id:'m1'},enabled:true}];
  const endpoints=[{id:'m1',name:'Day',topic:'home/astro/output',payloadType:'boolean'}];
  store.save({astroBlocks:[a],mqttDevices:[],endpoints,routes});
  assert.equal(store.resolve(routes[0].from).type,'boolean');
  const reload=new RoutingStore(f.deviceStore,f.gas,f.file);
  assert.equal(reload.astroBlocks[0].latitude,48.28);
  assert.equal(reload.routes[1].from.type,'astro');
  assert.equal(reload.list().mqttDevices.length,0);
  assert.throws(()=>reload.save({...reload.list(),routes:[{id:'reverse',from:routes[0].to,to:routes[0].from,enabled:true}]}),/output ports only/);
  assert.throws(()=>reload.save({...reload.list(),astroBlocks:[astroBlock({latitude:99})]}),/Astro requires valid/);
 }finally{f.cleanup();}
});
test('legacy MQTT Astro source migrates to a disabled internal block awaiting coordinates',()=>{
 const f=fixture();
 try{
  const legacy={id:'legacy',name:'Old Astro',templateId:'astro',signals:[{key:'day',label:'Tag/Nacht',topic:'home/astro/day',payloadType:'boolean',direction:'output'}]};
  const raw={version:3,mqttDevices:[legacy],endpoints:[],routes:[{id:'old',from:{type:'mqttDevice',id:'legacy',signal:'day'},to:{type:'device',id:'knx-1',signal:'command'},enabled:true}]};
  fs.writeFileSync(f.file,JSON.stringify(raw));
  const store=new RoutingStore(f.deviceStore,f.gas,f.file);
  assert.equal(store.mqttDevices.length,0);
  assert.equal(store.astroBlocks[0].enabled,false);
  assert.equal(store.astroBlocks[0].latitude,null);
  assert.equal(store.routes[0].from.type,'astro');
  const persisted=JSON.parse(fs.readFileSync(f.file,'utf8'));
  assert.equal(persisted.routes[0].from.type,'astro');
 }finally{f.cleanup();}
});

test('disabling Astro invalidates previously published internal states',()=>{
 let enabled=true;
 const revoked=[];
 const astro=new AstroDevice({blocks:()=>[astroBlock({enabled})],now:()=>new Date('2026-06-21T12:00:00Z'),onInactive:(id,signal)=>revoked.push([id,signal])});
 astro.tick();enabled=false;astro.tick();
 assert.equal(revoked.length,5);
 assert.deepEqual(Object.keys(astro.snapshot()['astro-1']),[]);
});
