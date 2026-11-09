// Inline scripts shared with the Webflow site (same storage key, same loop), so the theme carries over
// between Probe's public pages and /app, and the logo gradient behaves identically.

export const THEME_SCRIPT = `(function(){
var r=document.documentElement,K='ziffer-theme',mq=window.matchMedia?matchMedia('(prefers-color-scheme: dark)'):null;
function s(){try{return localStorage.getItem(K)}catch(e){return null}}
function a(t){r.classList.toggle('theme-dark',t==='dark');r.style.colorScheme=t;
var b=document.querySelectorAll('[data-theme-toggle]');for(var i=0;i<b.length;i++)b[i].setAttribute('aria-pressed',t==='dark'?'true':'false')}
a(s()||(mq&&mq.matches?'dark':'light'));
window.zifferTheme={get:function(){return r.classList.contains('theme-dark')?'dark':'light'},
set:function(t){try{localStorage.setItem(K,t)}catch(e){}a(t)},toggle:function(){this.set(this.get()==='dark'?'light':'dark')}};
if(mq&&mq.addEventListener)mq.addEventListener('change',function(e){if(!s())a(e.matches?'dark':'light')});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-theme-toggle]');if(b){e.preventDefault();window.zifferTheme.toggle()}});
document.addEventListener('DOMContentLoaded',function(){a(window.zifferTheme.get())});
})();`;

