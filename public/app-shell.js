/* Shared theme, service worker and install controls. */
(function(){'use strict';
 const saved=localStorage.getItem('theme');
 if(saved==='light'||saved==='dark')document.documentElement.setAttribute('data-bs-theme',saved);
 else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-bs-theme','dark');
 if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(err=>console.warn('PWA registration failed:',err)));}
 let installPrompt=null;
 const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1);
 function showInstall(){const button=document.querySelector('[data-app-install]');if(button)button.hidden=isStandalone()||(!installPrompt&&!isIOS);}
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;showInstall();});
 window.addEventListener('appinstalled',()=>{installPrompt=null;showInstall();});
 document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-app-theme-toggle]').forEach(button=>button.addEventListener('click',()=>{const next=document.documentElement.getAttribute('data-bs-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-bs-theme',next);localStorage.setItem('theme',next)}));
  const actions=document.querySelector('.app-shell-actions');
  if(actions){const button=document.createElement('button');button.type='button';button.className='btn btn-sm';button.setAttribute('data-app-install','');button.hidden=true;button.title='Als App installieren';button.textContent='＋ App installieren';button.addEventListener('click',async()=>{if(installPrompt){const prompt=installPrompt;installPrompt=null;await prompt.prompt();await prompt.userChoice;showInstall();}else if(isIOS){alert('In Safari: Teilen → Zum Home-Bildschirm. Anschließend die App vom Home-Bildschirm starten.');}});actions.prepend(button);showInstall();}
  fetch('/build-info.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).then(info=>{
   if(!info||!info.branch||!/^[0-9a-f]{7,40}$/.test(info.shortSha)||!Number.isFinite(Date.parse(info.builtAt)))return;
   const footer=document.createElement('footer');
   footer.className='app-build-info small text-body-secondary text-center py-3';
   footer.setAttribute('aria-label','Build-Information');
   footer.textContent=`Build · ${info.branch} · ${info.shortSha} · ${new Date(info.builtAt).toLocaleString('de-DE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}`;
   document.body.appendChild(footer);
  }).catch(()=>{});
 });
})();
