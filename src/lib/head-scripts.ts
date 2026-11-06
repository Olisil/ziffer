// Inline scripts shared with the Webflow site (same storage key, same loop), so the theme carries over
// between ziffer's public pages and /app, and the logo gradient behaves identically.

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

export const LOGO_LOOP_SCRIPT = `(function(){
var B=[-135.161,82.1532,-98.9879,-161.966,135.161,14.7581],CX=73.5,CY=61,P=24000;
var mq=window.matchMedia?matchMedia('(prefers-reduced-motion: reduce)'):null,raf=0,g=[];
function mul(a,b){return[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
function at(th){var c=Math.cos(th),s=Math.sin(th);return mul([c,s,-s,c,CX-c*CX+s*CY,CY-s*CX-c*CY],B);}
function set(th){var v='matrix('+at(th).map(function(n){return n.toFixed(3);}).join(' ')+')';for(var i=0;i<g.length;i++)g[i].setAttribute('gradientTransform',v);}
function tick(t){set((t%P)/P*6.283185307);raf=requestAnimationFrame(tick);}
function start(){cancelAnimationFrame(raf);g=document.querySelectorAll('[data-ziffer-grad]');if(!g.length)return;if(mq&&mq.matches){set(0);return;}raf=requestAnimationFrame(tick);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
if(mq&&mq.addEventListener)mq.addEventListener('change',start);
window.zifferLogo={refresh:start};
})();`;
