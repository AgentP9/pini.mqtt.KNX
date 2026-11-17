/* Offline-safe PWA: never cache live state, APIs, or editable pages. */
'use strict';
const VERSION='pini-knx-static-v2';
const STATIC=['/app-shell.css','/app-shell.js','/favicon.svg','/manifest.json','/offline.html'];
const ALLOWED=new Set(STATIC);
self.addEventListener('install',event=>{event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(STATIC)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('pini')&&key!==VERSION).map(key=>caches.delete(key)))),self.clients.claim()]));});
self.addEventListener('fetch',event=>{
 const req=event.request;if(req.method!=='GET')return;
 const url=new URL(req.url);if(url.origin!==self.location.origin)return;
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/socket.io/')||url.pathname==='/sw.js')return;
 if(req.mode==='navigate'){event.respondWith(fetch(req,{cache:'no-store'}).catch(()=>caches.match('/offline.html')));return;}
 if(!ALLOWED.has(url.pathname))return;
 event.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();event.waitUntil(caches.open(VERSION).then(cache=>cache.put(req,copy)));}return res;}).catch(()=>caches.match(req)));
});
