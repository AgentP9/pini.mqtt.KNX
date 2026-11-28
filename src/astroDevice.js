'use strict';
// Approximate solar altitude following NOAA fractional-year equations.
function altitude(date, lat, lon) {
 const rad=Math.PI/180, start=Date.UTC(date.getUTCFullYear(),0,1);
 const days=(date.getTime()-start)/86400000;
 const gamma=2*Math.PI/365*(days-0.5);
 const eq=229.18*(0.000075+0.001868*Math.cos(gamma)-0.032077*Math.sin(gamma)-0.014615*Math.cos(2*gamma)-0.040849*Math.sin(2*gamma));
 const dec=0.006918-0.399912*Math.cos(gamma)+0.070257*Math.sin(gamma)-0.006758*Math.cos(2*gamma)+0.000907*Math.sin(2*gamma)-0.002697*Math.cos(3*gamma)+0.00148*Math.sin(3*gamma);
 const minutes=date.getUTCHours()*60+date.getUTCMinutes()+date.getUTCSeconds()/60;
 const hour=(minutes+eq+4*lon)/4-180;
 return Math.asin(Math.sin(lat*rad)*Math.sin(dec)+Math.cos(lat*rad)*Math.cos(dec)*Math.cos(hour*rad))/rad;
}
const CHANNELS=Object.freeze([
 {key:'sunriseStart',label:'Sunrise Start'},
 {key:'sunriseEnd',label:'Sunrise End'},
 {key:'sunsetStart',label:'Sunset Start'},
 {key:'sunsetEnd',label:'Sunset End'},
 {key:'day',label:'Tag/Nacht'},
]);
function states(now,lat,lon,offsets={}) {
 const above=(key,threshold)=>altitude(new Date(now.getTime()-(offsets[key]||0)*60000),lat,lon)>=threshold;
 return {sunriseStart:above('sunriseStart',-0.833),sunriseEnd:above('sunriseEnd',-0.267),sunsetStart:!above('sunsetStart',-0.267),sunsetEnd:!above('sunsetEnd',-0.833),day:above('day',-0.833)};
}
class AstroDevice {
 constructor({blocks,emit=()=>{},onInactive=()=>{},onChange=()=>{},now=()=>new Date()}) {
  this.blocks=blocks;this.emit=emit;this.onInactive=onInactive;this.onChange=onChange;this.now=now;this.last=new Map();
 }
 snapshot() {
  const values={};
  for(const block of this.blocks()) {
   const channels={};
   for(const channel of CHANNELS) {
    const key=block.id+':'+channel.key;
    if(this.last.has(key))channels[channel.key]=this.last.get(key);
   }
   values[block.id]=channels;
  }
  return values;
 }
 tick(force=false) {
  const active=new Set(),now=this.now();let changed=false;
  for(const block of this.blocks()){
   if(!block.enabled||!Number.isFinite(block.latitude)||!Number.isFinite(block.longitude))continue;
   const values=states(now,block.latitude,block.longitude,block.offsets);
   for(const channel of CHANNELS) {
    const key=block.id+':'+channel.key,value=values[channel.key];
    active.add(key);
    if(force||this.last.get(key)!==value){
     this.last.set(key,value);
     this.emit(block.id,channel.key,value);
     changed=true;
    }
   }
  }
  for(const key of [...this.last.keys()])if(!active.has(key)){
   this.last.delete(key);const pos=key.lastIndexOf(':');this.onInactive(key.slice(0,pos),key.slice(pos+1));changed=true;
  }
  if(changed)this.onChange(this.snapshot());
 }
}
module.exports={AstroDevice,CHANNELS,states,altitude};
