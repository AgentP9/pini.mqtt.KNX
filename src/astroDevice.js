'use strict';
// Approximate solar altitude (NOAA fractional-year equations), UTC based.
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
function states(now,lat,lon,offsets={}) {
 const above=(key,threshold)=>altitude(new Date(now.getTime()-(offsets[key]||0)*60000),lat,lon)>=threshold;
 return {sunriseStart:above('sunriseStart',-0.833),sunriseEnd:above('sunriseEnd',-0.267),sunsetStart:!above('sunsetStart',-0.267),sunsetEnd:!above('sunsetEnd',-0.833),day:above('day',-0.833)};
}
class AstroDevice {
 constructor({devices,publish,env=process.env,now=()=>new Date()}) {
  this.devices=devices;this.publish=publish;this.now=now;this.last=new Map();
  this.lat=env.ASTRO_LATITUDE?.trim()?Number(env.ASTRO_LATITUDE):NaN;
  this.lon=env.ASTRO_LONGITUDE?.trim()?Number(env.ASTRO_LONGITUDE):NaN;
  this.valid=Number.isFinite(this.lat)&&Math.abs(this.lat)<=90&&Number.isFinite(this.lon)&&Math.abs(this.lon)<=180;
  this.offsets=Object.fromEntries(['sunriseStart','sunriseEnd','sunsetStart','sunsetEnd','day'].map(key=>{
   const name='ASTRO_'+key.replace(/[A-Z]/g,c=>'_'+c).toUpperCase()+'_OFFSET_MIN';
   const n=Number(env[name]||0);return [key,Number.isFinite(n)&&Math.abs(n)<=720?n:0];
  }));
 }
 tick(force=false) {
  if(!this.valid)return;
  const values=states(this.now(),this.lat,this.lon,this.offsets),seen=new Set();
  for(const device of this.devices().filter(d=>d.templateId==='astro'))for(const signal of device.signals){
   if(signal.enabled===false||!Object.hasOwn(values,signal.key))continue;
   const value=String(values[signal.key]);seen.add(signal.topic);
   if(force||this.last.get(signal.topic)!==value){
    if(this.publish(signal.topic,value)!==false)this.last.set(signal.topic,value);
   }
  }
  for(const topic of this.last.keys())if(!seen.has(topic))this.last.delete(topic);
 }
}
module.exports={AstroDevice,states,altitude};
