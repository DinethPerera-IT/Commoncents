/* Shared accessible controls; passwords and visibility stay in the current DOM only. */
(() => {
let sequence=0;
const eye = hidden => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="'+(hidden?'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0':'m3 3 18 18M10 5c7-1 12 7 12 7s-2 3-5 5M7 7c-3 2-5 5-5 5s4 7 10 7c1 0 2 0 3-1')+'"/></svg>';
function enhance() {
 document.querySelectorAll('input[type=password]:not([data-password])').forEach(input=>{
  input.dataset.password='ready';input.autocomplete=input.id==='pwNew'?'new-password':'current-password';
  const wrap=document.createElement('div');wrap.className='password-control';input.before(wrap);wrap.append(input);
  const button=document.createElement('button');button.type='button';button.setAttribute('aria-label','Show password');button.setAttribute('aria-pressed','false');button.innerHTML=eye(true);
  button.onclick=()=>{const hidden=input.type==='password';const start=input.selectionStart,end=input.selectionEnd;input.type=hidden?'text':'password';button.setAttribute('aria-label',hidden?'Hide password':'Show password');button.setAttribute('aria-pressed',String(hidden));button.innerHTML=eye(!hidden);if(start!==null) input.setSelectionRange(start,end);};wrap.append(button);
 });
 document.querySelectorAll('.field').forEach(field=>{const label=field.querySelector('label'),input=field.querySelector('input,select,textarea');if(label&&input&&!label.htmlFor){input.id ||= 'control-'+(++sequence);label.htmlFor=input.id;}});
 document.querySelectorAll('.dialog-backdrop:not([data-focus])').forEach(backdrop=>{
  backdrop.dataset.focus='ready';const box=backdrop.querySelector('.dialog');if(!box)return;
  const previous=document.activeElement;document.getElementById('app').inert=true;box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.tabIndex=-1;
  const title=box.querySelector('.dialog-title');if(title){title.id='dialog-title-'+(++sequence);box.setAttribute('aria-labelledby',title.id);}
  const focusable=()=>[...box.querySelectorAll('button,input,select,textarea,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);
  const handler=e=>{if([...document.querySelectorAll('.dialog-backdrop')].at(-1)!==backdrop)return;if(e.key==='Escape'){e.preventDefault();backdrop.remove();}if(e.key==='Tab'){const items=focusable();const first=items[0],last=items.at(-1);if(!first){e.preventDefault();box.focus();}else if(e.shiftKey&&(document.activeElement===first||document.activeElement===box)){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
  document.addEventListener('keydown',handler);queueMicrotask(()=> (focusable()[0]||box).focus());
  const cleanup=new MutationObserver(()=>{if(!backdrop.isConnected){document.removeEventListener('keydown',handler);cleanup.disconnect();document.getElementById('app').inert=!!document.querySelector('.dialog-backdrop');if(previous?.isConnected)previous.focus();}});cleanup.observe(document.body,{childList:true});
 });
}
new MutationObserver(enhance).observe(document.getElementById('app').parentElement,{childList:true,subtree:true});enhance();
window.addEventListener('offline',()=>{if(!document.querySelector('.offline-note')){const n=document.createElement('div');n.className='cc-toast offline-note';n.setAttribute('role','status');n.textContent='You’re offline. Reconnect before saving changes.';document.body.append(n);}});
window.addEventListener('online',()=>document.querySelectorAll('.offline-note').forEach(n=>n.remove()));
})();
