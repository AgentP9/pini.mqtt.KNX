/* Shared status indicators on subpages; dashboard owns its own socket and controls. */
(function(){'use strict';
 document.addEventListener('DOMContentLoaded',()=>{
  const knx=document.getElementById('knx-badge'),mqtt=document.getElementById('mqtt-badge');
  if(!knx||!mqtt||typeof io!=='function')return;
  const socket=io();
  socket.on('status',({service,connected})=>{
   const badge=service==='KNX'?knx:service==='MQTT'?mqtt:null;if(!badge)return;
   badge.className='badge rounded-pill badge-status '+(connected?'text-bg-success':'text-bg-danger')+(service==='MQTT'?' border-0':'');
   badge.title=service+': '+(connected?'Verbunden':'Getrennt')+(service==='MQTT'?' – klicken zum Neuverbinden':'');
   badge.setAttribute('aria-label',badge.title);
  });
  mqtt.addEventListener('click',()=>socket.emit('mqtt-restart'));
 });
})();
