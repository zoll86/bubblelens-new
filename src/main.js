if(location.search.includes('debug=1')){
  const s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/npm/eruda';
  s.onload=()=>{eruda.init();console.log('🔍 Debug mód bekapcsolva');};
  document.head.appendChild(s);
}

/* unrar eltávolítva - CBR kezelést a libarchive.js végzi (lazy-load CDN-ről) */

// ══ ERROR HANDLER ══
window.onerror=(m,s,l)=>{
  if(m&&(m.includes('töltődött be')||m.includes('Content-Length')||m.includes('network')||m.includes('Failed to fetch')))return true;
  setSt('error','⚠ '+m+' ('+l+')');console.error(m,s,l);
};
window.onunhandledrejection=e=>{
  const msg=e.reason?.message||String(e.reason||'');
  const ignore=['töltődött be','not loaded','Content-Length','NetworkError','network','Failed to fetch','Load failed','corsproxy','deepl'];
  if(ignore.some(s=>msg.toLowerCase().includes(s.toLowerCase())))return;
  setSt('error','⚠ '+msg);console.error(e.reason);
};

// ══ LAZY SCRIPTS ══
function loadScript(u){return new Promise((r,j)=>{const s=document.createElement('script');s.src=u;s.onload=r;s.onerror=()=>j(new Error('Nem töltődött be: '+u));document.head.appendChild(s);});}
let _pdf=false,_arch=false;
async function rPdf(){if(_pdf)return;await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';_pdf=true;}
async function rArch(){
  // Beágyazott unrar.js + WASM — a fájl alján töltődik be, amikor a <script> lefut
  // Itt csak megvárjuk hogy a window._unrarCreate globális változó létrejöjjön
  if(window._unrarCreate)return;
  // Max 10 másodperc várakozás (általában azonnal kész)
  const start=Date.now();
  while(!window._unrarCreate&&Date.now()-start<10000){
    await new Promise(r=>setTimeout(r,50));
    if(window._unrarError)throw new Error('unrar bundle hiba: '+window._unrarError);
  }
  if(!window._unrarCreate)throw new Error('unrar bundle időtúllépés (10s)');
}

// ══ DOM REFS ══
const iwrap=document.getElementById('iwrap');
const cimg=document.getElementById('cimg');

// ══ STATE ══
let library=[];
let pages=[];
let cur=0;
let loading=false;
let selModel='claude-haiku-4-5';
let svc='claude';

// ════════════════════════════════════════════════════════════════════════════
// GEMINI INTEGRÁCIÓ — Google API mint olcsóbb alternatíva
// ════════════════════════════════════════════════════════════════════════════
// A Gemini API másik formátumot használ mint a Claude:
//   - Más URL: https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={KEY}
//   - Más kérés-szerkezet (contents tömb, parts: text + inline_data)
//   - Más válasz-formátum (candidates[0].content.parts[].text)
// Az API kulcs külön mező a beállításokban.
// 
// Modell-azonosítók (2026 áprilisi állapot):
//   - gemini-2.5-flash-lite   → legolcsóbb ($0.10/$0.40 per 1M tokens, ingyenes tier!)
//   - gemini-2.5-flash         → kiegyensúlyozott ($0.30/$2.50)
//   - gemini-2.5-pro           → legjobb ($1.25/$10)

const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];

// ════════════════════════════════════════════════════════════════════════════
// HIBRID PIPELINE — Gemini OCR + Claude SZÖVEG-fordítás
// ════════════════════════════════════════════════════════════════════════════
// Stratégia: a Gemini "látja" jól a képet (felismerés), de gyengén fordít magyarra.
// A Claude jó fordításban, de drága ha a képet is látnia kell.
// Megoldás: két lépésben:
//   1. Gemini kép → angol szöveg + pozíciók
//   2. Claude (Sonnet/Haiku) angol szöveg → magyar (kép nélkül)
// Költség: ~50-90% spórolás a Sonnet teljes pipeline-hoz képest.
//
// Modell-azonosítók (kombinált):
//   hybrid-flashlite-sonnet     → Flash-Lite OCR + Sonnet fordítás (legolcsóbb hibrid, 2 szelet)
//   hybrid-flashlite-haiku      → Flash-Lite OCR + Haiku fordítás (legolcsóbb)
//   hybrid-flash-sonnet         → Flash OCR + Sonnet fordítás (jobb OCR, hosszú buborékokra)
//   hybrid-flashlite-sonnet-x1  → Flash-Lite + Sonnet, EGY szelet (nincs darabolás → nincs vágási hiba)

const HYBRID_MODELS = ['hybrid-flashlite-sonnet', 'hybrid-flashlite-haiku', 'hybrid-flash-sonnet', 'hybrid-flashlite-sonnet-x1'];

function isHybridModel(modelStr){
  return modelStr && modelStr.startsWith('hybrid-');
}

// 1 szeletes módot felismerő helper — ezekre nem alkalmazzuk a szeletelést
function isHybridSingleSlice(modelStr){
  return modelStr === 'hybrid-flashlite-sonnet-x1';
}

// Egy hibrid modellt szétbontunk: melyik OCR-modell, melyik fordító-modell?
function _hybridParts(modelStr){
  if(modelStr === 'hybrid-flashlite-sonnet'){
    return {ocr:'gemini-2.5-flash-lite', tr:'claude-sonnet-4-6', label:'Flash-Lite + Sonnet'};
  }
  if(modelStr === 'hybrid-flashlite-haiku'){
    return {ocr:'gemini-2.5-flash-lite', tr:'claude-haiku-4-5', label:'Flash-Lite + Haiku'};
  }
  if(modelStr === 'hybrid-flash-sonnet'){
    return {ocr:'gemini-2.5-flash', tr:'claude-sonnet-4-6', label:'Flash + Sonnet'};
  }
  if(modelStr === 'hybrid-flashlite-sonnet-x1'){
    return {ocr:'gemini-2.5-flash-lite', tr:'claude-sonnet-4-6', label:'Flash-Lite + Sonnet (1 szelet)'};
  }
  return null;
}

function isGeminiModel(modelStr){
  return modelStr && modelStr.startsWith('gemini-');
}
function getProvider(modelStr){
  if(isHybridModel(modelStr)) return 'hybrid';
  return isGeminiModel(modelStr) ? 'gemini' : 'claude';
}
function _modelLetterForGemini(modelStr){
  if(modelStr.includes('flash-lite')) return 'G';   // alap, olcsó, zöld
  if(modelStr.includes('flash'))      return 'g';   // közepes, halvány zöld
  if(modelStr.includes('pro'))        return 'P';   // legjobb, kék
  return '?';
}
let rtlMode=false;
let peekMode=true;
let pinching=false; // pinch zoom állapot (globális scope)
let projName='kepregeny';
let zoomed=false;
let curBookKey=null;
const ZSCALE=2.8;
let currentScale=1.0; // aktív zoom szint (pinch alapján)
let panX=0,panY=0;
let isPan=false,panPid=null,panSX=0,panSY=0,panBX=0,panBY=0;
// ══ INIT ══

// IndexedDB könyvtár-cache: ha elérhető, a könyvek bájtjai itt tárolódnak
// → legközelebb mappa választás nélkül is megnyithatók
let useIDB=false;
let _idb=null;
async function tryOpenIDB(){
  return new Promise(resolve=>{
    try{
      const req=indexedDB.open('bubblelens-cache',1);
      req.onupgradeneeded=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains('files'))db.createObjectStore('files');
      };
      req.onsuccess=e=>{_idb=e.target.result;resolve(true);};
      req.onerror=()=>resolve(false);
      req.onblocked=()=>resolve(false);
      setTimeout(()=>resolve(false),2000); // timeout
    }catch(e){resolve(false);}
  });
}
function idbPut(key,value){
  // Android módban a virtuális fájl-objektumok függvényeket tartalmaznak,
  // ami nem klónozható az IndexedDB-be. Az Android HTTP szerver amúgy is
  // gyors hozzáférést biztosít, nincs szükség IDB cache-re.
  if(typeof isAndroidApp==='function'&&isAndroidApp()){
    return Promise.resolve();
  }
  return new Promise((r,j)=>{const t=_idb.transaction('files','readwrite');t.objectStore('files').put(value,key);t.oncomplete=()=>r();t.onerror=()=>j(t.error);});
}
function idbGet(key){
  if(typeof isAndroidApp==='function'&&isAndroidApp()){
    return Promise.resolve(null);
  }
  return new Promise((r,j)=>{const t=_idb.transaction('files','readonly');const q=t.objectStore('files').get(key);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
}
function idbDel(key){
  if(typeof isAndroidApp==='function'&&isAndroidApp()){
    return Promise.resolve();
  }
  return new Promise((r,j)=>{const t=_idb.transaction('files','readwrite');t.objectStore('files').delete(key);t.oncomplete=()=>r();t.onerror=()=>j(t.error);});
}

// ════════════════════════════════════════════════════════════════════════════
// IDB-TRANS — Fordítások tárolása IndexedDB-ben (lap-szintű kulcsozással)
// ════════════════════════════════════════════════════════════════════════════
// A localStorage 5-10 MB korláta nem elég sok képregény fordításához.
// Az IDB-ben gyakorlatban gigabájtokat tárolhatunk.
// Lap-szintű kulcsozás: `{bookKey}::{pageIdx}` → {bubbles: [...]}.
// Ez azt jelenti hogy lapváltáskor csak EGY rekordot írunk, nem az egész könyvet.

let _idbTrans = null;
let _idbTransReady = false;

async function tryOpenIDBTrans(){
  return new Promise(resolve=>{
    try{
      const req = indexedDB.open('bubblelens-trans', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
      };
      req.onsuccess = e => { _idbTrans = e.target.result; _idbTransReady = true; resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    }catch(e){ resolve(false); }
  });
}

// Egy lap fordításának elmentése. A kulcs: `bookKey::pageIdx`.
function idbTransPut(bookKey, pageIdx, bubbles){
  if(!_idbTransReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try{
      const t = _idbTrans.transaction('pages', 'readwrite');
      const store = t.objectStore('pages');
      const key = bookKey + '::' + pageIdx;
      if(bubbles && bubbles.length){
        store.put({bookKey, pageIdx, bubbles, savedAt: Date.now()}, key);
      }else{
        store.delete(key);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }catch(e){ resolve(); /* csendes hiba */ }
  });
}

// Egy könyv ÖSSZES lapjának fordítását visszaadja egy tömbbé
// formátumban: [bubbles_lap0, bubbles_lap1, ...] — null ahol nincs fordítás
async function idbTransLoadBook(bookKey, pageCount){
  if(!_idbTransReady) return null;
  return new Promise((resolve) => {
    try{
      const t = _idbTrans.transaction('pages', 'readonly');
      const store = t.objectStore('pages');
      const result = new Array(pageCount).fill(null);
      const range = IDBKeyRange.bound(bookKey + '::', bookKey + '::\uffff');
      const req = store.openCursor(range);
      req.onsuccess = e => {
        const cursor = e.target.result;
        if(cursor){
          const v = cursor.value;
          if(v && v.pageIdx < pageCount && v.bubbles && v.bubbles.length){
            result[v.pageIdx] = v.bubbles;
          }
          cursor.continue();
        }else{
          // Készen vagyunk; ellenőrizzük van-e bármilyen találat
          const hasAny = result.some(p => p && p.length);
          resolve(hasAny ? result : null);
        }
      };
      req.onerror = () => resolve(null);
    }catch(e){ resolve(null); }
  });
}

// Egy könyv összes fordításának törlése (ha kell)
async function idbTransDeleteBook(bookKey){
  if(!_idbTransReady) return;
  return new Promise((resolve) => {
    try{
      const t = _idbTrans.transaction('pages', 'readwrite');
      const store = t.objectStore('pages');
      const range = IDBKeyRange.bound(bookKey + '::', bookKey + '::\uffff');
      store.delete(range);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    }catch(e){ resolve(); }
  });
}

// Egyszeri migráció: minden `*_trans` localStorage kulcsot átköltöztet IDB-be.
// Csendes — csak konzol-üzenetet ad, nincs popup, csak ha tényleg hiba van.
async function migrateLocalStorageToIDB(){
  if(!_idbTransReady) return;
  // Lokális flag hogy ne fussunk újra
  if(localStorage.getItem('bl_trans_migrated_v1') === '1') return;

  const transKeys = [];
  for(let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if(k && k.endsWith('_trans')) transKeys.push(k);
  }
  if(!transKeys.length){
    // Nincs mit migrálni; jelöljük kész-nek
    localStorage.setItem('bl_trans_migrated_v1', '1');
    return;
  }

  console.log(`[IDB-migrate] ${transKeys.length} könyv fordítása költözik IDB-be...`);
  let migratedBooks = 0, migratedPages = 0;
  for(const transKey of transKeys){
    const bookKey = transKey.replace(/_trans$/, '');
    try{
      const raw = localStorage.getItem(transKey);
      if(!raw) continue;
      const data = JSON.parse(raw);
      if(!data || !Array.isArray(data.pages)) continue;
      let pageCount = 0;
      for(let i = 0; i < data.pages.length; i++){
        const p = data.pages[i];
        if(p && Array.isArray(p) && p.length){
          await idbTransPut(bookKey, i, p);
          pageCount++;
        }
      }
      if(pageCount > 0){
        // Csak akkor töröljük localStorage-ből, ha sikerült mentenünk IDB-be
        localStorage.removeItem(transKey);
        migratedBooks++;
        migratedPages += pageCount;
      }
    }catch(e){
      console.warn(`[IDB-migrate] hiba ${transKey}:`, e.message);
    }
  }
  console.log(`[IDB-migrate] ✓ Kész: ${migratedBooks} könyv, ${migratedPages} lap`);
  localStorage.setItem('bl_trans_migrated_v1', '1');
}

// ══ TÉMA VÁLTÁS ══
// Érvényes értékek a kf_theme-ben: 'sunset-dark' (alap), 'sunset-light', 'ocean', 'forest', 'violet', 'coffee', 'beach', 'parchment', 'mint'
const THEMES = {
  'sunset-dark':    {mode:'dark',  cls:null,               label:'🌅 Naplemente',       meta:'#4d1e2a'},
  'sunset-light':   {mode:'light', cls:null,               label:'☀️ Naplemente világos', meta:'#ffcfa0'},
  'ocean':          {mode:'dark',  cls:'theme-ocean',      label:'🌊 Óceán',            meta:'#143050'},
  'forest':         {mode:'dark',  cls:'theme-forest',     label:'🌲 Erdő',             meta:'#2a4533'},
  'violet':         {mode:'dark',  cls:'theme-violet',     label:'🌌 Ibolya éjjel',     meta:'#3a2050'},
  'coffee':         {mode:'dark',  cls:'theme-coffee',     label:'☕ Kávéház',          meta:'#3d2a1f'},
  'midnight':       {mode:'dark',  cls:'theme-midnight',   label:'🌃 Éjfél',            meta:'#0a0510'},
  'cyberpunk':      {mode:'dark',  cls:'theme-cyberpunk',  label:'🎮 Cyberpunk',        meta:'#1a1a33'},
  'wine':           {mode:'dark',  cls:'theme-wine',       label:'🍷 Bor',              meta:'#4a1028'},
  'hellfire':       {mode:'dark',  cls:'theme-hellfire',   label:'🔥 Pokoltűz',         meta:'#1f0a0a'},
  'nordic':         {mode:'dark',  cls:'theme-nordic',     label:'🌙 Nordikus',         meta:'#272b33'},
  'retro80':        {mode:'dark',  cls:'theme-retro80',    label:'⚡ Retro 80s',        meta:'#2d0055'},
  'terminal':       {mode:'dark',  cls:'theme-terminal',   label:'💻 Terminál',         meta:'#0a140a'},
  'halloween':      {mode:'dark',  cls:'theme-halloween',  label:'🎃 Halloween',        meta:'#1f0a14'},
  'christmas':      {mode:'dark',  cls:'theme-christmas',  label:'🎄 Karácsony',        meta:'#1a4030'},
  'beach':          {mode:'light', cls:'theme-beach',      label:'🏖️ Tengerpart',        meta:'#b3d4e8'},
  'parchment':      {mode:'light', cls:'theme-parchment',  label:'📜 Pergamen',         meta:'#d9c080'},
  'mint':           {mode:'light', cls:'theme-mint',       label:'🌿 Menta',            meta:'#a0d0b5'},
  'cloud':          {mode:'light', cls:'theme-cloud',      label:'☁️ Felhő',             meta:'#ccd8e3'},
  'spring':         {mode:'light', cls:'theme-spring',     label:'🌷 Tavasz',           meta:'#ffc0d4'},
  'farm':           {mode:'light', cls:'theme-farm',       label:'🌾 Mezőgazdaság',     meta:'#ccb580'},
  'oldbook':        {mode:'light', cls:'theme-oldbook',    label:'📔 Régi könyv',       meta:'#ccc098'},
  'breakfast':      {mode:'light', cls:'theme-breakfast',  label:'🥐 Reggeli',          meta:'#e0c888'},
  'sepia':          {mode:'light', cls:'theme-sepia',      label:'📖 Sepia (e-book)',   meta:'#d0c090'},
};
function applyTheme(name){
  if(!THEMES[name]) name='sunset-dark';
  const t=THEMES[name];
  const body=document.body;
  // particles-off osztály megtartása ha be van állítva
  const wantParticles=!body.classList.contains('particles-off');
  body.className=body.className.split(/\s+/).filter(c=>c&&!c.startsWith('theme-')&&c!=='light'&&c!=='particles-off').join(' ');
  if(t.mode==='light') body.classList.add('light');
  if(t.cls) body.classList.add(t.cls);
  if(!wantParticles) body.classList.add('particles-off');
  const btn=document.getElementById('btn-theme');
  if(btn) btn.textContent = t.mode==='light'?'☀️':'🌙';
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content',t.meta);
  document.querySelectorAll('.theme-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.theme===name);
  });
  // Részecske-rendszer újraindítása az új témával
  if(typeof startParticles==='function') startParticles(name);
}

// ✨════════ RÉSZECSKE-RENDSZER ════════✨
// 24 témához egyedi háttér-részecskék canvas-en
const PARTICLE_CONFIGS = {
  'sunset-dark':  {type:'embers',  count:55, colors:['#ff6b35','#ffaa66','#ffd166']},
  'sunset-light': {type:'embers',  count:45, colors:['#e55a20','#ff9558','#d9a930']},
  'ocean':        {type:'bubbles', count:45, colors:['#00bfff','#4fd4ff','#06d6a0']},
  'forest':       {type:'leaves',  count:40, colors:['#c9954a','#6ad76a','#e8c547']},
  'violet':       {type:'stars',   count:80, colors:['#ff6bcb','#ff8fd9','#06d6a0']},
  'coffee':       {type:'steam',   count:25, colors:['#d4a574','#e8c298','#f0e6d2']},
  'midnight':     {type:'stars',   count:90, colors:['#b85cff','#d48fff','#00ffaa']},
  'cyberpunk':    {type:'sparks',  count:60, colors:['#ff0080','#00ffff','#ffee00']},
  'wine':         {type:'gold',    count:50, colors:['#d4a04a','#e8bf66','#f0d060']},
  'hellfire':     {type:'fire',    count:65, colors:['#ff4500','#ff6b33','#ffaa00']},
  'nordic':       {type:'snow',    count:70, colors:['#ffffff','#e0eaf5','#7fc3db']},
  'retro80':      {type:'grid',    count:50, colors:['#ff006e','#00fff0','#ffee00']},
  'terminal':     {type:'matrix',  count:50, colors:['#00ff00','#55ff55','#00ffaa']},
  'halloween':    {type:'bats',    count:25, colors:['#ff7518','#8b44ab','#ffcc00']},
  'christmas':    {type:'snow',    count:90, colors:['#ffffff','#f5e8cc','#d4a04a']},
  'beach':        {type:'bubbles', count:40, colors:['#2980b9','#4a9bcc','#88c0e0']},
  'parchment':    {type:'dust',    count:40, colors:['#a0603d','#c27a50','#d9a930']},
  'mint':         {type:'leaves',  count:40, colors:['#2d9966','#4fb888','#88c070']},
  'cloud':        {type:'clouds',  count:20, colors:['#ffffff','#dde5ee','#ccd8e3']},
  'spring':       {type:'petals',  count:50, colors:['#e66e9a','#f090b8','#88c070']},
  'farm':         {type:'wheat',   count:40, colors:['#b8663d','#d48858','#a88730']},
  'oldbook':      {type:'dust',    count:35, colors:['#6b4226','#8a5a38','#a88730']},
  'breakfast':    {type:'crumbs',  count:40, colors:['#c08030','#d89a50','#e8c547']},
  'sepia':        {type:'dust',    count:30, colors:['#8b4513','#a85a28','#b08830']},
};

let _particles=[];
let _particleAnim=null;
let _particleType='stars';
let _particleColors=['#ffffff'];
let _particleCanvas=null;
let _particleCtx=null;

function _initCanvas(){
  if(_particleCanvas)return;
  _particleCanvas=document.getElementById('particle-canvas');
  if(!_particleCanvas)return;
  _particleCtx=_particleCanvas.getContext('2d');
  const resize=()=>{
    _particleCanvas.width=window.innerWidth*window.devicePixelRatio;
    _particleCanvas.height=window.innerHeight*window.devicePixelRatio;
    _particleCanvas.style.width=window.innerWidth+'px';
    _particleCanvas.style.height=window.innerHeight+'px';
    _particleCtx.scale(window.devicePixelRatio,window.devicePixelRatio);
  };
  resize();
  window.addEventListener('resize',()=>{
    _particleCtx.setTransform(1,0,0,1,0,0);
    resize();
  });
}

function _makeParticle(type,W,H){
  const p={x:Math.random()*W,y:Math.random()*H};
  switch(type){
    case 'embers':
      p.vx=(Math.random()-.5)*.3;p.vy=-Math.random()*1.5-.5;
      p.size=Math.random()*2.5+1;p.life=Math.random()*100+50;p.maxLife=p.life;
      p.y=H+10;
      break;
    case 'bubbles':
      p.vx=(Math.random()-.5)*.4;p.vy=-Math.random()*1.2-.3;
      p.size=Math.random()*4+2;p.life=200;p.maxLife=200;
      p.y=H+10;
      break;
    case 'leaves':
      p.vx=(Math.random()-.5)*1.2;p.vy=Math.random()*1+.4;
      p.size=Math.random()*4+3;p.rotation=Math.random()*360;p.rotSpeed=(Math.random()-.5)*4;
      p.y=-10;p.life=300;p.maxLife=300;
      break;
    case 'stars':
      p.vx=0;p.vy=0;p.size=Math.random()*1.8+.5;
      p.twinkle=Math.random()*Math.PI*2;p.twinkleSpeed=Math.random()*.04+.01;
      p.life=Infinity;
      break;
    case 'steam':
      p.vx=(Math.random()-.5)*.2;p.vy=-Math.random()*.8-.3;
      p.size=Math.random()*15+10;p.life=Math.random()*150+80;p.maxLife=p.life;
      p.y=H+20;
      break;
    case 'sparks':
      p.vx=(Math.random()-.5)*3;p.vy=(Math.random()-.5)*3;
      p.size=Math.random()*1.5+.5;p.life=Math.random()*40+20;p.maxLife=p.life;
      break;
    case 'gold':
      p.vx=(Math.random()-.5)*.5;p.vy=Math.random()*.5+.2;
      p.size=Math.random()*1.5+.5;p.life=300;p.maxLife=300;
      p.y=-10;
      break;
    case 'fire':
      p.vx=(Math.random()-.5)*.6;p.vy=-Math.random()*2-.8;
      p.size=Math.random()*4+2;p.life=Math.random()*60+30;p.maxLife=p.life;
      p.y=H+10;
      break;
    case 'snow':
      p.vx=(Math.random()-.5)*.6;p.vy=Math.random()*1+.3;
      p.size=Math.random()*3+1.5;p.life=400;p.maxLife=400;
      p.y=-10;p.swing=Math.random()*Math.PI*2;p.swingSpeed=.02;
      break;
    case 'grid':
      p.vx=0;p.vy=0;p.size=Math.random()*2+1;p.life=Infinity;
      p.pulse=Math.random()*Math.PI*2;p.pulseSpeed=.03;
      break;
    case 'matrix':
      p.vx=0;p.vy=Math.random()*2+1;
      p.size=12;p.char=Math.random()<.5?'1':'0';p.life=Infinity;
      p.y=-20;
      break;
    case 'bats':
      p.vx=(Math.random()-.5)*1.5;p.vy=(Math.random()-.5)*1;
      p.size=Math.random()*8+8;p.life=Infinity;p.flap=0;p.flapSpeed=.15;
      break;
    case 'dust':
      p.vx=(Math.random()-.5)*.4;p.vy=Math.random()*.3+.05;
      p.size=Math.random()*1.2+.3;p.life=500;p.maxLife=500;
      p.y=-10;
      break;
    case 'clouds':
      p.vx=Math.random()*.3+.1;p.vy=0;
      p.size=Math.random()*40+30;p.life=Infinity;
      break;
    case 'petals':
      p.vx=(Math.random()-.5)*.8;p.vy=Math.random()*.8+.3;
      p.size=Math.random()*3+2;p.rotation=Math.random()*360;p.rotSpeed=(Math.random()-.5)*3;
      p.y=-10;p.life=400;p.maxLife=400;
      break;
    case 'wheat':
      p.vx=Math.random()*.5+.2;p.vy=Math.random()*.3+.1;
      p.size=Math.random()*1.5+.5;p.life=400;p.maxLife=400;
      p.y=-10;
      break;
    case 'crumbs':
      p.vx=(Math.random()-.5)*.3;p.vy=Math.random()*.5+.2;
      p.size=Math.random()*2+1;p.life=400;p.maxLife=400;
      p.y=-10;
      break;
  }
  p.color=_particleColors[Math.floor(Math.random()*_particleColors.length)];
  return p;
}

function _drawParticle(ctx,p){
  const W=window.innerWidth,H=window.innerHeight;
  let alpha=1;
  if(p.maxLife&&p.maxLife!==Infinity){
    alpha=Math.min(1,p.life/p.maxLife);
    if(p.life<p.maxLife*.3)alpha=p.life/(p.maxLife*.3);
  }
  ctx.save();
  switch(_particleType){
    case 'embers': case 'fire':
      ctx.globalAlpha=alpha*.8;
      const grad=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*3);
      grad.addColorStop(0,p.color);grad.addColorStop(1,'transparent');
      ctx.fillStyle=grad;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size*3,0,Math.PI*2);ctx.fill();
      break;
    case 'bubbles':
      ctx.globalAlpha=alpha*.6;
      ctx.strokeStyle=p.color;ctx.lineWidth=1;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.stroke();
      break;
    case 'leaves': case 'petals':
      ctx.globalAlpha=alpha*.7;
      ctx.translate(p.x,p.y);ctx.rotate(p.rotation*Math.PI/180);
      ctx.fillStyle=p.color;
      ctx.beginPath();ctx.ellipse(0,0,p.size,p.size*.6,0,0,Math.PI*2);ctx.fill();
      break;
    case 'stars':
      const tw=Math.sin(p.twinkle)*.5+.5;
      ctx.globalAlpha=tw*.9;ctx.fillStyle=p.color;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      // Halo
      ctx.globalAlpha=tw*.3;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size*2.5,0,Math.PI*2);ctx.fill();
      break;
    case 'steam':
      ctx.globalAlpha=alpha*.15;
      const sg=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size);
      sg.addColorStop(0,p.color);sg.addColorStop(1,'transparent');
      ctx.fillStyle=sg;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      break;
    case 'sparks':
      ctx.globalAlpha=alpha;
      ctx.shadowColor=p.color;ctx.shadowBlur=8;
      ctx.fillStyle=p.color;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      break;
    case 'gold': case 'wheat': case 'crumbs':
      ctx.globalAlpha=alpha*.7;ctx.fillStyle=p.color;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      break;
    case 'snow':
      ctx.globalAlpha=alpha*.85;ctx.fillStyle=p.color;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      // Hópihe részletek
      if(p.size>2){
        ctx.globalAlpha=alpha*.5;
        ctx.beginPath();ctx.arc(p.x,p.y,p.size*1.6,0,Math.PI*2);ctx.fill();
      }
      break;
    case 'grid':
      const pulse=Math.sin(p.pulse)*.4+.6;
      ctx.globalAlpha=pulse*.8;ctx.fillStyle=p.color;
      ctx.shadowColor=p.color;ctx.shadowBlur=6;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      break;
    case 'matrix':
      ctx.globalAlpha=.7;ctx.fillStyle=p.color;
      ctx.font='bold 12px monospace';ctx.shadowColor=p.color;ctx.shadowBlur=4;
      ctx.fillText(p.char,p.x,p.y);
      break;
    case 'bats':
      ctx.globalAlpha=.55;ctx.fillStyle=p.color;
      ctx.translate(p.x,p.y);
      const flap=Math.sin(p.flap)*.4+.6;
      // Egyszerű denevér ikon
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.bezierCurveTo(-p.size*flap,-p.size*.3,-p.size*1.5,-p.size*.2,-p.size*1.5,p.size*.2);
      ctx.bezierCurveTo(-p.size,p.size*.1,-p.size*.5,p.size*.15,0,p.size*.15);
      ctx.bezierCurveTo(p.size*.5,p.size*.15,p.size,p.size*.1,p.size*1.5,p.size*.2);
      ctx.bezierCurveTo(p.size*1.5,-p.size*.2,p.size*flap,-p.size*.3,0,0);
      ctx.fill();
      break;
    case 'dust':
      ctx.globalAlpha=alpha*.5;ctx.fillStyle=p.color;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      break;
    case 'clouds':
      ctx.globalAlpha=.18;
      const cg=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size);
      cg.addColorStop(0,p.color);cg.addColorStop(.7,p.color);cg.addColorStop(1,'transparent');
      ctx.fillStyle=cg;
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();
      break;
  }
  ctx.restore();
}

function _updateParticle(p){
  const W=window.innerWidth,H=window.innerHeight;
  switch(_particleType){
    case 'snow':
      p.swing+=p.swingSpeed;
      p.x+=p.vx+Math.sin(p.swing)*.5;p.y+=p.vy;
      if(p.y>H+10)Object.assign(p,_makeParticle(_particleType,W,H),{y:-10});
      if(p.x>W+10)p.x=-10;if(p.x<-10)p.x=W+10;
      break;
    case 'leaves': case 'petals':
      p.x+=p.vx;p.y+=p.vy;p.rotation+=p.rotSpeed;
      if(p.y>H+10)Object.assign(p,_makeParticle(_particleType,W,H));
      break;
    case 'embers': case 'fire': case 'steam':
      p.x+=p.vx;p.y+=p.vy;p.life--;
      if(p.life<=0||p.y<-30)Object.assign(p,_makeParticle(_particleType,W,H));
      break;
    case 'bubbles':
      p.x+=p.vx;p.y+=p.vy;
      if(p.y<-10)Object.assign(p,_makeParticle(_particleType,W,H));
      break;
    case 'stars':
      p.twinkle+=p.twinkleSpeed;
      break;
    case 'sparks':
      p.x+=p.vx;p.y+=p.vy;p.life--;
      if(p.life<=0)Object.assign(p,_makeParticle(_particleType,W,H));
      break;
    case 'gold': case 'wheat': case 'crumbs': case 'dust':
      p.x+=p.vx;p.y+=p.vy;p.life--;
      if(p.life<=0||p.y>H+10){Object.assign(p,_makeParticle(_particleType,W,H));p.y=-10;}
      break;
    case 'grid':
      p.pulse+=p.pulseSpeed;
      break;
    case 'matrix':
      p.y+=p.vy;
      if(p.y>H+20){p.y=-20;p.x=Math.random()*W;p.char=Math.random()<.5?'1':'0';}
      break;
    case 'bats':
      p.x+=p.vx;p.y+=p.vy;p.flap+=p.flapSpeed;
      if(p.x>W+30)p.x=-30;if(p.x<-30)p.x=W+30;
      if(p.y>H+30)p.y=-30;if(p.y<-30)p.y=H+30;
      break;
    case 'clouds':
      p.x+=p.vx;
      if(p.x>W+p.size)p.x=-p.size;
      break;
  }
}

function _animateParticles(){
  if(!_particleCtx||document.body.classList.contains('particles-off'))return;
  const W=window.innerWidth,H=window.innerHeight;
  _particleCtx.clearRect(0,0,W,H);
  for(const p of _particles){
    _updateParticle(p);
    _drawParticle(_particleCtx,p);
  }
  _particleAnim=requestAnimationFrame(_animateParticles);
}

function startParticles(themeName){
  _initCanvas();
  if(!_particleCtx)return;
  if(_particleAnim){cancelAnimationFrame(_particleAnim);_particleAnim=null;}
  if(document.body.classList.contains('particles-off')){
    _particleCtx.clearRect(0,0,window.innerWidth,window.innerHeight);
    return;
  }
  const cfg=PARTICLE_CONFIGS[themeName]||PARTICLE_CONFIGS['sunset-dark'];
  _particleType=cfg.type;
  _particleColors=cfg.colors;
  _particles=[];
  for(let i=0;i<cfg.count;i++){
    _particles.push(_makeParticle(cfg.type,window.innerWidth,window.innerHeight));
    // Mozgó típusoknál szétszórjuk a kezdő életük szerint hogy ne egyszerre érjenek le
    if(['snow','leaves','petals','dust','wheat','crumbs','bubbles','gold','matrix'].includes(cfg.type)){
      _particles[i].y=Math.random()*window.innerHeight;
      if(_particles[i].life&&_particles[i].life!==Infinity)_particles[i].life=Math.random()*_particles[i].maxLife;
    }
  }
  _animateParticles();
}

function toggleParticles(){
  document.body.classList.toggle('particles-off');
  const off=document.body.classList.contains('particles-off');
  localStorage.setItem('kf_particles_off',off?'1':'0');
  const cur=localStorage.getItem('kf_theme')||'sunset-dark';
  startParticles(cur);
  const lbl=document.getElementById('particles-label');
  if(lbl)lbl.textContent=off?'KI':'BE';
  return !off;
}

// ══ KILÉPÉS — mentés + tab bezárása ══
function confirmExit(){
  // Ha épp előfordítás fut, várjuk meg
  if(_prefetchActive){
    const msg=_prefetchCurrentIdx>=0
      ? `⏳ Előfordítás folyamatban (${_prefetchCurrentIdx+1}. lap).\n\nVárj egy pillanatot, míg befejezi — utána újra rányomhatsz a 🚪 Kilépés gombra.`
      : `⏳ Előfordítás folyamatban.\n\nVárj egy pillanatot — utána újra rányomhatsz a 🚪 Kilépés gombra.`;
    alert(msg);
    return;
  }
  // Megerősítő dialog
  const ok=confirm('Biztosan kilépsz?\n\n✓ Minden haladás és fordítás már elmentve\n✓ A borítók is cache-ben maradnak\n\nA böngésző tab bezárul.');
  if(!ok)return;
  performExit();
}

async function performExit(){
  // Explicit mentés flush — bár auto-mentés már megtörtént,
  // biztosítsuk hogy minden félbe hagyott művelet is kész
  try{
    // Ha épp olvasás közben vagyunk, mentsük a lap pozícióját
    if(curBookKey&&typeof cur!=='undefined'){
      const book=library.find(b=>b.key===curBookKey);
      if(book){
        book.curPage=cur;
        book.lastRead=Date.now();
        // bl_library frissítés
        try{
          let saved=null;try{saved=JSON.parse(localStorage.getItem('bl_library')||'null');}catch(e){console.warn('[lib] sérült bl_library:',e.message);}
          if(saved&&saved.books){
            const entry=saved.books.find(b=>b.key===curBookKey);
            if(entry){entry.curPage=cur;entry.lastRead=Date.now();
              localStorage.setItem('bl_library',JSON.stringify(saved));}
          }
        }catch(e){}
      }
    }
  }catch(e){console.warn('exit save:',e);}

  // Feedback képernyő
  showExitScreen();

  // 1.5 mp után próbálunk zárni
  setTimeout(()=>{
    try{
      window.close();
    }catch(e){}
    // Ha 500ms múlva még mindig élünk, akkor nem sikerült — fallback üzenet
    setTimeout(()=>{
      // A "most már bezárhatod" szöveg már látszódik
    },500);
  },1500);
}

function showExitScreen(){
  // Full-screen overlay
  const overlay=document.createElement('div');
  overlay.id='exit-overlay';
  overlay.innerHTML=`
    <div class="exit-content">
      <div class="exit-check">✓</div>
      <div class="exit-title">Minden mentve!</div>
      <div class="exit-msg">Viszlát! A böngésző most bezárja a tab-ot...</div>
      <div class="exit-fallback">
        Ha a tab nem záródna be automatikusan, <b>bezárhatod a felső sarokban lévő X gombbal</b>.
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}
function toggleTheme(){
  const cur=localStorage.getItem('kf_theme')||'sunset-dark';
  const t=THEMES[cur];
  let next;
  if(cur==='sunset-dark') next='sunset-light';
  else if(cur==='sunset-light') next='sunset-dark';
  else if(t&&t.mode==='dark') next='sunset-light';
  else next='sunset-dark';
  setTheme(next);
}
function setTheme(name){
  localStorage.setItem('kf_theme',name);
  applyTheme(name);
}

async function init(){
  // Téma betöltése (legacy támogatással: régi 'dark'/'light' → 'sunset-dark'/'sunset-light')
  let savedTheme=localStorage.getItem('kf_theme')||'sunset-dark';
  if(savedTheme==='dark') savedTheme='sunset-dark';
  else if(savedTheme==='light') savedTheme='sunset-light';
  // Részecskék állapota
  if(localStorage.getItem('kf_particles_off')==='1') document.body.classList.add('particles-off');
  applyTheme(savedTheme);
  // Részecske gomb UI sync
  setTimeout(()=>{
    const off=document.body.classList.contains('particles-off');
    const btn=document.getElementById('particles-btn');
    const lbl=document.getElementById('particles-label');
    if(btn)btn.classList.toggle('active',!off);
    if(lbl)lbl.textContent=off?'KI':'BE';
    // Előfordítás gomb sync — Android-on alapból OFF (a HTTP szerver túltelítődést elkerüli)
    const pfEnabled=isPrefetchEnabled();
    const pfBtn=document.getElementById('prefetch-btn');
    const pfLbl=document.getElementById('prefetch-label');
    if(pfBtn)pfBtn.classList.toggle('active',pfEnabled);
    if(pfLbl)pfLbl.textContent=pfEnabled?'BE':'KI';
    // Auto-Opus biztonsági háló sync
    const aoOff=localStorage.getItem('kf_auto_opus_off')==='1';
    const aoBtn=document.getElementById('auto-opus-btn');
    const aoLbl=document.getElementById('auto-opus-label');
    if(aoBtn)aoBtn.classList.toggle('active',!aoOff);
    if(aoLbl)aoLbl.textContent=aoOff?'KI':'BE';
  },50);
  ['kf_api_key'].forEach(k=>{
    const v=localStorage.getItem(k);
    if(v){const el=document.getElementById('api-key');if(el)el.value=v;}
  });
  // Gemini API kulcs betöltése (külön input mező)
  const gemKey = localStorage.getItem('kf_gemini_key');
  if(gemKey){
    const gel = document.getElementById('gemini-api-key');
    if(gel) gel.value = gemKey;
  }
  const sm=localStorage.getItem('kf_model')||'claude-haiku-4-5';
  // svc mindig claude (google/deepl kivéve)
  svc='claude';
  localStorage.setItem('kf_svc','claude');
  // Modell beállítás — előbb a globális változó, majd a UI
  selModel = sm;
  setModel(document.querySelector(`[data-model="${sm}"]`)||document.querySelector('.mbtn[data-model]'));
  updateModelPickerUI();
  // IndexedDB cache próbálkozás (HTTPS-en működik, content:// URL-en nem)
  useIDB=await tryOpenIDB();
  console.log('IDB cache:',useIDB?'BE (fájlok cachelve lesznek)':'KI (localStorage mód)');
  // IDB-Trans (lap-szintű fordítás-tárolás) megnyitása + automatikus migráció
  await tryOpenIDBTrans();
  console.log('IDB-Trans:', _idbTransReady?'BE (fordítások)':'KI (localStorage fallback)');
  if(_idbTransReady) await migrateLocalStorageToIDB();
  // Mentett könyvtár (csak metaadatok) betöltése
  library=[];
  try{
    let saved=null;try{saved=JSON.parse(localStorage.getItem('bl_library')||'null');}catch(e){console.warn('[lib] sérült bl_library:',e.message);}
    if(saved&&saved.books&&saved.books.length){
      savedDirName=saved.dirName||'';
      library=saved.books.map(b=>({...b,file:null,pending:true}));
      // Ha IDB van, nézzük meg mely könyvek vannak cachelve és azokat "feltámasztjuk"
      if(useIDB){
        for(const b of library){
          try{
            const cached=await idbGet(b.key);
            if(cached&&cached.blob){
              b.file=new File([cached.blob],b.title+'.'+b.type);
              b.pending=false;
              b.cached=true;
            }
          }catch(e){}
        }
      }
      renderLib();
      const cachedCount=library.filter(b=>b.cached).length;
      if(cachedCount===library.length){
        setSt('success',`✓ ${library.length} könyv betöltve (cache)`);
      }else if(cachedCount){
        setSt('warn',`${cachedCount}/${library.length} könyv cachelve · a többihez mappa kell`);
      }else{
        setSt('warn',`📁 "${savedDirName||'könyvtár'}" · koppints egy könyvre vagy válaszd újra a mappát`);
      }
    }
  }catch(e){console.warn('mentett könyvtár betöltés:',e);}
  renderLib();
  // Lib section szekció állapot betöltés (alapértelmezett: zárva)
  const sectOpen=localStorage.getItem('kf_lib_section_open')==='1';
  if(sectOpen) toggleLibSection(true);
  showScr('library');
}
init();

// Függőben lévő megnyitás
let pendingOpenKey=null;
let savedDirName='';

// ══ SCREENS ══
function showScr(n){
  document.getElementById('library').classList.toggle('active',n==='library');
  document.getElementById('reader').classList.toggle('active',n==='reader');
  document.body.classList.toggle('reader-active',n==='reader');
  document.getElementById('btn-back').style.display=n==='reader'?'inline-block':'none';
  document.getElementById('btn-save').style.display=n==='reader'?'inline-block':'none';
}
function goLib(){if(typeof cancelAutoImm==='function')cancelAutoImm();document.body.classList.remove('imm');if(curBookKey)saveProgress();curBookKey=null;pages=[];showScr('library');}

// ══ SETUP ══
function saveKey(k,v){localStorage.setItem(k,v);}
function toggleSetup(){document.getElementById('setup').classList.toggle('open');}
function setSvc(el){
  if(!el)return;
  svc='claude'; // mindig claude — google és deepl eltávolítva
  document.querySelectorAll('.mbtn[data-svc]').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  localStorage.setItem('kf_svc',svc);
}
function setModel(el){
  if(!el)return;
  selModel=el.dataset.model;
  document.querySelectorAll('.mbtn[data-model]').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  localStorage.setItem('kf_model',selModel);
  updateModelPickerUI();
}

// ══ Modell-választó (gyors gomb a bal oszlopban) ══
// 3 opció: Haiku (H, alap, olcsó), Sonnet (S, közepes), Opus (O, drága)
// Az ib-model gombon mindig az aktuális modell ELSŐ BETŰJE látszódik.
// Koppintásra felugrik egy 3-választós popup, kiválasztáskor:
//  1. Beállítja a modellt
//  2. AUTOMATIKUSAN újrafordítja az aktuális lapot

function _modelLetterFor(modelStr){
  if(!modelStr) return 'H';
  if(isHybridModel(modelStr)){
    if(modelStr === 'hybrid-flashlite-sonnet') return 'X';
    if(modelStr === 'hybrid-flashlite-haiku')  return 'Y';
    if(modelStr === 'hybrid-flash-sonnet')     return 'Z';
    if(modelStr === 'hybrid-flashlite-sonnet-x1') return 'W';
    return '?';
  }
  if(isGeminiModel(modelStr)) return _modelLetterForGemini(modelStr);
  if(modelStr.includes('haiku'))  return 'H';
  if(modelStr.includes('sonnet')) return 'S';
  if(modelStr.includes('opus'))   return 'O';
  return '?';
}

function updateModelPickerUI(){
  const btn = document.getElementById('ib-model');
  if(btn){
    const letter = _modelLetterFor(selModel);
    btn.textContent = letter;
    btn.setAttribute('data-current', letter);
    let displayName;
    if(isHybridModel(selModel)){
      const parts = _hybridParts(selModel);
      displayName = `Hibrid (${parts?.label || selModel})`;
    } else if(isGeminiModel(selModel)){
      displayName = selModel.includes('flash-lite') ? 'Gemini Flash-Lite' :
                    selModel.includes('flash')      ? 'Gemini Flash' :
                    selModel.includes('pro')        ? 'Gemini Pro' : 'Gemini';
    } else {
      displayName = letter==='H' ? 'Claude Haiku' : letter==='S' ? 'Claude Sonnet' : 'Claude Opus';
    }
    btn.title = `Modell: ${displayName} — kattints a váltáshoz`;
  }
  // Aktív állapot a popup-ban
  document.querySelectorAll('.mp-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.model === selModel);
  });
}

function toggleModelPicker(e){
  if(e) e.stopPropagation();
  const p = document.getElementById('model-picker');
  if(!p) return;
  if(p.style.display === 'none' || !p.style.display){
    p.style.display = 'flex';
    updateModelPickerUI();
    // Kattintás máshova → bezáródik
    setTimeout(() => {
      const closer = (ev) => {
        if(!p.contains(ev.target) && ev.target.id !== 'ib-model'){
          p.style.display = 'none';
          document.removeEventListener('click', closer);
        }
      };
      document.addEventListener('click', closer);
    }, 50);
  } else {
    p.style.display = 'none';
  }
}

async function pickModel(modelStr){
  // Hibrid: KÉT API kulcs kell — Gemini OCR-hez és Claude fordításhoz
  if(isHybridModel(modelStr)){
    const gKey = (document.getElementById('gemini-api-key')?.value || localStorage.getItem('kf_gemini_key') || '').trim();
    const cKey = (document.getElementById('api-key')?.value || localStorage.getItem('kf_api_key') || '').trim();
    if(!gKey || !cKey){
      const missing = !gKey && !cKey ? 'Gemini ÉS Claude' : (!gKey ? 'Gemini' : 'Claude');
      setSt('warn', `⚠️ A hibrid pipeline-hoz mindkét API kulcs kell. Hiányzik: ${missing}.`);
      const sett = document.getElementById('settings-panel');
      if(sett && sett.style.display !== 'block'){
        toggleSettings && toggleSettings();
      }
      return;
    }
  }
  // Ha Gemini-t választottak, ellenőrizzük hogy van-e Gemini API kulcs
  else if(isGeminiModel(modelStr)){
    const gKey = (document.getElementById('gemini-api-key')?.value || localStorage.getItem('kf_gemini_key') || '').trim();
    if(!gKey){
      setSt('warn', '⚠️ Add meg a Gemini API kulcsot a beállításokban (⚙️) — aistudio.google.com');
      // Megnyitjuk a beállítás-panelt automatikusan, hogy könnyebb legyen
      const sett = document.getElementById('settings-panel');
      if(sett && sett.style.display !== 'block'){
        toggleSettings && toggleSettings();
      }
      return;
    }
  }
  selModel = modelStr;
  localStorage.setItem('kf_model', selModel);
  // A beállítás-paneli rádiógombokat is frissíteni
  document.querySelectorAll('.mbtn[data-model]').forEach(b=>{
    b.classList.toggle('active', b.dataset.model === selModel);
  });
  updateModelPickerUI();
  document.getElementById('model-picker').style.display = 'none';
  let displayName;
  if(isHybridModel(modelStr)){
    const parts = _hybridParts(modelStr);
    displayName = `Hibrid (${parts.label})`;
  } else if(isGeminiModel(modelStr)){
    displayName = modelStr.includes('flash-lite') ? 'Gemini Flash-Lite' :
                  modelStr.includes('flash')      ? 'Gemini Flash' :
                                                    'Gemini Pro';
  } else {
    const l = _modelLetterFor(selModel);
    displayName = l==='H' ? 'Claude Haiku' : l==='S' ? 'Claude Sonnet' : 'Claude Opus';
  }
  // Csak modell-váltás, NEM indít automatikus fordítást.
  setSt('success', `🔄 Modell beállítva: ${displayName} — nyomd a 🔍-t újrafordításhoz`);
}

// ══ STATUS ══
// ════ DIAGNOSZTIKAI PANEL — A fordítási folyamat valós idejű kijelzéséhez ════
let _diagEnabled = false;
function diagToggle(){
  _diagEnabled = !_diagEnabled;
  const p = document.getElementById('diag-panel');
  if(p) p.style.display = _diagEnabled ? 'block' : 'none';
  if(_diagEnabled) diag('Diagnózis bekapcsolva. Próbálj fordítani — itt fogod látni mit csinál.');
}
function diag(msg, type='info'){
  if(!_diagEnabled) return;
  const p = document.getElementById('diag-panel');
  const c = document.getElementById('diag-content');
  if(!p || !c) return;
  p.style.display = 'block';
  const colors = { info: '#ffd166', warn: '#ff8055', err: '#ef476f', ok: '#06d6a0' };
  const time = new Date().toTimeString().slice(0,8);
  const line = document.createElement('div');
  line.style.cssText = 'color:'+(colors[type]||colors.info)+';margin-bottom:3px;word-break:break-word';
  line.innerHTML = `<span style="opacity:.6">[${time}]</span> ${String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;')}`;
  c.appendChild(line);
  c.scrollTop = c.scrollHeight;
  // Limitelt buffer (max 50 sor)
  while(c.children.length > 50) c.removeChild(c.firstChild);
}
function diagClear(){
  const c = document.getElementById('diag-content');
  if(c) c.innerHTML = '';
}

function setSt(type,msg,showP=false){
  const b=document.getElementById('sb');
  if(!type){b.className='';b.classList.remove('show');return;}
  b.className=type;b.classList.add('show');
  document.getElementById('sb-msg').textContent=msg;
  document.getElementById('sb-spin').style.display=type==='loading'?'block':'none';
  document.getElementById('pb-wrap').style.display=showP?'block':'none';
  if(!showP)document.getElementById('pb').style.width='0';
  if(type==='success')setTimeout(()=>b.classList.remove('show'),4000);
}
function setProg(n,t){document.getElementById('pb').style.width=`${n/t*100}%`;}

// ══ LIBRARY ══

// Biztonságos localStorage kulcs a fájlból (fájlnév alapján)
function bookKey(relPath){
  const b64 = btoa(unescape(encodeURIComponent(relPath)));
  return 'bl_book_' + b64.replace(/[^a-zA-Z0-9]/g,'').slice(0,80);
}

// ══════════ 📱 ANDROID NATÍV BRIDGE ══════════
function isAndroidApp(){
  try{return typeof AndroidBridge!=='undefined'&&AndroidBridge.isAndroid();}
  catch(e){return false;}
}

// Amikor a 📁 MAPPA gombot megnyomjuk:
// - Ha Android appban vagyunk → a natív mappaválasztót használjuk
// - Ha böngészőben → a normál <input type="file" webkitdirectory>
function androidPickFolderMaybe(ev){
  if(!isAndroidApp())return; // normál browser: a label automatikusan megnyitja az inputot
  // Android: megakadályozzuk az input-megnyitást és hívjuk a native-et
  ev.preventDefault();ev.stopPropagation();
  setSt('loading','Mappa kiválasztása...');
  try{AndroidBridge.pickFolder();}
  catch(e){setSt('error','Android hiba: '+e.message);}
}

// Android hívja ezt amikor a felhasználó kiválasztott egy mappát.
// A paraméter egy tömb: [{name, relativePath, uri (http url), size}, ...]
window.AndroidFolderPicked=async function(files){
  if(!files||!files.length){setSt('error','Nem találtam képregényeket a mappában.');return;}
  setSt('loading',`${files.length} fájl betöltése...`,true);

  // Átalakítjuk a natív fájl-listát File-szerű objektumokká.
  // A "uri" most egy localhost HTTP URL — így fetch-csel gyorsan be tudjuk olvasni.
  const virtualFiles=files.map(f=>{
    const vfile={
      name:f.name,
      size:f.size,
      type:'',
      _androidUrl:f.uri, // HTTP URL pl. http://127.0.0.1:8910/file/xxx/my.cbz
      webkitRelativePath:f.relativePath||f.name,
      // arrayBuffer() — fetch a belső HTTP szerverről (gyors, natív)
      arrayBuffer:async function(){
        // 3x próbálkozás növekvő várakozással — a NanoHTTPD néha lassan vagy
        // egyszerre több kapcsolatnál hibát ad, de második/harmadik kísérletre megy
        let lastErr=null;
        for(let attempt=0;attempt<3;attempt++){
          try{
            const r=await fetch(this._androidUrl);
            if(!r.ok)throw new Error('HTTP '+r.status+': '+this.name);
            return await r.arrayBuffer();
          }catch(e){
            lastErr=e;
            if(attempt<2){
              // Várjunk egy kicsit és próbáljuk újra
              await new Promise(res=>setTimeout(res,500*(attempt+1)));
            }
          }
        }
        throw new Error('Fetch failed after 3 retries ('+this.name+'): '+lastErr.message);
      }
    };
    return vfile;
  });
  loadLibFromDir(virtualFiles);
};

// Mappa kiválasztva — beolvassuk a képregényeket
function loadLibFromDir(fileList){
  if(!fileList||!fileList.length){setSt('error','Nem találtam fájlokat.');return;}
  const files=[...fileList].filter(f=>/\.(cbz|zip|cbr|pdf|jpg|jpeg|png|webp)$/i.test(f.name));
  if(!files.length){setSt('error','Nincs képregény fájl a kiválasztott mappában.');return;}
  // Előbb beolvassuk a mentett bl_library-t is (hogy a thumb-okat meg tudjuk őrizni)
  let prevLib={};
  try{
    let saved=null;try{saved=JSON.parse(localStorage.getItem('bl_library')||'null');}catch(e){console.warn('[lib] sérült bl_library:',e.message);}
    if(saved&&saved.books){
      for(const b of saved.books)prevLib[b.key]=b;
    }
  }catch(e){}
  library=files.map(f=>{
    const rel=f.webkitRelativePath||f.name;
    const title=f.name.replace(/\.[^.]+$/,'').replace(/[-_]/g,' ');
    const key=bookKey(rel);
    let saved={};
    try{saved=JSON.parse(localStorage.getItem(key+'_meta')||'{}')||{};}catch(e){}
    const prev=prevLib[key]||{};
    return {
      key, file:f, path:rel, title,
      type:(f.name.split('.').pop()||'').toLowerCase(),
      size:f.size,
      curPage:saved.curPage||0,
      pageCount:saved.pageCount||0,
      lastRead:saved.lastRead||0,
      thumb:prev.thumb||null,
    };
  });
  // Mappa neve (a webkitRelativePath első szegmense)
  const dirName=(files[0].webkitRelativePath||'').split('/')[0]||'';
  savedDirName=dirName;
  // Mentjük a meta-listát localStorage-ba
  try{
    const meta={
      dirName,
      savedAt:Date.now(),
      books:library.map(b=>({
        key:b.key,path:b.path,title:b.title,type:b.type,size:b.size,
        curPage:b.curPage,pageCount:b.pageCount,lastRead:b.lastRead,
        thumb:b.thumb||null,
      })),
    };
    localStorage.setItem('bl_library',JSON.stringify(meta));
  }catch(e){console.warn('library meta mentés:',e);}
  setSt('success',`✓ ${library.length} képregény${dirName?' ("'+dirName+'")':''}`);
  renderLib();
  // Függőben lévő megnyitás kezelése
  if(pendingOpenKey){
    const k=pendingOpenKey;pendingOpenKey=null;
    const book=library.find(b=>b.key===k);
    if(book&&book.file){
      setTimeout(()=>openBook(k),100);
    }else{
      setSt('warn','A kért könyv nincs a kiválasztott mappában.');
    }
  }
}

// ══ SOROZAT-FELISMERÉS ══
// A cím eleje a "prefix" (szám/v-szám előtti rész). 2+ könyv ugyanabban a prefixben = sorozat.
function extractSeriesPrefix(title){
  // Eltávolítjuk a végéből: [szóköz + (szám/vszám + utána bármi)]
  // Pl. "Gideon Falls 01" -> "Gideon Falls"
  //     "A Vicious Circle 01 (of 03) (2022)" -> "A Vicious Circle"
  //     "The Wicked + The Divine Book 01" -> "The Wicked + The Divine Book"
  //     "Black Badge v01 (2019)" -> "Black Badge"
  //     "Black Hole 01 [Kitchen Sink]" -> "Black Hole"
  //     "Black Science v01 How To Fall Forever" -> "Black Science"
  //     "Watchmen" -> "Watchmen" (nincs szám, nem sorozat-tag)
  const clean=title.trim();
  // Minták: " 01", " v01", " #01", " Book 01", " Vol 01", stb.
  // A szám UTÁN bármi jöhet (zárójel, szögletes zárójel, szöveg, kötőjel) — ez VÉG-marker.
  const m=clean.match(/^(.+?)\s+(?:v|#|Vol\.?|Volume|Book|Ch\.?|Chapter|Part|No\.?|Issue|Tome)?\s*(\d{1,4})(?:\b.*)?$/i);
  if(m&&m[1]){
    let prefix=m[1].replace(/\s+(?:v|#|Vol\.?|Volume|Book|Ch\.?|Chapter|Part|No\.?|Issue|Tome)$/i,'');
    return {prefix:prefix.trim(), number:parseInt(m[2],10)};
  }
  return {prefix:null, number:null};
}
function groupBooksBySeries(books){
  // Visszatérés: [{type:'series', prefix, books:[...], ...}, {type:'single', book:{...}}, ...]
  const prefixMap=new Map();
  for(const b of books){
    const {prefix,number}=extractSeriesPrefix(b.title);
    if(!prefix){prefixMap.set('__single__'+b.key,{prefix:null,books:[b]});continue;}
    if(!prefixMap.has(prefix))prefixMap.set(prefix,{prefix,books:[]});
    prefixMap.get(prefix).books.push({...b,_seriesNum:number});
  }
  const result=[];
  for(const [key,entry] of prefixMap){
    if(key.startsWith('__single__')||entry.books.length<2){
      // Egy könyv — egyedi
      result.push({type:'single',book:entry.books[0]});
    }else{
      // Sorozat
      entry.books.sort((a,b)=>(a._seriesNum||0)-(b._seriesNum||0));
      result.push({type:'series',prefix:entry.prefix,books:entry.books});
    }
  }
  return result;
}

function renderLib(filter='',sort='smart'){
  const grid=document.getElementById('lib-grid');
  const empty=document.getElementById('lib-empty');
  if(!grid){console.warn('#lib-grid nincs DOM-ban');return;}
  let books=[...library];
  if(filter)books=books.filter(b=>b.title.toLowerCase().includes(filter.toLowerCase()));
  const cmpTitle=(a,b)=>a.title.localeCompare(b.title,'hu',{numeric:true,sensitivity:'base'});
  const sortBooks=(arr)=>{
    if(sort==='title')arr.sort(cmpTitle);
    else if(sort==='progress')arr.sort((a,b)=>(b.curPage/Math.max(1,b.pageCount))-(a.curPage/Math.max(1,a.pageCount)));
    else if(sort==='recent')arr.sort((a,b)=>(b.lastRead||0)-(a.lastRead||0));
    else{
      arr.sort((a,b)=>{
        const gA=a.curPage>0&&a.pageCount>0&&a.curPage>=a.pageCount-1?3:(a.curPage>0?1:2);
        const gB=b.curPage>0&&b.pageCount>0&&b.curPage>=b.pageCount-1?3:(b.curPage>0?1:2);
        if(gA!==gB)return gA-gB;
        return cmpTitle(a,b);
      });
    }
  };

  // Csoportosítás sorozatokká
  const groups=groupBooksBySeries(books);

  // Rendezés: először kibontott sorozatok (a legutóbb olvasott kötet lastRead-je alapján), aztán egyedi könyvek
  const flat=[];
  for(const g of groups){
    if(g.type==='series'){
      // A sorozat "képviselője" a legutóbb olvasott kötet
      const rep=g.books.reduce((a,b)=>(b.lastRead||0)>(a.lastRead||0)?b:a,g.books[0]);
      flat.push({type:'series',prefix:g.prefix,books:g.books,rep});
    }else{
      flat.push({type:'single',book:g.book,rep:g.book});
    }
  }
  // Rendezés a rep-ek alapján
  if(sort==='title')flat.sort((a,b)=>(a.type==='series'?a.prefix:a.rep.title).localeCompare(b.type==='series'?b.prefix:b.rep.title,'hu',{numeric:true,sensitivity:'base'}));
  else if(sort==='recent')flat.sort((a,b)=>(b.rep.lastRead||0)-(a.rep.lastRead||0));
  else if(sort==='progress')flat.sort((a,b)=>(b.rep.curPage/Math.max(1,b.rep.pageCount))-(a.rep.curPage/Math.max(1,a.rep.pageCount)));
  else{
    // Okos
    flat.sort((a,b)=>{
      const gA=a.rep.curPage>0&&a.rep.pageCount>0&&a.rep.curPage>=a.rep.pageCount-1?3:(a.rep.curPage>0?1:2);
      const gB=b.rep.curPage>0&&b.rep.pageCount>0&&b.rep.curPage>=b.rep.pageCount-1?3:(b.rep.curPage>0?1:2);
      if(gA!==gB)return gA-gB;
      return (a.type==='series'?a.prefix:a.rep.title).localeCompare(b.type==='series'?b.prefix:b.rep.title,'hu',{numeric:true,sensitivity:'base'});
    });
  }

  grid.innerHTML='';
  if(!flat.length){if(empty)empty.style.display='flex';grid.style.display='none';return;}
  if(empty)empty.style.display='none';grid.style.display='block';

  // Összecsukott sorozatok állapota localStorage-ban
  const collapsed=JSON.parse(localStorage.getItem('bl_series_collapsed')||'{}');

  let _aniIdx=0;
  const _aniDelay=()=>{const d=Math.min(_aniIdx*25,600);_aniIdx++;return d;};

  for(const entry of flat){
    if(entry.type==='single'){
      const r=buildBookRow(entry.book);
      r.style.animationDelay=_aniDelay()+'ms';
      grid.appendChild(r);
    }else{
      // Sorozat fejléc + kibontható lista
      const isCollapsed=collapsed[entry.prefix]!==false; // alapértelmezett: összecsukva
      const header=document.createElement('div');
      header.className='series-header'+(isCollapsed?'':' open');
      header.style.animationDelay=_aniDelay()+'ms';
      const totalCount=entry.books.length;
      const readingCount=entry.books.filter(b=>b.curPage>0&&b.pageCount>0&&b.curPage<b.pageCount-1).length;
      const doneCount=entry.books.filter(b=>b.curPage>0&&b.pageCount>0&&b.curPage>=b.pageCount-1).length;

      // Utolsó olvasott kötet
      const lastRead=entry.books.filter(b=>b.lastRead).sort((a,b)=>b.lastRead-a.lastRead)[0];
      let lastTxt='';
      if(lastRead){
        const num=lastRead._seriesNum?String(lastRead._seriesNum).padStart(2,'0'):'?';
        lastTxt=` — Utolsó: ${num}. kötet · ${lastRead.curPage||0}. lap`;
      }

      // Fejléc összefoglalója
      let summary=`${totalCount} kötet`;
      if(readingCount)summary+=` · ${readingCount} olvasás alatt`;
      if(doneCount)summary+=` · ${doneCount} kész`;

      header.innerHTML=`
        <div class="series-arrow">▶</div>
        <div class="series-icon">📚</div>
        <div class="series-info">
          <div class="series-title">${esc(entry.prefix)}</div>
          <div class="series-meta">${summary}${lastTxt}</div>
        </div>
      `;
      header.onclick=()=>{
        const st=JSON.parse(localStorage.getItem('bl_series_collapsed')||'{}');
        st[entry.prefix]=!header.classList.contains('open')?false:true;
        localStorage.setItem('bl_series_collapsed',JSON.stringify(st));
        renderLib(filter,sort);
      };
      grid.appendChild(header);

      if(!isCollapsed){
        const wrap=document.createElement('div');
        wrap.className='series-books';
        sortBooks(entry.books);
        entry.books.forEach(b=>{
          const r=buildBookRow(b,true);
          r.style.animationDelay=_aniDelay()+'ms';
          wrap.appendChild(r);
        });
        grid.appendChild(wrap);
      }
    }
  }
  renderStats();
  renderContinueHero();
  // Frissítsük a "ÖSSZES KÖNYV" szekció számlálót
  const cnt=document.getElementById('lib-section-count');
  if(cnt)cnt.textContent=library.length+' db';
  // Ha nincs könyv (üres), nyissuk a szekciót automatikusan, hogy a MAPPA gomb látsszon
  if(!library.length){
    const tg=document.getElementById('lib-section-toggle');
    const ct=document.getElementById('lib-section-content');
    if(tg&&ct&&!tg.classList.contains('open')){tg.classList.add('open');ct.classList.add('open');}
  }
}

// Egy könyv-sor HTML elem építése (sorozaton belül vagy egyedileg)
function buildBookRow(book,inSeries=false){
  const row=document.createElement('div');
  // Méret-figyelmeztetés Android-on (CBR>800MB vagy bármi>1.2GB)
  const sizeMB=book.size?book.size/1024/1024:0;
  const isCBR=book.type==='cbr';
  const tooLargeForAndroid=isAndroidApp()&&sizeMB&&((isCBR&&sizeMB>800)||sizeMB>1200);
  row.className='brow'+(book.pending?' pending':'')+(book.cached?' cached':'')+(inSeries?' in-series':'')+(tooLargeForAndroid?' size-warn':'');
  row.onclick=()=>openBook(book.key);
  const pct=book.pageCount?Math.round(book.curPage/book.pageCount*100):0;
  const done=book.curPage>0&&book.pageCount>0&&book.curPage>=book.pageCount-1;
  const inP=book.curPage>0&&!done;
  let status='';
  if(done)status='<span class="bstatus done">✓ kész</span>';
  else if(inP)status=`<span class="bstatus">${pct}%</span>`;
  else if(tooLargeForAndroid){
    const sizeStr=sizeMB>=1024?(sizeMB/1024).toFixed(1)+' GB':Math.round(sizeMB)+' MB';
    status=`<span class="bstatus warn" title="Túl nagy fájl Android-hoz — konvertáld CBZ-re">⚠️ ${sizeStr}</span>`;
  }
  // Ikon vagy miniatűr
  let iconHtml;
  if(book.thumb){
    iconHtml=`<img class="bthumb" src="${book.thumb}" alt="">`;
  }else{
    const icon=book.cached?'📘':(book.pending?'📁':'📖');
    iconHtml=`<div class="bicon">${icon}</div>`;
  }
  row.innerHTML=`
    ${iconHtml}
    <div class="binfo">
      <div class="btitle">${esc(book.title)}</div>
      <div class="bmeta">${book.type.toUpperCase()}${book.pageCount?' · '+book.pageCount+' old':''}${book.curPage>0?' · '+book.curPage+'. lap':''}</div>
      ${inP?`<div class="bpbar"><div class="bpfill" style="width:${pct}%"></div></div>`:''}
    </div>
    ${status}
  `;
  return row;
}

// ══ STATISZTIKA ══
function toggleStats(){
  const panel=document.getElementById('lib-stats');
  const full=document.getElementById('lib-stats-full');
  const open=panel.classList.toggle('open');
  full.style.display=open?'block':'none';
}

// ══ FOLYTATÁS — utolsó olvasott könyv nagy borítóval ══
function renderContinueHero(){
  const hero=document.getElementById('continue-hero');
  if(!hero)return;
  // Az utolsó olvasott könyv (lastRead alapján)
  const candidates=library.filter(b=>b.lastRead&&b.curPage>0);
  if(!candidates.length){
    // Üres állapot — még nem olvasott semmit
    hero.classList.add('empty');
    hero.innerHTML=`
      <div class="ch-empty-icon">📚</div>
      <div class="ch-empty-text">Még nem olvastál semmit. Görgess le az <b>Összes könyv</b> alá és válassz egyet!</div>
      <button class="ch-btn-secondary" onclick="toggleLibSection(true)">▼ Könyvtár megnyitása</button>
    `;
    return;
  }
  hero.classList.remove('empty');
  candidates.sort((a,b)=>b.lastRead-a.lastRead);
  const book=candidates[0];

  const pct=book.pageCount?Math.round(book.curPage/book.pageCount*100):0;
  const done=book.curPage>0&&book.pageCount>0&&book.curPage>=book.pageCount-1;
  const coverHtml=book.thumb
    ? `<div class="ch-cover" onclick="openBook('${book.key}')"><img src="${book.thumb}" alt="" draggable="false">${book.pageCount?`<div class="ch-progress-overlay"><div class="ch-progress-fill" style="width:${pct}%"></div></div>`:''}</div>`
    : `<div class="ch-cover no-thumb" onclick="openBook('${book.key}')">📖${book.pageCount?`<div class="ch-progress-overlay"><div class="ch-progress-fill" style="width:${pct}%"></div></div>`:''}</div>`;

  // Méretadatok
  let metaParts=[];
  if(book.pageCount){
    metaParts.push(`<span class="ch-pct">${pct}%</span>`);
    metaParts.push(`${book.curPage} / ${book.pageCount} lap`);
  }
  if(book.type)metaParts.push(book.type.toUpperCase());

  // Idő-jelzés
  if(book.lastRead){
    const diff=Date.now()-book.lastRead;
    const min=Math.round(diff/60000);
    let timeStr='';
    if(min<1)timeStr='most';
    else if(min<60)timeStr=min+' perce';
    else if(min<1440)timeStr=Math.round(min/60)+' órája';
    else if(min<2880)timeStr='tegnap';
    else if(min<10080)timeStr=Math.round(min/1440)+' napja';
    else timeStr=Math.round(min/10080)+' hete';
    metaParts.push(timeStr);
  }

  const btnLabel=done?`▶ Újraolvasás`:`▶ Folytatás${book.curPage?` a ${book.curPage+1}. lapon`:''}`;

  hero.innerHTML=`
    <div class="ch-label">📖 ${done?'LEGUTÓBB OLVASOTT':'FOLYTATÁS'}</div>
    ${coverHtml}
    <div class="ch-info">
      <div class="ch-title">${esc(book.title)}</div>
      <div class="ch-meta">${metaParts.join(' · ')}</div>
      <div class="ch-actions">
        <button class="ch-btn-primary" onclick="openBook('${book.key}')">${btnLabel}</button>
      </div>
    </div>
  `;
}

// ══ ÖSSZES KÖNYV — lenyitható ══
function toggleLibSection(forceOpen){
  const toggle=document.getElementById('lib-section-toggle');
  const content=document.getElementById('lib-section-content');
  if(!toggle||!content)return;
  let open;
  if(forceOpen===true){open=true;}
  else if(forceOpen===false){open=false;}
  else{open=!toggle.classList.contains('open');}
  toggle.classList.toggle('open',open);
  content.classList.toggle('open',open);
  localStorage.setItem('kf_lib_section_open',open?'1':'0');
}

function renderStats(){
  const row=document.getElementById('lib-stats-row');
  const full=document.getElementById('lib-stats-full');
  if(!row||!full)return;

  // Alapadatok
  const totalBooks=library.length;
  const reading=library.filter(b=>b.curPage>0&&b.pageCount>0&&b.curPage<b.pageCount-1).length;
  const done=library.filter(b=>b.curPage>0&&b.pageCount>0&&b.curPage>=b.pageCount-1).length;
  const notStarted=totalBooks-reading-done;
  const cached=library.filter(b=>b.cached).length;

  // Lefordított oldalak + modelltípus
  // Fordítás-stats: az új IDB rendszerben a könyv-szintű meta-ban tároljuk
  // a `transPageCount` mezőt (frissítjük lapozáskor). Visszafelé kompatibilis:
  // ha nincs ilyen mező, akkor a régi localStorage-ből olvasunk.
  let transPages=0,transBooks=0;
  const perBook=[];
  library.forEach(b=>{
    let n = 0;
    if(typeof b.transPageCount === 'number'){
      n = b.transPageCount;
    }else{
      // Régi mód — localStorage olvasás (visszafelé kompatibilitás)
      try{
        let t=null;try{t=JSON.parse(localStorage.getItem(b.key+'_trans')||'null');}catch(e){}
        if(t&&t.pages) n=t.pages.filter(p=>p&&p.length).length;
      }catch(e){}
    }
    if(n>0){transPages+=n;transBooks++;perBook.push({title:b.title,pages:n});}
  });

  // Költség becslés (Sonnet alap; modell szerint változik)
  const model=localStorage.getItem('kf_model')||'claude-haiku-4-5';
  const ftPerPage=model.includes('haiku')?0.3:model.includes('opus')?7:1;
  const costFt=Math.round(transPages*ftPerPage);
  const modelShort=model.includes('haiku')?'Haiku':model.includes('opus')?'Opus':'Sonnet';

  // Tömör sor
  row.querySelector('.stats-text').textContent=`📚 ${totalBooks} könyv · 📖 ${reading} olvasás alatt · 📄 ${transPages} oldal fordítva`;

  // Top 3 legtöbb fordítás
  perBook.sort((a,b)=>b.pages-a.pages);
  const top3=perBook.slice(0,3);

  // Utolsó olvasott 3
  const recent=[...library].filter(b=>b.lastRead).sort((a,b)=>b.lastRead-a.lastRead).slice(0,3);
  const fmtTime=(ts)=>{
    if(!ts)return '—';
    const diff=Date.now()-ts;
    const min=Math.round(diff/60000);
    if(min<1)return 'most';
    if(min<60)return min+' perce';
    const hr=Math.round(min/60);
    if(hr<24)return hr+' órája';
    const d=Math.round(hr/24);
    if(d===1)return 'tegnap';
    if(d<7)return d+' napja';
    const w=Math.round(d/7);
    if(w<5)return w+' hete';
    return Math.round(d/30)+' hónapja';
  };

  // Teljes panel
  full.innerHTML = `
    <div class="stats-section">
      <h4>📚 KÖNYVTÁR</h4>
      <div class="stats-grid">
        <div class="stats-item"><div class="stats-item-label">Összes</div><div class="stats-item-value">${totalBooks}</div></div>
        <div class="stats-item"><div class="stats-item-label">Olvasás alatt</div><div class="stats-item-value">${reading}</div></div>
        <div class="stats-item"><div class="stats-item-label">Kész</div><div class="stats-item-value">${done}</div></div>
        <div class="stats-item"><div class="stats-item-label">Nem kezdett</div><div class="stats-item-value">${notStarted}</div></div>
        <div class="stats-item"><div class="stats-item-label">Cachelve</div><div class="stats-item-value">${cached}<small> / ${totalBooks}</small></div></div>
      </div>
    </div>
    <div class="stats-section">
      <h4>📄 FORDÍTÁS</h4>
      <div class="stats-grid">
        <div class="stats-item"><div class="stats-item-label">Oldalak összesen</div><div class="stats-item-value">${transPages}</div></div>
        <div class="stats-item"><div class="stats-item-label">Érintett könyv</div><div class="stats-item-value">${transBooks}</div></div>
        <div class="stats-item"><div class="stats-item-label">Becsült költség</div><div class="stats-item-value">~${costFt} Ft<small> (${modelShort})</small></div></div>
      </div>
    </div>
    ${top3.length?`
    <div class="stats-section">
      <h4>🏆 LEGTÖBBET FORDÍTOTT</h4>
      <div class="stats-top-list">
        ${top3.map((b,i)=>`<div class="stats-top-item"><span class="stats-top-title">${i+1}. ${esc(b.title)}</span><span class="stats-top-val">${b.pages} old</span></div>`).join('')}
      </div>
    </div>`:''}
    ${recent.length?`
    <div class="stats-section">
      <h4>⏱️ AKTIVITÁS</h4>
      <div class="stats-top-list">
        ${recent.map(b=>`<div class="stats-top-item"><span class="stats-top-title">${esc(b.title)}</span><span class="stats-top-val">${fmtTime(b.lastRead)}</span></div>`).join('')}
      </div>
    </div>`:''}
  `;
}
function filterLib(v){const sort=document.getElementById('lib-sort');renderLib(v,sort?sort.value:'smart');}
function sortLib(v){const srch=document.getElementById('lib-search');renderLib(srch?srch.value:'',v);}

// ══ OPEN BOOK ══
async function openBook(key){
  const book=library.find(b=>b.key===key);if(!book){setSt('error','Könyv nem található.');return;}
  // Ha "pending" (csak mentett meta, nincs fájl) → kérjük a mappa újraválasztását
  if(!book.file||book.pending){
    pendingOpenKey=key;
    setSt('loading',`"${book.title}" — válaszd ki a mappát ahol van`);
    const inp=document.getElementById('fi-dir');
    if(inp)inp.click();
    return;
  }
  // ⚠️ Android-specifikus: nagy fájlok megnyitása crash-elheti az app-ot.
  // CBR-eknél kritikus mert a unrar dekódolás +sok memória.
  if(isAndroidApp()&&book.file.size){
    const sizeMB=book.file.size/1024/1024;
    const isCBR=book.type==='cbr';
    // CBR > 800 MB vagy bármi > 1.2 GB veszélyes
    const tooLarge=(isCBR&&sizeMB>800)||sizeMB>1200;
    if(tooLarge){
      const sizeStr=sizeMB>=1024?(sizeMB/1024).toFixed(2)+' GB':sizeMB.toFixed(0)+' MB';
      const msg=`⚠️ Ez a fájl ${sizeStr}, ami túl nagy az Android megnyitáshoz.\n\n`+
        (isCBR?'CBR fájloknál különösen kritikus a méret. Konvertáld CBZ-re egy gépen (pl. 7-Zip-pel: bontsd ki, majd ZIP-be tömörítsd, és nevezd át .cbz-re).\n\n':'')+
        `Tényleg megpróbáljuk?\nAz app valószínűleg lefagy vagy bezáródik.`;
      if(!confirm(msg)){
        setSt('warn','Megnyitás megszakítva — fájl túl nagy ('+sizeStr+').');
        return;
      }
      setSt('loading','⚠️ Nagy fájl — kísérlet, de várhatóan lassú...');
    }
  }
  setSt('loading',`${book.title} megnyitása...`);
  pages=[];cur=book.curPage||0;projName=book.title;curBookKey=key;
  // IndexedDB cache: ha még nincs cachelve, a háttérben elmentjük
  // Android módban kihagyjuk — a fájlok amúgy is elérhetők a natív HTTP szerveren keresztül,
  // és a virtuális fájl-objektum nem klónozható IDB-be (mert függvényeket tartalmaz).
  if(useIDB&&!book.cached&&!isAndroidApp()){
    (async()=>{
      try{
        const existing=await idbGet(book.key);
        if(!existing){
          await idbPut(book.key,{blob:book.file,type:book.type,title:book.title,size:book.file.size});
          book.cached=true;
          console.log('cached:',book.title,(book.file.size/1024/1024).toFixed(1)+'MB');
        }
      }catch(e){console.warn('IDB cache failed:',e.message);}
    })();
  }
  try{
    const ext=book.type;
    if(ext==='cbz'||ext==='zip')await lCBZ(book.file);
    else if(ext==='cbr')await lCBR(book.file);
    else if(ext==='pdf')await lPDF(book.file);
    else await lImg(book.file);
  }catch(e){setSt('error','Hiba: '+e.message);return;}
  if(!pages.length){setSt('error','Nem találtam oldalakat.');return;}
  // Fordítások betöltése: először IDB-Trans-ból, fallback localStorage-re
  try{
    let loaded = null;
    if(_idbTransReady){
      loaded = await idbTransLoadBook(key, pages.length);
    }
    if(!loaded){
      // Fallback: régi localStorage formátum
      let savedT=null;try{savedT=JSON.parse(localStorage.getItem(key+'_trans')||'null');}catch(e){console.warn('[trans] sérült _trans adat:',e.message);}
      if(savedT&&savedT.pages) loaded = savedT.pages;
    }
    if(loaded){
      loaded.forEach((t,i)=>{if(pages[i]&&t)pages[i].bubbles=t;});
    }
  }catch(e){console.warn('translations load failed:',e);}
  cur=Math.min(cur,pages.length-1);
  showScr('reader');buildThumbs();
  await ensureLoaded(cur);renderPage();preload(cur);
  book.pageCount=pages.length;book.lastRead=Date.now();
  saveMeta();
  // Miniatűr generálás (ha még nincs) — a háttérben, nem blokkolva az olvasót
  generateThumbIfMissing(book).catch(e=>console.warn('thumb hiba:',e));
  setSt('success',`✓ ${book.title} — ${pages.length} oldal`);
  showZHint();initLHandleDrag();
  // Auto-elrejtés: 5 másodperc múlva immerzív módba vált (teljes képernyős olvasás)
  scheduleAutoImm();
  // 📖 Lore gomb állapotának frissítése (ha van hozzá lore)
  updateLoreButton();
  // 🧠 Előfordítás csak akkor induljon automatikusan, ha a könyvben már van legalább 1
  // korábbi fordítás (tehát a felhasználó már folytat). Új könyv esetén várunk a manuális
  // 🔍 fordításra, hogy ne pazaroljuk a címlapon/credits lapokon.
  const hasPrevTranslations=pages.some(p=>p.bubbles!==null);
  if(hasPrevTranslations){
    setTimeout(()=>{if(curBookKey===key)schedulePrefetch();},800);
  }
}

// ══ MINIATŰR GENERÁLÁS — Nyers első oldal elmentése ══
// Egyszerű megoldás: az első oldal KÉPÉT mentjük el közvetlenül, nem tömörítünk.
// Így nem veszítjük el a minőséget. A CSS object-fit:cover majd szépen bevágja a keretbe.
async function generateThumbIfMissing(book){
  if(book.thumb)return;
  try{
    const p=pages[0];
    if(!p)return;

    // A nyers blob-ot használjuk közvetlenül
    let sourceBlob=null;
    if(p._blob){
      sourceBlob=p._blob;
    }else if(p._gb){
      sourceBlob=await p._gb();
      p._blob=sourceBlob;
      if(!p.dataUrl)p.dataUrl=URL.createObjectURL(sourceBlob);
    }else if(p.dataUrl){
      const resp=await fetch(p.dataUrl);
      sourceBlob=await resp.blob();
    }
    if(!sourceBlob)return;

    // Blob → base64 dataUrl konverzió tömörítés nélkül
    const dataUrl=await new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=e=>res(e.target.result);
      r.onerror=rej;
      r.readAsDataURL(sourceBlob);
    });

    // Ha nagyon nagy (>1.5MB), akkor enyhén tömörítsük — különben localStorage kvóta bug
    let finalThumb=dataUrl;
    if(sourceBlob.size > 1.5*1024*1024){
      // Csak nagy képeknél: töltsük be img-be és mentsük el 1200px szélesre JPEG 95%-kal
      const img=await new Promise((res,rej)=>{
        const i=new Image();
        const url=URL.createObjectURL(sourceBlob);
        i.onload=()=>{URL.revokeObjectURL(url);res(i);};
        i.onerror=()=>{URL.revokeObjectURL(url);rej();};
        i.src=url;
      });
      const targetW=1200;
      if(img.width>targetW){
        // Csak ha tényleg nagyobb mint 1200, akkor kicsinyítünk
        const ratio=targetW/img.width;
        const cv=document.createElement('canvas');
        cv.width=targetW;cv.height=Math.round(img.height*ratio);
        const ctx=cv.getContext('2d');
        ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,0,0,cv.width,cv.height);
        finalThumb=cv.toDataURL('image/jpeg',0.95);
        console.log(`[thumb] ${book.title}: ${img.width}x${img.height} → ${cv.width}x${cv.height}, ${(finalThumb.length/1024).toFixed(0)}KB`);
      }else{
        console.log(`[thumb] ${book.title}: ${img.width}x${img.height} (nyers, nem kicsinyítve), ${(dataUrl.length/1024).toFixed(0)}KB`);
      }
    }else{
      console.log(`[thumb] ${book.title}: blob ${(sourceBlob.size/1024).toFixed(0)}KB (nyers megtartva)`);
    }

    book.thumb=finalThumb;
    // Mentés a bl_library-be
    try{
      let saved=null;try{saved=JSON.parse(localStorage.getItem('bl_library')||'null');}catch(e){console.warn('[lib] sérült bl_library:',e.message);}
      if(saved&&saved.books){
        const entry=saved.books.find(b=>b.key===book.key);
        if(entry){entry.thumb=finalThumb;localStorage.setItem('bl_library',JSON.stringify(saved));}
      }
    }catch(e){
      // localStorage kvóta: ha tele van, csökkentsük és próbáljuk újra
      console.warn('thumb mentés, próbálkozom kisebb mérettel:',e);
      try{
        const img=await new Promise((res,rej)=>{
          const i=new Image();
          const url=URL.createObjectURL(sourceBlob);
          i.onload=()=>{URL.revokeObjectURL(url);res(i);};
          i.onerror=()=>{URL.revokeObjectURL(url);rej();};
          i.src=url;
        });
        const cv=document.createElement('canvas');
        cv.width=800;cv.height=Math.round(img.height*(800/img.width));
        const ctx=cv.getContext('2d');
        ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,0,0,cv.width,cv.height);
        const smaller=cv.toDataURL('image/jpeg',0.88);
        book.thumb=smaller;
        let saved=null;try{saved=JSON.parse(localStorage.getItem('bl_library')||'null');}catch(e){console.warn('[lib] sérült bl_library:',e.message);}
        if(saved&&saved.books){
          const entry=saved.books.find(b=>b.key===book.key);
          if(entry){entry.thumb=smaller;localStorage.setItem('bl_library',JSON.stringify(saved));}
        }
      }catch(e2){console.warn('thumb fallback mentés is elbukott:',e2);}
    }
  }catch(e){console.warn('thumb generálás:',e);}
}

// ══ Borítók tömeges újragenerálása ══
async function regenerateAllThumbs(){
  // Csak a cachelt könyveknél megy (van file objektum)
  const eligible=library.filter(b=>b.file&&!b.pending);
  if(!eligible.length){
    setSt('warn','Nincs cachelt könyv. Először nyiss meg könyveket!');
    return;
  }
  if(!confirm(`${eligible.length} könyv borítóját regeneráljuk magas felbontásban. Eltarthat egy ideig. Folytassuk?`))return;

  // Régi pages mentése (ha épp nyitva van egy könyv)
  const savedPages=pages;
  const savedBookKey=curBookKey;

  let done=0;
  for(const book of eligible){
    setSt('loading',`Borító regenerálás: ${done+1}/${eligible.length} — ${book.title.slice(0,40)}...`,true);
    setProg(done,eligible.length);
    try{
      // Kényszerítjük az újragenerálást
      book.thumb=null;
      // Ideiglenesen kicseréljük a pages-et
      pages=[];
      // Csak az első oldalra van szükség
      const f=book.file;
      const ext=book.type;
      if(ext==='cbz'||ext==='zip'){
        await lCBZ(f);
      }else if(ext==='cbr'){
        await lCBR(f);
      }else if(ext==='pdf'){
        await lPDF(f);
      }else if(/^(jpg|jpeg|png|webp)$/.test(ext)){
        pages=[{dataUrl:null,base64:null,bubbles:null,_gb:async()=>f}];
      }
      if(pages.length){
        // Kényszerítjük a thumb generálást
        const tmp={...book,thumb:null,key:book.key};
        curBookKey=book.key;
        await generateThumbIfMissing(tmp);
        if(tmp.thumb){
          book.thumb=tmp.thumb;
        }
      }
    }catch(e){console.warn('regen thumb:',book.title,e);}
    done++;
    await new Promise(r=>setTimeout(r,50));
  }

  // Visszaállítjuk az eredeti állapotot
  pages=savedPages;
  curBookKey=savedBookKey;

  setSt('success',`✓ ${done} borító regenerálva!`);
  renderLib();
}

// Automatikus UI-elrejtő időzítő
let _autoImmT=null;
function scheduleAutoImm(){
  if(_autoImmT)clearTimeout(_autoImmT);
  _autoImmT=setTimeout(()=>{
    // Csak akkor rejtjük el, ha a reader aktív és nem már imm módban
    if(document.body.classList.contains('reader-active')&&!document.body.classList.contains('imm')){
      toggleImm();
    }
  },5000);
}
function cancelAutoImm(){
  if(_autoImmT){clearTimeout(_autoImmT);_autoImmT=null;}
}
function saveMeta(){
  if(!curBookKey)return;
  const book=library.find(b=>b.key===curBookKey);if(!book)return;
  try{
    localStorage.setItem(curBookKey+'_meta',JSON.stringify({
      title:book.title,type:book.type,
      curPage:book.curPage,pageCount:book.pageCount,lastRead:book.lastRead,
    }));
  }catch(e){console.warn('meta save failed:',e);}
  // Frissítjük a bl_library-t is, hogy a kezdőképernyőn is jó legyen a haladás
  try{
    let saved=null;try{saved=JSON.parse(localStorage.getItem('bl_library')||'null');}catch(e){console.warn('[lib] sérült bl_library:',e.message);}
    if(saved&&saved.books){
      const entry=saved.books.find(b=>b.key===curBookKey);
      if(entry){
        entry.curPage=book.curPage;
        entry.pageCount=book.pageCount;
        entry.lastRead=book.lastRead;
        localStorage.setItem('bl_library',JSON.stringify(saved));
      }
    }
  }catch(e){console.warn('bl_library frissítés:',e);}
}
async function saveProgress(){
  if(!curBookKey)return;
  const book=library.find(b=>b.key===curBookKey);if(!book)return;
  book.curPage=cur;book.lastRead=Date.now();
  // Frissítjük a könyv-meta `transPageCount` mezőjét — gyors statisztikához
  if(pages && pages.length){
    book.transPageCount = pages.filter(p => p && p.bubbles && p.bubbles.length).length;
  }
  saveMeta();
  // Fordítás-mentés: csak az AKTUÁLIS lapot (lap-szintű IDB)
  // Ezt akkor hívjuk amikor lapozunk vagy menetni akarunk — minden lapozáskor
  // CSAK az aktuális lapot mentjük IDB-be, nem az egész könyvet újra. Gyors.
  if(_idbTransReady){
    const cb = pages[cur]?.bubbles;
    if(cb !== undefined){ // null is OK — törli ha üres
      try{
        await idbTransPut(curBookKey, cur, cb);
      }catch(e){ console.warn('IDB-Trans write hiba:', e.message); }
    }
  }else{
    // Fallback localStorage-be (régi mód) — csak ha az IDB nem működne
    const transPages=pages.map(p=>p.bubbles||null);
    const hasAny=transPages.some(p=>p&&p.length);
    if(hasAny){
      const transData=JSON.stringify({pages:transPages});
      try{
        localStorage.setItem(curBookKey+'_trans',transData);
      }catch(e){
        console.warn('trans save failed (localStorage):',e.message);
        const freedKB = cleanupOldTranslations(curBookKey, transData.length);
        try{ localStorage.setItem(curBookKey+'_trans',transData); }
        catch(e2){
          try{
            const minimal=JSON.stringify({pages:transPages.map((p,i)=>i===cur?p:null)});
            localStorage.setItem(curBookKey+'_trans',minimal);
          }catch(e3){ /* csendes */ }
        }
      }
    }
  }
}

// Egy lap fordításának kifejezett mentése — pl. fordítás után rögtön
// hogy ne csak lapozáskor mentődjön
async function saveCurrentPageTranslation(){
  if(!curBookKey || !_idbTransReady) return;
  const cb = pages[cur]?.bubbles;
  if(cb !== undefined){
    try{ await idbTransPut(curBookKey, cur, cb); }
    catch(e){ console.warn('IDB-Trans write hiba:', e.message); }
  }
}

// Régi (nem aktív) könyvek fordításának törlése helyfelszabadítás céljából.
// Visszaadja: hány kilobyte-ot szabadított fel.
function cleanupOldTranslations(keepKey, neededBytes){
  // Az utoljára olvasott időpont szerint rendezzük: a legrégebbieket törölhetjük
  const sortedBooks=[...library].sort((a,b)=>(a.lastRead||0)-(b.lastRead||0));
  let freedBytes=0;
  for(const b of sortedBooks){
    if(b.key===keepKey)continue; // a jelenlegit hagyjuk
    const transKey=b.key+'_trans';
    const data=localStorage.getItem(transKey);
    if(!data)continue;
    const size=data.length;
    try{
      localStorage.removeItem(transKey);
      freedBytes+=size;
      console.log(`[cleanup] törölve: ${b.title} (${(size/1024).toFixed(1)} KB)`);
      // Ha már elég helyet szabadítottunk fel + 50% biztonsági ráhagyás, álljunk meg
      if(freedBytes>neededBytes*1.5)break;
    }catch(e){console.warn('[cleanup] hiba:',e);}
  }
  return Math.round(freedBytes/1024);
}
// ══ FILE LOADERS ══
function nsort(a,b){
  // Fájlnév kinyerése (almappa neve ne befolyásoljon)
  const ba=a.replace(/^.*[\\/]/,'');
  const bb=b.replace(/^.*[\\/]/,'');
  // Az első számsorozat kinyerése a fájlnévből
  const na=ba.match(/\d+/); const nb=bb.match(/\d+/);
  // Ha csak az egyiknek van száma, az kerül előre
  // (pl. "Credits.jpg" vs "page001.jpg" → page001 előre)
  if(na&&!nb)return -1;
  if(!na&&nb)return 1;
  // Ha mindkettőnek van száma, numerikusan hasonlítjuk
  if(na&&nb){const d=parseInt(na[0])-parseInt(nb[0]);if(d)return d;}
  // Azonos szám vagy mindkettő számmentes → teljes localeCompare
  return ba.localeCompare(bb,undefined,{numeric:true,sensitivity:'base'})||
         a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});
}
function b64(blob){return new Promise((r,j)=>{const f=new FileReader();f.onload=e=>r(e.target.result.split(',')[1]);f.onerror=j;f.readAsDataURL(blob);});}
async function ensureLoaded(idx){
  const p=pages[idx];if(!p||p.dataUrl)return;
  if(p._gb){const blob=await p._gb();p.dataUrl=URL.createObjectURL(blob);p._blob=blob;delete p._gb;
    const imgs=document.querySelectorAll('.th img');if(imgs[idx])imgs[idx].src=p.dataUrl;}
}
async function ensureB64(idx){
  const p=pages[idx];if(p.base64)return;
  if(p._blob){p.base64=await compressB64(p._blob);return;}
  if(p.dataUrl?.startsWith('blob:')){const r=await fetch(p.dataUrl);const bl=await r.blob();p.base64=await compressB64(bl);}
  else if(p.dataUrl?.startsWith('data:')){
    // Already data URL - check size and compress if needed
    const raw=p.dataUrl.split(',')[1];
    if(raw&&raw.length*0.75>4*1024*1024){p.base64=await compressDataUrl(p.dataUrl);}
    else{p.base64=raw;}
  }
}

async function compressB64(blob){
  // If under 4MB, just convert
  if(blob.size<4*1024*1024){return new Promise((r,j)=>{const f=new FileReader();f.onload=e=>r(e.target.result.split(',')[1]);f.onerror=j;f.readAsDataURL(blob);});}
  // Compress via canvas
  return new Promise(r=>{
    const img=new Image();const u=URL.createObjectURL(blob);
    img.onload=()=>{
      URL.revokeObjectURL(u);
      let q=0.85,scale=1.0;
      if(blob.size>10*1024*1024)scale=0.7;
      else if(blob.size>6*1024*1024)scale=0.85;
      const cv=document.createElement('canvas');
      cv.width=Math.round(img.width*scale);cv.height=Math.round(img.height*scale);
      cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
      const tryQ=(quality)=>{
        const data=cv.toDataURL('image/jpeg',quality);
        const size=data.length*0.75;
        if(size<4*1024*1024||quality<0.4){r(data.split(',')[1]);}
        else{tryQ(quality-0.1);}
      };
      tryQ(q);
    };
    img.onerror=()=>{URL.revokeObjectURL(u);r(null);};
    img.src=u;
  });
}

async function compressDataUrl(dataUrl){
  return new Promise(r=>{
    const img=new Image();
    img.onload=()=>{
      const cv=document.createElement('canvas');cv.width=img.width;cv.height=img.height;
      cv.getContext('2d').drawImage(img,0,0);
      const tryQ=(q)=>{const d=cv.toDataURL('image/jpeg',q);if(d.length*0.75<4*1024*1024||q<0.4){r(d.split(',')[1]);}else tryQ(q-0.1);};
      tryQ(0.85);
    };
    img.src=dataUrl;
  });
}
function preload(idx){[-2,-1,0,1,2].forEach(d=>{const i=idx+d;if(i>=0&&i<pages.length&&pages[i]&&!pages[i].dataUrl)ensureLoaded(i);});}
async function lImg(file){const u=await new Promise((r,j)=>{const fr=new FileReader();fr.onload=e=>r(e.target.result);fr.onerror=j;fr.readAsDataURL(file);});pages=[{dataUrl:u,base64:u.split(',')[1],bubbles:null}];}
async function lPDF(file){await rPdf();setSt('loading','PDF...');const buf=await file.arrayBuffer();const pdf=await pdfjsLib.getDocument({data:buf}).promise;for(let i=0;i<pdf.numPages;i++){const pn=i+1;pages.push({dataUrl:null,base64:null,bubbles:null,_gb:async()=>{const pg=await pdf.getPage(pn);const vp=pg.getViewport({scale:2});const cv=document.createElement('canvas');cv.width=vp.width;cv.height=vp.height;await pg.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;return new Promise(r=>cv.toBlob(r,'image/jpeg',.92));}});}}
async function lCBZ(file){if(!window.JSZip)await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');setSt('loading','CBZ...');const zip=await JSZip.loadAsync(await file.arrayBuffer());const names=Object.keys(zip.files).filter(n=>/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(n)&&!zip.files[n].dir).sort(nsort);if(!names.length)throw new Error('Nincs kép a CBZ-ben.');
  // Diagnosztika: megmutatja az első és utolsó 5 fájlnevet
  if(names.length){
    const preview=n=>n.length>50?'...'+n.slice(-47):n;
    const head=names.slice(0,5).map((n,i)=>`[${i}] ${preview(n)}`).join('\n');
    const tail=names.length>5?'\n...\n'+names.slice(-5).map((n,i)=>`[${names.length-5+i}] ${preview(n)}`).join('\n'):'';
    diag(`CBZ lapok (${names.length} db):\n${head}${tail}`);
  }
  for(const n of names)pages.push({dataUrl:null,base64:null,bubbles:null,_gb:()=>zip.files[n].async('blob')});}
async function lCBR(file){
  try{ await rArch(); }
  catch(e){
    throw new Error('CBR megnyitása sikertelen — beágyazott unrar nem töltődött be: '+e.message);
  }
  setSt('loading','CBR...');
  const buf=await file.arrayBuffer();
  const extractor=await window._unrarCreate({data:new Uint8Array(buf)});
  const list=extractor.getFileList();
  const fileHeaders=[];
  for(const h of list.fileHeaders)fileHeaders.push(h);
  const imgs=fileHeaders
    .filter(h=>!h.flags.directory&&/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(h.name));
  if(!imgs.length)throw new Error('Nincs kép a CBR-ben.');
  // MINDIG fájlnév sorrend — az extracted.files archív sorrendben jön vissza,
  // ezért a kinyert fájlokat is fájlnév szerint kell rendezni.
  // (A RAR belső sorrendje nem megbízható — pl. SiP v02-ben -011 jön először,
  //  -001 az utolsó 10-ben, de a helyes olvasási sorrend -001-gyel kezdődik.)
  const imgsSorted=[...imgs].sort((a,b)=>nsort(a.name,b.name));
  // Diagnosztika
  {
    const preview=n=>n.length>55?'...'+n.slice(-52):n;
    const show=imgsSorted;
    const head=show.slice(0,8).map((h,i)=>`[${i}] ${preview(h.name)}`).join('\n');
    const mid=show.length>20?'\n---[175-183]---\n'+show.slice(175,183).map((h,i)=>`[${175+i}] ${preview(h.name)}`).join('\n'):'';
    const tail=show.length>8?'\n...\n'+show.slice(-5).map((h,i)=>`[${show.length-5+i}] ${preview(h.name)}`).join('\n'):'';
    diag(`CBR (${imgsSorted.length} db, fájlnév sorrend):\n${head}${mid}${tail}`);
  }
  // Kicsomagolás — extracted.files visszarendezése fájlnév szerint
  const extracted=extractor.extract({files:imgsSorted.map(h=>h.name)});
  const nameOrder=new Map(imgsSorted.map((h,i)=>[h.name,i]));
  const sortedFiles=[...extracted.files].sort((a,b)=>{
    const ia=nameOrder.get(a.fileHeader.name)??9999;
    const ib=nameOrder.get(b.fileHeader.name)??9999;
    return ia-ib;
  });
  for(const f of sortedFiles){
    if(!f.extraction)continue;
    const ext=(f.fileHeader.name.split('.').pop()||'jpg').toLowerCase();
    const mime=ext==='jpg'||ext==='jpeg'?'image/jpeg':ext==='png'?'image/png':ext==='gif'?'image/gif':ext==='webp'?'image/webp':'image/jpeg';
    const blob=new Blob([f.extraction],{type:mime});
    pages.push({dataUrl:null,base64:null,bubbles:null,_gb:async()=>blob});
  }
  if(!pages.length)throw new Error('Nem sikerült képeket kicsomagolni.');
  if(curBookKey){const book=library.find(b=>b.key===curBookKey);if(book&&!book.pageCount){book.pageCount=pages.length;saveMeta();}}
}
// ══ RENDER PAGE ══
function renderPage(){
  clearLot();
  const p=pages[cur];if(!p)return;
  if(!p.dataUrl){cimg.src='';ensureLoaded(cur).then(()=>{if(pages[cur]===p)cimg.src=p.dataUrl||'';});}
  else cimg.src=p.dataUrl;
  preload(cur);
  // Toolbar
  document.getElementById('pctr-txt').textContent=`${cur+1} / ${pages.length}`;
  document.getElementById('nl').classList.toggle('dis',cur===0);
  document.getElementById('nr').classList.toggle('dis',cur===pages.length-1);
  // Translate buttons
  const hasBub=p.bubbles!==null&&p.bubbles!==undefined;
  const hasTxt=hasBub&&p.bubbles.length>0;
  const tb=document.getElementById('btn-trans');tb.disabled=loading;tb.textContent=hasTxt?'🔄 ÚJRA':'🔍 FORDÍTÁS';
  const tball=document.getElementById('btn-transall');tball.style.display=pages.every(pg=>pg.bubbles!==null)?'none':'inline-block';
  // Immersive
  const it=document.getElementById('ib-trans');it.disabled=loading;
  const ip=document.getElementById('imm-pctr');if(ip)ip.textContent=`${cur+1} / ${pages.length}`;
  // Bubbles
  renderBub(p.bubbles||[]);
  if(hasTxt)renderTrans(p.bubbles);
  else document.getElementById('trows').innerHTML='<div style="padding:10px;font-family:monospace;font-size:.78rem;color:#555">Még nincs fordítva.</div>';
  updateThumbs();
  document.getElementById('blayer').style.setProperty('--layer-x','0px');
  // Immerzív progress bar frissítés
  const progFill=document.getElementById('imm-progress-fill');
  if(progFill&&pages.length){
    const pct=((cur+1)/pages.length)*100;
    progFill.style.width=pct+'%';
  }
}

// Immerzív progress bar: koppintás → ugrás arra az oldalra
function immProgressJump(ev){
  if(!pages.length)return;
  const bar=document.getElementById('imm-progress');
  const rect=bar.getBoundingClientRect();
  const x=ev.clientX-rect.left;
  const ratio=Math.max(0,Math.min(1,x/rect.width));
  const newPage=Math.floor(ratio*pages.length);
  if(newPage!==cur&&newPage>=0&&newPage<pages.length){
    cur=newPage;
    if(typeof resetZoom==='function')resetZoom();
    ensureLoaded(cur).then(renderPage);
    if(typeof scrollThumb==='function')scrollThumb();
    if(typeof saveProgress==='function')saveProgress();
  }
}

// ══ BUBBLES ══


// ── Font stílus → Magyar-kompatibilis font mapping ────────────────────────
const FONT_MAP = {
  'bold_display': "'Bangers HU',cursive",
  'rounded':      "'Fredoka HU',sans-serif",
  'handwritten':  "'Caveat HU',cursive",
  'print':        "'Patrick Hand HU','Patrick Hand',sans-serif",
};
function getFontFamily(fontStyle){
  return FONT_MAP[fontStyle] || FONT_MAP['print'];
}
// ── Bubble szín segédfüggvények ────────────────────────────────────────────
function hexToRgba(hex,alpha){
  hex=hex.replace('#','');
  if(hex.length===3)hex=hex.split('').map(c=>c+c).join('');
  const r=parseInt(hex.slice(0,2),16);
  const g=parseInt(hex.slice(2,4),16);
  const b=parseInt(hex.slice(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function isDark(hex){
  hex=hex.replace('#','');
  if(hex.length===3)hex=hex.split('').map(c=>c+c).join('');
  const r=parseInt(hex.slice(0,2),16);
  const g=parseInt(hex.slice(2,4),16);
  const b=parseInt(hex.slice(4,6),16);
  return (r*299+g*587+b*114)/1000 < 128;
}

// ── Overlay szöveg toggle ──────────────────────────────────────────────────
let overlaysVisible=true;
function toggleOverlays(){
  overlaysVisible=!overlaysVisible;
  const btn=document.getElementById('ov-btn');
  if(btn){
    btn.classList.toggle('active',!overlaysVisible);
    btn.title=overlaysVisible?'Overlay szöveg elrejtése':'Overlay szöveg megjelenítése';
  }
  document.querySelectorAll('.bub.overlay').forEach(el=>{
    el.classList.toggle('ov-hidden',!overlaysVisible);
  });
}




// ── Szín + font matching kapcsoló ─────────────────────────────────────────
let styleMatchEnabled = true;
function toggleStyleMatch(){
  styleMatchEnabled = !styleMatchEnabled;
  const btn = document.getElementById('style-match-btn');
  const lbl = document.getElementById('smb-label');
  if(btn) btn.classList.toggle('active', styleMatchEnabled);
  if(lbl) lbl.textContent = styleMatchEnabled ? 'BE' : 'KI';
  // Újrarajzolja az aktuális oldalt
  const p = pages[cur];
  if(p?.bubbles) renderBub(p.bubbles);
}



// ── Közeli azonos-speaker buborékok összevonása ───────────────────────────────
function mergeNearbySpeakers(bubs) {
  if(!bubs || bubs.length < 2) return bubs;
  
  // Y szerint rendezzük
  const sorted = [...bubs].sort((a,b) => a.y - b.y);
  const merged = [];
  let skip = new Set();

  for(let i = 0; i < sorted.length; i++) {
    if(skip.has(i)) continue;
    const a = sorted[i];
    
    // Csak "bubble" típusú elemeket vonunk össze, és csak ha van speaker
    if((a.type||'bubble') !== 'bubble' || !a.speaker || 
       a.speaker === 'narrator' || a.speaker === 'sfx' || a.speaker === 'overlay') {
      merged.push(a);
      continue;
    }

    // Keresünk összevonható szomszédokat
    let group = [a];
    for(let j = i+1; j < sorted.length; j++) {
      if(skip.has(j)) continue;
      const b = sorted[j];
      
      // Feltételek: ugyanaz a speaker, bubble típus, közel van y-ban, hasonló x-en
      const sameSpkr = b.speaker === a.speaker;
      const sameType = (b.type||'bubble') === 'bubble';
      const lastInGroup = group[group.length-1];
      const yGap = b.y - (lastInGroup.y + lastInGroup.h); // köz a két buborék közt
      const xOverlap = Math.abs(b.x - a.x) < 0.20; // vízszintesen hasonló helyen
      const close = yGap < 0.05; // 5%-nál kisebb y-rés

      if(sameSpkr && sameType && close && xOverlap) {
        group.push(b);
        skip.add(j);
      } else if(yGap > 0.08) {
        break; // túl messze van, nem keresünk tovább
      }
    }

    if(group.length === 1) {
      merged.push(a);
    } else {
      // Összevonjuk: bounding box = az összes lefedése, szöveg = összefűzve
      const x = Math.min(...group.map(b => b.x));
      const y = Math.min(...group.map(b => b.y));
      const x2 = Math.max(...group.map(b => b.x + b.w));
      const y2 = Math.max(...group.map(b => b.y + b.h));
      merged.push({
        ...a,
        x, y, w: x2-x, h: y2-y,
        original:  group.map(b => b.original).join(' '),
        hungarian: group.map(b => b.hungarian||b.original).join(' '),
      });
    }
  }
  return merged;
}


// ── Képszeletelés + többlépéses fordítás sűrű szöveges oldalakhoz ─────────────
async function splitAndTranslate(b64, idx, slices=2) {
  // Az 1-szeletes hibrid módoknál (W) NEM szeletelünk: az egész lapot egyben dolgozzuk fel
  // — nincs vágási vonal → nincs átvágott buborék → nincs eldobott szöveg
  if(isHybridSingleSlice(selModel)){
    slices = 1;
    diag(`Egész-lap mód (${selModel}) — szeletelés kikapcsolva`);
  }
  const img = await new Promise((res,rej)=>{
    const i=new Image(); i.onload=()=>res(i); i.onerror=rej;
    i.src='data:image/jpeg;base64,'+b64;
  });
  const W=img.width, H=img.height;
  const OVERLAP = 0.20; // 20% átfedés — biztosan ne vágódjanak félbe a nagy buborékok
  const sliceH = Math.ceil(H/slices);
  const results = [];
  let prevSliceTail = null; // az előző szelet utolsó buboréka, ha folytatást jelez
  let anyHitLimit = false;

  for(let s=0; s<slices; s++){
    // Átfedéssel vágunk: kicsit feljebb kezdjük az alsó szeleteket
    const y0 = Math.max(0, s*sliceH - Math.round(H*OVERLAP/2));
    const y1 = Math.min(H, (s+1)*sliceH + Math.round(H*OVERLAP/2));
    const h  = y1 - y0;

    const cv = document.createElement('canvas');
    cv.width=W; cv.height=h;
    cv.getContext('2d').drawImage(img, 0,y0, W,h, 0,0, W,h);
    const sliceB64 = cv.toDataURL('image/jpeg',0.92).split(',')[1];

    setSt('loading', `Szeletelve fordítás: ${s+1}/${slices}...`);
    diag(`Szelet ${s+1}/${slices} indul...`);
    let bubs;
    try {
      // Provider routing: a selModel alapján döntjük el
      if(isHybridModel(selModel)){
        bubs = await hybridFullSlice(sliceB64, idx, s, slices, prevSliceTail);
      } else if(isGeminiModel(selModel)){
        bubs = await geminiFullSlice(sliceB64, idx, s, slices, prevSliceTail);
      } else {
        bubs = await claudeFullSlice(sliceB64, idx, s, slices, prevSliceTail);
      }
      diag(`Szelet ${s+1}: ${bubs.length} buborék találva, hitLimit=${bubs._hitLimit?'IGEN':'nem'}`, bubs._hitLimit?'warn':'ok');

      // Ha elérte a token-limitet, a csonka utolsó buborék már le van vágva,
      // de még hiányozhatnak buborékok. PRÓBÁZUS módban kérjük újra hogy meglegyenek.
      if(bubs && bubs._hitLimit){
        anyHitLimit = true;
        console.log('[trans] hitLimit szelet',s+1,'-> próza módban kiegészítés');
        diag(`→ próza módban újrapróbálás...`,'warn');
        try{
          // Hibrid esetén a próza-mode-ot a fordítónk modelljével csináljuk
          const proseRetry = isHybridModel(selModel)
            ? await claudeProse(sliceB64, idx)  // a hibrid fallback-je most claudeProse
            : (isGeminiModel(selModel)
                ? await geminiProse(sliceB64, idx)
                : await claudeProse(sliceB64, idx));
          // Ha próza-mód többet talált, használjuk azt — különben a JSON-listával maradunk
          if(proseRetry.length > bubs.length){
            console.log('[trans] próza retry:',proseRetry.length,'> JSON',bubs.length,'— próza nyer');
            diag(`Próza ${proseRetry.length} > JSON ${bubs.length}, próza nyer`,'ok');
            bubs = proseRetry;
          } else {
            diag(`Próza ${proseRetry.length} ≤ JSON ${bubs.length}, JSON marad`);
          }
        }catch(e){console.warn('[trans] próza retry hiba:',e.message); diag('Próza hiba: '+e.message,'err');}
      }
      if(bubs.length === 0){
        bubs = isHybridModel(selModel)
          ? await claudeProse(sliceB64, idx)
          : (isGeminiModel(selModel)
              ? await geminiProse(sliceB64, idx)
              : await claudeProse(sliceB64, idx));
      }
    }
    catch(e) { bubs = []; diag('Szelet hiba: '+e.message,'err'); }

    const yOffset = y0/H;
    const yScale  = h/H;
    bubs = bubs.map(b=>({...b, y: yOffset + b.y*yScale, h: b.h*yScale}));
    results.push(...bubs);

    // Ha ennek a szeletnek az utolsó buboréka folytatást jelez, átadjuk kontextusként a következőnek
    prevSliceTail = null;
    if(bubs.length){
      const last = bubs[bubs.length-1];
      const ot = (last.original||'').trim();
      if(ot.endsWith('...')||ot.endsWith('--')||ot.endsWith('—')){
        prevSliceTail = last;
      }
    }

    if(s < slices-1) await sleep(600);
  }

  // Duplikátum eltávolítás az átfedő zónából
  const deduped = [];
  for(const b of results){
    const isDup = deduped.some(a => {
      const ta = (a.original||'').trim().toLowerCase().replace(/\s+/g,' ');
      const tb = (b.original||'').trim().toLowerCase().replace(/\s+/g,' ');
      if(ta.length < 4 || tb.length < 4) return false;
      // Szöveg: teljes egyezés VAGY az egyik tartalmazza a másikat VAGY első 30 char egyezik
      const textMatch = ta === tb ||
        ta.includes(tb) || tb.includes(ta) ||
        ta.slice(0,30) === tb.slice(0,30);
      // Pozíció nem szükséges ha szöveg teljesen egyezik
      if(ta === tb) return true;
      const posMatch = Math.abs(a.x - b.x) < 0.15 && Math.abs(a.y - b.y) < 0.12;
      return textMatch && posMatch;
    });
    if(!isDup) deduped.push(b);
  }
  if(anyHitLimit) deduped._anyHitLimit = true;
  return deduped;
}


async function claudeProse(b64, idx) {
  // Folyószöveges oldalhoz speciális prompt
  const apiKey = document.getElementById('api-key').value.trim();
  if(!apiKey) throw new Error('Claude API kulcs szükséges!');
  const prompt = `This is a page of prose/dialogue text (not a comic with speech bubbles).
Translate ALL visible text to Hungarian. Extract each paragraph/speech line as a separate element.
For each text block: give the original text, Hungarian translation, and bounding box (x,y,w,h as 0.0-1.0).
Group lines that belong together (same speaker, same paragraph) into one element.
Return ONLY JSON array:
[{"original":"...","hungarian":"...","type":"caption","bg":"#ffffff","font_style":"print","speaker":"narrator","x":0.0,"y":0.0,"w":0.0,"h":0.0}]`;
  const res = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:selModel,max_tokens:16384,messages:[{role:'user',content:[
      {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
      {type:'text',text:prompt}
    ]}]})
  });
  const data = await res.json();
  if(data.error) throw new Error(data.error.message);
  const raw = data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
  try { return JSON.parse(raw).filter(b=>(b.original||'').trim().length>0); }
  catch {
    try {
      const fixed = raw.replace(/,\s*\{[^}]*$/,'').replace(/,\s*$/,'').trimEnd();
      return JSON.parse(fixed+']').filter(b=>(b.original||'').trim().length>0);
    } catch { return []; }
  }
}

// Oldal típus felismerés: ha fehér/világos háttér + kevés buborék → prose mód
function isProsePageLikely(bubs) {
  // Ha üres vagy csak 1-2 elem jött vissza egy komplex oldalról → prose
  return bubs.length <= 2;
}


// ── 20×20 rács rajzolása a képre Claude számára ──────────────────────────────
function drawGridOnImage(b64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = img.width, H = img.height;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const COLS = 20, ROWS = 20;
      const cellW = W / COLS, cellH = H / ROWS;

      // Rácsvonalak — halvány fehér, hogy ne takarja a tartalmat
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      for(let c = 0; c <= COLS; c++){
        ctx.beginPath();
        ctx.moveTo(c * cellW, 0);
        ctx.lineTo(c * cellW, H);
        ctx.stroke();
      }
      for(let r = 0; r <= ROWS; r++){
        ctx.beginPath();
        ctx.moveTo(0, r * cellH);
        ctx.lineTo(W, r * cellH);
        ctx.stroke();
      }

      // Oszlop számok felül (1-20)
      ctx.fillStyle = 'rgba(255,255,0,0.85)';
      ctx.font = `bold ${Math.max(10, Math.round(cellW * 0.45))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for(let c = 0; c < COLS; c++){
        ctx.fillText(String(c+1), (c + 0.5) * cellW, 2);
      }

      // Sor betűk bal oldalt (A-T)
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const rowLabels = 'ABCDEFGHIJKLMNOPQRST';
      for(let r = 0; r < ROWS; r++){
        ctx.fillText(rowLabels[r], 2, (r + 0.5) * cellH);
      }

      resolve(cv.toDataURL('image/jpeg', 0.92).split(',')[1]);
    };
    img.src = 'data:image/jpeg;base64,' + b64;
  });
}

// Rács-koordinátát visszaszámít 0-1 értékre
// pl. col=3 (1-alapú) → x = (3-1)/20 = 0.10
function gridToFloat(colOrRow, total=20) {
  return (colOrRow - 1) / total;
}
function gridSizeToFloat(size, total=20) {
  return size / total;
}

// JSON buborékok rács-koordinátáinak konvertálása (ha Claude rácsot adott vissza)
function convertGridBubs(bubs) {
  return bubs.map(b => {
    // Ha Claude col/row mezőket adott vissza grid módban
    if(b.col !== undefined && b.row !== undefined) {
      return {
        ...b,
        x: gridToFloat(b.col),
        y: gridToFloat(b.row),
        w: gridSizeToFloat(b.col_span || 2),
        h: gridSizeToFloat(b.row_span || 2),
      };
    }
    return b;
  });
}


// ── Szelet-fordítás: levágott buborék kihagyása ──────────────────────────────
async function claudeFullSlice(b64, idx, sliceIdx, totalSlices, prevSliceTail) {
  const apiKey = document.getElementById('api-key').value.trim();
  if(!apiKey) throw new Error('Claude API kulcs szükséges!');
  b64 = await drawGridOnImage(b64);

  const isFirst = sliceIdx === 0;
  const isLast  = sliceIdx === totalSlices - 1;
  const cutNote = [
    !isFirst ? 'CRITICAL: This is a slice. The TOP edge may cut through a bubble. SKIP COMPLETELY any bubble where you cannot see all the text — if the top of a bubble is cut and you only see a partial sentence, DO NOT include it. The bubble will be processed in the previous slice.' : '',
    !isLast  ? 'CRITICAL: The BOTTOM edge may cut through a bubble. SKIP COMPLETELY any bubble where you cannot see all the text — if the bottom of a bubble is cut and the sentence is incomplete (no period, question mark, or natural ending), DO NOT include it. The bubble will be processed in the next slice. NEVER guess or invent text you cannot see.' : '',
    'IMPORTANT: Only include bubbles where you can read the ENTIRE text from start to end. If unsure whether a bubble is complete, SKIP IT.',
  ].filter(Boolean).join(' ');

  let ctx='';
  if(idx>0&&pages[idx-1]?.bubbles?.length){const lb=pages[idx-1].bubbles[pages[idx-1].bubbles.length-1];const ot=lb?.original?.trim()||'';if(ot.endsWith('...')||ot.endsWith('--')||ot.endsWith('—'))ctx=`\nContext: Previous page ended with: "${lb.original}" → "${lb.hungarian}".`;}
  if(prevSliceTail&&prevSliceTail.original){ctx+=`\nCross-slice continuation: The previous slice of THIS page ended with "${prevSliceTail.original}" → "${prevSliceTail.hungarian||''}" (ends with "--" or "—"). The first bubble in THIS slice starting with "--" is its direct continuation. Translate that "--" bubble so it grammatically continues "${prevSliceTail.hungarian||''}" (same subject, flowing sentence). Do NOT start a new clause with a new subject.`;}
  const rtl=rtlMode?'\nIMPORTANT MANGA MODE: Right-to-left.':'';

  const prompt=`Analyze this comic/manga page slice. Find ALL text elements.
${cutNote}
For each: extract English, translate to Hungarian, classify type, detect bg color, estimate bounding box using the 20×20 grid (columns 1-20, rows A-T).
Grid: x=(col-1)/20, y=(row-1)/20, w=col_span/20, h=row_span/20.
IMPORTANT: If a speech bubble contains a character name label (like "ELLIE" or "RJ:") followed by dialogue text, treat them as ONE single bubble element — include the name in the original text (e.g. "ELLIE: So are you going to do it?"). Do NOT split name labels and their dialogue into separate elements.
CONTINUATION: When a bubble ends with "--" or "—" and the next bubble starts with "--" or "—", these are parts of one sentence split across bubbles (common in American comics). Translate them as one flowing Hungarian sentence, then split the Hungarian back into the bubbles keeping "--" at the same positions. The second bubble's Hungarian must grammatically continue the first — same subject unless clearly a new speaker. Example: "THIS WAS A CURSE--" / "--KNEW IT WOULD COST US EVERYTHING" → "EZ EGY ÁTOK VOLT--" / "--AMI MINDENÜNKBE FOG KERÜLNI" (continuing "átok" as subject, not starting "I knew" anew).
Font style: "bold_display" ONLY for text that is visually thick/heavy comic lettering. Most normal speech bubbles = "print". Only use "bold_display" for KNOCK KNOCK style big lettering.
Background color: exact hex of bubble fill. Chat bubbles are often light gray (#f0f0f0) or white (#ffffff).
Speaker: same ID for same character. "narrator" for caption boxes, "sfx" for sound effects.${rtl}${ctx}
Return ONLY JSON array:
[{"original":"...","hungarian":"...","type":"bubble","bg":"#ffffff","font_style":"print","speaker":"char_1","x":0.0,"y":0.0,"w":0.0,"h":0.0}]
Return [] if no text.`;

  const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','x-app-name':'BubbleLens'},body:JSON.stringify({model:selModel,max_tokens:16384,messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},{type:'text',text:prompt}]}]})});
  const data=await res.json();if(data.error)throw new Error(data.error.message);
  const hitLimit = data.stop_reason === 'max_tokens';
  const raw=data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();

  // ─── Csonkolás-tudatos JSON-parser ───
  // Ha hitLimit van, az utolsó buborék biztosan csonka — vágjuk le előbb mint hogy parse-oljuk
  let parsed = [];
  function tryParse(jsonStr){
    try{ return JSON.parse(jsonStr).filter(b=>{const t=(b.original||'').replace(/[.…!?•\s*~\-–—]/g,'').trim();return t.length>0;}); }
    catch{ return null; }
  }
  parsed = tryParse(raw);
  if(parsed === null){
    // A JSON törve van — próbáljuk az utolsó (csonka) objektumot levágni
    // Keressük az utolsó vesszőt egy záró kapcsos zárójel után
    let cleaned = raw;
    // Vágjuk le mindent az utolsó "},"  után (amíg jó pozíció)
    const lastClose = cleaned.lastIndexOf('},');
    if(lastClose > 0){
      cleaned = cleaned.slice(0, lastClose + 1) + ']';
      parsed = tryParse(cleaned);
    }
    // Ha még mindig null, próbáljuk záró ]-t hozzáadni
    if(parsed === null){
      parsed = tryParse(raw.replace(/,\s*\{[^}]*$/, '').replace(/,?\s*$/, '') + ']');
    }
    if(parsed === null) parsed = [];
  }

  // Ha hitLimit volt, a tömb utolsó eleme is gyanús — ellenőrizzük hogy mindkét szöveg-mező jól ki van-e töltve
  if(hitLimit && parsed.length > 0){
    const last = parsed[parsed.length - 1];
    const hu = (last.hungarian || '').trim();
    const en = (last.original || '').trim();
    // Ha a magyar fordítás jelentősen rövidebb mint az angol (pl. fele alatti karakter),
    // vagy üres, vagy láthatóan félbehagyott (nem végződik írásjellel) — eldobjuk
    const looksTruncated = !hu ||
      (hu.length < en.length * 0.4 && en.length > 30) ||
      (!/[.!?…\-—]$/.test(hu) && hu.length > 15);
    if(looksTruncated){
      console.log('[trans] hitLimit — utolsó csonka buborék eldobva:', en.slice(0,50), '→', hu.slice(0,50));
      parsed.pop();
    }
    parsed._hitLimit = true;
  }
  return parsed;
}

// ════════════════════════════════════════════════════════════════════════════
// GEMINI API HÍVÓ FÜGGVÉNYEK
// ════════════════════════════════════════════════════════════════════════════
// Pontosan ugyanazt a logikát csinálják mint a claudeFullSlice / claudeProse,
// csak a Google Gemini API formátumában. Az eredmény ugyanaz a buborék-tömb.

async function geminiFullSlice(b64, idx, sliceIdx, totalSlices, prevSliceTail) {
  const apiKey = (document.getElementById('gemini-api-key')?.value || localStorage.getItem('kf_gemini_key') || '').trim();
  if(!apiKey) throw new Error('Gemini API kulcs szükséges! (beállítások → Gemini API kulcs)');
  b64 = await drawGridOnImage(b64);

  const isFirst = sliceIdx === 0;
  const isLast  = sliceIdx === totalSlices - 1;
  const cutNote = [
    !isFirst ? 'CRITICAL: This is a slice. The TOP edge may cut through a bubble. SKIP COMPLETELY any bubble where you cannot see all the text.' : '',
    !isLast  ? 'CRITICAL: The BOTTOM edge may cut through a bubble. SKIP COMPLETELY any bubble where you cannot see all the text.' : '',
    'IMPORTANT: Only include bubbles where you can read the ENTIRE text from start to end. If unsure whether a bubble is complete, SKIP IT.',
  ].filter(Boolean).join(' ');

  let ctx='';
  if(idx>0&&pages[idx-1]?.bubbles?.length){const lb=pages[idx-1].bubbles[pages[idx-1].bubbles.length-1];const ot=lb?.original?.trim()||'';if(ot.endsWith('...')||ot.endsWith('--')||ot.endsWith('—'))ctx=`\nContext: Previous page ended with: "${lb.original}" → "${lb.hungarian}".`;}
  if(prevSliceTail&&prevSliceTail.original){ctx+=`\nCross-slice continuation: The previous slice of THIS page ended with "${prevSliceTail.original}" → "${prevSliceTail.hungarian||''}".`;}
  const rtl=rtlMode?'\nIMPORTANT MANGA MODE: Right-to-left.':'';

  const prompt=`Analyze this comic/manga page slice. Find ALL text elements.
${cutNote}
For each: extract English, translate to Hungarian, classify type, detect bg color, estimate bounding box using the 20×20 grid (columns 1-20, rows A-T).
Grid: x=(col-1)/20, y=(row-1)/20, w=col_span/20, h=row_span/20.
IMPORTANT: If a speech bubble contains a character name label (like "ELLIE" or "RJ:") followed by dialogue text, treat them as ONE single bubble element.
Font style: "bold_display" ONLY for thick/heavy comic lettering. Normal speech bubbles = "print".
Background color: exact hex of bubble fill.
Speaker: same ID for same character. "narrator" for caption boxes, "sfx" for sound effects.${rtl}${ctx}
Return ONLY JSON array (no markdown, no commentary):
[{"original":"...","hungarian":"...","type":"bubble","bg":"#ffffff","font_style":"print","speaker":"char_1","x":0.0,"y":0.0,"w":0.0,"h":0.0}]
Return [] if no text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  console.log('[gemini] kérés indul:', selModel, 'kép-méret:', Math.round(b64.length/1024), 'KB');
  diag(`Gemini hívás: ${selModel.split('-').slice(-2).join('-')}, kép ${Math.round(b64.length/1024)}KB`);
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      contents:[{parts:[
        {inline_data:{mime_type:'image/jpeg',data:b64}},
        {text:prompt}
      ]}],
      generationConfig:{
        temperature:0.3,
        maxOutputTokens:8192,
      },
      safetySettings:[
        {category:'HARM_CATEGORY_HARASSMENT',       threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_HATE_SPEECH',      threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_ONLY_HIGH'},
      ],
    })
  });
  const data = await res.json();
  console.log('[gemini] válasz:', data);
  if(data.error){
    diag('Gemini API HIBA: '+(data.error.message||JSON.stringify(data.error)),'err');
    throw new Error('Gemini: '+(data.error.message||JSON.stringify(data.error)));
  }
  if(!data.candidates || !data.candidates[0]) {
    const fb = JSON.stringify(data.promptFeedback||{});
    console.warn('[gemini] üres válasz, promptFeedback:', fb);
    diag('Gemini ÜRES VÁLASZ. Feedback: '+fb,'warn');
    return [];
  }

  // Finish reason
  const finishReason = data.candidates[0].finishReason;
  console.log('[gemini] finishReason:', finishReason);
  if(finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'BLOCKLIST'){
    const sr = JSON.stringify(data.candidates[0].safetyRatings||[]);
    console.warn('[gemini] BLOKKOLVA:', finishReason, 'ratings:', sr);
    diag('Gemini BLOKKOLT ('+finishReason+'). Ratings: '+sr,'err');
    return [];
  }
  const hitLimit = finishReason === 'MAX_TOKENS';

  // A Gemini válasz formátuma: candidates[0].content.parts[].text
  const partsArr = data.candidates[0].content?.parts || [];
  const raw = partsArr.map(p=>p.text||'').join('').replace(/```json|```/g,'').trim();
  console.log('[gemini] raw hossz:', raw.length, 'első 200ch:', raw.slice(0,200));
  diag(`Gemini válasz: ${raw.length}ch, finishReason: ${finishReason||'N/A'}`);
  if(raw.length < 50){
    diag('Gemini gyanúsan rövid válasz: '+raw,'warn');
  }

  // ─── JSON parse ───
  let parsedG = [];
  function tryParseG(jsonStr){
    try{ return JSON.parse(jsonStr).filter(b=>{const t=(b.original||'').replace(/[.…!?•\s*~\-–—]/g,'').trim();return t.length>0;}); }
    catch{ return null; }
  }
  parsedG = tryParseG(raw);
  if(parsedG === null){
    let cleaned = raw;
    const lastClose = cleaned.lastIndexOf('},');
    if(lastClose > 0){
      cleaned = cleaned.slice(0, lastClose + 1) + ']';
      parsedG = tryParseG(cleaned);
    }
    if(parsedG === null){
      parsedG = tryParseG(raw.replace(/,\s*\{[^}]*$/, '').replace(/,?\s*$/, '') + ']');
    }
    if(parsedG === null) parsedG = [];
  }

  if(hitLimit && parsedG.length > 0){
    const last = parsedG[parsedG.length - 1];
    const hu = (last.hungarian || '').trim();
    const en = (last.original || '').trim();
    const looksTruncated = !hu ||
      (hu.length < en.length * 0.4 && en.length > 30) ||
      (!/[.!?…\-—]$/.test(hu) && hu.length > 15);
    if(looksTruncated){
      console.log('[gemini] hitLimit — utolsó csonka buborék eldobva');
      parsedG.pop();
    }
    parsedG._hitLimit = true;
  }
  return parsedG;
}

async function geminiProse(b64, idx) {
  const apiKey = (document.getElementById('gemini-api-key')?.value || localStorage.getItem('kf_gemini_key') || '').trim();
  if(!apiKey) throw new Error('Gemini API kulcs szükséges!');
  const prompt = `This is a page of prose/dialogue text (not a comic with speech bubbles).
Translate ALL visible text to Hungarian. Extract each paragraph/speech line as a separate element.
For each text block: give the original text, Hungarian translation, and bounding box (x,y,w,h as 0.0-1.0).
Group lines that belong together (same speaker, same paragraph) into one element.
Return ONLY JSON array:
[{"original":"...","hungarian":"...","type":"caption","bg":"#ffffff","font_style":"print","speaker":"narrator","x":0.0,"y":0.0,"w":0.0,"h":0.0}]`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      contents:[{parts:[
        {inline_data:{mime_type:'image/jpeg',data:b64}},
        {text:prompt}
      ]}],
      generationConfig:{temperature:0.3,maxOutputTokens:8192},
      safetySettings:[
        {category:'HARM_CATEGORY_HARASSMENT',       threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_HATE_SPEECH',      threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_ONLY_HIGH'},
      ],
    })
  });
  const data = await res.json();
  if(data.error){
    diag('Gemini próza hiba: '+data.error.message,'err');
    throw new Error('Gemini: '+data.error.message);
  }
  if(!data.candidates || !data.candidates[0]){
    diag('Gemini próza üres válasz. promptFeedback: '+JSON.stringify(data.promptFeedback||{}),'warn');
    return [];
  }
  const finishReason = data.candidates[0].finishReason;
  if(finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'BLOCKLIST'){
    diag('Gemini próza BLOKKOLT: '+finishReason,'err');
    return [];
  }
  const partsArr = data.candidates[0].content?.parts || [];
  const raw = partsArr.map(p=>p.text||'').join('').replace(/```json|```/g,'').trim();
  try { return JSON.parse(raw).filter(b=>(b.original||'').trim().length>0); }
  catch {
    try {
      const fixed = raw.replace(/,\s*\{[^}]*$/,'').replace(/,\s*$/,'').trimEnd();
      return JSON.parse(fixed+']').filter(b=>(b.original||'').trim().length>0);
    } catch { return []; }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HIBRID PIPELINE — geminiOcrOnly + claudeTranslateOnly + hybridFullSlice
// ════════════════════════════════════════════════════════════════════════════
// 1. lépés: Gemini olcsó modellel csak az angol szöveget + pozíciókat kéri
// 2. lépés: Claude-dal kép nélkül csak fordít magyarra (sokkal olcsóbb)
// Eredmény: a teljes Sonnet-pipeline ~50-60%-áért, hasonló minőséggel.

async function geminiOcrOnly(b64, idx, sliceIdx, totalSlices, modelOverride) {
  // Csak az angol szöveget + buborék-pozíciókat kéri vissza, NEM fordít
  const apiKey = (document.getElementById('gemini-api-key')?.value || localStorage.getItem('kf_gemini_key') || '').trim();
  if(!apiKey) throw new Error('Gemini API kulcs szükséges a hibrid pipeline-hoz!');
  b64 = await drawGridOnImage(b64);

  const ocrModel = modelOverride || 'gemini-2.5-flash-lite';
  const isFirst = sliceIdx === 0;
  const isLast  = sliceIdx === totalSlices - 1;
  const cutNote = [
    !isFirst ? 'CRITICAL: This is a slice. The TOP edge may cut through a bubble. SKIP COMPLETELY any bubble where you cannot see all the text.' : '',
    !isLast  ? 'CRITICAL: The BOTTOM edge may cut through a bubble. SKIP COMPLETELY any bubble where you cannot see all the text.' : '',
    'IMPORTANT: Only include bubbles where you can read the ENTIRE text from start to end. If unsure whether a bubble is complete, SKIP IT.',
  ].filter(Boolean).join(' ');

  const rtl = rtlMode ? '\nIMPORTANT MANGA MODE: Right-to-left.' : '';

  // FONTOS: NEM kérünk fordítást — csak az angol szöveget + pozíciót!
  const prompt = `Analyze this comic/manga page slice. Find ALL text elements.
${cutNote}
For each text element: extract the ORIGINAL English text exactly as it appears, classify type, detect bg color, estimate bounding box using the 20×20 grid (columns 1-20, rows A-T).
Grid: x=(col-1)/20, y=(row-1)/20, w=col_span/20, h=row_span/20.
IMPORTANT: If a speech bubble contains a character name label (like "ELLIE" or "RJ:") followed by dialogue text, treat them as ONE single bubble element.
Font style: "bold_display" ONLY for thick/heavy comic lettering. Normal speech bubbles = "print".
Background color: exact hex of bubble fill.
Speaker: same ID for same character. "narrator" for caption boxes, "sfx" for sound effects.${rtl}
DO NOT TRANSLATE. Only extract the original English text.
Return ONLY JSON array (no markdown, no commentary):
[{"original":"...","type":"bubble","bg":"#ffffff","font_style":"print","speaker":"char_1","x":0.0,"y":0.0,"w":0.0,"h":0.0}]
Return [] if no text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${ocrModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  diag(`Hibrid OCR: ${ocrModel.split('-').slice(-2).join('-')}, kép ${Math.round(b64.length/1024)}KB`);
  const res = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      contents:[{parts:[
        {inline_data:{mime_type:'image/jpeg',data:b64}},
        {text:prompt}
      ]}],
      generationConfig:{temperature:0.2, maxOutputTokens:16384},
      safetySettings:[
        {category:'HARM_CATEGORY_HARASSMENT',       threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_HATE_SPEECH',      threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_ONLY_HIGH'},
        {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_ONLY_HIGH'},
      ],
    })
  });
  const data = await res.json();
  if(data.error){
    diag('Hibrid OCR HIBA: '+(data.error.message||JSON.stringify(data.error)),'err');
    throw new Error('Gemini OCR: '+(data.error.message||'ismeretlen'));
  }
  if(!data.candidates || !data.candidates[0]){
    diag('Hibrid OCR: üres válasz','warn');
    return [];
  }
  const finishReason = data.candidates[0].finishReason;
  if(finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'BLOCKLIST'){
    diag('Hibrid OCR BLOKKOLT: '+finishReason,'err');
    return [];
  }
  if(finishReason === 'MAX_TOKENS'){
    diag(`⚠️ Hibrid OCR token-limit elérve! Növelt szeletszám segíthet.`,'warn');
  }
  const partsArr = data.candidates[0].content?.parts || [];
  const raw = partsArr.map(p=>p.text||'').join('').replace(/```json|```/g,'').trim();

  // JSON parse — ugyanaz a logika mint geminiFullSlice-ban
  let parsed = [];
  function tryParse(jsonStr){
    try{
      return JSON.parse(jsonStr).filter(b=>{
        const t=(b.original||'').replace(/[.…!?•\s*~\-–—]/g,'').trim();
        return t.length>0;
      });
    } catch{ return null; }
  }
  parsed = tryParse(raw);
  if(parsed === null){
    let cleaned = raw;
    const lastClose = cleaned.lastIndexOf('},');
    if(lastClose > 0){
      cleaned = cleaned.slice(0, lastClose + 1) + ']';
      parsed = tryParse(cleaned);
    }
    if(parsed === null) parsed = [];
  }

  // hitLimit jelzés ha túl rövid output → splitAndTranslate ezt látja és 3 szelettel próbálja
  if(finishReason === 'MAX_TOKENS'){
    parsed._hitLimit = true;
  }
  return parsed;
}

async function claudeTranslateOnly(bubblesEN, idx, modelStr) {
  // Kép nélkül, csak az angol szövegeket fordítja magyarra.
  // bubblesEN: tömb, mindegyikben original (angol szöveg)
  // Visszatér: ugyanazok a buborékok kiegészítve hungarian mezővel
  if(!bubblesEN || !bubblesEN.length) return bubblesEN;
  const apiKey = document.getElementById('api-key').value.trim();
  if(!apiKey) throw new Error('Claude API kulcs szükséges a fordításhoz!');

  // Készítsünk egy számozott listát a fordítónak — egyszerűbb visszaolvasni
  const numberedList = bubblesEN.map((b, i) =>
    `${i+1}. [${b.type||'bubble'}, ${b.speaker||'unknown'}] "${(b.original||'').replace(/"/g,'\\"')}"`
  ).join('\n');

  // Kontextus az előző laptól (ha hiányos / folytatódó)
  let ctx = '';
  if(idx>0 && pages[idx-1]?.bubbles?.length){
    const lb = pages[idx-1].bubbles[pages[idx-1].bubbles.length-1];
    const ot = lb?.original?.trim() || '';
    if(ot.endsWith('...') || ot.endsWith('--') || ot.endsWith('—')){
      ctx = `\nContext: Previous page ended with: "${lb.original}" → "${lb.hungarian}". Continue naturally if relevant.`;
    }
  }

  const prompt = `You are translating a comic book from English to Hungarian. Below is a numbered list of all text bubbles from one comic page (with type and speaker info).${ctx}

Translate each line to natural, comic-style Hungarian:
- Speech bubbles: ALL CAPS Hungarian (mert a képregényekben így vannak)
- Caption boxes: normal sentence case
- Sound effects (sfx): keep original or use Hungarian onomatopoeia (e.g., BOOM! → BUMM!, but BANG! → BANG! is fine)
- Keep names, brand names, proper nouns in original (Matt Kindt, BOOM! Studios, BLACK BADGE, ISBN numbers, distances like "20 km")
- Keep the same tone (whisper / shout / narration)
- If a bubble ends with "--" or "—", that's a continuation; the next bubble starts where this leaves off

Numbered list:
${numberedList}

Return ONLY a JSON array of strings (the Hungarian translations in the same order), no markdown:
["hungarian text 1", "hungarian text 2", ...]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-api-key':apiKey,
      'anthropic-version':'2023-06-01',
      'anthropic-dangerous-direct-browser-access':'true',
      'x-app-name':'BubbleLens',
    },
    body: JSON.stringify({
      model: modelStr,
      max_tokens: 16384,
      messages:[{role:'user', content:[{type:'text', text:prompt}]}],
    })
  });
  const data = await res.json();
  if(data.error){
    diag('Hibrid fordítás HIBA: '+data.error.message,'err');
    throw new Error('Claude fordítás: '+data.error.message);
  }
  if(data.stop_reason === 'max_tokens'){
    diag(`⚠️ Hibrid fordítás token-limit elérve! Néhány buborék hiányozhat.`,'warn');
  }
  const raw = data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();

  let translations = [];
  try {
    translations = JSON.parse(raw);
  } catch(e){
    // Ha nem tiszta JSON, próbáljuk kinyerni a tömböt
    const m = raw.match(/\[[\s\S]*\]/);
    if(m){
      try{ translations = JSON.parse(m[0]); }
      catch{ translations = []; }
    }
  }

  if(!Array.isArray(translations)){
    diag('Hibrid fordítás: rossz formátumú válasz','warn');
    translations = [];
  }

  diag(`Hibrid fordítás: ${translations.length}/${bubblesEN.length} buborék`);

  // Visszailesztés: minden buborék kapja meg a magyar fordítást
  return bubblesEN.map((b, i) => ({
    ...b,
    hungarian: translations[i] || '[fordítás hiányzik]',
  }));
}

async function hybridFullSlice(b64, idx, sliceIdx, totalSlices, prevSliceTail) {
  // A hibrid pipeline egy szelet-fordítása: OCR + fordítás összekapcsolva
  const parts = _hybridParts(selModel);
  if(!parts){
    throw new Error('Ismeretlen hibrid modell: '+selModel);
  }

  // 1. lépés: Gemini OCR
  diag(`HIBRID szelet ${sliceIdx+1}/${totalSlices} → 1. lépés: ${parts.ocr.split('-').slice(-2).join('-')} OCR`);
  const bubblesEN = await geminiOcrOnly(b64, idx, sliceIdx, totalSlices, parts.ocr);

  if(!bubblesEN || bubblesEN.length === 0){
    diag(`HIBRID szelet ${sliceIdx+1}: OCR 0 buborék`,'warn');
    return [];
  }
  diag(`HIBRID szelet ${sliceIdx+1}: OCR ${bubblesEN.length} buborék`);

  // 2. lépés: Claude fordítás (csak szöveg)
  diag(`HIBRID szelet ${sliceIdx+1} → 2. lépés: ${parts.tr.includes('haiku')?'Haiku':'Sonnet'} fordítás`);
  const bubblesHU = await claudeTranslateOnly(bubblesEN, idx, parts.tr);

  // hitLimit jelzés átadása ha volt
  if(bubblesEN._hitLimit){
    bubblesHU._hitLimit = true;
  }

  return bubblesHU;
}


// ── Szöveg illesztés a buborék méretéhez (layout után, egyszer) ──────────────
function fitTextToBox(div) {
  const MIN = 5.5;
  const shrink = () => {
    if(div.scrollHeight <= div.offsetHeight + 3) return;
    let fs = parseFloat(getComputedStyle(div).fontSize);
    let tries = 0;
    while(div.scrollHeight > div.offsetHeight + 3 && fs > MIN && tries < 20) {
      fs = Math.max(MIN, fs - 0.7);
      div.style.fontSize = fs + 'px';
      tries++;
    }
  };
  // Két frame után mérünk (biztosan renderelve van)
  requestAnimationFrame(() => requestAnimationFrame(shrink));
}

// ── Speaker tracking (szín-alapú, oldalak közt konzisztens) ─────────────────
const speakerColors = {};   // speaker_id → hex szín (első előfordulásból)
const speakerPalette = [    // karakterenkénti megkülönböztető színek
  '#fff9c4','#fce4ec','#e3f2fd','#e8f5e9','#f3e5f5',
  '#fff3e0','#e0f7fa','#fbe9e7','#f1f8e9','#ede7f6'
];
let speakerPaletteIdx = 0;

function getSpeakerColor(speakerId, bubbleBg) {
  if(!speakerId || speakerId==='narrator'||speakerId==='sfx') return bubbleBg||null;
  if(!speakerColors[speakerId]) {
    // Mindig paletta-szín: így minden karakter vizuálisan különbözik
    // (Claude bg-jét csak akkor használjuk ha az tényleg egyedi, nem az alap sárga/fehér)
    const isDefaultBg = !bubbleBg || bubbleBg==='#fffcdc'||bubbleBg==='#ffffff'||bubbleBg==='#fff';
    speakerColors[speakerId] = isDefaultBg
      ? speakerPalette[speakerPaletteIdx++ % speakerPalette.length]
      : bubbleBg;
  }
  // Ha a szín túl sötét (overlay/sfx), ne használjuk peek gombhoz — semleges szürkét adunk vissza
  const c = speakerColors[speakerId];
  return c;
}

function peekSafeColor(speakerId, bubbleBg) {
  if(speakerId==='sfx'||speakerId==='overlay') return '#bbbbcc';
  const c = getSpeakerColor(speakerId, bubbleBg);
  if(!c) return '#aaaaaa';
  const hex = c.replace('#','');
  if(hex.length===6){
    const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    const lum=(r*299+g*587+b*114)/1000;
    // Sötét szín esetén: az adott speaker palettaszínét keressük vissza
    if(lum < 80){
      const keys=Object.keys(speakerColors);
      const idx=keys.indexOf(speakerId);
      return speakerPalette[idx>=0 ? idx % speakerPalette.length : 0];
    }
  }
  return c;
}

// ── Overlap detection & position fix ─────────────────────────────────────────
function resolveOverlaps(bubs) {
  // Csak a nem-overlay elemeket rendezzük (overlay-ek helyét ne bántsuk)
  const movable = bubs.filter(b => (b.type||'bubble') !== 'overlay');
  const fixed   = bubs.filter(b => (b.type||'bubble') === 'overlay');

  // Y szerint rendezünk, bal-jobb másodlagos
  movable.sort((a,b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  const PADDING = 0.005; // ~0.5% gap az elemek között
  let changed = true;
  let iterations = 0;
  while(changed && iterations < 20) {
    changed = false;
    iterations++;
    for(let i=0; i<movable.length; i++) {
      for(let j=i+1; j<movable.length; j++) {
        const a = movable[i];
        const b = movable[j];
        // Átfedés vizsgálat
        const overlapX = a.x < b.x+b.w && a.x+a.w > b.x;
        const overlapY = a.y < b.y+b.h && a.y+a.h > b.y;
        if(overlapX && overlapY) {
          // Mennyit lóg át?
          const overlapAmt = (a.y + a.h) - b.y + PADDING;
          if(overlapAmt > 0) {
            // A mélyebbiket toljuk le
            movable[j] = {...b, y: Math.min(0.99 - b.h, b.y + overlapAmt)};
            changed = true;
          }
        }
      }
    }
  }
  return [...movable, ...fixed];
}
function renderBub(bubs){
  const layer=document.getElementById('blayer');
  const handle=document.getElementById('lhandle');
  layer.innerHTML='';layer.appendChild(handle);
  if(!bubs.length)return;
  // (Overlap fix kikapcsolva — komplex oldalakon ront)
  // Közeli azonos-speaker buborékok összevonása
  // mergeNearbySpeakers kikapcsolva — rontja a párbeszédeket
  // bubs = mergeNearbySpeakers(bubs);
  if(peekMode){
    bubs.forEach((b,i)=>{
      const btn=document.createElement('div');btn.className='pbtn';btn.textContent='👁';
      // Peek gomb pozíciója:
      //   1. Ha a felhasználó manuálisan elhúzta (b._manual) → ott marad
      //   2. Egyébként a buborék középpontja (Claude koordinátáiból)
      // Mindkét esetben min. 3%, max. 93% — hogy ne lógjon le a képről
      let leftPct, topPct;
      if(b._manual && typeof b._manual.x === 'number' && typeof b._manual.y === 'number'){
        leftPct = b._manual.x * 100;
        topPct  = b._manual.y * 100;
      } else {
        leftPct = (b.x + b.w/2) * 100;
        topPct  = (b.y + b.h/2) * 100;
      }
      btn.style.left = Math.min(97, Math.max(0, leftPct)) + '%';
      btn.style.top  = Math.min(97, Math.max(0, topPct))  + '%';
      // Peek gomb színe = speaker / buborék színe (csak ha engedélyezett)
      if(styleMatchEnabled){const _pc=peekSafeColor(b.speaker,b.bg)||b.bg;if(_pc){btn.style.background=hexToRgba(_pc,0.30);btn.style.borderColor=hexToRgba(_pc,0.9);btn.style.color=isDark(_pc)?'rgba(255,255,255,0.9)':'rgba(0,0,0,0.7)';btn.style.boxShadow=`0 0 5px ${hexToRgba(_pc,0.4)}`;btn.style.fontWeight='bold';}}
      makePeekDrag(btn,b,layer);
      let pop=null;
      btn.addEventListener('click',e=>{
        e.stopPropagation();if(btn._sc)return;
        // 🗑 Törlés mód: ha aktív, popup nyit a törlés megerősítésére
        if(document.body.classList.contains('delete-mode')){
          // A buborék indexét keressük az aktuális tömbben
          const bubIdx = pages[cur].bubbles.indexOf(b);
          if(bubIdx >= 0) openDeletePopup(bubIdx);
          return;
        }
        if(pop){pop.remove();pop=null;btn.classList.remove('rev');}
        else{pop=document.createElement('div');pop.className='ppop';pop.textContent=b.hungarian;pop.title='Eredeti: '+b.original;
          // Popup a gomb közelébe kerül, nem a buborék eredeti pozíciójára
          const btnL=parseFloat(btn.style.left)||50;
          const btnT=parseFloat(btn.style.top)||50;
          // Szélesség: buborék szélességéből, de legalább 20%
          const popW=Math.max(18, b.w*100);
          // Vízszintes pozíció: gomb középpontja körül, képen belül marad
          let popL=Math.min(98-popW, Math.max(1, btnL - popW/2));
          // Függőleges: gomb alatt jelenik meg, ha van hely, egyébként felette
          let popT=btnT+6;
          if(popT+15>97) popT=btnT-20;
          pop.style.left=popL+'%';
          pop.style.top=popT+'%';
          pop.style.width=popW+'%';
          pop.style.minHeight=(b.h*100)+'%';
          // Szín + font
          const _pbg=getSpeakerColor(b.speaker,b.bg)||b.bg;
          if(_pbg){pop.style.background=hexToRgba(_pbg,b.type==='overlay'?0.88:0.96);pop.style.color=isDark(_pbg)?'#f5f5f5':'#111';pop.style.borderColor=isDark(_pbg)?'rgba(255,255,255,.25)':'rgba(0,0,0,.4)';}
          if(b.font_style&&b.font_style!=='print')pop.style.fontFamily=getFontFamily(b.font_style);
          if(b.type==='overlay'||b.type==='caption'||b.type==='narration')pop.style.fontStyle='italic';
          layer.appendChild(pop);btn.classList.add('rev');
          const close=ev=>{if(!btn.contains(ev.target)&&!pop?.contains(ev.target)){pop?.remove();pop=null;btn.classList.remove('rev');document.removeEventListener('click',close);}};
          setTimeout(()=>document.addEventListener('click',close),10);}
      });
      layer.appendChild(btn);
    });
  }else{
    bubs.forEach(b=>{
      const div=document.createElement('div');
      const t=b.type||'bubble';
      div.className='bub '+t;
      // Overlay: ha el van rejtve, adjuk hozzá az osztályt
      if(t==='overlay'&&!overlaysVisible)div.classList.add('ov-hidden');
      // Speaker szín + háttérszín (csak ha engedélyezett)
      if(styleMatchEnabled){
        const effectiveBg = getSpeakerColor(b.speaker, b.bg) || b.bg;
        if(effectiveBg){
          div.style.background=hexToRgba(effectiveBg, t==='overlay'?0.85:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bop'))||0.93);
          div.style.color=isDark(effectiveBg)?'#f5f5f5':'#111111';
          div.style.borderColor=isDark(effectiveBg)?'rgba(255,255,255,.2)':'rgba(0,0,0,.4)';
        }
        if(b.speaker && b.speaker!=='narrator' && b.speaker!=='sfx' && b.speaker!=='overlay') {
          div.setAttribute('data-speaker', b.speaker);
        }
      }
      div.style.left=`${b.x*100}%`;div.style.top=`${b.y*100}%`;
      div.style.width=`${b.w*100}%`;div.style.height=`${b.h*100}%`;
      div.textContent=b.hungarian||b.original;div.setAttribute('data-orig',b.original);
      // Arányos betűméret: buborék területe alapján skálázunk
      {
        const area = b.w * b.h;
        const refArea = 0.020; // "normál" buborék területe
        const scale = Math.min(1.0, Math.max(0.28, Math.sqrt(area / refArea)));
        // Overlay szöveg: mindig kisebb
        const typeScale = (b.type==='overlay'||b.type==='narration') ? 0.72 : 1.0;
        const basePx = Math.round(12 * scale * typeScale);
        div.style.fontSize = `clamp(5px, ${basePx}px, 14px)`;
      }
      // Font matching: csak ha engedélyezett
      if(styleMatchEnabled && b.font_style && b.font_style !== 'print'){
        div.style.fontFamily = getFontFamily(b.font_style);
      }
      div.setAttribute('data-type',t);
      makeBubDrag(div,b);
      div.addEventListener('dblclick',e=>{e.stopPropagation();div.classList.toggle('hid');});
      // Magyarázat mód: egyszeri koppintásra magyarázatot kérünk az AI-tól
      // 🗑 Törlés mód: egyszeri koppintásra megerősítő popup
      div.addEventListener('click',e=>{
        if(document.body.classList.contains('explain-mode')){
          e.stopPropagation();
          explainBubble(b);
        } else if(document.body.classList.contains('delete-mode')){
          e.stopPropagation();
          const bubIdx = pages[cur].bubbles.indexOf(b);
          if(bubIdx >= 0) openDeletePopup(bubIdx);
        }
      });
      layer.appendChild(div);
    });
  }
}

function makePeekDrag(btn,bData,layer){
  let dr=false,sx,sy,spx,spy,mv=false,pid=null;
  btn.addEventListener('pointerdown',e=>{e.stopPropagation();e.preventDefault();btn.setPointerCapture(e.pointerId);pid=e.pointerId;dr=true;mv=false;sx=e.clientX;sy=e.clientY;spx=parseFloat(btn.style.left)||0;spy=parseFloat(btn.style.top)||0;btn.style.zIndex=99;});
  btn.addEventListener('pointermove',e=>{if(!dr||e.pointerId!==pid)return;if(Math.abs(e.clientX-sx)>4||Math.abs(e.clientY-sy)>4)mv=true;if(!mv)return;const r=layer.getBoundingClientRect();const nx=Math.max(0,Math.min(100,spx+(e.clientX-sx)/r.width*100));const ny=Math.max(0,Math.min(100,spy+(e.clientY-sy)/r.height*100));btn.style.left=nx+'%';btn.style.top=ny+'%';});
  btn.addEventListener('pointerup',e=>{
    if(e.pointerId!==pid)return;
    dr=false;btn.style.zIndex='';
    if(mv){
      btn._sc=true;setTimeout(()=>btn._sc=false,200);
      // 💾 Manuális pozíció elmentése — a buborék objektumába rakjuk hogy
      // a következő render-nél (lapváltás után is) a megőrzött helyen jelenjen meg.
      // Az IDB save automatikusan átviszi a `_manual` mezőt, mert a teljes
      // bubbles tömb mentődik el, és ez kerül vissza onnan.
      const px=parseFloat(btn.style.left)||0;
      const py=parseFloat(btn.style.top)||0;
      bData._manual={x:px/100,y:py/100};
      if(typeof saveCurrentPageTranslation==='function') saveCurrentPageTranslation();
      else saveProgress();
    }
  });
  btn.addEventListener('pointercancel',()=>{dr=false;btn.style.zIndex='';});
}

let _lotY=10;
function clearLot(){document.querySelectorAll('.plot').forEach(l=>l.remove());_lotY=10;}
function makeBubDrag(div,bData){
  let dragActive=false,dr=false,sx,sy,sl,st,pid=null,parked=false,holdTimer=null;

  div.addEventListener('contextmenu',e=>e.preventDefault());
  div.addEventListener('pointerdown',e=>{
    e.stopPropagation();
    pid=e.pointerId;sx=e.clientX;sy=e.clientY;
    sl=parseFloat(div.style.left)||0;st=parseFloat(div.style.top)||0;

    if(zoomed){
      // Zoomed: instant drag, no waiting
      div.setPointerCapture(pid);
      dragActive=true;dr=true;
      div.classList.add('drag-ready');
    } else {
      // Not zoomed: long press 320ms to activate
      holdTimer=setTimeout(()=>{
        holdTimer=null;
        dragActive=true;
        div.setPointerCapture(pid);
        div.classList.add('drag-ready');
        if(navigator.vibrate)navigator.vibrate(30);
        dr=true;
      },320);
    }
  });

  div.addEventListener('pointermove',e=>{
    if(e.pointerId!==pid)return;
    // If moved too much before long press, cancel
    if(holdTimer&&(Math.abs(e.clientX-sx)>8||Math.abs(e.clientY-sy)>8)){
      clearTimeout(holdTimer);holdTimer=null;
    }
    if(!dragActive||!dr)return;
    const r=document.getElementById('blayer').getBoundingClientRect();
    div.style.left=`${sl+(e.clientX-sx)/r.width*100}%`;
    div.style.top=`${st+(e.clientY-sy)/r.height*100}%`;
    bData.x=(sl+(e.clientX-sx)/r.width*100)/100;
    bData.y=(st+(e.clientY-sy)/r.height*100)/100;
  });

  div.addEventListener('pointerup',e=>{
    if(e.pointerId!==pid)return;
    if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
    dragActive=false;dr=false;
    div.classList.remove('drag-ready');
  });

  div.addEventListener('pointercancel',e=>{
    if(holdTimer){clearTimeout(holdTimer);holdTimer=null;}
    dragActive=false;dr=false;
    div.classList.remove('drag-ready');
  });
}

// Layer handle drag
function initLHandleDrag(){
  const h=document.getElementById('lhandle');const layer=document.getElementById('blayer');
  let dr=false,sx=0,tx=0;
  h.addEventListener('pointerdown',e=>{e.stopPropagation();h.setPointerCapture(e.pointerId);dr=true;sx=e.clientX;tx=parseFloat(layer.style.getPropertyValue('--layer-x'))||0;});
  h.addEventListener('pointermove',e=>{if(!dr)return;layer.style.setProperty('--layer-x',(tx+e.clientX-sx)+'px');});
  h.addEventListener('pointerup',()=>{dr=false;});
}

// ══ TRANS TABLE ══
function renderTrans(bubs){
  document.getElementById('tph-t').textContent=`📋 ${cur+1}. OLDAL — ${bubs.length} szöveg`;
  const c=document.getElementById('trows');c.innerHTML='';
  bubs.forEach(b=>{const r=document.createElement('div');r.className='trow';r.innerHTML=`<div><div class="tlbl">🇬🇧 ANGOL</div><div class="ttxt">${esc(b.original)}</div></div><div><div class="tlbl">🇭🇺 MAGYAR</div><div class="ttxt">${esc(b.hungarian)}</div></div>`;c.appendChild(r);});
}
function toggleTP(){document.getElementById('tpanel').classList.toggle('open');document.getElementById('tptog').textContent=document.getElementById('tpanel').classList.contains('open')?'▲ FORDÍTÁSI TÁBLÁZAT ELREJTÉSE':'▼ FORDÍTÁSI TÁBLÁZAT';}

// ══ THUMBS ══
function buildThumbs(){
  const strip=document.getElementById('tstrip');strip.innerHTML='';
  pages.forEach((p,i)=>{const w=document.createElement('div');w.className='th'+(i===cur?' active':'');w.onclick=()=>{if(!loading){cur=i;resetZoom();ensureLoaded(i).then(renderPage);scrollThumb();}};const img=document.createElement('img');img.src=p.dataUrl||'';if(!p.dataUrl&&p._gb){const obs=new IntersectionObserver(en=>{if(en[0].isIntersecting){obs.disconnect();ensureLoaded(i).then(()=>{img.src=pages[i].dataUrl||'';});}},{root:strip,rootMargin:'100px'});obs.observe(w);}const st=document.createElement('div');st.className='ts none';w.appendChild(img);w.appendChild(st);strip.appendChild(w);});
}
function updateThumbs(){document.querySelectorAll('.th').forEach((el,i)=>{el.classList.toggle('active',i===cur);const st=el.querySelector('.ts');if(i===cur&&loading){st.className='ts act';return;}if(pages[i]?.bubbles!==null&&pages[i]?.bubbles!==undefined){st.className='ts done';st.textContent='✓';}else{st.className='ts none';st.textContent='';}});}
function scrollThumb(){const t=document.querySelectorAll('.th');if(t[cur])t[cur].scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});}

// ══ NAV ══
function goPrev(){if(loading||cur<=0)return;cur--;resetZoom();ensureLoaded(cur).then(renderPage);scrollThumb();saveProgress();onPageChange();}
function goNext(){if(loading||cur>=pages.length-1)return;cur++;resetZoom();ensureLoaded(cur).then(renderPage);scrollThumb();saveProgress();onPageChange();}
document.addEventListener('keydown',e=>{
  if(!document.getElementById('reader').classList.contains('active'))return;
  if(e.key==='ArrowLeft')goPrev();
  if(e.key==='ArrowRight')goNext();
  if(e.key==='Escape'){if(zoomed)resetZoom();else if(document.body.classList.contains('imm'))toggleImm();}
  if(e.key==='f'||e.key==='F')toggleImm();
});

// ══ ZOOM + PAN ══
function applyTr(){iwrap.style.transform=zoomed?`scale(${currentScale>1?currentScale:ZSCALE}) translate(${panX}px,${panY}px)`:''; }
function updateIwrapMargin(img){
  const vp = document.getElementById('zvp');
  const hw = Math.round(vp.clientWidth / 2);
  const hh = Math.round(vp.clientHeight / 2);
  iwrap.style.margin = `${hh}px ${hw}px`;
}

function clampPan(){
  const vp=document.getElementById('zvp');
  const vpW=vp.clientWidth,vpH=vp.clientHeight;
  const style=window.getComputedStyle(iwrap);
  const mH=parseFloat(style.marginLeft)+parseFloat(style.marginRight);
  const mV=parseFloat(style.marginTop)+parseFloat(style.marginBottom);
  const cW=iwrap.offsetWidth+mH,cH=iwrap.offsetHeight+mV;
  const sc=currentScale>1?currentScale:ZSCALE;
  const oxW=Math.max(0,(cW*sc-vpW)/2),oxH=Math.max(0,(cH*sc-vpH)/2);
  panX=Math.max(-oxW/sc,Math.min(oxW/sc,panX));
  panY=Math.max(-oxH/sc,Math.min(oxH/sc,panY));
}
function handleZoom(cx,cy){
  const vp=document.getElementById('zvp');
  if(zoomed){zoomed=false;panX=0;panY=0;iwrap.style.transformOrigin='center center';applyTr();iwrap.classList.remove('zoomed');vp.classList.remove('zoomed');}
  else{const rect=iwrap.getBoundingClientRect();panX=-(cx-rect.left-rect.width/2)/ZSCALE;panY=-(cy-rect.top-rect.height/2)/ZSCALE;iwrap.style.transformOrigin='center center';zoomed=true;clampPan();applyTr();iwrap.classList.add('zoomed');vp.classList.add('zoomed');}
}
function resetZoom(){if(zoomed){zoomed=false;panX=0;panY=0;currentScale=1.0;applyTr();iwrap.classList.remove('zoomed');document.getElementById('zvp').classList.remove('zoomed');}}
function showZHint(){const h=document.getElementById('zhint');h.classList.add('show');setTimeout(()=>h.classList.remove('show'),3000);}

// Pan (pointer events on zvp)
{const vp=document.getElementById('zvp');
  vp.addEventListener('pointerdown',e=>{if(!zoomed)return;if(e.target.closest('.bub,.pbtn,#lhandle'))return;isPan=true;panPid=e.pointerId;vp.setPointerCapture(e.pointerId);panSX=e.clientX;panSY=e.clientY;panBX=panX;panBY=panY;e.preventDefault();},{passive:false});
  vp.addEventListener('pointermove',e=>{if(!isPan||e.pointerId!==panPid)return;const sc=currentScale>1?currentScale:ZSCALE;panX=panBX+(e.clientX-panSX)/sc;panY=panBY+(e.clientY-panSY)/sc;clampPan();applyTr();e.preventDefault();},{passive:false});
  vp.addEventListener('pointerup',e=>{if(e.pointerId===panPid)isPan=false;});
  vp.addEventListener('pointercancel',e=>{if(e.pointerId===panPid)isPan=false;});
}

// Double tap/click zoom
{const vp=document.getElementById('zvp');let lt=0,lx=0,ly=0;
  // dblclick zoom eltávolítva
  // Double-tap zoom eltávolítva — csak pinch működik
}

// Pinch zoom
// ── Folyamatos pinch zoom ─────────────────────────────────────────────────
{const vp=document.getElementById('zvp');
  let pd=0, pScale=1, pCx=0, pCy=0;
  const MIN_SCALE=1.0, MAX_SCALE=5.0;

  vp.addEventListener('touchstart',e=>{
    if(e.touches.length===2){
      e.preventDefault();
      pinching=true;
      pd=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      pScale=currentScale;
      pCx=(e.touches[0].clientX+e.touches[1].clientX)/2;
      pCy=(e.touches[0].clientY+e.touches[1].clientY)/2;
    }
  },{passive:false});

  vp.addEventListener('touchmove',e=>{
    if(!pinching||e.touches.length!==2)return;
    e.preventDefault();
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    if(pd===0)return;
    const ratio=d/pd;
    const newScale=Math.min(MAX_SCALE,Math.max(MIN_SCALE, pScale*ratio));
    currentScale=newScale;

    const iw=document.getElementById('iwrap');
    const rect=iw.getBoundingClientRect();
    // Nagyítás középpontja az ujjak közepe
    const originX=((pCx-rect.left)/rect.width*100).toFixed(1)+'%';
    const originY=((pCy-rect.top)/rect.height*100).toFixed(1)+'%';

    if(newScale<=1.02){
      // Visszaáll alaphelyzetbe
      currentScale=1.0;
      if(zoomed)resetZoom();
    } else {
      if(!zoomed){
        // Zoom-ba lép
        zoomed=true;
        iwrap.classList.add('zoomed');
        vp.classList.add('zoomed');
      }
      // Folyamatos skála alkalmazása panX/panY nélkül
      iw.style.transformOrigin='center center';
      iw.style.transform=`scale(${newScale}) translate(${panX}px,${panY}px)`;
    }
  },{passive:false});

  vp.addEventListener('touchend',e=>{
    if(e.touches.length<2 && pinching){
      pinching=false;
      // Pinch után blokkoljuk a double-tap detektálást egy ideig
      lt=0; // reset double-tap timer
      if(currentScale>1.02){
        zoomed=true;
        iwrap.classList.add('zoomed');
        vp.classList.add('zoomed');
        const iw=document.getElementById('iwrap');
        iw.style.transform=`scale(${currentScale}) translate(${panX}px,${panY}px)`;
      } else {
        currentScale=1.0;
        if(zoomed)resetZoom();
      }
    }
  },{passive:false});
}

// ══ SWIPE LAPOZÁS (csak nem-zoomolt állapotban, 1 ujj) ══
{
  const rm = document.getElementById('rmain');
  const THRESHOLD = 0.18; // képernyőszélesség 18%-a = lapozás
  const MAX_DRAG  = 0.45; // maximum ennyi a látható eltolás (rugalmas gumiszalag)
  let sw=false, sx=0, sy=0, dx=0, pid=null, sActive=false;

  function swipeCancel(){
    if(!sActive)return;
    sActive=false;
    // Visszapattan
    const iw=document.getElementById('iwrap');
    iw.style.transition='transform .3s cubic-bezier(.25,.46,.45,.94)';
    iw.style.transform='';
    setTimeout(()=>iw.style.transition='',350);
  }

  rm.addEventListener('touchstart',e=>{
    // Csak 1 ujj, nem zoomolva, nem buborékon
    if(zoomed||e.touches.length!==1)return;
    if(e.target.closest('.bub,.pbtn,#lhandle,.navarr'))return;
    sw=true; sActive=false;
    sx=e.touches[0].clientX;
    sy=e.touches[0].clientY;
    dx=0;
  },{passive:true});

  rm.addEventListener('touchmove',e=>{
    if(!sw||zoomed||e.touches.length!==1)return;
    dx=e.touches[0].clientX - sx;
    const dy=e.touches[0].clientY - sy;
    // Ha inkább függőleges a mozgás → ne swipe
    if(!sActive&&Math.abs(dy)>Math.abs(dx)+8){sw=false;return;}
    if(!sActive&&Math.abs(dx)>8)sActive=true;
    if(!sActive)return;

    // Gumiszalag: a széleknél visszafogja
    const W=window.innerWidth;
    const isFirst = cur===0;
    const isLast  = cur===pages.length-1;
    let pull = dx;
    if((pull>0&&isFirst)||(pull<0&&isLast)){
      // Nincs hová menni → rugalmas ellenállás (gyök-alapú)
      pull = Math.sign(dx)*Math.sqrt(Math.abs(dx))*8;
    }
    // Maximum eltolás
    const maxPx = W * MAX_DRAG;
    pull = Math.max(-maxPx, Math.min(maxPx, pull));

    const iw=document.getElementById('iwrap');
    iw.style.transition='none';
    iw.style.transform=`translateX(${pull}px)`;
  },{passive:true});

  rm.addEventListener('touchend',e=>{
    if(!sw)return;
    sw=false;
    if(!sActive){dx=0;return;}
    const W=window.innerWidth;
    const iw=document.getElementById('iwrap');
    if(Math.abs(dx) > W*THRESHOLD){
      // Lapozás: animálj ki, majd váltson
      const dir = dx<0 ? -1 : 1;
      const canGo = dir<0 ? cur<pages.length-1 : cur>0;
      if(canGo){
        iw.style.transition='transform .22s ease-in';
        iw.style.transform=`translateX(${dir<0?-W:W}px)`;
        setTimeout(()=>{
          iw.style.transition='none';
          iw.style.transform='';
          if(dir<0) goNext(); else goPrev();
        },220);
      } else {
        swipeCancel();
      }
    } else {
      swipeCancel();
    }
    dx=0;sActive=false;
  },{passive:true});

  // Ha az ujj elmegy a képernyőről
  rm.addEventListener('touchcancel',()=>{sw=false;swipeCancel();},{passive:true});
}

// ══ IMMERSIVE ══
function toggleImm(){
  cancelAutoImm();
  const on=document.body.classList.toggle('imm');
  document.getElementById('imm-btn').classList.toggle('active',on);
}

// ══ MAGYARÁZAT MÓD ══
function toggleExplainMode(){
  const on=document.body.classList.toggle('explain-mode');
  document.getElementById('ib-explain').classList.toggle('active',on);
  if(on){
    // Ha a delete-mode is aktív volt, kapcsoljuk ki
    if(document.body.classList.contains('delete-mode')){
      document.body.classList.remove('delete-mode');
      document.getElementById('ib-delete')?.classList.remove('active');
    }
    setSt('success','💡 Magyarázat mód BE — koppints egy buborékra');
  }else{
    closeExplain();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 🗑 BUBORÉK-TÖRLÉS MÓD
// ════════════════════════════════════════════════════════════════════════════
// 1. 🗑-ra koppintás → delete-mode aktív (piros pulzáló gomb, piros buborék-keret)
// 2. Felhasználó koppint egy szem-ikonra (peek) vagy buborékra → popup felugrik
// 3. Popup mutatja az eredeti angol + magyar fordítást, "Törlöm" / "Mégse" gombokkal
// 4. Akármelyik választás után a mód MARAD aktív — folytatható a következő törlés
// 5. 🗑 újra koppintásra → kikapcsol

let _deleteTargetIdx = -1; // melyik buborék-index van kiválasztva törlésre

function toggleDeleteMode(){
  const on = document.body.classList.toggle('delete-mode');
  document.getElementById('ib-delete').classList.toggle('active', on);
  if(on){
    // Ha a magyarázat-mode aktív volt, kapcsoljuk ki
    if(document.body.classList.contains('explain-mode')){
      document.body.classList.remove('explain-mode');
      document.getElementById('ib-explain')?.classList.remove('active');
      closeExplain();
    }
    setSt('success','🗑 Törlés mód BE — koppints egy buborékra a törléshez');
  }else{
    closeDeletePopup();
    setSt('success','✓ Törlés mód KI');
  }
}

function openDeletePopup(bubIdx){
  if(!pages[cur]?.bubbles||!pages[cur].bubbles[bubIdx]) return;
  const b = pages[cur].bubbles[bubIdx];
  _deleteTargetIdx = bubIdx;
  document.getElementById('dp-orig').textContent = b.original || '(nincs eredeti szöveg)';
  document.getElementById('dp-hu').textContent = b.hungarian || '(nincs fordítás)';
  document.getElementById('delete-popup').classList.add('open');
}

function closeDeletePopup(){
  document.getElementById('delete-popup').classList.remove('open');
  _deleteTargetIdx = -1;
}

async function confirmBubbleDelete(){
  if(_deleteTargetIdx < 0 || !pages[cur]?.bubbles) return;
  const idx = _deleteTargetIdx;
  // Töröljük a buborékot
  pages[cur].bubbles.splice(idx, 1);
  // Bezárjuk a popupot, de NEM kapcsoljuk ki a delete módot — folytatható
  closeDeletePopup();
  // Mentés IDB-be
  if(typeof saveCurrentPageTranslation === 'function'){
    saveCurrentPageTranslation();
  } else {
    saveProgress();
  }
  // Újrarajzolás
  renderPage();
  setSt('success','🗑 Buborék törölve. Koppints egy másikra vagy a 🗑-ra a kilépéshez.');
}
function closeExplain(){
  const p=document.getElementById('explain-popup');
  if(p)p.classList.remove('open');
}
async function explainBubble(bub){
  const popup=document.getElementById('explain-popup');
  const origEl=document.getElementById('explain-orig');
  const contentEl=document.getElementById('explain-content');
  popup.classList.add('open');
  origEl.textContent=bub.original||'';
  contentEl.innerHTML='<div style="color:var(--mut);font-style:italic">⏳ AI magyaráz...</div>';

  const apiKey=document.getElementById('api-key').value.trim();
  if(!apiKey){
    contentEl.innerHTML='<div style="color:var(--acc)">❌ Claude API kulcs szükséges a magyarázathoz!</div>';
    return;
  }

  // Kontextus: az előző és következő buborék, ha van
  let context='';
  try{
    const p=pages[cur];
    if(p&&p.bubbles&&p.bubbles.length){
      const idx=p.bubbles.indexOf(bub);
      if(idx>=0){
        const prev=p.bubbles[idx-1];
        const next=p.bubbles[idx+1];
        if(prev)context+=`\nPrevious bubble: "${prev.original}"`;
        if(next)context+=`\nNext bubble: "${next.original}"`;
      }
    }
  }catch(e){}

  const prompt=`This is a speech bubble from an American comic book:
"${bub.original}"
${context?'Context from nearby bubbles:'+context:''}

Please explain in Hungarian (1-3 short paragraphs):
1. What does it mean (if there are slang, idioms, or cultural references)?
2. Are there any pop culture references, character nicknames, or comic-specific terms?
3. Any wordplay or double meanings?

Be concise and useful. Format your answer in plain Hungarian prose. If the bubble is simple and needs no explanation, just say so briefly ("Nincs különleges jelentés, egyszerű ${bub.original.length<30?'kifejezés':'mondat'}.").`;

  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','x-app-name':'BubbleLens'},
      body:JSON.stringify({
        model:selModel,
        max_tokens:600,
        messages:[{role:'user',content:prompt}]
      })
    });
    const data=await res.json();
    if(data.error)throw new Error(data.error.message);
    const txt=data.content.map(b=>b.text||'').join('').trim();
    // Egyszerű markdown-szerű átalakítás: **bold** -> <strong>, *italic* -> <em>
    const html=txt
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .split(/\n\n+/).map(p=>'<p>'+p.replace(/\n/g,'<br>')+'</p>').join('');
    contentEl.innerHTML=html;
  }catch(e){
    contentEl.innerHTML='<div style="color:var(--acc)">❌ Hiba: '+e.message+'</div>';
  }
}

// Icon column popups
let openPop=null;
function togglePop(popId,btnId){
  const pop=document.getElementById(popId);
  const btn=document.getElementById(btnId);
  // Close previously open popup
  if(openPop&&openPop!==popId){
    document.getElementById(openPop).classList.remove('show');
    const prevBtn=document.getElementById(openPop.replace('pop-','ib-'));
    if(prevBtn)prevBtn.classList.remove('on');
  }
  const isOpen=pop.classList.toggle('show');
  btn.classList.toggle('on',isOpen);
  openPop=isOpen?popId:null;
  if(isOpen){
    // Position popup next to the button
    const btnRect=btn.getBoundingClientRect();
    const popH=pop.offsetHeight||60;
    // Align center of popup with center of button
    let top=btnRect.top+btnRect.height/2-popH/2;
    // Keep within viewport
    top=Math.max(8,Math.min(window.innerHeight-popH-8,top));
    pop.style.top=top+'px';
    pop.style.bottom='auto';
    syncPopValues();
  }
}
function syncPopValues(){
  document.getElementById('ip-fs').value=document.getElementById('fs-sl').value;document.getElementById('ip-fs-v').textContent=document.getElementById('fs-sl').value+'%';
  document.getElementById('ip-bs').value=document.getElementById('bs-sl').value;document.getElementById('ip-bs-v').textContent=document.getElementById('bs-sl').value+'%';
  document.getElementById('ip-op').value=document.getElementById('op-sl').value;document.getElementById('ip-op-v').textContent=document.getElementById('op-sl').value+'%';
  document.getElementById('ip-font-sel').value=document.getElementById('font-sel').value;
}
function syncSlider(id,v){const el=document.getElementById(id);if(el)el.value=v;}
function syncShapes(shape){['rect','oval','round'].forEach(s=>{const b=document.getElementById('ish-'+s);if(b)b.classList.toggle('active',s===shape);const b2=document.getElementById('sh-'+s);if(b2)b2.classList.toggle('active',s===shape);});}

// Jump to page
function toggleJump(){const j=document.getElementById('imm-jump');const vis=j.style.display==='flex';j.style.display=vis?'none':'flex';if(!vis){const inp=document.getElementById('jump-input');inp.value='';inp.max=pages.length;inp.focus();}}
function doJump(){const v=parseInt(document.getElementById('jump-input').value);if(v>=1&&v<=pages.length){cur=v-1;resetZoom();ensureLoaded(cur).then(renderPage);scrollThumb();saveProgress();}toggleJump();}

// ══ BUBBLE SETTINGS ══
function setOp(v){document.documentElement.style.setProperty('--bop',v/100);document.getElementById('op-v').textContent=v+'%';}
function setBFont(v){document.documentElement.style.setProperty('--bfont',v);}
function setBFS(v){document.documentElement.style.setProperty('--bfsc',v/100);document.getElementById('fs-v').textContent=v+'%';}
function setBSc(v){document.documentElement.style.setProperty('--bssc',v/100);document.getElementById('bs-v').textContent=v+'%';}
function setShape(s,el){
  document.querySelectorAll('.shbtn,.ishbtn').forEach(b=>b.classList.remove('active'));
  const r=s==='rect'?'6px':s==='oval'?'40% / 50%':'50%';
  document.documentElement.style.setProperty('--brad',r);
  if(el)el.classList.add('active');
  syncShapes(s);
}
function togglePeek(){
  peekMode=!peekMode;
  document.getElementById('peek-btn').classList.toggle('active',peekMode);
  document.getElementById('ib-peek').classList.toggle('on',peekMode);
  const p=pages[cur];if(p?.bubbles)renderBub(p.bubbles);
}
function toggleRtl(){rtlMode=!rtlMode;document.getElementById('rtl-btn').classList.toggle('active',rtlMode);document.getElementById('rtl-btn').textContent=rtlMode?'🈷️ RTL BE':'🈷️ RTL';}

// ══ TRANSLATE ══
async function transCur(){
  if(loading)return;loading=true;
  setSt('loading',`${cur+1}. oldal fordítása...`);
  document.getElementById('ib-trans').disabled=true;
  updateThumbs();
  try{
    await ensureB64(cur);
    pages[cur].bubbles=await transPage(pages[cur].base64,cur);
    await saveProgress();
    const n=pages[cur].bubbles.length;
    setSt(n?'success':'error',n?`✓ ${n} szöveg (${svcName()})`:'Nem találtam szöveget. Próbáld újra!');
  }catch(e){setSt('error','Hiba: '+e.message);}
  loading=false;renderPage();
  // 🧠 Előfordítás indítása — a felhasználó manuálisan lefordított egy lapot,
  // tehát "itt van az érdekes rész", kezdjük el a következő 2 lapot előfordítani.
  schedulePrefetch();
}
async function transAll(){
  if(loading)return;loading=true;
  const todo=pages.map((p,i)=>p.bubbles===null?i:-1).filter(i=>i>=0);
  for(let n=0;n<todo.length;n++){
    const i=todo[n];cur=i;setProg(n+1,todo.length);
    setSt('loading',`Fordítás: ${n+1}/${todo.length}...`,true);renderPage();
    try{
      await ensureB64(i);
      pages[i].bubbles=await transPage(pages[i].base64,i);
      // Lap-szintű IDB mentés MINDEN lap után (nem csak a végén)
      if(_idbTransReady && curBookKey && pages[i].bubbles){
        await idbTransPut(curBookKey, i, pages[i].bubbles);
      }
      if(n<todo.length-1)await sleep(600);
    }catch(e){pages[i].bubbles=[];}
  }
  await saveProgress();loading=false;setSt('success',`✓ Kész!`);renderPage();
}

// ════════ 🧠 ELŐFORDÍTÁS (PREFETCH) ════════
// Mindig 2 lapot fordít előre a háttérben hogy azonnali megjelenés legyen lapozáskor
let _prefetchActive=false; // épp fordít-e most
let _prefetchAbort=false;  // régi queue-t eldobjuk (gyors átlapozás után)
let _prefetchCurrentIdx=-1;// épp melyik lapot fordítja (hogy tudjuk várni rá kilépéskor)

function isPrefetchEnabled(){
  // Android módban alapból KIKAPCSOLT, ha még nem nyúlt hozzá a felhasználó
  // — mert sok fájllal a HTTP szerver túltelítődik és crash-elhet.
  // Browser-ben alapból bekapcsolt.
  const stored=localStorage.getItem('kf_prefetch_off');
  if(stored===null){
    return !isAndroidApp(); // browser:true (BE), Android:false (KI)
  }
  return stored!=='1';
}

function togglePrefetch(){
  const off=localStorage.getItem('kf_prefetch_off')==='1';
  const newState=!off;
  localStorage.setItem('kf_prefetch_off',newState?'1':'0');
  const lbl=document.getElementById('prefetch-label');
  if(lbl)lbl.textContent=newState?'KI':'BE';
  // Ha bekapcsoltuk és nyitva egy könyv, induljunk el
  if(!newState&&curBookKey&&pages.length){
    schedulePrefetch();
  }
  return !newState; // active? = BE állapot
}

// Beindítja az előfordítást ha kell
// Az algoritmus: mindig biztosítsa hogy cur+1 és cur+2 megvan.
// Ha nincs, sorban elindul azokat fordítani.
function schedulePrefetch(){
  if(!isPrefetchEnabled())return;
  if(!pages.length||curBookKey==null)return;
  if(loading)return;
  if(_prefetchActive)return;
  _runPrefetch();
}

async function _runPrefetch(){
  if(_prefetchActive)return;
  _prefetchActive=true;
  _prefetchAbort=false;
  _updatePrefetchDot(true);
  try{
    while(!_prefetchAbort){
      if(loading)break;
      const targets=[cur+1,cur+2].filter(i=>i<pages.length&&pages[i]&&pages[i].bubbles===null);
      if(!targets.length)break;
      const idx=targets[0];
      _prefetchCurrentIdx=idx;
      try{
        await ensureB64(idx);
        if(_prefetchAbort||loading)break;
        const result=await transPage(pages[idx].base64,idx);
        if(curBookKey==null)break;
        pages[idx].bubbles=result;
        // Lap-szintű IDB mentés a prefetched lapra (nem az aktuálisra!)
        if(_idbTransReady && curBookKey){
          await idbTransPut(curBookKey, idx, result);
        }
        // saveProgress a könyv-meta frissítésére (curPage, transPageCount, lastRead)
        await saveProgress();
        if(idx===cur)renderPage();
        else updateThumbs();
      }catch(e){
        console.warn('[prefetch] hiba lap',idx+1,':',e.message);
        break;
      }
      _prefetchCurrentIdx=-1;
      await sleep(400);
    }
  }finally{
    _prefetchActive=false;
    _prefetchCurrentIdx=-1;
    _prefetchAbort=false;
    _updatePrefetchDot(false);
  }
}

function _updatePrefetchDot(on){
  const el=document.getElementById('pctr');
  if(el)el.classList.toggle('prefetching',on);
  // Body class is toggle-ózzuk hogy az immerzív mód sárga karikája is látszódjon
  document.body.classList.toggle('prefetching',on);
}

// Ha gyorsan átlapozol és a "szomszédos 2 lap" cél-lista megváltozott, hagyjuk befejezni a jelenlegit
// aztán a while-loop újra értékeli a helyzetet. Nem kell abortálni.
function onPageChange(){
  schedulePrefetch();
}

async function transPage(b64,idx){
  // Google és DeepL eltávolítva a v2.40-ben — csak Claude
  diag(`━━━ Lap ${idx+1} fordítás indul (modell: ${selModel.split('-').slice(0,3).join('-')}) ━━━`);
  // Claude: kezdetben 2 szelettel, de ha hitLimit volt → 3 szelettel újrapróbálás (több hely mindenhol)
  {
    let result = await splitAndTranslate(b64, idx, 2);
    diag(`2 szelettel: ${result.length} buborék összesen${result._anyHitLimit?' (volt hitLimit!)':''}`,result._anyHitLimit?'warn':'ok');
    // Ha bárhol elérte a token-limitet a 2 szeletes változatban, próbáljuk 3 szelettel
    // (az 1-szeletes hibrid módoknál kihagyjuk — a felhasználó kifejezetten 1 szeletet kért)
    if(result._anyHitLimit && !isHybridSingleSlice(selModel)){
      console.log('[trans] 2 szeletnél hitLimit volt, próba 3 szelettel...');
      diag('→ Újrapróba 3 szelettel...','warn');
      try{
        const result3 = await splitAndTranslate(b64, idx, 3);
        diag(`3 szelettel: ${result3.length} buborék`, result3.length>=result.length?'ok':'warn');
        if(result3.length >= result.length) {
          result = result3;
          diag('3-szeletes verzió használva','ok');
        } else {
          diag('2-szeletes maradt (több találattal)');
        }
      }catch(e){console.warn('[trans] 3 szelet hiba:',e.message); diag('3-szelet hiba: '+e.message,'err');}
    }
    if(result.length > 0){
      // Részletes lista a végén — TELJES SZÖVEG (nem csonkolva, hogy lássuk mit kapott)
      result.forEach((b,i)=>{
        const orig=(b.original||'');
        const hu=(b.hungarian||'');
        const oLen=orig.length, hLen=hu.length;
        diag(`#${i+1} [${oLen}→${hLen}ch]: "${orig}"`);
        diag(`     → "${hu}"`);
      });
      // ⚠️ Gyanúsan kevés? Ha az olcsó modellel csak 1-2 buborékot találtunk,
      // próbáljuk meg az erősebbel (saját szolgáltatón belül).
      // Heurisztika: csak akkor lépünk feljebb, ha (a) olcsó modellel próbáltunk,
      // (b) eredmény ≤ 2 buborék, (c) auto-eszkaláció BE van kapcsolva.
      const isLowResultOnCheap = result.length <= 2 && isAutoOpusFallbackEnabled() && (
        selModel.includes('haiku') || selModel === 'gemini-2.5-flash-lite'
      );
      if(isLowResultOnCheap){
        const escalateTo = selModel.includes('haiku') ? 'claude-sonnet-4-6' : 'gemini-2.5-flash';
        const escName = selModel.includes('haiku') ? 'Sonnet' : 'Gemini Flash';
        diag(`⚠️ Csak ${result.length} buborék — próba ${escName}-val`,'warn');
        const origModel = selModel;
        try{
          selModel = escalateTo;
          const escResult = await splitAndTranslate(b64, idx, 2);
          if(escResult.length > result.length){
            diag(`${escName} ${escResult.length} > ${result.length} — ${escName} nyer`,'ok');
            return escResult;
          } else {
            diag(`${escName} ${escResult.length} ≤ ${result.length} — eredeti marad`);
          }
        }catch(e){
          console.warn('[escalate] hiba:',e.message);
        }finally{
          selModel = origModel;
        }
      }
      return result;
    }
    // 1. fallback: prose mód ugyanazzal a modellel (provider-aware)
    // Hibrid esetén a fordítónk modelljével (Claude) próza-módba esünk vissza
    const prose = isHybridModel(selModel)
      ? await claudeProse(b64, idx)
      : (isGeminiModel(selModel)
          ? await geminiProse(b64, idx)
          : await claudeProse(b64, idx));
    if(prose.length > 0) return prose;
    // 2. fallback — KASZKÁD a SAJÁT szolgáltatón belül (Gemini → Gemini, Claude → Claude)
    // Ha az automatikus eszkaláció BE van kapcsolva, és az első modell gyenge volt,
    // próbáljuk meg az ERŐSEBB modellel(ekkel). NEM ugrunk át szolgáltatóra (te döntesz).
    if(isAutoOpusFallbackEnabled()){
      const origModel = selModel;
      // Cascade-lánc: az aktuális modell után érkező erősebbek (UGYANABBAN A SZOLGÁLTATÓBAN)
      const cascade = [];
      if(selModel === 'gemini-2.5-flash-lite'){
        cascade.push('gemini-2.5-flash', 'gemini-2.5-pro');
      } else if(selModel === 'gemini-2.5-flash'){
        cascade.push('gemini-2.5-pro');
      } else if(selModel.includes('haiku')){
        cascade.push('claude-sonnet-4-6', 'claude-opus-4-5-20251101');
      } else if(selModel.includes('sonnet')){
        cascade.push('claude-opus-4-5-20251101');
      }
      // Csúcs-modell után nincs feljebb
      try{
        for(const nextModel of cascade){
          selModel = nextModel;
          const letter = isGeminiModel(nextModel) ? _modelLetterForGemini(nextModel) :
                         (nextModel.includes('haiku')?'Haiku':nextModel.includes('sonnet')?'Sonnet':'Opus');
          console.log(`[auto-cascade] 0/kevés találat → ${letter}-val újrapróba (lap ${idx+1})`);
          diag(`Kaszkád eszkaláció → ${nextModel}`,'warn');
          // Próba az új modellel
          const retry = await splitAndTranslate(b64, idx, 2);
          if(retry.length > 0) return retry;
          const retryProse = isHybridModel(selModel)
            ? await claudeProse(b64, idx)
            : (isGeminiModel(selModel)
                ? await geminiProse(b64, idx)
                : await claudeProse(b64, idx));
          if(retryProse.length > 0) return retryProse;
          // Ha még ez a modell se talált, megyünk tovább a következőre
        }
      }catch(e){console.warn('[auto-cascade] hiba:',e.message);}
      finally{selModel = origModel;} // visszaállítjuk a felhasználó választott modelljét
    }
    return [];
  }
}
function isAutoOpusFallbackEnabled(){
  return localStorage.getItem('kf_auto_opus_off')!=='1';
}
function toggleAutoOpus(){
  const off=localStorage.getItem('kf_auto_opus_off')==='1';
  const newState=!off;
  localStorage.setItem('kf_auto_opus_off',newState?'1':'0');
  const lbl=document.getElementById('auto-opus-label');
  if(lbl)lbl.textContent=newState?'KI':'BE';
  return !newState;
}

// ════════════ 📖 LORE RENDSZER ════════════
// A képregényekhez tartozó háttér-információk: szereplők, idővonal, kapcsolatok, eredet.
// JSON fájlokként importálódnak, automatikusan párosodnak könyv-címek alapján.

const LORE_LIB_KEY='bl_lore_library_v1';
let _loreLib={};      // {normalizedTitle: loreData}
let _currentLore=null; // az aktuális könyvhöz tartozó lore (ha van)

function loreNormalize(s){
  if(!s)return '';
  // Lowercase, ékezet-mentes, csak alfanumerikus + szóköz
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // ékezet
    .replace(/[^a-z0-9\s]/g,' ')                     // spec karakterek → szóköz
    .replace(/\s+/g,' ').trim();
}

function loadLoreLibrary(){
  try{
    const raw=localStorage.getItem(LORE_LIB_KEY);
    _loreLib=raw?JSON.parse(raw):{};
  }catch(e){_loreLib={};}
  renderLoreLibrary();
}

function saveLoreLibrary(){
  try{localStorage.setItem(LORE_LIB_KEY,JSON.stringify(_loreLib));}
  catch(e){setSt('error','Lore mentés sikertelen: '+e.message);}
}

// ════════════════════════════════════════════════════════════════════════════
// 🔤 OCR EXPORT / IMPORT — split pipeline (olcsó OCR + manuális fordítás)
// ════════════════════════════════════════════════════════════════════════════
// Stratégia: ha a Sonnet/Opus drága, az olcsóbb modellek (Gemini Flash-Lite,
// Haiku) "látnak" jól de gyengén fordítanak. Megoldás:
//   1. Az olcsó modellel csak az ANGOL szöveg + buborék-pozíciók kinyerése
//   2. Te a kapott TXT-t bemásolod egy chatbe (Claude.ai, ChatGPT) — INGYEN
//   3. Visszahozott magyar TXT-t importálod → összerakja
// Költség: kb. 50-100× olcsóbb mint a teljes Sonnet pipeline.

function exportOcrTxt(){
  if(!curBookKey || !pages.length){
    setSt('warn','📚 Először nyiss meg egy könyvet!');
    return;
  }
  const book = library.find(b=>b.key===curBookKey);
  const title = book?.title || curBookKey;

  // Számoljuk meg melyik lapokon van fordítható tartalom
  let totalBubbles = 0;
  let pagesWithContent = 0;
  pages.forEach(p=>{
    if(p.bubbles && p.bubbles.length){
      pagesWithContent++;
      totalBubbles += p.bubbles.length;
    }
  });

  if(totalBubbles === 0){
    setSt('warn','⚠️ Nincs OCR-elt buborék. Először fordíts le pár lapot az olcsó modellel (G/g/H betű).');
    return;
  }

  // TXT generálás — strukturált formátum amit a fordító megért + a BubbleLens vissza tud importálni
  let txt = `# BubbleLens OCR fordítási csomag\n`;
  txt += `# Könyv: ${title}\n`;
  txt += `# bookKey: ${curBookKey}\n`;
  txt += `# Lapok: ${pagesWithContent} lapon ${totalBubbles} buborék\n`;
  txt += `# Generálva: ${new Date().toISOString()}\n`;
  txt += `#\n`;
  txt += `# UTASÍTÁS A FORDÍTÓNAK (Claude.ai, ChatGPT, vagy bárki):\n`;
  txt += `# Fordítsd le a [HU:] sorokat magyarra. A jelölőket (== LAP X ==, [N.M]) NE módosítsd!\n`;
  txt += `# A magyar fordítást a [HU:] mögé írd, az [EN:] sort hagyd változatlanul.\n`;
  txt += `# Ha valamit nem értesz, hagyd üresen — később kézzel javítható.\n`;
  txt += `\n`;

  pages.forEach((p, pageIdx)=>{
    if(!p.bubbles || !p.bubbles.length) return;
    txt += `== LAP ${pageIdx+1} ==\n`;
    p.bubbles.forEach((b, bubIdx)=>{
      const orig = (b.original || '').replace(/\r?\n/g, ' ').trim();
      txt += `[${pageIdx+1}.${bubIdx+1}]\n`;
      txt += `[EN:] ${orig}\n`;
      txt += `[HU:] ${b.hungarian || ''}\n`;
      txt += `\n`;
    });
  });

  // Letöltés
  const safeTitle = title.replace(/[^a-zA-Z0-9_-]+/g,'_').slice(0,50);
  const filename = `${safeTitle}_ocr_for_translation.txt`;
  const blob = new Blob([txt], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);

  setSt('success',`✅ Exportálva: ${filename} (${totalBubbles} buborék) — másold át chatbe fordításra!`);
}

async function importOcrTrans(file){
  if(!curBookKey || !pages.length){
    setSt('warn','📚 Először nyiss meg ugyanazt a könyvet amit exportáltál!');
    return;
  }

  let txt;
  try{ txt = await file.text(); }
  catch(e){ setSt('error','TXT olvasási hiba: '+e.message); return; }

  // BookKey egyezés ellenőrzés (header sorból)
  const headerMatch = txt.match(/# bookKey:\s*(\S+)/);
  if(headerMatch && headerMatch[1] !== curBookKey){
    if(!confirm(`⚠️ A TXT más könyvhöz készült!\n\nTXT bookKey: ${headerMatch[1]}\nAktuális könyv: ${curBookKey}\n\nFolytatod mégis?`)){
      return;
    }
  }

  // Parse: [N.M] blokkok
  // Pl.:
  //   [3.5]
  //   [EN:] What's there?
  //   [HU:] Ki van ott?
  const blocks = txt.split(/\n(?=\[\d+\.\d+\]\s*\n)/);
  let updated = 0;
  let missingHu = 0;

  for(const block of blocks){
    const idMatch = block.match(/\[(\d+)\.(\d+)\]/);
    if(!idMatch) continue;
    const pageIdx = parseInt(idMatch[1],10) - 1;
    const bubIdx = parseInt(idMatch[2],10) - 1;
    if(!pages[pageIdx] || !pages[pageIdx].bubbles || !pages[pageIdx].bubbles[bubIdx]) continue;

    const huMatch = block.match(/\[HU:\]\s*(.+?)(?=\n\[|$)/s);
    if(huMatch){
      const hu = huMatch[1].trim();
      if(hu){
        pages[pageIdx].bubbles[bubIdx].hungarian = hu;
        updated++;
      } else {
        missingHu++;
      }
    }
  }

  if(updated === 0){
    setSt('error','⚠️ Egy fordítás sem lett importálva. Ellenőrizd a fájl formátumát!');
    return;
  }

  // Mentés IDB-be
  if(typeof saveCurrentPageTranslation === 'function'){
    // Az összes lapot mentjük (mert minden lapon változott valami)
    for(let i=0; i<pages.length; i++){
      if(pages[i].bubbles && _idbTransReady){
        await idbTransPut(curBookKey, i, pages[i].bubbles);
      }
    }
  } else {
    saveProgress();
  }

  // Újrarajzolás
  renderPage();

  let msg = `✅ ${updated} fordítás importálva`;
  if(missingHu > 0) msg += ` (${missingHu} buborék még üres magyar)`;
  setSt('success', msg);
}

async function importLoreFiles(files){
  let added=0;
  for(const f of files){
    try{
      const text=await f.text();
      const data=JSON.parse(text);
      // Title meghatározás
      const title=data?.meta?.title||data?.title||f.name.replace(/\.json$/i,'');
      const key=loreNormalize(title);
      if(!key)continue;
      _loreLib[key]={
        title:title,
        data:data,
        importedAt:Date.now(),
        fileName:f.name
      };
      added++;
    }catch(e){
      console.warn('Lore import hiba:',f.name,e.message);
      setSt('error',`Hiba: ${f.name} — ${e.message}`);
    }
  }
  if(added){
    saveLoreLibrary();
    renderLoreLibrary();
    setSt('success',`✓ ${added} lore fájl betöltve`);
    // Frissítsük a 📖 gomb állapotát ha épp olvasunk
    updateLoreButton();
  }
}

// Android-on a natív fájlválasztót használjuk
function androidPickLoreMaybe(ev){
  if(!isAndroidApp())return; // browser: a label automatikusan megnyitja az inputot
  ev.preventDefault();ev.stopPropagation();
  setSt('loading','Lore fájl(ok) kiválasztása...');
  try{
    if(typeof AndroidBridge.pickLoreFiles==='function'){
      AndroidBridge.pickLoreFiles();
    }else{
      // Régi MainActivity, nincs ilyen metódus → adj feedback-et
      setSt('error','Frissítsd a Bubblelens app-ot a v78 MainActivity.kt-jával!');
    }
  }catch(e){setSt('error','Android hiba: '+e.message);}
}

// Android hívja ezt amikor a felhasználó kiválasztott egy vagy több JSON-t.
// A paraméter egy tömb: [{name, content}, ...]  — content = a JSON szövege
window.AndroidLoreFilesPicked=async function(files){
  if(!files||!files.length){setSt('warn','Nem választottál ki fájlt.');return;}
  let added=0;
  for(const f of files){
    try{
      const data=JSON.parse(f.content);
      const title=data?.meta?.title||data?.title||f.name.replace(/\.json$/i,'');
      const key=loreNormalize(title);
      if(!key)continue;
      _loreLib[key]={
        title:title,data:data,
        importedAt:Date.now(),fileName:f.name
      };
      added++;
    }catch(e){
      console.warn('Lore import hiba:',f.name,e.message);
      setSt('error',`Hiba: ${f.name} — ${e.message}`);
    }
  }
  if(added){
    saveLoreLibrary();
    renderLoreLibrary();
    setSt('success',`✓ ${added} lore fájl betöltve`);
    updateLoreButton();
  }
};

function deleteLore(key){
  if(!confirm(`Törlöd: ${_loreLib[key]?.title}?`))return;
  delete _loreLib[key];
  saveLoreLibrary();
  renderLoreLibrary();
  updateLoreButton();
}

function renderLoreLibrary(){
  const container=document.getElementById('lore-library');
  if(!container)return;
  const entries=Object.entries(_loreLib);
  if(!entries.length){
    container.innerHTML=`<div style="padding:6px 4px;font-size:.78rem;color:var(--mut);font-family:'Share Tech Mono',monospace">Még nincs lore betöltve.</div>`;
    return;
  }
  container.innerHTML=entries.map(([key,entry])=>{
    const chars=entry.data?.characters?.length||0;
    const tl=entry.data?.timeline?.length||0;
    return `<div class="lore-lib-item">
      <span>📖</span>
      <span class="lli-name">${esc(entry.title)}</span>
      <span class="lli-meta">${chars} szerep · ${tl} esemény</span>
      <button class="lli-del" onclick="deleteLore('${esc(key)}')" title="Törlés">🗑</button>
    </div>`;
  }).join('');
}

// Egy könyv címéhez illő lore keresése
function findLoreForBook(bookTitle){
  const norm=loreNormalize(bookTitle);
  if(!norm)return null;
  // Keressük meg azt a lore-t aminek a normalizált címe prefixe a könyv normalizált címének
  let best=null, bestLen=0;
  for(const key in _loreLib){
    // pl. key="black science", norm="black science v01 how to fall forever 2014"
    if(norm.startsWith(key+' ')||norm===key){
      if(key.length>bestLen){best=_loreLib[key];bestLen=key.length;}
    }
    // Vagy fordítva: ha a könyv címe rövidebb és pre fix-ként szerepel a lore címében
    else if(key.startsWith(norm+' ')||key===norm){
      if(norm.length>bestLen){best=_loreLib[key];bestLen=norm.length;}
    }
  }
  return best;
}

// A 📖 gomb állapotának frissítése az épp megnyitott könyv alapján
function updateLoreButton(){
  const btn=document.getElementById('ib-lore');
  if(!btn)return;
  if(!curBookKey){btn.style.display='none';_currentLore=null;return;}
  const book=library.find(b=>b.key===curBookKey);
  if(!book){btn.style.display='none';_currentLore=null;return;}
  const lore=findLoreForBook(book.title);
  _currentLore=lore;
  if(lore){
    btn.style.display='flex';
    btn.classList.add('has-lore');
    btn.title=`Lore: ${lore.title}`;
  }else{
    btn.style.display='none'; // csak akkor mutatjuk ha van találat
    btn.classList.remove('has-lore');
  }
}

// ══ LORE POPUP ══
let _loreActiveTab='meta';
function openLoreViewer(){
  if(!_currentLore){setSt('warn','Nincs lore ehhez a könyvhöz.');return;}
  const pop=document.getElementById('lore-popup');
  document.getElementById('lore-title').textContent=_currentLore.title||'Lore';
  _loreActiveTab='meta';
  document.querySelectorAll('.lore-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab==='meta'));
  renderLoreTab('meta');
  pop.classList.add('open');
}

function closeLoreViewer(){
  document.getElementById('lore-popup').classList.remove('open');
}

function switchLoreTab(tab){
  _loreActiveTab=tab;
  document.querySelectorAll('.lore-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  renderLoreTab(tab);
}

function renderLoreTab(tab){
  const body=document.getElementById('lore-body');
  if(!body||!_currentLore)return;
  const d=_currentLore.data||{};

  if(tab==='meta'){
    const m=d.meta||{};
    const parts=[];
    parts.push(`<div class="lore-meta-title">${esc(m.title||_currentLore.title||'Ismeretlen')}</div>`);
    const subParts=[];
    if(m.creator)subParts.push(esc(m.creator));
    if(m.year)subParts.push(esc(m.year));
    if(subParts.length)parts.push(`<div class="lore-meta-sub">${subParts.join(' · ')}</div>`);

    const fields=[];
    if(m.publisher)fields.push(`<div class="lore-meta-field"><div class="lbl">Kiadó</div><div class="val">${esc(m.publisher)}</div></div>`);
    if(m.genre)fields.push(`<div class="lore-meta-field"><div class="lbl">Műfaj</div><div class="val">${esc(m.genre)}</div></div>`);
    if(m.year&&!subParts.includes(m.year))fields.push(`<div class="lore-meta-field"><div class="lbl">Megjelenés</div><div class="val">${esc(m.year)}</div></div>`);
    if(fields.length)parts.push(`<div class="lore-meta-grid">${fields.join('')}</div>`);

    if(m.summary)parts.push(`<div class="lore-summary">${esc(m.summary)}</div>`);

    if(d.readingOrder)parts.push(`<div class="lore-reading-order">
      <div class="rol-lbl">📚 AJÁNLOTT OLVASÁSI SORREND</div>
      ${esc(d.readingOrder)}
    </div>`);

    body.innerHTML=parts.join('');
    return;
  }

  // Segéd: spoiler-szűrés a karakterekre és az idővonal-eseményekre.
  // Az `unlocksAtPage` mező alapján rejtjük az elemeket. Ha nincs könyv nyitva,
  // vagy nincs `unlocksAtPage`, alapból minden látszik.
  const _curPage = (typeof curBookKey === 'string' && curBookKey && typeof cur === 'number') ? (cur + 1) : Infinity;
  const _isUnlocked = (item) => {
    const u = item && item.unlocksAtPage;
    if(typeof u !== 'number' || u <= 0) return true;
    return _curPage >= u;
  };

  if(tab==='chars'){
    const allChars=d.characters||[];
    const chars=allChars.filter(_isUnlocked);
    const hiddenCount=allChars.length - chars.length;
    if(!allChars.length){body.innerHTML=renderLoreEmpty('👥','Nincsenek szereplők megadva');return;}
    let html = '';
    if(hiddenCount > 0){
      html += `<div style="margin-bottom:12px;padding:8px 12px;background:rgba(255,209,102,.1);border-left:3px solid var(--yel);border-radius:5px;font-size:.78rem;color:var(--yel);font-family:'Share Tech Mono',monospace">
        🔒 ${hiddenCount} szereplő rejtett spoiler-védelemmel — folytasd az olvasást a megjelenítéshez!
      </div>`;
    }
    if(chars.length === 0){
      html += renderLoreEmpty('🔒','Még nem unlockoltál szereplőt');
      body.innerHTML = html;
      return;
    }
    html += chars.map((c,i)=>{
      const traits=(c.traits||[]).map(t=>`<span class="lore-trait">${esc(t)}</span>`).join('');
      const aliases=c.aliases?`<span class="lore-char-aliases">"${esc(c.aliases)}"</span>`:'';
      const role=c.role?`<span class="lore-char-role">· ${esc(c.role)}</span>`:'';
      const bio=c.shortBio?`<div class="lore-char-bio">${esc(c.shortBio)}</div>`:'';
      const voice=c.voiceStyle?`<div class="lore-char-voice">🎭 <b>Hang:</b> ${esc(c.voiceStyle)}</div>`:'';
      const hasMore=!!c.fullBio&&c.fullBio!==c.shortBio;
      const fullId=`lore-full-${i}`;
      const expandBtn=hasMore?`<button class="lore-char-expand" onclick="toggleLoreFullBio('${fullId}',this)">▼ Részletes háttér</button>
        <div id="${fullId}" class="lore-char-bio-full" style="display:none">${esc(c.fullBio)}</div>`:'';
      return `<div class="lore-char" style="animation-delay:${i*30}ms">
        <div class="lore-char-head">
          <span class="lore-char-name">${esc(c.name||'?')}</span>
          ${aliases}${role}
        </div>
        ${bio}
        ${traits?`<div class="lore-char-traits">${traits}</div>`:''}
        ${voice}
        ${expandBtn}
      </div>`;
    }).join('');
    body.innerHTML = html;
    return;
  }

  if(tab==='rel'){
    const chars=d.characters||[];
    const withRel=chars.filter(c=>(c.relationships||[]).length);
    if(!chars.length){body.innerHTML=renderLoreEmpty('🔗','Nincs kapcsolati információ');return;}
    // Vizuális graf + lista
    body.innerHTML=`
      <div id="lore-rel-container">
        <div id="lore-rel-toolbar">
          <button class="rel-layout-btn active" data-layout="force" onclick="setRelLayout('force')">⚡ Erő</button>
          <button class="rel-layout-btn" data-layout="circle" onclick="setRelLayout('circle')">⭕ Kör</button>
          <button class="rel-layout-btn" onclick="resetRelView()" title="Háló visszaállítása alaphelyzetbe">⊙ Reset</button>
          <span id="lore-rel-stats">0 node · 0 él</span>
        </div>
        <svg id="lore-rel-svg" preserveAspectRatio="xMidYMid meet"></svg>
        <div id="lore-rel-spread-bar">
          <label>🔍 Nagyítás</label>
          <input type="range" id="lore-rel-zoom-slider" min="50" max="400" value="100" step="5"
            oninput="setRelZoomFromSlider(this.value)">
          <span id="lore-rel-zoom-val">100%</span>
        </div>
        <div id="lore-rel-info">Koppints egy szereplőre — csak az ő kapcsolatait mutatjuk. Húzd a mozgatáshoz, csippents a szétnyitáshoz (szellősebb háló).</div>
      </div>
    `;
    // Az SVG-t populáljuk:
    _loreRelChars=chars;
    _loreRelActive=null;
    _loreRelLayout='force';
    _loreRelView={x:0,y:0,w:800,h:420};
    _loreRelSpread=1.0;
    renderLoreRelGraph();
    initLoreRelGestures();
    return;
  }

  if(tab==='timeline'){
    const allTl=d.timeline||[];
    const tl=allTl.filter(_isUnlocked);
    const hiddenCount=allTl.length - tl.length;
    if(!allTl.length){body.innerHTML=renderLoreEmpty('⏳','Nincs idővonal megadva');return;}
    // Toolbar: mindet ki/be gomb + spoiler info
    const toolbar=`<div id="lore-tl-toolbar">
      <button class="rel-layout-btn" onclick="toggleAllTimelineItems(true)">▼ Mindet ki</button>
      <button class="rel-layout-btn" onclick="toggleAllTimelineItems(false)">▲ Mindet be</button>
      <span style="font-family:'Share Tech Mono',monospace;font-size:.7rem;color:var(--mut);margin-left:auto">
        ${tl.length} / ${allTl.length} esemény
      </span>
    </div>`;
    let html = toolbar;
    if(hiddenCount > 0){
      html += `<div style="margin-bottom:12px;padding:8px 12px;background:rgba(255,209,102,.1);border-left:3px solid var(--yel);border-radius:5px;font-size:.78rem;color:var(--yel);font-family:'Share Tech Mono',monospace">
        🔒 ${hiddenCount} esemény rejtett spoiler-védelemmel — folytasd az olvasást a megjelenítéshez!
      </div>`;
    }
    if(tl.length === 0){
      html += renderLoreEmpty('🔒','Még nem unlockoltál idővonal-eseményt');
      body.innerHTML = html;
      return;
    }
    html += tl.map((t,i)=>{
      const era=t.era||t.time||t.when||'';
      const content=t.content||t.description||'';
      const hasContent=content&&content.trim().length>0;
      const ariaId=`lore-tl-cont-${i}`;
      // Csak akkor van click-handler ha van tartalom
      const clickable=hasContent?`onclick="toggleTimelineItem(${i},this)"`:'';
      const indicator=hasContent?`<span class="lore-tl-toggle">▶</span>`:'';
      return `<div class="lore-tl-item${hasContent?' clickable':''}" ${clickable} style="animation-delay:${i*30}ms">
        <div class="lore-tl-head">
          ${indicator}
          <div class="lore-tl-title">${esc(t.title||'?')}</div>
        </div>
        ${era?`<div class="lore-tl-era">${esc(era)}</div>`:''}
        ${hasContent?`<div class="lore-tl-content" id="${ariaId}" style="display:none">${esc(content)}</div>`:''}
      </div>`;
    }).join('');
    body.innerHTML = html;
    return;
  }

  if(tab==='origin'){
    const parts=[];
    if(d.originStory){
      parts.push(`<div class="lore-origin"><p>${esc(d.originStory).replace(/\n\n+/g,'</p><p>').replace(/\n/g,'<br>')}</p></div>`);
    }
    if(!parts.length){body.innerHTML=renderLoreEmpty('🎬','Nincs háttér-információ megadva');return;}
    body.innerHTML=parts.join('');
    return;
  }
}

function toggleLoreFullBio(id,btn){
  const el=document.getElementById(id);
  if(!el)return;
  const open=el.style.display!=='none';
  el.style.display=open?'none':'block';
  btn.textContent=open?'▼ Részletes háttér':'▲ Bezárás';
}

function toggleTimelineItem(idx,el){
  const cont=el.querySelector('.lore-tl-content');
  const tog=el.querySelector('.lore-tl-toggle');
  if(!cont)return;
  const isOpen=cont.style.display!=='none';
  cont.style.display=isOpen?'none':'block';
  if(tog)tog.textContent=isOpen?'▶':'▼';
  el.classList.toggle('open',!isOpen);
}

function toggleAllTimelineItems(open){
  document.querySelectorAll('.lore-tl-item.clickable').forEach(el=>{
    const cont=el.querySelector('.lore-tl-content');
    const tog=el.querySelector('.lore-tl-toggle');
    if(!cont)return;
    cont.style.display=open?'block':'none';
    if(tog)tog.textContent=open?'▼':'▶';
    el.classList.toggle('open',open);
  });
}

function renderLoreEmpty(ico,msg){
  return `<div class="lore-empty"><div class="lore-empty-ico">${ico}</div>${esc(msg)}</div>`;
}

// ══ Vizuális kapcsolati háló ══
let _loreRelChars=[];
let _loreRelActive=null;
let _loreRelLayout='force';
let _loreRelView={x:0,y:0,w:800,h:420};
let _loreRelPositions={};
// Spread tényező: 1 = normál, >1 = szellősebb (pinch-spread).
// Csak a csomópont-pozíciókat befolyásolja, NEM a csomópontok méretét.
let _loreRelSpread=1.0;

function setRelLayout(layout){
  _loreRelLayout=layout;
  document.querySelectorAll('.rel-layout-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.layout===layout);
  });
  renderLoreRelGraph();
}

function resetRelView(){
  _loreRelView={x:0,y:0,w:800,h:420};
  _loreRelSpread=1.0;
  const svg=document.getElementById('lore-rel-svg');
  if(svg)svg.setAttribute('viewBox',`0 0 800 420`);
  _syncZoomSlider();
  renderLoreRelGraph();
}

function selectRelNode(id){
  // Ha explicit null jött, akkor a × VISSZA gombról (vissza a teljes hálóra)
  // Egyébként toggle: ugyanaz a node = bezár, más node = az új lesz aktív
  if(id===null||id===undefined||id==='null'){
    _loreRelActive=null;
  } else {
    _loreRelActive=(_loreRelActive===id?null:id);
  }
  renderLoreRelGraph();
}

// Spread max megnövelve a v2.40-ban: 3.0 → 9.0 (3× a mostanit)
function setRelSpreadFromSlider(val){
  const v = parseInt(val,10) / 100;
  _loreRelSpread = Math.max(0.4, Math.min(9.0, v));
  renderLoreRelGraph();
}

// Nagyítás csúszka — viewBox alapú zoom (a köröket is nagyítja)
// 50% = 2× kicsi, 100% = normál, 400% = 4× nagy
function setRelZoomFromSlider(val){
  const pct = parseInt(val,10) / 100;
  // Az alap viewBox 800x420 — ezt osztjuk a zoom-mal
  // Minél kisebb a w/h, annál nagyobb a zoom (a viewBox kisebb területet mutat)
  const baseW = 800, baseH = 420;
  const newW = baseW / pct;
  const newH = baseH / pct;
  // A nézet középpontja maradjon (a viewBox közepét tartjuk)
  const cx = _loreRelView.x + _loreRelView.w / 2;
  const cy = _loreRelView.y + _loreRelView.h / 2;
  _loreRelView.x = cx - newW / 2;
  _loreRelView.y = cy - newH / 2;
  _loreRelView.w = newW;
  _loreRelView.h = newH;
  const lbl = document.getElementById('lore-rel-zoom-val');
  if(lbl) lbl.textContent = Math.round(pct*100)+'%';
  const svg = document.getElementById('lore-rel-svg');
  if(svg) svg.setAttribute('viewBox', `${_loreRelView.x} ${_loreRelView.y} ${_loreRelView.w} ${_loreRelView.h}`);
}

// Slider szinkronizáció (pinch után frissítjük) — csak a nagyítás-slider-re kell
function _syncZoomSlider(){
  const slider = document.getElementById('lore-rel-zoom-slider');
  const lbl = document.getElementById('lore-rel-zoom-val');
  // Az aktuális nagyítás = baseW / _loreRelView.w
  const pct = Math.round((800 / _loreRelView.w) * 100);
  if(slider) slider.value = Math.max(50, Math.min(400, pct));
  if(lbl) lbl.textContent = pct+'%';
}

function _relCircleLayout(chars,cx,cy,r){
  const n=chars.length,pos={};
  chars.forEach((c,i)=>{
    const a=(i/n)*Math.PI*2-Math.PI/2;
    pos[c.id]={x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r};
  });
  return pos;
}
function _relGridLayout(chars,W,H){
  const n=chars.length;
  const cols=Math.ceil(Math.sqrt(n*(W/H)));
  const rows=Math.ceil(n/cols);
  const sx=W/(cols+1),sy=H/(rows+1),pos={};
  chars.forEach((c,i)=>{
    const col=i%cols,row=Math.floor(i/cols);
    pos[c.id]={x:sx*(col+1),y:sy*(row+1)};
  });
  return pos;
}
function _relForceLayout(chars,W,H){
  const pos=_relCircleLayout(chars,W/2,H/2,Math.min(W,H)/2-70);
  const adj={};
  chars.forEach(c=>{adj[c.id]=[];});
  chars.forEach(c=>{
    (c.relationships||[]).forEach(r=>{
      if(r.withId&&adj[r.withId]!==undefined){
        adj[c.id].push(r.withId);
        adj[r.withId].push(c.id);
      }
    });
  });
  for(let iter=0;iter<60;iter++){
    chars.forEach(c=>{
      const p=pos[c.id];let dx=0,dy=0;
      chars.forEach(other=>{
        if(other.id===c.id)return;
        const o=pos[other.id];
        const vx=p.x-o.x,vy=p.y-o.y;
        const d2=vx*vx+vy*vy+0.01,d=Math.sqrt(d2),f=800/d2;
        dx+=(vx/d)*f;dy+=(vy/d)*f;
      });
      (adj[c.id]||[]).forEach(oid=>{
        const o=pos[oid];
        dx+=(o.x-p.x)*0.01;dy+=(o.y-p.y)*0.01;
      });
      dx+=(W/2-p.x)*0.002;dy+=(H/2-p.y)*0.002;
      p.x+=dx*0.3;p.y+=dy*0.3;
      p.x=Math.max(40,Math.min(W-40,p.x));
      p.y=Math.max(40,Math.min(H-50,p.y));
    });
  }
  return pos;
}

function renderLoreRelGraph(){
  const svg=document.getElementById('lore-rel-svg');
  const info=document.getElementById('lore-rel-info');
  const stats=document.getElementById('lore-rel-stats');
  if(!svg||!_loreRelChars.length)return;

  // ─────────────────────────────────────────────────────────────────
  // SPOILER-VÉDELEM: az `unlocksAtPage` mező alapján rejtjük a karaktereket.
  // Ha a karakteren nincs `unlocksAtPage` → mindig látszik (alapérték: 0).
  // Ha nincs nyitva könyv (lore-popup más helyről) → minden látszik.
  // ─────────────────────────────────────────────────────────────────
  const curBookPage = (typeof curBookKey === 'string' && curBookKey && typeof cur === 'number') ? (cur + 1) : Infinity;
  const isUnlocked = (c) => {
    const u = c.unlocksAtPage;
    if(typeof u !== 'number' || u <= 0) return true;
    return curBookPage >= u;
  };
  const visibleChars = _loreRelChars.filter(isUnlocked);
  const hiddenCount = _loreRelChars.length - visibleChars.length;

  // Stats
  let edgeCount=0;
  visibleChars.forEach(c=>edgeCount+=(c.relationships||[]).filter(r=>r.withId&&visibleChars.find(v=>v.id===r.withId)).length);
  if(stats){
    let txt = `${visibleChars.length} szereplő · ${edgeCount} él`;
    if(hiddenCount>0) txt += ` · 🔒 ${hiddenCount} rejtett (spoiler)`;
    stats.textContent = txt;
  }

  // Pozíciók (csak a látható karakterekre)
  const W=800,H=420;
  const layoutFn={
    circle:()=>_relCircleLayout(visibleChars,W/2,H/2,Math.min(W,H)/2-60),
    force:()=>_relForceLayout(visibleChars,W,H),
    grid:()=>_relGridLayout(visibleChars,W,H)
  };
  const basePos=(layoutFn[_loreRelLayout]||layoutFn.force)();

  // SPREAD alkalmazása: a csomópontokat a háló közepétől kifelé skálázzuk,
  // de a csomópontok mérete (r) változatlan marad. Ez "szellősebb" elrendezést ad.
  const cx = W/2, cy = H/2;
  const pos = {};
  for(const id in basePos){
    const p = basePos[id];
    pos[id] = {
      x: cx + (p.x - cx) * _loreRelSpread,
      y: cy + (p.y - cy) * _loreRelSpread
    };
  }
  _loreRelPositions=pos;

  // ViewBox beállítás
  svg.setAttribute('viewBox',`${_loreRelView.x} ${_loreRelView.y} ${_loreRelView.w} ${_loreRelView.h}`);

  // Élek (csak látható karakterek között, deduplikálva)
  const edgesMap=new Map();
  visibleChars.forEach(c=>{
    (c.relationships||[]).forEach(r=>{
      if(!r.withId||!pos[r.withId])return;
      const a=c.id,b=r.withId;
      const key=[a,b].sort().join('|');
      if(!edgesMap.has(key)){
        const [ka,kb]=key.split('|');
        edgesMap.set(key,{a:ka,b:kb,types:[]});
      }
      edgesMap.get(key).types.push({from:a,to:b,label:r.type||''});
    });
  });
  const edges=[...edgesMap.values()];
  const hasActive=!!_loreRelActive && visibleChars.some(c=>c.id===_loreRelActive);
  const connectedIds=new Set();
  if(hasActive){
    connectedIds.add(_loreRelActive);
    edges.forEach(e=>{
      if(e.a===_loreRelActive)connectedIds.add(e.b);
      if(e.b===_loreRelActive)connectedIds.add(e.a);
    });
  }

  // ─── FÓKUSZ MÓD ─────────────────────────────────────────────────────
  // Ha van aktív karakter, CSAK az aktív + a kapcsolatai jelennek meg.
  // A többi karakter ÉS minden hozzájuk tartozó él TELJESEN ELTŰNIK
  // (opacity 0, de még a DOM-ban marad — animálható átmenet).
  // ────────────────────────────────────────────────────────────────────

  // Élek render
  const activeEdges=[];
  const otherEdgesHtml=edges.map(e=>{
    const pa=pos[e.a],pb=pos[e.b];
    if(!pa||!pb)return '';
    const isActive=hasActive&&(e.a===_loreRelActive||e.b===_loreRelActive);
    if(isActive){activeEdges.push({e,pa,pb});return '';}
    const klass=hasActive?'rel-edge dim':'rel-edge';
    return `<line class="${klass}" x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" />`;
  }).join('');
  const activeEdgesHtml=activeEdges.map(({pa,pb})=>
    `<line class="rel-edge highlight" x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" />`
  ).join('');

  // Címkék (csak aktív csomópont éleihez)
  // ÚJ logika: a címke NEM az él közepén van, hanem a MÁSIK csomópont felé
  // 85%-ig (közelebb a kapcsolódó karakterhez, távol az aktívtól és egymástól).
  if(hasActive){
    const activePos = pos[_loreRelActive];
    const labelItems = activeEdges.map(({e,pa,pb})=>{
      // A címke iránya AZ AKTÍV csomópont szempontjából.
      const isAFrom = e.a === _loreRelActive;
      const otherPos = isAFrom ? pb : pa;
      const otherId = isAFrom ? e.b : e.a;
      // Csak az aktívból kifelé mutatott típusokat vegyük (A→B típusok)
      const fromActiveTypes = e.types.filter(t => t.from === _loreRelActive);
      let lblTexts = fromActiveTypes.map(t=>t.label).filter(Boolean);
      if(lblTexts.length === 0){
        lblTexts = e.types.filter(t => t.to === _loreRelActive).map(t=>t.label).filter(Boolean);
      }
      const lblText = [...new Set(lblTexts)].join(' · ');
      if(!lblText) return null;
      // Címke pozíció: a vonal KÖZEPE (50%) — egyszerű és átlátható
      const t = 0.5;
      const lx = activePos.x + (otherPos.x - activePos.x) * t;
      const ly = activePos.y + (otherPos.y - activePos.y) * t;
      return {
        text: lblText.length > 30 ? lblText.slice(0,28)+'…' : lblText,
        x: lx, y: ly,
        otherX: otherPos.x, otherY: otherPos.y,
        otherId,
      };
    }).filter(Boolean);

    // Ütközés-elkerülés: agresszívabban (8 iteráció, mindkét tengely, csomópont-elkerülés)
    const labelW = 140, labelH = 36;
    const nodeR = 38; // valódi nagy körök (44/36)
    for(let pass = 0; pass < 8; pass++){
      // 1) Címkék egymástól elkerülése (mindkét tengely)
      for(let i = 0; i < labelItems.length; i++){
        for(let j = i+1; j < labelItems.length; j++){
          const dx = labelItems[j].x - labelItems[i].x;
          const dy = labelItems[j].y - labelItems[i].y;
          const adx = Math.abs(dx), ady = Math.abs(dy);
          if(adx < labelW && ady < labelH){
            // Átfedés van — eltoljuk Y-ban (vízszintes szöveg miatt jobban tűr)
            const overlapY = labelH - ady + 4;
            const dirY = dy >= 0 ? 1 : -1;
            labelItems[i].y -= dirY * overlapY * 0.5;
            labelItems[j].y += dirY * overlapY * 0.5;
            // Ha függőlegesen NEM tudjuk eltolni eléggé, X-ben is
            if(adx < labelW * 0.3){
              const overlapX = labelW - adx + 4;
              const dirX = dx >= 0 ? 1 : -1;
              labelItems[i].x -= dirX * overlapX * 0.25;
              labelItems[j].x += dirX * overlapX * 0.25;
            }
          }
        }
      }
      // 2) Címkék elkerülik a saját + más csomópontokat (kör + körkörös biztonsági zóna)
      for(const L of labelItems){
        // Az aktív csomópont
        const ddx = L.x - activePos.x, ddy = L.y - activePos.y;
        const dist = Math.hypot(ddx, ddy);
        const minDist = nodeR + 20;
        if(dist < minDist && dist > 0.001){
          const factor = minDist / dist;
          L.x = activePos.x + ddx * factor;
          L.y = activePos.y + ddy * factor;
        }
        // A kapcsolódó (másik) csomópont
        const dx2 = L.x - L.otherX, dy2 = L.y - L.otherY;
        const dist2 = Math.hypot(dx2, dy2);
        const minDist2 = nodeR + 22;
        if(dist2 < minDist2 && dist2 > 0.001){
          const factor = minDist2 / dist2;
          L.x = L.otherX + dx2 * factor;
          L.y = L.otherY + dy2 * factor;
        }
      }
    }

    var labelHtml = labelItems.map(L=>{
      const w = L.text.length * 12 + 24;
      return `<rect class="rel-edge-bg" x="${L.x-w/2}" y="${L.y-18}" width="${w}" height="32" rx="6"/>
        <text class="rel-edge-label" x="${L.x}" y="${L.y+6}">${esc(L.text)}</text>`;
    }).join('');
  } else {
    var labelHtml = '';
  }

  // Csomópontok (csak a látható karakterek)
  const nodeSvg=visibleChars.map(c=>{
    const p=pos[c.id];if(!p)return '';
    const active=c.id===_loreRelActive;
    const dimmed=hasActive&&!connectedIds.has(c.id);
    const r=active?44:36;
    const initial=((c.name||'?').trim().charAt(0)||'?').toUpperCase();
    const klass=`rel-node${active?' active':''}${dimmed?' dim':''}`;
    return `<g class="${klass}" onclick="selectRelNode('${esc(c.id)}')">
      <circle class="rel-node-circle" cx="${p.x}" cy="${p.y}" r="${r}" />
      <text class="rel-node-initial" x="${p.x}" y="${p.y}">${esc(initial)}</text>
      <text class="rel-node-label" x="${p.x}" y="${p.y+r+22}">${esc((c.name||'?').slice(0,16))}</text>
    </g>`;
  }).join('');

  svg.innerHTML=otherEdgesHtml+activeEdgesHtml+labelHtml+nodeSvg;

  // Info panel
  if(hasActive&&info){
    const c=visibleChars.find(x=>x.id===_loreRelActive);
    if(c){
      // Csak a NEM-rejtett karakterekkel való kapcsolatokat mutatjuk
      const rels=(c.relationships||[]).filter(r=>r.withId&&visibleChars.find(x=>x.id===r.withId)).map(r=>{
        const other=visibleChars.find(x=>x.id===r.withId);
        return `<span class="rel-info-chip"><strong>${esc(other?other.name||'?':'?')}</strong>${esc(r.type||'—')}</span>`;
      });
      const header=`<strong>${esc(c.name||'?')}</strong>${c.role?' · <span style="color:var(--mut)">'+esc(c.role)+'</span>':''}`;
      const bio=c.shortBio?`<div style="margin-top:3px;color:var(--txt);font-size:.78rem">${esc(c.shortBio)}</div>`:'';
      const relHtml=rels.length?`<div style="margin-top:6px">${rels.join('')}</div>`:'';
      const closeBtn=`<button onclick="selectRelNode(null)" style="float:right;background:none;border:1px solid var(--brd);color:var(--mut);padding:2px 8px;border-radius:4px;font-size:.7rem;cursor:pointer;font-family:'Share Tech Mono',monospace">× VISSZA</button>`;
      info.innerHTML=closeBtn+header+bio+relHtml;
    }
  }else if(info){
    let txt = 'Koppints egy szereplőre — csak az ő kapcsolatait mutatjuk. Húzd a mozgatáshoz, csippents a szétnyitáshoz (szellősebb háló).';
    if(hiddenCount>0) txt += ` <span style="color:var(--yel)">🔒 ${hiddenCount} szereplő rejtett spoiler-védelemmel.</span>`;
    info.innerHTML=txt;
  }
}

function initLoreRelGestures(){
  const svg=document.getElementById('lore-rel-svg');
  if(!svg||svg._gesturesInit)return;
  svg._gesturesInit=true;

  const applyViewBox=()=>svg.setAttribute('viewBox',`${_loreRelView.x} ${_loreRelView.y} ${_loreRelView.w} ${_loreRelView.h}`);

  const panView=(dxs,dys)=>{
    const rect=svg.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0)return;
    _loreRelView.x-=(dxs/rect.width)*_loreRelView.w;
    _loreRelView.y-=(dys/rect.height)*_loreRelView.h;
    applyViewBox();
  };

  // Spread módosítás: NEM a viewBox-ot zoom-olja (mert az a köröket is nagyítaná),
  // hanem a csomópont-távolságokat skálázza. A körök mérete változatlan.
  // Max 9.0 (3× a régi 3.0-tól) — nagyon szellős hálót lehet csinálni.
  const applySpread=(factor)=>{
    const newSpread = Math.max(0.4, Math.min(9.0, _loreRelSpread * factor));
    if(Math.abs(newSpread - _loreRelSpread) < 0.001) return;
    _loreRelSpread = newSpread;
    renderLoreRelGraph();
  };

  // Egér pan
  svg.addEventListener('mousedown',e=>{
    if(e.target.closest('.rel-node'))return;
    e.preventDefault();
    let lastX=e.clientX,lastY=e.clientY;
    svg.classList.add('dragging');
    const onMove=em=>{panView(em.clientX-lastX,em.clientY-lastY);lastX=em.clientX;lastY=em.clientY;};
    const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);svg.classList.remove('dragging');};
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
  });
  // Egér wheel: SPREAD (csomópont-távolságok), nem viewBox zoom
  svg.addEventListener('wheel',e=>{e.preventDefault();applySpread(e.deltaY<0?1.12:1/1.12);},{passive:false});

  // Touch pan+pinch
  let touch=null;
  svg.addEventListener('touchstart',e=>{
    if(e.touches.length===1){
      if(e.target.closest('.rel-node')){touch=null;return;}
      const t=e.touches[0];
      touch={mode:'pan',lastX:t.clientX,lastY:t.clientY};
    }else if(e.touches.length===2){
      const t1=e.touches[0],t2=e.touches[1];
      const dx=t2.clientX-t1.clientX,dy=t2.clientY-t1.clientY;
      touch={mode:'pinch',lastDist:Math.hypot(dx,dy),
        lastCx:(t1.clientX+t2.clientX)/2,lastCy:(t1.clientY+t2.clientY)/2};
    }
  },{passive:true});
  svg.addEventListener('touchmove',e=>{
    if(!touch)return;
    if(touch.mode==='pan'&&e.touches.length===1){
      e.preventDefault();
      const t=e.touches[0];
      panView(t.clientX-touch.lastX,t.clientY-touch.lastY);
      touch.lastX=t.clientX;touch.lastY=t.clientY;
    }else if(touch.mode==='pinch'&&e.touches.length===2){
      e.preventDefault();
      const t1=e.touches[0],t2=e.touches[1];
      const dx=t2.clientX-t1.clientX,dy=t2.clientY-t1.clientY;
      const newDist=Math.hypot(dx,dy);
      const newCx=(t1.clientX+t2.clientX)/2,newCy=(t1.clientY+t2.clientY)/2;
      // Pan közben: az ujjak középpontjának mozgása alapján
      panView(newCx-touch.lastCx,newCy-touch.lastCy);
      // Spread: a két ujj távolsága alapján — szétnyitás = szellősebb háló
      const f=newDist/(touch.lastDist||newDist);
      if(f!==1)applySpread(f);
      touch.lastDist=newDist;touch.lastCx=newCx;touch.lastCy=newCy;
    }
  },{passive:false});
  svg.addEventListener('touchend',e=>{
    if(e.touches.length===0)touch=null;
    else if(e.touches.length===1){
      const t=e.touches[0];
      touch={mode:'pan',lastX:t.clientX,lastY:t.clientY};
    }
  });
}

// HTML escape helper (lehet hogy már van a kódban, de biztos ami biztos)
if(typeof esc!=='function'){
  window.esc=function(s){if(s==null)return '';return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));};
}

// Load lore library on init
loadLoreLibrary();

// detectOnly, tGoogle, tDeepl ELTÁVOLÍTVA a v2.40-ben — csak Claude-ot használunk

async function claudeFull(b64,idx){
  const apiKey=document.getElementById('api-key').value.trim();
  if(!apiKey)throw new Error('Claude API kulcs szükséges! (⚙️ → API KULCS)');
  if(!b64){await ensureB64(idx);b64=pages[idx].base64;}
  // Rács rajzolása a képre
  b64 = await drawGridOnImage(b64);
  let ctx='';
  if(idx>0&&pages[idx-1]?.bubbles?.length){const lb=pages[idx-1].bubbles[pages[idx-1].bubbles.length-1];const ot=lb?.original?.trim()||'';if(ot.endsWith('...')||ot.endsWith('--')||ot.endsWith('—'))ctx=`\nContext: Previous page ended with: "${lb.original}" → "${lb.hungarian}".`;}
  const rtl=rtlMode?'\nIMPORTANT MANGA MODE: Right-to-left. Ellipsis chains (A ends "...", B starts "...") = ONE sentence. Translate as natural continuation.':'\nCONTINUATION: When a bubble ends with "--" or "—" and the next starts with "--" or "—", they are one sentence split across bubbles. Translate as one flowing Hungarian sentence, keeping "--" at the same positions. The "--" bubble must grammatically continue the previous one (same subject). Example: "THIS WAS A CURSE--" / "--KNEW IT WOULD COST US" → "EZ EGY ÁTOK VOLT--" / "--AMI MINDENÜNKBE FOG KERÜLNI" (not "--TUDTAM, HOGY...").';
  const prompt=`Find EVERY piece of readable text on this comic page — do not skip any. Speech bubbles, captions, overlays, chat messages, sound effects — ALL of them.
Translate each to natural Hungarian.
The image has a 20×20 grid (cols 1-20, rows A-T). Bounding box: x=(col-1)/20, y=(row-1)/20, w=col_span/20, h=row_span/20.${rtl}${ctx}
For each text element:
- original: exact English text
- hungarian: natural Hungarian translation
- type: "bubble"|"caption"|"narration"|"overlay"|"sfx"
- bg: exact hex fill color (look carefully — "#ffffff", "#ffb3c6", etc. Do NOT default to "#fffcdc")
- font_style: "print" for normal bubbles (DEFAULT). "bold_display" ONLY for huge thick lettering. When in doubt: "print"
- speaker: consistent ID ("char_1","char_2","narrator","sfx")
- x,y,w,h: from grid
Chat/SMS: merge same-sender into one box. SKIP only pure punctuation.
Return ONLY JSON:
[{"original":"...","hungarian":"...","type":"bubble","bg":"#ffffff","font_style":"print","speaker":"char_1","x":0.0,"y":0.0,"w":0.0,"h":0.0}]`;
  const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true','x-app-name':'BubbleLens'},body:JSON.stringify({model:selModel,max_tokens:16384,messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},{type:'text',text:prompt}]}]})});
  const data=await res.json();if(data.error)throw new Error(data.error.message);
  const hitLimit = data.stop_reason === 'max_tokens';
  const raw=data.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
  let parsed=[];
  try{
    parsed=JSON.parse(raw).filter(b=>{const t=(b.original||'').replace(/[.…!?•\s*~\-–—]/g,'').trim();return t.length>0;});
  }catch{
    try{
      const fixed=raw.replace(/,\s*\{[^}]*$/,'').replace(/,\s*$/,'').trimEnd();
      parsed=JSON.parse(fixed+']').filter(b=>{const t=(b.original||'').replace(/[.…!?•\s*~\-–—]/g,'').trim();return t.length>0;});
    }catch{parsed=[];}
  }
  if(hitLimit) parsed._hitLimit=true;
  return parsed;
}

// ══ SAVE / LOAD ══
async function saveProject(){
  setSt('loading','Mentés...');
  for(let i=0;i<pages.length;i++)await ensureB64(i);
  const proj={version:5,savedAt:new Date().toISOString(),name:projName,rtl:rtlMode,pages:pages.map(p=>({base64:p.base64,bubbles:p.bubbles}))};
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(proj)],{type:'application/json'}));a.download=projName+'.kfp.json';a.click();
  setSt('success',`✓ Mentve: ${projName}.kfp.json`);
}
async function loadProject(file){
  try{
    setSt('loading','Projekt betöltése...');
    let raw;
    try{ raw=await file.text(); }
    catch(e){ throw new Error('A fájl nem olvasható: '+e.message); }
    if(!raw||!raw.trim()){ throw new Error('A fájl üres.'); }
    let proj;
    try{ proj=JSON.parse(raw); }
    catch(e){
      // Csonkított JSON esetén próbáljuk azonosítani a problémát
      const kb=(raw.length/1024).toFixed(0);
      if(raw.endsWith('"')||raw.endsWith('}')||raw.endsWith(']')){
        throw new Error(`A projekt fájl sérült (${kb} KB, hiányos JSON). A letöltés megszakadhatott — próbáld újra menteni.`);
      }
      throw new Error(`A projekt fájl sérült (${kb} KB olvasva). ${e.message}`);
    }
    if(!proj.pages)throw new Error('Érvénytelen projekt formátum.');
    projName=proj.name||'kepregeny';rtlMode=proj.rtl||false;
    pages=proj.pages.map(p=>{const u=p.base64?'data:image/jpeg;base64,'+p.base64:null;return{dataUrl:u,base64:p.base64||null,bubbles:p.bubbles};});
    cur=0;curBookKey=null;
    showScr('reader');buildThumbs();await ensureLoaded(0);renderPage();preload(0);
    setSt('success',`✓ Projekt: ${pages.length} oldal`);showZHint();initLHandleDrag();
    document.getElementById('btn-back').style.display='inline-block';
  }catch(e){setSt('error','Projekt hiba: '+e.message);}
}

// ══ UTILS ══
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function svcName(){return{claude:'Claude',google:'Google',deepl:'DeepL'}[svc]||svc;}

/* node-unrar-js inline bundle - WASM beágyazva */
(function(){
var _wasmB64="AGFzbQEAAAABtQInYAF/AX9gAn9/AX9gA39/fwF/YAF/AGADf39/AGACf38AYAN/fn8AYAR/f39/AX9gAX8BfmAEf39/fwBgBX9/f39/AGAAAGAAAX9gBn9/f39/fwBgBX9/f39/AX9gB39/f39/f38AYAJ/fgBgCn9/f39/f39/f38Bf2AKf39/f39/f39/fwBgA39/fgBgCX9/f39/f39/fwBgCH9/f39/fn9/AX9gBn9/f39/fwF/YAF+AGAGf3x/f39/AX9gC39/f39/f39/f39/AGAIf39/f39/f38AYAd/f39/f39/AX9gAAF8YA1/f39/f39/f39/f39/AGACf38BfmACfn8Bf2AJf39/f39/f39/AX9gBH9/fn4AYAN+f38Bf2AEf35+fwBgAnx/AXxgA39/fABgAn9/AXwCiwNAAWEBYQAMAWEBYgABAWEBYwAMAWEBZAAAAWEBZQADAWEBZgAEAWEBZwAHAWEBaAACAWEBaQAJAWEBagAEAWEBawAZAWEBbAABAWEBbQAFAWEBbgAOAWEBbwAEAWEBcAAAAWEBcQAKAWEBcgAAAWEBcwAAAWEBdAALAWEBdQAEAWEBdgANAWEBdwAaAWEBeAALAWEBeQAFAWEBegAEAWEBQQADAWEBQgASAWEBQwAKAWEBRAARAWEBRQAbAWEBRgAPAWEBRwABAWEBSAAOAWEBSQAHAWEBSgAHAWEBSwAAAWEBTAAAAWEBTQAEAWEBTgAFAWEBTwARAWEBUAAJAWEBUQABAWEBUgAKAWEBUwADAWEBVAAAAWEBVQABAWEBVgAOAWEBVwABAWEBWAABAWEBWQAcAWEBWgAFAWEBXwAAAWEBJAAEAWECYWEABAFhAmJhAAUBYQJjYQAKAWECZGEABQFhAmVhAAMBYQJmYQADAWECZ2EAEgFhAmhhAA0BYQJpYQAdAWECamEADQP+AvwCAwICBQAAAAUeCwQIAAQAAAQEAAMCCgsCAgQCAQUAAAQAAQQBAAIBAAMBAAMAAgMCCwAAAAQBAwQFAAIDAgIBHwEGBAADBQUJABMFBAECAAIDBQUBBQUgFAAABAEFBxMFAQECBQAHAgMEAAcDCQMCAQABAQgEAxUADwABAgQCAAABAAgABAEBAwMDAAMFAwoAAwMDAAAACw8WBAMBAAEEAgMBBQABAwEEISIFFwUDAAkBBAIBBAMBACMAAgIABwAEDgUFAwIEAA4CJAEBAQcCAAALCwgCCQICAwMEAQQBBAADAgEFBQAFBwIDAwIEAAcCBAQFBQEKEAAFAwkFAwUDBQUAAAEABwAJAwAIBgICAwMBAQQRCQEKAwwAAAAAAAINDQoKAgkJAgUEAQ8CBAEABQIFGAABAAEECQAQAAEDASUmAwwDDAQBAwwCBAEFDgoMAAMABwsMBwUABQQEBwAAEBYCBAUHAQcBAAADBQAEBAMEAxQEAAQFAAgFBQcEBwFwAe4B7gEFBwEBgAKAgAIGCQF/AUGQq8kCCwdjEQJrYQIAAmxhANYBAm1hAEACbmEATwJvYQEAAnBhAPUCAnFhAJICAnJhAO8CAnNhANgCAnRhANcCAnVhAN4CAnZhAN0CAndhANYCAnhhANUCAnlhANQCAnphANMCAkFhANICCbcDAQBBAQvtAa8DTJgD0AKlA6MCggGdAZcDzQLkAdECpAKCAlijA0P7AuEBqgHLAtsB2AF9twO4A0rOAlqKAaQDXe4CpwNLXGXBAbEDtQOxAqICmwOaA6gDrQGzA2/FAnrfAdwB1QG0A9QBcc8CzALKAskCwwKnAVLCApkDRbYDngKYAZkByAKTAkeWAZsBwQLXAZUCZsACugOxAV+VA9IBeLIBsAG1AaUBmgGqA3eGAccCrgO2ArkD4gGcAbADsgOfA68CZ7cCqQP8AbYBxgKiA6EDlgP8Aa0DlAP6AnzOAa4CoAOmA/kC+AKsAvcC9gKtAfwCcKYBlAJXUfcBXmucA0SrA7oCpQKeA6wDtAKdA6ACkgORA5ADjwOOA40DjAOLA4oDiQOIA4cDPMUBxAGGA4UDO4QDgwOdApwCmwKaAsUBxAGCA4EDnQKcApsCmgLFAcQBgAP/AsQC9AKTA+kCjQF2uwPrAuwC/gLuAesBav0ClwKBAcIB8gLxAvACuwFo7QLoAvoBF+cC9wForQGtAfIBaPIBaOYC3wLhAuUCaOAC4gLkAmjjAmjbAmjaAmjcAu0B2QLtAQrR4Qv8AsoMAQd/AkAgAEUNACAAQQhrIgIgAEEEaygCACIBQXhxIgBqIQUCQCABQQFxDQAgAUEDcUUNASACIAIoAgAiAWsiAkGgpwkoAgBJDQEgACABaiEAQaSnCSgCACACRwRAIAFB/wFNBEAgAigCCCIEIAFBA3YiAUEDdEG4pwlqRhogBCACKAIMIgNGBEBBkKcJQZCnCSgCAEF+IAF3cTYCAAwDCyAEIAM2AgwgAyAENgIIDAILIAIoAhghBgJAIAIgAigCDCIBRwRAIAIoAggiAyABNgIMIAEgAzYCCAwBCwJAIAJBFGoiBCgCACIDDQAgAkEQaiIEKAIAIgMNAEEAIQEMAQsDQCAEIQcgAyIBQRRqIgQoAgAiAw0AIAFBEGohBCABKAIQIgMNAAsgB0EANgIACyAGRQ0BAkAgAigCHCIEQQJ0QcCpCWoiAygCACACRgRAIAMgATYCACABDQFBlKcJQZSnCSgCAEF+IAR3cTYCAAwDCyAGQRBBFCAGKAIQIAJGG2ogATYCACABRQ0CCyABIAY2AhggAigCECIDBEAgASADNgIQIAMgATYCGAsgAigCFCIDRQ0BIAEgAzYCFCADIAE2AhgMAQsgBSgCBCIBQQNxQQNHDQBBmKcJIAA2AgAgBSABQX5xNgIEIAIgAEEBcjYCBCAAIAJqIAA2AgAPCyACIAVPDQAgBSgCBCIBQQFxRQ0AAkAgAUECcUUEQEGopwkoAgAgBUYEQEGopwkgAjYCAEGcpwlBnKcJKAIAIABqIgA2AgAgAiAAQQFyNgIEIAJBpKcJKAIARw0DQZinCUEANgIAQaSnCUEANgIADwtBpKcJKAIAIAVGBEBBpKcJIAI2AgBBmKcJQZinCSgCACAAaiIANgIAIAIgAEEBcjYCBCAAIAJqIAA2AgAPCyABQXhxIABqIQACQCABQf8BTQRAIAUoAggiBCABQQN2IgFBA3RBuKcJakYaIAQgBSgCDCIDRgRAQZCnCUGQpwkoAgBBfiABd3E2AgAMAgsgBCADNgIMIAMgBDYCCAwBCyAFKAIYIQYCQCAFIAUoAgwiAUcEQCAFKAIIIgNBoKcJKAIASRogAyABNgIMIAEgAzYCCAwBCwJAIAVBFGoiBCgCACIDDQAgBUEQaiIEKAIAIgMNAEEAIQEMAQsDQCAEIQcgAyIBQRRqIgQoAgAiAw0AIAFBEGohBCABKAIQIgMNAAsgB0EANgIACyAGRQ0AAkAgBSgCHCIEQQJ0QcCpCWoiAygCACAFRgRAIAMgATYCACABDQFBlKcJQZSnCSgCAEF+IAR3cTYCAAwCCyAGQRBBFCAGKAIQIAVGG2ogATYCACABRQ0BCyABIAY2AhggBSgCECIDBEAgASADNgIQIAMgATYCGAsgBSgCFCIDRQ0AIAEgAzYCFCADIAE2AhgLIAIgAEEBcjYCBCAAIAJqIAA2AgAgAkGkpwkoAgBHDQFBmKcJIAA2AgAPCyAFIAFBfnE2AgQgAiAAQQFyNgIEIAAgAmogADYCAAsgAEH/AU0EQCAAQXhxQbinCWohAQJ/QZCnCSgCACIDQQEgAEEDdnQiAHFFBEBBkKcJIAAgA3I2AgAgAQwBCyABKAIICyEAIAEgAjYCCCAAIAI2AgwgAiABNgIMIAIgADYCCA8LQR8hBCAAQf///wdNBEAgAEEIdiIBIAFBgP4/akEQdkEIcSIEdCIBIAFBgOAfakEQdkEEcSIDdCIBIAFBgIAPakEQdkECcSIBdEEPdiADIARyIAFyayIBQQF0IAAgAUEVanZBAXFyQRxqIQQLIAIgBDYCHCACQgA3AhAgBEECdEHAqQlqIQcCQAJAAkBBlKcJKAIAIgNBASAEdCIBcUUEQEGUpwkgASADcjYCACAHIAI2AgAgAiAHNgIYDAELIABBAEEZIARBAXZrIARBH0YbdCEEIAcoAgAhAQNAIAEiAygCBEF4cSAARg0CIARBHXYhASAEQQF0IQQgAyABQQRxaiIHQRBqKAIAIgENAAsgByACNgIQIAIgAzYCGAsgAiACNgIMIAIgAjYCCAwBCyADKAIIIgAgAjYCDCADIAI2AgggAkEANgIYIAIgAzYCDCACIAA2AggLQbCnCUGwpwkoAgBBAWsiAEF/IAAbNgIACwuABAEDfyACQYAETwRAIAAgASACEDYgAA8LIAAgAmohAwJAIAAgAXNBA3FFBEACQCAAQQNxRQRAIAAhAgwBCyACRQRAIAAhAgwBCyAAIQIDQCACIAEtAAA6AAAgAUEBaiEBIAJBAWoiAkEDcUUNASACIANJDQALCwJAIANBfHEiBEHAAEkNACACIARBQGoiBUsNAANAIAIgASgCADYCACACIAEoAgQ2AgQgAiABKAIINgIIIAIgASgCDDYCDCACIAEoAhA2AhAgAiABKAIUNgIUIAIgASgCGDYCGCACIAEoAhw2AhwgAiABKAIgNgIgIAIgASgCJDYCJCACIAEoAig2AiggAiABKAIsNgIsIAIgASgCMDYCMCACIAEoAjQ2AjQgAiABKAI4NgI4IAIgASgCPDYCPCABQUBrIQEgAkFAayICIAVNDQALCyACIARPDQEDQCACIAEoAgA2AgAgAUEEaiEBIAJBBGoiAiAESQ0ACwwBCyADQQRJBEAgACECDAELIAAgA0EEayIESwRAIAAhAgwBCyAAIQIDQCACIAEtAAA6AAAgAiABLQABOgABIAIgAS0AAjoAAiACIAEtAAM6AAMgAUEEaiEBIAJBBGoiAiAETQ0ACwsgAiADSQRAA0AgAiABLQAAOgAAIAFBAWohASACQQFqIgIgA0cNAAsLIAAL8gICAn8BfgJAIAJFDQAgACABOgAAIAAgAmoiA0EBayABOgAAIAJBA0kNACAAIAE6AAIgACABOgABIANBA2sgAToAACADQQJrIAE6AAAgAkEHSQ0AIAAgAToAAyADQQRrIAE6AAAgAkEJSQ0AIABBACAAa0EDcSIEaiIDIAFB/wFxQYGChAhsIgE2AgAgAyACIARrQXxxIgRqIgJBBGsgATYCACAEQQlJDQAgAyABNgIIIAMgATYCBCACQQhrIAE2AgAgAkEMayABNgIAIARBGUkNACADIAE2AhggAyABNgIUIAMgATYCECADIAE2AgwgAkEQayABNgIAIAJBFGsgATYCACACQRhrIAE2AgAgAkEcayABNgIAIAQgA0EEcUEYciIEayICQSBJDQAgAa1CgYCAgBB+IQUgAyAEaiEBA0AgASAFNwMYIAEgBTcDECABIAU3AwggASAFNwMAIAFBIGohASACQSBrIgJBH0sNAAsLIAALzgEBBH8CQCAARQ0AIAFFDQAgAUEHcSEDIAFBAWtBB08EQCABQXhxIQVBACEBA0AgACACakEAOgAAIAAgAkEBcmpBADoAACAAIAJBAnJqQQA6AAAgACACQQNyakEAOgAAIAAgAkEEcmpBADoAACAAIAJBBXJqQQA6AAAgACACQQZyakEAOgAAIAAgAkEHcmpBADoAACACQQhqIQIgAUEIaiIBIAVHDQALCyADRQ0AA0AgACACakEAOgAAIAJBAWohAiAEQQFqIgQgA0cNAAsLCzQBAX8gACgCDCAAKAIAaiIBLQABQQh0IAEtAABBEHRyIAEtAAJyQQggACgCBGt2Qf//A3ELVgEEfyAAKAIcIgNBA2oiAiAAKAIYSQR/IAAoAgAiASACai0AACECIAEgA2oiAS8AACEEIAEtAAIhASAA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akGh1+f2BmoiBiAFIAJBHnciB3NzaiAEICdqIAEgB3MgA3NqIAZBBXdqQaHX5/YGaiIDQQV3akGh1+f2BmoiASADQR53IgJyIAZBHnciEHEgASACcXJqIAcgLWogBSAQcyADc2ogAUEFd2pBodfn9gZqIgNBBXdqQaSGkYcHayIFQR53IgRqICkgAUEedyIBaiADQR53IgYgECAjaiABIANyIAJxIAEgA3FyaiAFQQV3akGkhpGHB2siAyAEcnEgAyAEcXJqIAIgLmogBSAGciABcSAFIAZxcmogA0EFd2pBpIaRhwdrIgFBBXdqQaSGkYcHayICIAFBHnciBXIgA0EedyIDcSACIAVxcmogBiAkaiABIANyIARxIAEgA3FyaiACQQV3akGkhpGHB2siAUEFd2pBpIaRhwdrIgRBHnciBmogNCACQR53IgJqIAFBHnciByADICpqIAEgAnIgBXEgASACcXJqIARBBXdqQaSGkYcHayIBIAZycSABIAZxcmogBSAvaiAEIAdyIAJxIAQgB3FyaiABQQV3akGkhpGHB2siAkEFd2pBpIaRhwdrIgMgAkEedyIFciABQR53IgFxIAMgBXFyaiAHICtqIAEgAnIgBnEgASACcXJqIANBBXdqQaSGkYcHayICQQV3akGkhpGHB2siBEEedyIGaiA6IANBHnciA2ogAkEedyIHIAEgNWogAiADciAFcSACIANxcmogBEEFd2pBpIaRhwdrIgEgBnJxIAEgBnFyaiAFICxqIAQgB3IgA3EgBCAHcXJqIAFBBXdqQaSGkYcHayICQQV3akGkhpGHB2siAyACQR53IgVyIAFBHnciAXEgAyAFcXJqIAcgNmogASACciAGcSABIAJxcmogA0EFd2pBpIaRhwdrIgJBBXdqQaSGkYcHayIEQR53IgZqIAUgN2ogA0EedyIDIAQgAkEedyIHcnEgBCAHcXJqIAEgO2ogAiADciAFcSACIANxcmogBEEFd2pBpIaRhwdrIgFBBXdqQaSGkYcHayICQR53IgQgAUEedyIFcyADIDJqIAEgBnIgB3EgASAGcXJqIAJBBXdqQaSGkYcHayIBc2ogByA8aiACIAVyIAZxIAIgBXFyaiABQQV3akGkhpGHB2siAkEFd2pBqvz0rANrIgNBHnciBmogBCA9aiACQR53IgcgAUEedyIBcyADc2ogBSA/aiABIARzIAJzaiADQQV3akGq/PSsA2siAkEFd2pBqvz0rANrIgNBHnciBSACQR53IgRzIAEgOWogBiAHcyACc2ogA0EFd2pBqvz0rANrIgFzaiAHIEBqIAQgBnMgA3NqIAFBBXdqQar89KwDayICQQV3akGq/PSsA2siA0EedyIGaiAFIEdqIAJBHnciByABQR53IgFzIANzaiAEIERqIAEgBXMgAnNqIANBBXdqQar89KwDayICQQV3akGq/PSsA2siA0EedyIFIAJBHnciBHMgASBGaiAGIAdzIAJzaiADQQV3akGq/PSsA2siAXNqIAcgRWogBCAGcyADc2ogAUEFd2pBqvz0rANrIgJBBXdqQar89KwDayIDQR53IgZqIAUgTGogAkEedyIHIAFBHnciAXMgA3NqIAQgSGogASAFcyACc2ogA0EFd2pBqvz0rANrIgJBBXdqQar89KwDayIDQR53IgUgAkEedyIEcyABIE9qIAYgB3MgAnNqIANBBXdqQar89KwDayIBc2ogByBOaiAEIAZzIANzaiABQQV3akGq/PSsA2siAkEFd2pBqvz0rANrIgNBHnciBiAAKAIQajYCECAAIAQgUGogAUEedyIBIAVzIAJzaiADQQV3akGq/PSsA2siBEEedyIHIAAoAgxqNgIMIAAgACgCCCAFIFVqIAJBHnciAiABcyADc2ogBEEFd2pBqvz0rANrIgNBHndqNgIIIAAgASBUaiACIAZzIARzaiADQQV3akGq/PSsA2siASAAKAIEajYCBCAAIAAoAgAgVmogAmogBiAHcyADc2ogAUEFd2pBqvz0rANrNgIAC+QDAQJ/AkAgACgC0JMGIgEEQCAAQeCTBmotAAAEfyAAQdiTBmooAgAhAkGAqwlBADYCACABIAJBAnQQQ0GAqwkoAgAhAUGAqwlBADYCACABQQFGDQIgACgC0JMGBSABCxBACyAAKALwkgYiAQRAIABBgJMGai0AAAR/IABB+JIGaigCACECQYCrCUEANgIAIAEgAkECdBBDQYCrCSgCACEBQYCrCUEANgIAIAFBAUYNAiAAKALwkgYFIAELEEALIAAoApCSBiIBBEAgAEGgkgZqLQAABH8gAEGYkgZqKAIAIQJBgKsJQQA2AgAgASACQQJ0EENBgKsJKAIAIQFBgKsJQQA2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EIYBAkACQCAHRQ0AIAgtAABFDQAgCkEIaiAHQegAEEEaDAELAkAgAQRAQQAhDUEAIQkgAUEBa0EDTwRAIAFBfHEhA0EAIQsDQCAKQZABaiICIAlqIAAgCWotAABB3ABzOgAAIAIgCUEBciIFaiAAIAVqLQAAQdwAczoAACACIAlBAnIiBWogACAFai0AAEHcAHM6AAAgAiAJQQNyIgVqIAAgBWotAABB3ABzOgAAIAlBBGohCSALQQRqIgsgA0cNAAsLIAFBA3EiAgRAA0AgCkGQAWogCWogACAJai0AAEHcAHM6AAAgCUEBaiEJIA1BAWoiDSACRw0ACwsgAUE/Sw0BCyAKQZABaiABakHcAEHAACABaxBCGgsgCkEIaiIAQgA3AyAgAEKrs4/8kaOz8NsANwMYIABC/6S5iMWR2oKbfzcDECAAQvLmu+Ojp/2npX83AwggAELnzKfQ1tDrs7t/NwMAIAAgCkGQAWpBwAAQdyAHRQ0AIAgtAAANACAHIApBCGpB6AAQQRogCEEBOgAACyAKQQhqIgAgCkHwAGpBIBB3IAAgBBCGASAKQeACaiQACzIBAn8gACgCACICBEAgACEBA0AgASACEHM2AgAgASgCBCECIAFBBGohASACDQALCyAACzUBAn8gACgCACICBEAgACEBA0AgASACQQAQigI2AgAgASgCBCECIAFBBGohASACDQALCyAAC5QBAQJ/IwBB0ABrIgMkACADQUBrIgRCADcDACADQgA3AyggA0IANwMwIANCADcDOCAEQQM2AgAgA0IANwMgIANBvA42AhwgA0G8DjYCGCADQbwONgIUIANBvA42AhAgA0G8DjYCDCADQSI2AkggAyABNgIEIAMgAjYCCCADIABBNGo2AgBBpP4CQQEQRyADQdAAaiQACzQAIAAtAIy8AwR/QQAgAWtBD3EgAWohASAAKAKAvANBA0YEQCABQRBqDwsgAUEIagUgAQsLiwEBAn8jAEHQAGsiAiQAIAJBQGsiA0IANwMAIAJCADcDKCACQgA3AzAgAkIANwM4IANBATYCACACQgA3AyAgAkHQDTYCHCACQdANNgIYIAJB0A02AhQgAkHQDTYCECACQdANNgIMIAJB0A02AgggAkHQDTYCBCACIAA2AkggAiABNgIAIAJB0ABqJAALVQACQAJAIAFFDQAgASgC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IAIoAogBIgMgAUsNACACKAKMASIDIAFLDQAgAigCkAEiAyABSw0AIAIoApQBIgMgAUsNACACKAKYASIDIAFLDQAgAigCnAEiAyABSw0AIAIoAqABIgMgAUsNACACKAKkASIDIAFLDQAgAigCqAEiAyABSw0AIAIoAqwBIgMgAUsNACACKAKwASIDIAFLDQAgAigCtAEiAyABSw0AIAIoArgBIgMgAUsNACACKAK8ASIDIAFLDQAgAigCwAEiAyABSw0AIAIoAsQBIgMgAUsNACACKALIASIDIAFLDQAgAigCzAEiAyABSw0AIAIoAtABIgMgAUsNACACKALUASIDIAFLDQAgAigC2AEiAyABSw0AIAIoAtwBIgMgAUsNACACKALgASIDIAFLDQAgAigC5AEiAyABSw0AIAIoAugBIgMgAUsNACACKALsASIDIAFLDQAgAigC8AEiAyABSw0AIAIoAvQBIgMgAUsNACACKAL4ASIDIAFLDQBBACACKAL8ASIDIAFNDQEaCyADIAFrIgMgBCADIARJGwsiAyABagJ/IAYgACkDuJgBIgdTBEAgACgCACACIAEQYSAHIAZ9IganIAMgBiADrSIHUxsQUSAAIAApA8iYASAHfCIGNwPImAEgACgC0M0DIQULIAULcSEBIAQgA2siBA0ACwwCCyAAKQO4mAEiBiAAKQPImAEiB1cNASAAQciYAWohBCAAKAIAIAAoArCWASABaiAGIAd9IgenIAIgAWsiACAHIACtIgZTGxBRCyAEIAQpAwAgBnw3AwALC9wOARF/IwBBsAhrIgYkAAJAAkAgACgCBCIDIAAoAnQiAUEZa0wNACABIANrIgJBAEgNASAAIAAoAnwgACgChAEgA2tqNgJ8IANBgYABTgRAIAIEQCAAKAIQIgEgASADaiACEE0LIAAgAjYCdCAAQQA2AgQgAiEBC0GAgAIhAwJAIAFBgIACRg0AIAAoAgAgACgCECABakGAgAIgAWsQVyEEIAAoAnQhAyAEQQBMDQAgACADIARqIgM2AnQLIAAgA0EeayIBNgJ4IAAgACgCBCIDNgKEASAAKAJ8IgJBf0cEQCAAIAEgAiADakEBayICIAEgAkgbNgJ4CyAEQX9HDQAMAQsgACAAKAIQIgkgA2oiAS0AAUEIdCABLQAAQRB0ciABLQACckEIIAAoAggi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IiARIC5zIREgGSAvcyEZIBogMHMhGiAbIDFzIRsgBiAycwUgBgs6AA8gCyASOgAOIAsgBToADSALIBw6AAwgCyAeOgALIAsgIDoACiALICE6AAkgCyAfOgAIIAsgHToAByALIBU6AAYgCyAkOgAFIAsgIjoABCALIBE6AAMgCyAZOgACIAsgGjoAASALIBs6AAAgC0EQaiELIApBEGohCiAAITEgASEwIAIhLyAHIS4gCSEtIAwhLCAQISsgCCEqIBMhKSAUISggDiEnIBghJiAXISUgDyEEIBYhMyANITIgREEBayJEDQALCyADIA06ABcgAyAWOgAWIAMgDzoAFSADIBc6ABQgAyAYOgATIAMgDjoAEiADIBQ6ABEgAyATOgAQIAMgCDoADyADIBA6AA4gAyAMOgANIAMgCToADCADIAc6AAsgAyACOgAKIAMgAToACSADIAA6AAgLCwufAQECfyMAQdAAayIBJAAgAUFAayICQgA3AwAgAUIANwMoIAFCADcDMCABQgA3AzggAkEBNgIAIAFCADcDICABQbwONgIcIAFBvA42AhggAUG8DjYCFCABQbwONgIQIAFBvA42AgwgAUG8DjYCCCABQbwONgIEIAFBGjYCSCABIABBNGo2AgAgAEEBOgCUvANBpP4CQQMQRyABQdAAaiQAC0kBAX8gBARAIARBADoAAAsCfyABBEBBASABIAJBEkERIAcbIgMQlgINARogAC0Az8QDGiABIAIgAxCWAg8LIAAtAM/EAxpBAQsLFgAgAEUEQEEADwsgAEGEDBC6AUEARwvuAgEFfyMAQRBrIgckACACIAFBf3NBEWtNBEACfyAALQALQQd2BEAgACgCAAwBCyAACyEJIAACfyABQef///8HSQRAIAcgAUEBdDYCCCAHIAEgAmo2AgwjAEEQayICJAAgB0EMaiIIKAIAIAdBCGoiCigCAEkhCyACQRBqJAAgCiAIIAsbKAIAIgJBC08EfyACQRBqQXBxIgIgAkEBayICIAJBC0YbBUEKCwwBC0FuC0EBaiIIEPYBIQIgBQRAIAIgBiAFEIsBCyADIARrIQYgAyAERwRAIAIgBWogBCAJaiAGEIsBCyABQQFqIgFBC0cEQEGAqwlBADYCAEHPASAJIAFBARAIQYCrCSgCACEBQYCrCUEANgIAIAFBAUYEQEEAEAMa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aiIELQAAQQR0aiICNgLAlgEgACgCxJYBIAJJBEAgACACIAQtAABBBHRrNgLAlgEgBSADEJMBIQELIAAoAsgMIAE2AgggACABNgLUDCABRQ0BC0EAIQUgAEEAOgDxFCAAIAAoAuwMNgLoDCAAKALIDCEBQQAhAwNAIANBA3QiAiABKAIIaiADOgAAIAEoAgggAmpBAToAASABKAIIIAJqQQA2AgQgA0EBciIEQQN0IgIgASgCCGogBDoAACABKAIIIAJqQQE6AAEgASgCCCACakEANgIEIANBAmoiA0GAAkcNAAsDQCAAIAVBB3RqIgFB5BVqQYCAAUHd+QAgBUECaiIDbmsiAjsBACABQdQVaiACOwEAIAFBxBVqIAI7AQAgAUG0FWogAjsBACABQaQVaiACOwEAIAFBlBVqIAI7AQAgAUGEFWogAjsBACABQfQUaiACOwEAIAFB5hVqQYCAAUG/PiADbmsiAjsBACABQdYVaiACOwEAIAFBxhVqIAI7AQAgAUG2FWogAjsBACABQaYVaiACOwEAIAFBlhVqIAI7AQAgAUGGFWogAjsBACABQfYUaiACOwEAIAFB6BVqQYCAAUG/swEgA25rIgI7AQAgAUHYFWogAjsBACABQcgVaiACOwEAIAFBuBVqIAI7AQAgAUGoFWogAjsBACABQZgVaiACOwEAIAFBiBVqIAI7AQAgAUH4FGogAjsBACABQeoVakGAgAFB85EBIANuayICOwEAIAFB2hVqIAI7AQAgAUHKFWogAjsBACABQboVaiACOwEAIAFBqhVqIAI7AQAgAUGaFWogAjsBACABQYoVaiACOwEAIAFB+hRqIAI7AQAgAUHsFWpBgIABQaHJASADbmsiAjsBACABQdwVaiACOwEAIAFBzBVqIAI7AQAgAUG8FWogAjsBACABQawVaiACOwEAIAFBnBVqIAI7AQAgAUGMFWogAjsBACABQfwUaiACOwEAIAFB3hVqQYCAAUG8tQEgA25rIgI7AQAgAUHOFWogAjsBACABQb4VaiACOwEAIAFBrhVqIAI7AQAgAUGeFWogAjsBACABQY4VaiACOwEAIAFB/hRqIAI7AQAgAUHuFWogAjsBACABQfAVakGAgAFBsswBIANuayICOwEAIAFB4BVqIAI7AQAgAUHQFWogAjsBACABQcAVaiACOwEAIAFB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AiAAQbgBaiAAIABBkAFqEIACIQIgBSAFKAIAIgcgBkEgcXI2AgBBfyACIAdBIHEbIQIgAw0ACyAAQcABaiQAIAIhACAFQQBBABC7ARogAEF/IAAgAUkbIQULIARBoANqJAAgBQtzAQR/IAAoAgAiBCgCAEEwayICQQlLBEBBAA8LA0BBfyEBIANBzJmz5gBNBEBBfyACIANBCmwiAWogAkH/////ByABa0sbIQELIAQoAgQhAiABIQMgBEEEaiIBIQQgAkEwayICQQpJDQALIAAgATYCACADC4QHAwN+AX8BfCMAQRBrIgYkAAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAFBCWsOEgABAgUDBAYHCAkKCwwNDg8QERILIAIgAigCACIBQQRqNgIAIAAgASgCADYCAAwRCyACIAIoAgAiAUEEajYCACAAIAE0AgA3AwAMEAsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADA8LIAIgAigCACIBQQRqNgIAIAAgATQCADcDAAwOCyACIAIoAgAiAUEEajYCACAAIAE1AgA3AwAMDQsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMADAwLIAIgAigCACIBQQRqNgIAIAAgATIBADcDAAwLCyACIAIoAgAiAUEEajYCACAAIAEzAQA3AwAMCgsgAiACKAIAIgFBBGo2AgAgACABMAAANwMADAkLIAIgAigCACIBQQRqNgIAIAAgATEAADcDAAwICyACIAIoAgBBB2pBeHEiAUEIajYCACAAIAEpAwA3AwAMBwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADAYLIAIgAigCAEEHakF4cSIBQQhqNgIAIAAgASkDADcDAAwFCyACIAIoAgBBB2pBeHEiAUEIajYCACAAIAEpAwA3AwAMBAsgAiACKAIAIgFBBGo2AgAgACABNAIANwMADAMLIAIgAigCACIBQQRqNgIAIAAgATUCADcDAAwCCyACIAIoAgBBB2pBeHEiAUEIajYCACABKwMAIQcjAEEQayIBJAACfiAHvSIFQv///////////wCDIgNCgICAgICAgAh9Qv/////////v/wBYBEAgA0I8hiEEIANCBIhCgICAgICAgIA8fAwBCyADQoCAgICAgID4/wBaBEAgBUI8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KAIIIQILIAEgAiACQQJ2akEgaiICIAEgAksbIQECQCAALQAQBEAgARBPIgJFBEAQVgsgACgCACIDRQ0BIAIgAyAAKAIIIgUQQRogAyAFEEMgACgCABBADAELIAAoAgAgARCMASICDQAQVkEAIQILIAAgATYCCCAAIAI2AgALIARBEGokAAs7AQF/IAAoAkwaIAAoAogBRQRAIABB0DhBuDhB3KUJKAIAKAIAGzYCiAELIAAoAkhFBEAgAEEBNgJICwvMAgEDfyMAQdABayIDJAAgAyACNgLMASADQaABaiICQQBBKBBCGiADIAMoAswBNgLIAQJAQQAgASADQcgBaiADQdAAaiACEIcCQQBIBEBBfyEADAELIAAoAkxBAE4hBSAAKAIAIQIgACgCSEEATARAIAAgAkFfcTYCAAsCfwJAAkAgACgCMEUEQCAAQdAANgIwIABBADYCHCAAQgA3AxAgACgCLCEEIAAgAzYCLAwBCyAAKAIQDQELQX8gABC+AQ0BGgsgACABIANByAFqIANB0ABqIANBoAFqEIcCCyEBIAQEQCAAQQBBACAAKAIkEQIAGiAAQQA2AjAgACAENgIsIABBADYCHCAAKAIUIQQgAEIANwMQIAFBfyAEGyEBCyAAIAAoAgAiACACQSBxcjYCAEF/IAEgAEEgcRshACAFRQ0ACyADQdABaiQAIAALvQIAAkACQAJAAkACQAJAAkACQAJAAkACQCABQQlrDhIACAkKCAkBAgMECgkKCggJBQYHCyACIAIoAgAiAUEEajYCACAAIAEoAgA2AgAPCyACIAIoAgAiAUEEajYCACAAIAEyAQA3AwAPCyACIAIoAgAiAUEEajYCACAAIAEzAQA3AwAPCyACIAIoAgAiAUEEajYCACAAIAEwAAA3AwAPCyACIAIoAgAiAUEEajYCACAAIAExAAA3AwAPCyACIAIoAgBBB2pBeHEiAUEIajYCACAAIAErAwA5AwAPCyAAIAJBygERBQALDwsgAiACKAIAIgFBBGo2AgAgACABNAIANwMADwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMAC3IBA38gACgCACwAAEEwa0EKTwRAQQAPCwNAIAAoAgAhA0F/IQEgAkHMmbPmAE0EQEF/IAMs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IAU2AgAgAyAENgIEDAELIAMgBDoACyADIQUgBEUNAQtBgKsJQQA2AgAgBSACQQRqIAQQjQEaQYCrCSgCACECQYCrCUEANgIAIAJBAUYNAgsgBSAEQQJ0akEANgIAIAEgACgCAGoiACwAC0EASARAIAAoAgAQQAsgACADKQMANwIAIAAgAygCCDYCCCADQRBqJAAPCyADEHYAC0EAEAMaEAAaEEkAC08BA38gASAAKAIAaiIAKAIEIAAtAAsiASABQRh0QRh1QQBIIgIbIgNBAnQiBEEEahBPIgEgAzYCACABQQRqIAAoAgAgACACGyAEEEEaIAEL2AIBAn8gASAAKAIAaiIAIAIoAgA2AgAgACACRwRAIAJBBGoiAS0ACyIEQRh0QRh1IQMgAEEEaiIALAALQQBOBEAgA0EATgRAIAAgASkCADcCACAAIAEoAgg2AggPCyACKAIEIQMgAigCCCEBIwBBEGsiAiQAAkAgAUEKTQRAIAAgAToACyAAIAMgARCLASACQQA6AA8gACABaiACLQAPOgAADAELIABBCiABQQprIAAtAAsiACAAIAEgAxC4AQsgAkEQaiQADwsgAigCBCABIANBAEgiARshAyACKAIIIAQgARshASMAQRBrIgIkAAJAIAEgACgCCEH/////B3EiBEkEQCAAKAIAIQQgACABNgIEIAQgAyABEIsBIAJBADoADyABIARqIAItAA86AAAMAQsgACAEQQFrIAEgBGtBAWogACgCBCIAIAAgASADELgBCyACQRBqJAALC5YBAQJ/IAAoAgAhAEEQEEwiAiAAIAFqIgAoAgA2AgAgAkEEaiEBAkAgACwAD0EATgRAIAEgACkCBDcCACABIAAoAgw2AggMAQsgACgCCCEDIAAoAgQhAEGAqwlBADYCAEHAASABIAAgAxAIQYCrCSgCACEAQYCrCUEANgIAIABBAUcNABACIQAQABogAhBAIAAQBAALIAILUgEBfwJAIAAgAUYNACACRQ0AAkAgAkEBayICRQ0AA0AgAC0AACIDRQ0BIAEgAzoAACABQQFqIQEgAEEBaiEAIAJBAWsiAg0ACwsgAUEAOgAACwswAQJ/IAAoAhQiAiAAKAIESQRAIAAgACgCACACQQJ0aiIBEEYgAmpBAWo2AhQLIAEL6AEBAX8gAEEAQYiQBRBCIgFBAjYC2I8E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ai0AACEPIAVBwYAEai0AACEQIANBwpgEai0AACERIARBwpAEai0AACESIAZBwogEai0AACETIAVBwoAEai0AACEUIANBw5gEai0AACEVIARBw5AEai0AACEWIAZBw4gEai0AACEXIAVBw4AEai0AACEYIAEtAB9BAnQiA0HAmARqLQAAIRkgAS0AHkECdCIEQcCQBGotAAAhGiABLQAdQQJ0IgZBwIgEai0AACEbIAEtABxBAnQiBUHAgARqLQAAIRwgA0HBmARqLQAAIR0gBEHBkARqLQAAIR4gBkHBiARqLQAAIR8gBUHBgARqLQAAISAgA0HCmARqLQAAISEgBEHCkARqLQAAISIgBkHCiARqLQAAISMgBUHCgARqLQAAISQgA0HDmARqLQAAISUgBEHDkARqLQAAISYgBkHDiARqLQAAIScgBUHDgARqLQAAISggAS0AI0ECdCIDQcCYBGotAAAhKSABLQAiQQJ0IgRBwJAEai0AACEqIAEtACFBAnQiBkHAiARqLQAAISsgAS0AIEECdCIFQcCABGotAAAhLCADQcGYBGotAAAhLSAEQcGQBGotAAAhLiAGQcGIBGotAAAhLyAFQcGABGotAAAhMCADQcKYBGotAAAhMSAEQcKQBGotAAAhMiAGQcKIBGotAAAhMyAFQcKABGotAAAhNCADQcOYBGotAAAhNSAEQcOQBGotAAAhNiAGQcOIBGotAAAhNyAFQcOABGotAAAhOCABLQAnQQJ0IgNBwJgEai0AACE5IAEtACZBAnQiBEHAkARqLQAAITogAS0AJUECdCIGQcCIBGotAAAhOyABLQAkQQJ0IgVBwIAEai0AACE8IANBwZgEai0AACE9IARBwZAEai0AACE+IAZBwYgEai0AACE/IAVBwYAEai0AACFAIANBwpgEai0AACFBIARBwpAEai0AACFCIAZBwogEai0AACFDIAVBwoAEai0AACFEIAEgA0HDmARqLQAAIARBw5AEai0AACAGQcOIBGotAAAgBUHDgARqLQAAc3NzOgAnIAEgQSBCIEMgRHNzczoAJiABID0gPiA/IEBzc3M6ACUgASA5IDogOyA8c3NzOgAkIAEgNSA2IDcgOHNzczoAIyABIDEgMiAzIDRzc3M6ACIgASAtIC4gLyAwc3NzOgAhIAEgKSAqICsgLHNzczoAICABICUgJiAnIChzc3M6AB8gASAhICIgIyAkc3NzOgAeIAEgHSAeIB8gIHNzczoAHSABIBkgGiAbIBxzc3M6ABwgASAVIBYgFyAYc3NzOgAbIAEgESASIBMgFHNzczoAGiABIA4gDCAPIBBzc3M6ABkgASALIAogByAIc3NzOgAYIAJBAWoiAiAJRw0ACwsLIA1BIGokAAumAwICfwF+AkACQCAALQDoMUUEQCAAKAIAIgIgAigCACgCGBEIACEEIABBADoAwDIgACAENwO4MiAAKAIAIgIgAUEAIAIoAgAoAhQRBgAgACgCACICQQE6ALCmASACEF0hAyAAKAIAIgJBADoAsKYBIANFDQEgAigC3HNBA0cNASACQciuAmpBvAoQZiEDIAAoAgAhAiADDQEgACACKQPwuwM3A/AxIAAgAiACKAIAKAIYEQgANwP4MSAAIAAoAgAiAkGA7wJqKQMANwOAMiACIARBACACKAIAKAIUEQYAIABBAToA6DELIAAoAgAiAkG77wJqLQAABEAgAigCzHMiA0GohANqLQAARQ0CIABBGGpBAEEFIANBqIADaiACQcHvAmogAkHR7wJqIAJBjPACaigCACACQevvAmogAkHi7wJqEJYBGgsgAEIANwOIMiAAQZAyakIANwMAIAAoApgyIgIEQCACEEAgAEEANgKYMgsgAEIANwOwMiAAQZwyakIANwIAIAAQzwEaDwsgAiAEQQAgAigCACgCFBEGAA8LIABBADoA6DEL7AYBCH9BwL4DLQAARQRAA0AgAkGwEWotAABBwL4DaiACOgAAIAJBAXIiAUGwEWotAABBwL4DaiABOgAAIAJBAnIiAUGwEWotAABBwL4DaiABOgAAIAJBA3IiAUGwEWotAABBwL4DaiABOgAAIAJBBGoiAkGAAkcNAAsDQCAEQQJ0IgJBwNgDaiAEQbARaiwAACIBOgAAIAJBwdgDaiABOgAAIAJBwNADaiABOgAAIAJBw9ADaiABOgAAIAJBwsgDaiABOgAAIAJBw8gDaiABOgAAIAJBwcADaiABOgAAIAJBwsADaiABOgAAIAJBw9gDaiABQQF0IgNBG3MgAyABQQBIGyIDOgAAIAJBwtADaiADOgAAIAJBwcgDaiADOgAAIAJBwMADaiADOgAAIAJBwtgDaiABIANzIgE6AAAgAkHB0ANqIAE6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IwBB0ABrIgIkACACQUBrIgNCADcDACACQgA3AyggAkIANwMwIAJCADcDOCADQQI2AgAgAkIANwMgIAJBzBA2AhwgAkHMEDYCGCACQcwQNgIUIAJBzBA2AhAgAkHMEDYCDCACQcwQNgIIIAJBCTYCSCACIAA2AgAgAiABNgIEQaT+AkEJNgIAQaj+AkGo/gIoAgBBAWo2AgAgAkHQAGokAAvKAQECfyMAQdAAayIBJABBsP4CLQAARQRAIAFBQGsiAkIANwMAIAFCADcDKCABQgA3AzAgAUIANwM4IAJBATYCACABQgA3AyAgAUHMEDYCHCABQcwQNgIYIAFBzBA2AhQgAUHMEDYCECABQcwQNgIMIAFBzBA2AgggAUHMEDYCBCABQQs2AkggASAANgIAC0Gk/gIoAgBBAU0EQEGk/gJBAjYCAAtBqP4CQaj+AigCAEEBajYCAEEEEA8iAEECNgIAIABBjAhBABAOAAtvAQJ+IAEoAhRBAUcEQCABEJMCIQILAkACQCABQfimAWopAwAiA1BFDQAgAUGIpwFqKQMAIgNQRQ0AIAJCF1cEQCAAKQOIASEDDAILIAJCF30hAwsgACADNwOIAQsgACAAKQOQASADIAJ9fDcDkAELoQEBAn8jAEEQayIDJAAgAyAAKQMAQoCA2JzLnqGz3gB8QoCU69wDgD4CDCABIANBDGoQjwIiAigCFEHsDmo2AgAgASACKAIQQQFqNgIEIAEgAigCDDYCCCABIAIoAgg2AgwgASACKAIENgIQIAEgAigCADYCFCABIAIoAhg2AhwgASACKAIcNgIgIAEgACkDAEKAlOvcA4I+AhggA0EQaiQACxkAIABBADYCDCAAQgA3AgQgAEEAOgAAIAALLAECfyAAKAIcIgEgACgCGEkEfyAAIAFBAWo2AhwgACgCACABai0AAAVBAAsLyAEBA38gACgCIARAIAEgACgCBCIEIAAoAhgiAmsiA0sEQCAAQQAgASADayICa0EPcSACaiICEFwgACgCFCIDIAAoAgAgBGogAiADKAIAKAIQEQIAIQMgACgCICAAKAIAIARqIAIQtAEgACAAKAIYIAFBACADG2o2AhggAw8LIAAgASACajYCGCABDwsgAUUEQEEADwsgACABEFwgACAAKAIUIgQgACgCACAAKAIYaiABIAQoAgAoAhARAgAi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BCQAAkAgASgCGCACayIFIAEoAhxJDQAgASAFNgIcIAJBAkkNACADQcLBAGohDCADQbHBAGohDyADQaHBAGohECAAQTRqIREgA0H0wABqIRIgA0HQwABqIQkgA0HIwABqIQogA0HAwABqIQsgA0EoaiENIANBhMIAaiETIANBiIIBaiEUIANBiIQBaiEVIANBqMAAaiEOIARB4MAAaiEHA0AgARBLIhhCAFcNASABKAIYIgUgASgCHCICRg0BIBggBSACa61WDQEgGKchBiABEEshGCABKAIcIQggAygCBCEFAkAgGEIBUg0AIAVBAUcNACADQQE6AB4CQCABEEunIgVBAXFFDQAgARBLIhlQDQAgAyAAKQPwuwMgGXw3AyALAkAgBUECcUUNACABEEsiGVANACADIAApA/C7AyAZfDcDMAsgAygCBCEFCyACIAZqIQYCQCAFQX5xQQJHDQAgGEIBfSIYQgZWDQAgBiAIayECAkACQAJAAkACQAJAAkACQAJAAkAgGKdBAWsOBgECAwQFBgALIAEQS6ciAgRAIAQgAjYCECAEQTBqIgJBFEGIDiAEQRBqEKUBGiAEQbwONgLcQCAEQbwONgLYQCAEQbwONgLUQCAEQbwONgLQQCAEQbwONgLMQCAHQgA3AiAgB0IANwIYIAdCADcCECAHQgA3AgggB0IANwIAIARBAzYCgEEgBCANNgLEQCAEIBE2AsBAIARBIjYCiEEgBCACNgLIQEGk/gJBARBHDAoLIAMgARBLpyICQQFxOgDBQSADIAJBAXZBAXE6AMpBIAMgASgCHCICIAEoAhhJBH8gASACQQFqNgIcIAEoAgAgAmotAAAFQQALIgI2AuxBIAJBGU8EQCAEIAI2AgAgBEEwaiICQRRBmA4gBBClARogACANIAIQmgELIAEgEEEQEGUaIAEgD0EQEGUaAkAgAy0AwUFFDQAgASAMQQgQZRogASAEQbzAAGpBBBBlGiAEQTBqIgJCADcDICACQquzj/yRo7Pw2wA3AxggAkL/pLmIxZHagpt/NwMQIAJC8ua746On/aelfzcDCCACQufMp9DW0Ouzu383AwAgAiAMQQgQdyACIARBwMAAahCGASADIAQoALxAIAQoAsBARjoAwUEgAygCBEEDRw0AIAwpAABCAFINACADQQA6AMFBCyADQQU2ApxBIANB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IAMgACACKAIAQQEgAygCACgCHBEJAAJAIAYoAiAiAEEBRw0AIAIoAgBFDQAgAiAGKAIYNgIACyAAQQFGIQQMAQtBACEECyAGQUBrJAAgBAsyACAAIAEoAghBABBUBEAgASACIAMQ8QEPCyAAKAIIIgAgASACIAMgACgCACgCHBEJAAsZACAAIAEoAghBABBUBEAgASACIAMQ8QELC58BAQJ/IwBBQGoiAyQAAn9BASAAIAFBABBUDQAaQQAgAUUNABpBACABQaT2ABBbIgFFDQAaIANBCGoiBEEEckEAQTQQQhogA0EBNgI4IANBfzYCFCADIAA2AhAgAyABNgIIIAEgBCACKAIAQQEgASgCACgCHBEJACADKAIgIgBBAUYEQCACIAMoAhg2AgALIABBAUYLIQAgA0FAayQAIAALBQAQFwALQQAgAkEISwRAQYCrCUEANgIAIAAQQEGAqwkoAgAhAEGAqwlBADYCACAAQQFGBEBBABADGhAAGhBJAAsPCyAAEEALiAIBAn8CfyABEEYhAiACIAAtAAtBB3YEfyAAKAIIQf////8HcUEBawVBAQsiA00EQAJ/IAAtAAtBB3YEQCAAKAIADAELIAALIQMCQAJAIAIEQEGAqwlBADYCACADIAEgAhD6ARpBgKsJKAIAIQFBgKsJQQA2AgAgAUEBRg0BCwwBC0EAEAMaEAAaEEkACyMAQRBrIgEkAAJAIAAtAAtBB3YEQCAAIAI2AgQMAQsgACACOgALCyABQQA2AgwgAyACQQJ0aiABKAIMNgIAIAFBEGokACAADAELIAAgAyACIANrAn8gAC0AC0EHdgRAIAAoAgQMAQsgAC0ACwsiAyADIAIgARDqAiAACwu+AwEFfyMAQRBrIgckACACIAFBf3NB7////wNqTQRAAn8gAC0AC0EHdgRAIAAoAgAMAQsgAAshCQJ/IAFB5////wFJBEAgByABQQF0NgIIIAcgASACajYCDCMAQRBrIgIkACAHQQxqIggoAgAgB0EIaiIKKAIASSELIAJBEGokACAKIAggCxsoAgAiAkECTwR/IAJBBGpBfHEiAiACQQFrIgIgAkECRhsFQQELDAELQe7///8DC0EBaiIIIgJB/////wNLBEBBBBAPIgBBrPwANgIAIABBhPwANgIAIABBmPwANgIAIABBhP0AQYcBEA4ACyACQQJ0QQQQ8wEhAiAFBEAgAiAGIAUQ9AELIAMgBGshBiADIARHBEAgBUECdCACaiAEQQJ0IAlqIAYQ9AELIAFBAWoiAUECRwRAQYCrCUEANgIAQc8BIAkgAUECdEEEEAhBgKsJKAIAIQFBgKsJQQA2AgAgAUEBRgRAQQAQAxoQABoQSQALCyAAIAI2AgAgACAIQYCAgIB4cjYCCCAAIAUgBmoiADYCBCAHQQA2AgQgAiAAQQJ0aiAHKAIENgIAIAdBEGokAA8LIAAQdgALxAEBAX8gAiAALQALQQd2BH8gACgCCEH/////B3FBAWsFQQoLIgNNBEACfyAALQALQQd2BEAgACgCAAwBCyAACyEDIAIEQCADIAEgAhBNCyMAQRBrIgEkAAJAIAAtAAtBB3YEQCAAIAI2AgQMAQsgACACOgALCyABQQA6AA8gAiADaiABLQAPOgAAIAFBEGokACAADwsgACADIAIgA2sCfyAALQALQQd2BEAgACgCBAwBCyAALQALCyIDIAMgAiABELgBIAALfgECfwJAAkAgAkELSQRAIAAiAyACOgALDAELIAJBb0sNASAAIAAgAkELTwR/IAJBEGpBcHEiAyADQQFrIgMgA0ELRhsFQQoLQQFqIgQQ9gEiAzYCACAAIARBgICAgHhyNgIIIAAgAjYCBAsgAyABIAJBAWoQiwEPCyAAEHYACzkBAn8gARBgIgJBDWoQTCIDQQA2AgggAyACNgIEIAMgAjYCACAAIANBDGogASACQQFqEEE2AgAgAAsGACAAEEwLHwBBgKsJKAIARQRAQYSrCSABNgIAQYCrCSAANgIACwupAQEEfyAAKAJUIgMoAgQiBSAAKAIUIAAoAhwiBmsiBCAEIAVLGyIEBEAgAygCACAGIAQQQRogAyADKAIAIARqNgIAIAMgAygCBCAEayIFNgIECyADKAIAIQQgBSACIAIgBUsbIgUEQCAEIAEgBRBBGiADIAMoAgAgBWoiBDYCACADIAMoAgQgBWs2AgQLIARBADoAACAAIAAoAiwiATYCHCAAIAE2AhQgAgu/BAEFfiABIAEoAgBBB2pBeHEiAUEQajYCACAAAnwgASkDACEEIAEpAwghBSMAQSBrIgAkAAJAIAVC////////////AIMiAkKAgICAgIDAgDx9IAJCgICAgICAwP/DAH1UBEAgBUIEhiAEQjyIhCEGIARC//////////8PgyICQoGAgICAgICACFoEQCAGQoGAgICAgICAwAB8IQMMAgsgBkKAgICAgICAgEB9IQMgAkKAgICAgICAgAhSDQEgAyAGQgGDfCEDDAELIARQIAJCgICAgICAwP//AFQgAkKAgICAgIDA//8AURtFBEAgBUIEhiAEQjyIhEL/////////A4NCgICAgICAgPz/AIQhAwwBC0KAgICAgICA+P8AIQMgAkL///////+//8MAVg0AQgAhAyACQjCIpyIBQZH3AEkNACAAQRBqIAQgBUL///////8/g0KAgICAgIDAAIQiAiABQYH3AGsQ+AECQEGB+AAgAWsiAUHAAHEEQCACIAFBQGqtiCEEQgAhAgwBCyABRQ0AIAJBwAAgAWuthiAEIAGtIgaIhCEEIAIgBoghAgsgACAENwMAIAAgAjcDCCAAKQMIQgSGIAApAwAiAkI8iIQhAyAAKQMQIAApAxiEQgBSrSACQv//////////D4OEIgJCgYCAgICAgIAIWgRAIANCAXwhAwwBCyACQoCAgICAgICACFINACADQgGDIAN8IQMLIABBIGokACADIAVCgICAgICAgICAf4OEvws5AwALqhgDEn8BfAJ+IwBBsARrIgskACALQQA2AiwCQCABvSIZQgBTBEBBASEQQfIjIRMgAZoiAb0hGQwBCyAEQYAQcQRAQQEhEEH1IyETDAELQfgjQfMjIARBAXEiEBshEyAQRSEVCwJAIBlCgICAgICAgPj/AINCgICAgICAgPj/AFEEQCAAQSAgAiAQQQNqIgMgBEH//3txEFUgACATIBAQUCAAQcwlQZ4oIAVBIHEiBRtBzCZBriggBRsgASABYhtBAxBQIABBICACIAMgBEGAwABzEFUgAyACIAIgA0gbIQkMAQsgC0EQaiERAkACfwJAIAEgC0EsahCJAiIBIAGgIgFEAAAAAAAAAABiBEAgCyALKAIsIgZBAWs2AiwgBUEgciIOQeEARw0BDAMLIAVBIHIiDkHhAEYNAiALKAIsIQpBBiADIANBAEgbDAELIAsgBkEdayIKNgIsIAFEAAAAAAAAsEGiIQFBBiADIANBAEgbCyEMIAtBMGpBAEGgAiAKQQBIG2oiDSEHA0AgBwJ/IAFEAAAAAAAA8EFjIAFEAAAAAAAAAABmcQRAIAGrDAELQQALIgM2AgAgB0EEaiEHIAEgA7ihRAAAAABlzc1BoiIBRAAAAAAAAAAAYg0ACwJAIApBAEwEQCAKIQMgByEGIA0hCAwBCyANIQggCiEDA0AgA0EdIANBHUgbIQMCQCAHQQRrIgYgCEkNACADrSEaQgAhGQNAIAYgGUL/////D4MgBjUCACAahnwiGSAZQoCU69wDgCIZQoCU69wDfn0+AgAgBkEEayIGIAhPDQALIBmnIgZFDQAgCEEEayIIIAY2AgALA0AgCCAHIgZJBEAgBkEEayIHKAIARQ0BCwsgCyALKAIsIANrIgM2AiwgBiEHIANBAEoNAAsLIANBAEgEQCAMQRlqQQluQQFqIQ8gDkHmAEYhEgNAQQAgA2siA0EJIANBCUgbIQkCQCAGIAhNBEAgCCgCACEHDAELQYCU69wDIAl2IRRBfyAJdEF/cyEWQQAhAyAIIQcDQCAHIAMgBygCACIXIAl2ajYCACAWIBdxIBRsIQMgB0EEaiIHIAZJDQALIAgoAgAhByADRQ0AIAYgAzYCACAGQQRqIQYLIAsgCygCLCAJaiIDNgIsIA0gCCAHRUECdGoiCCASGyIHIA9BAnRqIAYgBiAHa0ECdSAPShshBiADQQBIDQALC0EAIQMCQCAGIAhNDQAgDSAIa0ECdUEJbCEDQQohByAIKAIAIglBCkkNAANAIANBAWohAyAJIAdBCmwiB08NAAsLIAxBACADIA5B5gBGG2sgDkHnAEYgDEEAR3FrIgcgBiANa0ECdUEJbEEJa0gEQEEEQaQCIApBAEgbIAtqIAdBgMgAaiIJQQltIg9BAnRqQdAfayEKQQohByAJIA9BCWxrIglBB0wEQANAIAdBCmwhByAJQQFqIglBCEcNAAsLAkAgCigCACISIBIgB24iDyAHbGsiCUUgCkEEaiIUIAZGcQ0AAkAgD0EBcUUEQEQAAAAAAABAQyEBIAdBgJTr3ANHDQEgCCAKTw0BIApBBGstAABBAXFFDQELRAEAAAAAAEBDIQELRAAAAAAAAOA/RAAAAAAAAPA/RAAAAAAAAPg/IAYgFEYbRAAAAAAAAPg/IAkgB0EBdiIURhsgCSAUSRshGAJAIBUNACATLQAAQS1HDQAgGJohGCABmiEBCyAKIBIgCWsiCTYCACABIBigIAFhDQAgCiAHIAlqIgM2AgAgA0GAlOvcA08EQANAIApBADYCACAIIApBBGsiCksEQCAIQQRrIghBADYCAAsgCiAKKAIAQQFqIgM2AgAgA0H/k+vcA0sNAAsLIA0gCGtBAnVBCWwhA0EKIQcgCCgCACIJQQpJDQADQCADQQFqIQMgCSAHQQpsIgdPDQALCyAKQQRqIgcgBiAGIAdLGyEGCwNAIAYiByAITSIJRQRAIAdBBGsiBigCAEUNAQsLAkAgDkHnAEcEQCAEQQhxIQoMAQsgA0F/c0F/IAxBASAMGyIGIANKIANBe0pxIgobIAZqIQxBf0F+IAobIAVqIQUgBEEIcSIKDQBBdyEGAkAgCQ0AIAdBBGsoAgAiDkUNAEEKIQlBACEGIA5BCnANAANAIAYiCkEBaiEGIA4gCUEKbCIJcEUNAAsgCkF/cyEGCyAHIA1rQQJ1QQlsIQkgBUFfcUHGAEYEQEEAIQogDCAGIAlqQQlrIgZBACAGQQBKGyIGIAYgDEobIQwMAQtBACEKIAwgAyAJaiAGakEJayIGQQAgBkEAShsiBiAGIAxKGyEMC0F/IQkgDEH9////B0H+////ByAKIAxyIhIbSg0BIAwgEkEAR2pBAWohDgJAIAVBX3EiFUHGAEYEQCADQf////8HIA5rSg0DIANBACADQQBKGyEGDAELIBEgAyADQR91IgZzIAZrrSAREH8iBmtBAUwEQANAIAZBAWsiBkEwOgAAIBEgBmtBAkgNAAsLIAZBAmsiDyAFOgAAIAZBAWtBLUErIANBAEgbOgAAIBEgD2siBkH/////ByAOa0oNAgsgBiAOaiIDIBBB/////wdzSg0BIABBICACIAMgEGoiBSAEEFUgACATIBAQUCAAQTAgAiAFIARBgIAEcxBVAkACQAJAIBVBxgBGBEAgC0EQaiIGQQhyIQMgBkEJciEKIA0gCCAIIA1LGyIJIQgDQCAINQIAIAoQfyEGAkAgCCAJRwRAIAYgC0EQak0NAQNAIAZBAWsiBkEwOgAAIAYgC0EQaksNAAsMAQsgBiAKRw0AIAtBMDoAGCADIQYLIAAgBiAKIAZrEFAgCEEEaiIIIA1NDQALIBIEQCAAQaItQQEQUAsgByAITQ0BIAxBAEwNAQNAIAg1AgAgChB/IgYgC0EQaksEQANAIAZBAWsiBkEwOgAAIAYgC0EQaksNAAsLIAAgBiAMQQkgDEEJSBsQUCAMQQlrIQYgCEEEaiIIIAdPDQMgDEEJSiEDIAYhDCADDQALDAILAkAgDEEASA0AIAcgCEEEaiAHIAhLGyEJIAtBEGoiBkEIciEDIAZBCXIhDSAIIQcDQCANIAc1AgAgDRB/IgZGBEAgC0EwOgAYIAMhBgsCQCAHIAhHBEAgBiALQRBqTQ0BA0AgBkEBayIGQTA6AAAgBiALQRBqSw0ACwwBCyAAIAZBARBQIAZBAWohBiAKIAxyRQ0AIABBoi1BARBQCyAAIAYgDCANIAZrIgYgBiAMShsQUCAMIAZrIQwgB0EEaiIHIAlPDQEgDEEATg0ACwsgAEEwIAxBEmpBEkEAEFUgACAPIBEgD2sQUAwCCyAMIQYLIABBMCAGQQlqQQlBABBVCyAAQSAgAiAFIARBgMAAcxBVIAUgAiACIAVIGyEJDAELIBMgBUEadEEfdUEJcWohDAJAIANBC0sNAEEMIANrIQZEAAAAAAAAMEAhGANAIBhEAAAAAAAAMECiIRggBkEBayIGDQALIAwtAABBLUYEQCAYIAGaIBihoJohAQwBCyABIBigIBihIQELIBEgCygCLCIGIAZBH3UiBnMgBmutIBEQfyIGRgRAIAtBMDoADyALQQ9qIQYLIBBBAnIhCiAFQSBxIQggCygCLCEHIAZBAmsiDSAFQQ9qOgAAIAZBAWtBLUErIAdBAEgbOgAAIARBCHEhBiALQRBqIQcDQCAHIgUCfyABmUQAAAAAAADgQWMEQCABqgwBC0GAgICAeAsiB0GA4QBqLQAAIAhyOgAAIAEgB7ehRAAAAAAAADBAoiEBAkAgBUEBaiIHIAtBEGprQQFHDQACQCAGDQAgA0EASg0AIAFEAAAAAAAAAABhDQELIAVBLjoAASAFQQJqIQcLIAFEAAAAAAAAAABiDQALQX8hCUH9////ByAKIBEgDWsiBWoiBmsgA0gNACAAQSAgAiAGAn8CQCADRQ0AIAcgC0EQamsiCEECayADTg0AIANBAmoMAQsgByALQRBqayIICyIHaiIDIAQQVSAAIAwgChBQIABBMCACIAMgBEGAgARzEFUgACALQRBqIAgQUCAAQTAgByAIa0EAQQAQVSAAIA0gBRBQIABBICACIAMgBEGAwABzEFUgAyACIAIgA0gbIQkLIAtBsARqJAAgCQsgAQJ/IAAQYEEBaiIBEE8iAkUEQEEADwsgAiAAIAEQQQuiAwEGfyMAQTBrIgMkAAJAIABBBksNACAAQQZGBEAgAQRAIANB0DkpAwA3AxAgA0HIOSkDADcDCCADQcA5KQMANwMAQQAhAANAIAFBOxCLAiICIAFrIgRBF0wEQCADIAEgBBBBGiADIARqQQA6AAAgAkEBaiABIAItAAAbIQELIAAgAxCMAiICQX9GBEBBACECDAQLIANBGGogAEECdGogAjYCACAAQQFqIgBBBkcNAAtBuKQJIAMpAxg3AgBByKQJIAMpAyg3AgBBwKQJIAMpAyA3AgALQYCmCSEBQQAhAkEAIQADQEG4pAkoAgAhByABIABBAnRBuKQJaigCACIEQQhqQbYoIAQbIgYgBhBgIgUQQRogASAFaiIFQTs6AAAgBUEBaiEBIAIgBCAHRmohAiAAQQFqIgBBBkcNAAsgBUEAOgAAIAZBgKYJIAJBBkYbIQIMAQsCQCABBEAgACABEIwCIgFBf0YNAiAAQQJ0QbikCWogATYCAAwBCyAAQQJ0QbikCWooAgAhAQsgAUEIakG2KCABGyECCyADQTBqJAAgAgsKACAAKAIEEPMCCwQAQQELAwABCwMAAQsEAEEBCwMAAQsvAQF+IAApAwgiAUJ/UgRAIAAtABlFBEAgARDrAQsgAEJ/NwMICyAAQQA2AhRBAQu/AQECfyAAIAFBACAAKAIAKAIIEQIAIgJFBEAjAEHQAGsiACQAEHAgAEFAayIDQgA3AwAgAEIANwMoIABCADcDMCAAQgA3AzggA0ECNgIAIABCADcDICAAQcwQNgIcIABBzBA2AhggAEHMEDYCFCAAQcwQNgIQIABBzBA2AgwgAEHMEDYCCCAAQQg2AkggAEEANgIAIAAgATYCBEGk/gJBBjYCAEGo/gJBqP4CKAIAQQFqNgIAIABB0ABqJAALIAILCwAgABBqGiAAEEALYAACfyAAQaz8ADYCACAAQZj9ADYCAEGAqwlBADYCAEHOASAAQQRqIAEQBxpBgKsJKAIAIQFBgKsJQQA2AgAgACABQQFHDQAaEAIhABAAGiAAEAQACyIAQcj9ADYCACAACw8AIAEgACgCAGogAjkDAAsNACABIAAoAgBqKwMAC0EAIAAEQCAALAAnQQBIBEAgACgCHBBACyAALAAbQQBIBEAgACgCEBBACyAALAAPQQBIBEAgACgCBBBACyAAEEALCw4AQdgAEExBAEHYABBCCy8AIAAEQCAALAAbQQBIBEAgACgCEBBACyAALAAPQQBIBEAgACgCBBBACyAAEEALCyYBAX9BIBBMIgBCADcDACAAQgA3AxggAEIANwMQIABCADcDCCAAC7UBAQR/IwBBEGsiAyQAIAIoAgAiBEFwSQRAAkACQCAEQQtPBEAgBEEQakFwcSIGEEwhBSADIAZBgICAgHhyNgIIIAMgBTYCACADIAQ2AgQMAQsgAyAEOgALIAMhBSAERQ0BCyAFIAJBBGogBBBBGgsgBCAFakEAOgAAIAEgACgCAGoiACwAC0EASARAIAAoAgAQQAsgACADKQMANwIAIAAgAygCCDYCCCADQRBqJAAPCyADEHYAC0oBAn8gASAAKAIAaiIAKAIEIAAtAAsiASABQRh0QRh1QQBIIgMbIgFBBGoQTyICIAE2AgAgAkEEaiAAKAIAIAAgAxsgARBBGiACCx0AIAAEQCAALAAPQQBIBEAgACgCBBBACyAAEEALCxgBAX9BEBBMIgBCADcDACAAQgA3AwggAAuwAQECfyMAQRBrIgMkACAAKAIAIQQgAyABIAAoAgQiAEEBdWoiASACIABBAXEEfyABKAIAIARqKAIABSAECxEEAEGAqwlBADYCAEECQRAQASEAQYCrCSgCACEBQYCrCUEANgIAIAFBAUYEQBACIQAQABogAywAD0EASARAIAMoAgQQQAsgABAEAAsgACADKAIANgIAIAAgAykCBDcCBCAAIAMoAgw2AgwgA0EQaiQAIAALrgEBAX8gAEIANwIEIABBADYCDCABKAIAIQFBgKsJQQA2AgBBvgEgAUEAQQIgAhtBAEEAEA0hAkGAqwkoAgAhA0GAqwlBADYCACAAQQRqIQECQCADQQFHBEAgACACNgIAQYCrCUEANgIAQb8BIAFBhyhBCxAGGkGAqwkoAgAhAEGAqwlBADYCACAAQQFHDQELEAIhABAAGiABLAALQQBIBEAgASgCABBACyAAEAQACwuXAgECfyMAQeAAayICJAAgASAAKAIEIgNBAXVqIQEgACgCACEAIAJBCGogASADQQFxBH8gASgCACAAaigCAAUgAAsRBQBBgKsJQQA2AgBBAkHYABABIQBBgKsJKAIAIQFBgKsJQQA2AgAgAUEB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CUEANgIAIABB0JMGaiIBQQA2AlwgAUIANwIUIAFCADcCACABQgA3AgggAUEAOgAQIAEhBkGAqwkoAgAhAUGAqwlBADYCACABQQFGDQRBgKsJQQA2AgAgABCgAkGAqwkoAgAhAUGAqwlBADYCACABQQFGDQUgAA8LEAIhARAAGgwJCxACIQEQABoMBwsQAiEBEAAaDAULEAIhARAAGgwDCxACIQEQABoMAQsQAiEBEAAaIAYQewsgBRB7CyAEEHsLIAMQewsgAhB7CyAAENMBGiABEAQAC7QBAAJAIAEgAEGwwABqKAIASwRAIABBqMAAaiABIAAoAqxAaxBcDAELIAAgATYCrEALIABBADoAECAAQfDAAGpBADYCACAAQQA7AYSCASAAQQA2AoBCIABBADoAykEgAEEAOgDBQSAAQQA2AiQgAEIANwPAQCAAQcjAAGpCADcDACAAQdDAAGpCADcDACAAQgA3A5hBIABBoMEAakEAOgAAIABCADcC7EEgAEHzwQBqQgA3AAALhJoBAiN/AX4CQAJAAkACQAJAIAFBD2sOJAAEBAQEAQQEBAQEAQQEAgQEBAQEBAQEBAQEBAQEBAQEBAQEAwQLIAAtALSYAQ0DQQAhASAAIgMgAhCSASACRQRAIANCADcC3K4BIANBgcAANgKIrwEgA0GA6gA2AtiuASADQoCBgICAEDcDgK8BIANB7K4BakIANwIAIANB5K4BakIANwIACyADQgA3AvSuASADQQA2AtSuASADQQA2AvyuASADQQA2AnQCQCADKAIEIgBBAEoNACADIAMoAnwgAygChAEgAGtqNgJ8IAMoAgAgAygCEEGAgAIQVyEAIAMoAnQhBiAAQQBKBEAgAyAAIAZqIgY2AnQLIAMgBkEeayIGNgJ4IAMgAygCBCIENgKEASADKAJ8IgBBf0YNACADIAYgACAEakEBayIAIAAgBkobNgJ4CyADAn8gAkUEQCADQdKgAWohByADQdKYAWohBSADQdKcAWohBiADQdKkAWohBANAIAcgAUEBdCICaiABQQh0IgA7AQAgAiAFaiAAOwEAIAIgBmogATsBACACIARqQQAgAGs7AQAgByABQQFyIgJBAXQiCGogAkEIdCIAOwEAIAUgCGogADsBACAGIAhqIAI7AQAgBCAIakEAIABrOwEAIAFBAmoiAUGAAkcN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rwEgAyADKALYrgEgB2oiACAAQQh2azYC2K4BIAFBgAJPBEAgA0GQATYCgK8BIAMgAygChK8BQQF2NgKErwELIANB0pgBaiIEIAdBAXRqIgYtAAEhASADIAMoAmwiAEEBajYCbCAAIAMoArCWAWogAToAACADIAMpA7iYAUIBfTcDuJgBIAMgBi8BACIBQf8BcWpB0qgBaiIAIAAtAAAiAEEBajoAACABQQFqIgdB/gFxQaIBTwRAIANB0qgBaiECA0AgBCACEJEBIAMgBi8BACIBQf8BcWpB0qgBaiIAIAAtAAAiAEEBajoAACABQQFqIgdB/gFxQaEBSw0ACwsgBiADIABB/wFxQQF0akHSmAFqIgAvAQA7AQAgACAHOwEADAILIAUgBSgCBEEFaiIBQQdxNgIEIAUgBSgCACABQQN2ajYCAEEACyEEIAUQRCECIAUgBSgCBEEFaiIBQQdxNgIEIAUgBSgCACABQQN2ajYCACADIAMpA7iYASAArX03A7iYASAHQQJ0QcAbaigCACAGIARrQRAgB2t2akEFdCACQQt2ciEGIAMoAtDNAyEBIAMoAmwhByAAQQFxBEAgAygCsJYBIgIgB2ogAiAHIAZrIAFxai0AADoAACADIAMoAtDNAyIBIAMoAmxBAWpxIgc2AmwgAEEBayEACwNAIAMoArCWASICIAdqIAIgByAGayABcWotAAA6AAAgAyADKALQzQMiAiADKAJsQQFqcSIENgJsIAMoArCWASIBIARqIAEgAiAEIAZrcWotAAA6AAAgAyADKALQzQMiASADKAJsQQFqcSIHNgJsIABBAmsiAA0ACwsLIAMpA7iYAUIAWQ0ACwsgAygCbCICIAMoAnAiBEcEQCADQQE6AMKYAQsgAygCsJYBIARqIQEgAygCACEAAkAgAiAESQRAIAAgASADKALQzQNBACAEa3EQUSADKAIAIAMoArCWASADKAJsEFEgA0EBOgDBmAEMAQsgACABIAIgBGsQUQsgAyADKAJsNgJwDwsgAC0AtJgBDQICQAJAIAAiAy0AwJgBBEAgAyADKAJwNgJsIAMpA7iYASEmDAELIAMgAhCSASADKAJ0IgAgAygCBCIEayIBQQBIDQEgAyADKAJ8IAMoAoQBIARrajYCfCAEQYGAAU4EQCABBEAgAygCECIAIAAgBGogARBNCyAD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AQEBAQEBAAELIARBqMABakIANwMAIARBoMABakIANwMAIARCADcDmMABQQAgBSAAKAIILQDfxAMbIQULAkAgAUHwpwFqLQAARQ0AIAFB7KcBaigCACICQTJLIAJBHmtBb0kgASgCgLwDQQNGG0UNACMAQdAAayICJAAgAkFAayIDQgA3AwAgAkIANwMoIAJCADcDMCACQgA3AzggA0ECNgIAIAJCADcDICACQcwQNgIcIAJBzBA2AhggAkHMEDYCFCACQcwQNgIQIAJBzBA2AgwgAkHMEDYCCCACQSE2AkggAiABQTRqIgM2AgAgAiAEQcDAAWo2AgRBpP4CKAIAQQFNBEBBpP4CQQI2AgALQaj+AkGo/gIoAgBBAWo2AgAgAkHQAGokACAEQciAAWoiAkIANwMAIARBsIABakIANwMAIARBuIABakIANwMAIARBwIABakIANwMAIAJBATYCACAEQgA3A6iAASAEQbQXNgKkgAEgBEG0FzYCoIABIARBtBc2ApyAASAEQbQXNgKYgAEgBEG0FzYClIABIARBtBc2ApCAASAEQbQXNgKMgAEgBEEkNgLQgAEgBCADNgKIgAFBpP4CQQIQRyAAKAIIQQ42AvCPBSABIAEpA/i7A0EAIAEoAgAoAhQRBgAgAS0AhLwDRSECDA4LAkAgAS0A6+gBRQ0AIwBBgAVrIgIkAAJ/AkAgACgCCCIDQaiEA2otAAANAEEAIAMoAviPBSIGRQ0BGiACQQA2AoABAkACQEEEIAMoAvSPBSACQYABakGAASAGEQcAQX9GBEAgAkEANgKAAQwBCyACKAKAAQ0BCyACQQA6AABBAiAAKAIIIgMoAvSPBSACQYABIAMoAviPBREHAEF/RgRAIAJBADoAAAsgAkEAIAJBgAFqQYABEJ0BGiACQYABEEMLIAAoAghBqIADaiACQYABaiIDELgCIANBgAQQQyAAKAIIIgNBAToAroQDIANBqIQDai0AAA0AQQAMAQtBAQshAyACQYAFaiQAIAMNACAAKAIIQRY2AvCPBUEAIQIMDgsgBEGIgAFqIgIgACgCCEGogANqQYQEEEEaIAFBvOkBaigCACEDIAFB7OgBaigCACEKIAFB8OgBai0AACEMQYCrCUEANgIAQeYAIABBEGoiBkEAIAogAiABQfHoAWpBACAMGyABQYHpAWogAyAB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QbAXNgKYECAAQbAXNgKUECAAQbAXNgKQECAAQbAXNgKMECAAQbAXNgKIECAAQbAXNgKEECAAQd4ANgLIECAAIAM2AoAQDAELIABBwBBqIgFCADcDACAAQagQakIANwMAIABBsBBqQgA3AwAgAEG4EGpCADcDACABQQI2AgAgAEIANwOgECAAQbAXNgKcECAAQbAXNgKYECAAQbAXNgKUECAAQbAXNgKQECAAQbAXNgKMECAAQbAXNgKIECAAQRU2AsgQIABBADYCgBAgACADNgKEEEGk/gJBARBHCyAAQdAQaiQADAYLIABBAWohAAsgBCABQQFqIgFBAnRqKAIAIQIMAAsACyAGQQFqIQYLIAFBAWohAQwACwALIARBgNAAaiQAIAYhBAsgBAupAgIDfwF+IAAoApQyIgJBgf4Da0H/AU0EQCAAKAIQIgMgAiADaiAAKAKQMiACayICEEEaIAAgAjYCkDIgAEEANgKUMiAAEM8BGiAAKAKUMiECC0EAIQMCQCAAKAKQMiACQQdqTwR/IAEgACgCECACakEHENkBIAAgACgClDJBB2o2ApQyIAEQRSEEIAFBBBCyASECIAEQSyIFUA0BIAJFDQEgAiAFp2pBA2siAkEASA0BAkAgAkUNAANAIAEgACgClDIiAyAAKAIQaiAAKAKQMiADayIDIAIgAiADSxsiAxDZASAAIAAoApQyIANqNgKUMiACIANrIgJBAEwNASAAQgA3A5AyIAAQzwENAAtBAA8LIAEQsAEgBEYFQQALDwsgAEEAOgDoMUEACxUAIAAoAgRBf3NBACAAKAIAQQJGGwsSACAAQQA2AgAgAEEANgIIIAALSQAgAEIANwMgIABCq7OP/JGjs/DbADcDGCAAQv+kuYjFkdqCm383AxAgAELy5rvjo6f9p6V/NwMIIABC58yn0NbQ67O7fzcDAAskACAAIAAoAgQgAWoiAUEHcTYCBCAAIAAoAgAgAUEDdmo2AgALCwAgAEEANgIAIAALKwAgAEEFNgIAIAAgACgCBEEBajYCBEEEEA8iAEEFNgIAIABBjAhBABAOAAtwAQN/AkAgAUUNACAAKAIIIgNFDQADQCADKAIQIQQgAygCACIFBEAgBRBACyADEEAgBCIDDQALCyAAQgA3AwggACACOgAEIAAgATYCACAAKAIQRQRAIABBgIAEEEw2AhALIABBADoA6DEgAEEANgIUCx4AIABBADYACSAAQQE6AAggAEIANwIAIABBADoADQsXACAAIAE2AhQgAEEBOgAMIAAgAjYCEAssACAAQQE6AL0BIAAoAkwiAEGADjsBxDEgAEEBNgKoJSAAQcYxakHNADoAAAtEACABBEAgACAAKAJIQQEgAiADIAQgBSAGIAcgCBCWAToAvAEPCyAAIAAoAkxBACACIAMgBCAFIAYgByAIEJYBOgC9AQsWACABIAAoAhw2AgAgAiAAKAIYNgIAC6cBAQN/IABBGGoQ3AEhAiAAQagyakEAOgAAIABBoDJqQgA3AwAgAEIANwOYMiAAQQA2AhAgAEIANwMIIABBADoABCAAQQA2AgBBgKsJQQA2AgBBIUGAgAQQASEBQYCrCSgCACEDQYCrCUEANgIAIANBAUcEQCAAQQA6AOgxIABBADYCFCAAIAE2AhAgAA8LEAIhARAAGiAAQZgyahBTIAIQeRogARAEAAshACABBEAgACABNgI0CyACBEAgACACNgI4CyAAQX82AlALiwEBAX8jAEEwayICJAAgAiABQRl2QdAAajYCFCACIAFBEHZBH3E2AgwgAiABQQt2QR9xNgIIIAIgAUEFdkE/cTYCBCACIAFBAXRBPnE2AgAgAkF/NgIgIAIgAUEVdkEPcUEBazYCECAAIAIQkAKtQoCU69wDfkKAgNicy56hs94AfTcDACACQTBqJAALkwEBBn8jAEEQayIBJAAgASAAKQMAQoCA2JzLnqGz3gB8QoCU69wDgD4CDCABQQxqEI8CIgAoAgwhAiAAKAIUIQMgACgCECEEIAAoAgghBSAAKAIEIQYgACgCACEAIAFBEGokACAEQRV0QYCAgAFqIANBGXRBgICAgAZqIAJBEHRyciAFQQt0ciAGQQV0ciAAQQF2cgsLACAAKQMAQuQAgAsdACAAIAGtQoCU69wDfkKAgNicy56hs94AfTcDAAuGAQECfyMAQTBrIgIkACACIAEoAhQ2AgAgAiABKAIQNgIEIAIgASgCDDYCCCACIAEoAgg2AgwgAiABKAIEQQFrNgIQIAEoAgAhAyACQX82AiAgAiADQewOazYCFCAAIAIQkAKtQoCU69wDfiABNQIYfEKAgNicy56hs94AfTcDACACQTBqJAALEQAgACABIAIgA0EAQQAQ2AEL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dHJpbmcAaW5mAHVucFNpemUAcGFja1NpemUAUmFyQXJjaGl2ZQBzdGF0ZQBTdGF0ZQBlcnJUeXBlAHRpbWUAbmFtZQByZWFkRmlsZQBkb3VibGUAZXJyQ29kZQBtZXRob2QAdm9pZAB0ZXJtaW5hdGVfaGFuZGxlciB1bmV4cGVjdGVkbHkgcmV0dXJuZWQAY3JjAHN0ZDo6YmFkX2FsbG9jACUlJXMlcyVzJXMlcyouKiVjJWMAUE9TSVgAU0VUAEVSUl9QUk9DRVNTAGhvc3RPUwBDVVIATkFOAExDX0FMTABMQU5HAElORgBFTkQAQwBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzxzaG9ydD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8dW5zaWduZWQgc2hvcnQ+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PGludD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8dW5zaWduZWQgaW50PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzxmbG9hdD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8dWludDhfdD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8aW50OF90PgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzx1aW50MTZfdD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8aW50MTZfdD4AZW1zY3JpcHRlbjo6bWVtb3J5X3ZpZXc8dWludDMyX3Q+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PGludDMyX3Q+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PGNoYXI+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PHVuc2lnbmVkIGNoYXI+AHN0ZDo6YmFzaWNfc3RyaW5nPHVuc2lnbmVkIGNoYXI+AGVtc2NyaXB0ZW46Om1lbW9yeV92aWV3PHNpZ25lZCBjaGFyPgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzxsb25nPgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzx1bnNpZ25lZCBsb25nPgBlbXNjcmlwdGVuOjptZW1vcnlfdmlldzxkb3VibGU+AEMuVVRGLTgAMAAuAC0AKwAobnVsbCkAIwAgADEwUmFyQXJjaGl2ZQBkPQAAsxYAAFAxMFJhckFyY2hpdmUAAADoPQAAyBYAAAAAAADAFgAAUEsxMFJhckFyY2hpdmUAAOg9AADoFgAAAQAAAMAWAABpaQB2AHZpANgWAEGgLguCCEAXAADYFgAAiBcAAIgXAABsPAAAOUFyY0hlYWRlcgAAZD0AADQXAABOU3QzX18yMTJiYXNpY19zdHJpbmdJd05TXzExY2hhcl90cmFpdHNJd0VFTlNfOWFsbG9jYXRvckl3RUVFRQAAZD0AAEgXAABpaWlpaWkAALAXAADYFgAAMTNBcmNGaWxlSGVhZGVyAGQ9AACgFwAAaWlpANAXAADYFgAAbDwAADVTdGF0ZQAAZD0AAMgXAABpaWlpAGkAdmlpaQBOU3QzX18yMTJiYXNpY19zdHJpbmdJY05TXzExY2hhcl90cmFpdHNJY0VFTlNfOWFsbG9jYXRvckljRUVFRQAAZD0AAOQXAABkaWkAdmlpZAAAAAAAAAAAaBgAAMQAAADFAAAAxgAAABIAAACDAAAAxwAAAMgAAAA8AAAANEZpbGUAAABkPQAAYBgAAE5TdDNfXzIxMmJhc2ljX3N0cmluZ0loTlNfMTFjaGFyX3RyYWl0c0loRUVOU185YWxsb2NhdG9ySWhFRUVFAABkPQAAcBgAAE5TdDNfXzIxMmJhc2ljX3N0cmluZ0lEc05TXzExY2hhcl90cmFpdHNJRHNFRU5TXzlhbGxvY2F0b3JJRHNFRUVFAAAAZD0AALgYAABOU3QzX18yMTJiYXNpY19zdHJpbmdJRGlOU18xMWNoYXJfdHJhaXRzSURpRUVOU185YWxsb2NhdG9ySURpRUVFRQAAAGQ9AAAEGQAATjEwZW1zY3JpcHRlbjN2YWxFAABkPQAAUBkAAE4xMGVtc2NyaXB0ZW4xMW1lbW9yeV92aWV3SWNFRQAAZD0AAGwZAABOMTBlbXNjcmlwdGVuMTFtZW1vcnlfdmlld0lhRUUAAGQ9AACUGQAATjEwZW1zY3JpcHRlbjExbWVtb3J5X3ZpZXdJaEVFAABkPQAAvBkAAE4xMGVtc2NyaXB0ZW4xMW1lbW9yeV92aWV3SXNFRQAAZD0AAOQZAABOMTBlbXNjcmlwdGVuMTFtZW1vcnlfdmlld0l0RUUAAGQ9AAAMGgAATjEwZW1zY3JpcHRlbjExbWVtb3J5X3ZpZXdJaUVFAABk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KysrKysrKysrKysrzUbNKwAlKwcBBgFVVlZWVlZVVlYCJIGBgYGBFYGBgQAAKwCy0bLRstGy0QAAzcwBANfX19fXg4GBgYGBgYGBgYGsrKysrKysrKysHAAAAAAAMVAxUDFQMVAxUDECAAAxUDFQMVAxUDFQMVAxUDFQMVBOMVAxUE4xUDFQMVAxUDFQMVAxUDECh6aHpoemh6aHpoemh6aHpiorKysrKysrKysrKysAAABUVlZWVlZWVlZWVlZWAEHTzQALIVRWVlZWVlZWVlZWVlYMAAwqKysrKysrKysrKysrKwcqAQBBqc4AC3cqKysrKysrKysrKysrKysrKysrKysrKysrKytWVmyBFQArKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysHbANBKytWVlZWVlZWVlZWVlZWVixWKysrKysrKysrKysrKysrKysrKysrAQBByM8ACwgMbAAAAAAABgBB9s8AC+gCBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBiVWep4mBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBiUGJQYlBgErK09WViwrf1ZWOSsrVVZWKytPVlYsK39WVoE3dVt7XCsrT1ZWAqwEAAA5KytVVlYrK09WViwrK1ZWMhOBVwBvgX7J134tgYEOfjl/b1cAgYF+FQB+AysrKysrKysrKysrKwcrJCuXKysrKysrKysrKisrKysrVlZWVlaAgYGBgTm7KisrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysBgYGBgYGBgYGBgYGBgYGByaysrKysrKysrKysrKysrNANAE4xArTBwdfXJFAxUDFQMVAxUDFQMVAxUDFQMVAxUDFQMVAxUDFQMVAxUNfXU8FH1NfX1wUrKysrKysrKysrKysHAQABAEG50wALH04xUDFQMVAxUDFQMVAxUA0AAAAAACRQMVAxUDFQMVAAQfrTAAtWKysrKysrKysrKyt5XHtce097XHtce1x7XHtce1x7XHtce1x7XC0rK3kUXHtcLXkqXCdce1x7XHukAAq0XHtce08DKisrKysrKysrKysrKysrKysrKwEAQevUAAsBSABB9dQACxsqKysrKysrKysrKysrKysrKysrKysrKysrKysAQbHVAAsUKysrKysrKysHAEhWVlZWVlZWVgIAQfzVAAsbKysrKysrKysrKysrK1VWVlZWVlZWVlZWVlYOAEG21gALGiQrKysrKysrKysrKwcAVlZWVlZWVlZWVlZWAEH81gALJyQrKysrKysrKysrKysrKysrBwAAAABWVlZWVlZWVlZWVlZWVlZWVgBB3dcACxYqKysrKysrKysrK1ZWVlZWVlZWVlYOAEGT2AALFiorKysrKysrKysrVlZWVlZWVlZWVg4AQdTYAAsXKysrKysrKysrKytVVlZWVlZWVlZWVg4AQbHZAAsFBidRb3cAQcDZAAsSfAAAfwAAAAAAAAAAg46SlwCqAEHc2QALArTEAEHW2gALBsbJAAAA2wBBr9sACw7eAAAAAOEAAAAAAAAA5ABByNsACwHnAEGe3AALAeoAQZndAAsB7QBBsN0AC0EZAAoAGRkZAAAAAAUAAAAAAAAJAAAAAAsAAAAAAAAAABkAEQoZGRkDCgcAAQAJCxgAAAkGCwAACwAGGQAAABkZGQBBgd4ACyEOAAAAAAAAAAAZAAoNGRkZAA0AAAIACQ4AAAAJAA4AAA4AQbveAAsBDABBx94ACxUTAAAAABMAAAAACQwAAAAAAAwAAAwAQfXeAAsBEABBgd8ACxUPAAAABA8AAAAACRAAAAAAABAAABAAQa/fAAsBEgBBu98ACx4RAAAAABEAAAAACRIAAAAAABIAABIAABoAAAAaGhoAQfLfAAsOGgAAABoaGgAAAAAAAAkAQaPgAAsBFABBr+AACxUXAAAAABcAAAAACRQAAAAAABQAABQAQd3gAAsBFgBB6eAAC98PFQAAAAAVAAAAAAkWAAAAAAAWAAAWAAAwMTIzNDU2Nzg5QUJDREVGTm8gZXJyb3IgaW5mb3JtYXRpb24ASWxsZWdhbCBieXRlIHNlcXVlbmNlAERvbWFpbiBlcnJvcgBSZXN1bHQgbm90IHJlcHJlc2VudGFibGUATm90IGEgdHR5AFBlcm1pc3Npb24gZGVuaWVkAE9wZXJhdGlvbiBub3QgcGVybWl0dGVkAE5vIHN1Y2ggZmlsZSBvciBkaXJlY3RvcnkATm8gc3VjaCBwcm9jZXNzAEZpbGUgZXhpc3RzAFZhbHVlIHRvbyBsYXJnZSBmb3IgZGF0YSB0eXBlAE5vIHNwYWNlIGxlZnQgb24gZGV2aWNlAE91dCBvZiBtZW1vcnkAUmVzb3VyY2UgYnVzeQBJbnRlcnJ1cHRlZCBzeXN0ZW0gY2FsbABSZXNvdXJjZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZQBJbnZhbGlkIHNlZWsAQ3Jvc3MtZGV2aWNlIGxpbmsAUmVhZC1vbmx5IGZpbGUgc3lzdGVtAERpcmVjdG9yeSBub3QgZW1wdHkAQ29ubmVjdGlvbiByZXNldCBieSBwZWVyAE9wZXJhdGlvbiB0aW1lZCBvdXQAQ29ubmVjdGlvbiByZWZ1c2VkAEhvc3QgaXMgZG93bgBIb3N0IGlzIHVucmVhY2hhYmxlAEFkZHJlc3MgaW4gdXNlAEJyb2tlbiBwaXBlAEkvTyBlcnJvcgBObyBzdWNoIGRldmljZSBvciBhZGRyZXNzAEJsb2NrIGRldmljZSByZXF1aXJlZABObyBzdWNoIGRldmljZQBOb3QgYSBkaXJlY3RvcnkASXMgYSBkaXJlY3RvcnkAVGV4dCBmaWxlIGJ1c3kARXhlYyBmb3JtYXQgZXJyb3IASW52YWxpZCBhcmd1bWVudABBcmd1bWVudCBsaXN0IHRvbyBsb25nAFN5bWJvbGljIGxpbmsgbG9vcABGaWxlbmFtZSB0b28gbG9uZwBUb28gbWFueSBvcGVuIGZpbGVzIGluIHN5c3RlbQBObyBmaWxlIGRlc2NyaXB0b3JzIGF2YWlsYWJsZQBCYWQgZmlsZSBkZXNjcmlwdG9yAE5vIGNoaWxkIHByb2Nlc3MAQmFkIGFkZHJlc3MARmlsZSB0b28gbGFyZ2UAVG9vIG1hbnkgbGlua3MATm8gbG9ja3MgYXZhaWxhYmxlAFJlc291cmNlIGRlYWRsb2NrIHdvdWxkIG9jY3VyAFN0YXRlIG5vdCByZWNvdmVyYWJsZQBQcmV2aW91cyBvd25lciBkaWVkAE9wZXJhdGlvbiBjYW5jZWxlZABGdW5jdGlvbiBub3QgaW1wbGVtZW50ZWQATm8gbWVzc2FnZSBvZiBkZXNpcmVkIHR5cGUASWRlbnRpZmllciByZW1vdmVkAERldmljZSBub3QgYSBzdHJlYW0ATm8gZGF0YSBhdmFpbGFibGUARGV2aWNlIHRpbWVvdXQAT3V0IG9mIHN0cmVhbXMgcmVzb3VyY2VzAExpbmsgaGFzIGJlZW4gc2V2ZXJlZABQcm90b2NvbCBlcnJvcgBCYWQgbWVzc2FnZQBGaWxlIGRlc2NyaXB0b3IgaW4gYmFkIHN0YXRlAE5vdCBhIHNvY2tldABEZXN0aW5hdGlvbiBhZGRyZXNzIHJlcXVpcmVkAE1lc3NhZ2UgdG9vIGxhcmdlAFByb3RvY29sIHdyb25nIHR5cGUgZm9yIHNvY2tldABQcm90b2NvbCBub3QgYXZhaWxhYmxlAFByb3RvY29sIG5vdCBzdXBwb3J0ZWQAU29ja2V0IHR5cGUgbm90IHN1cHBvcnRlZABOb3Qgc3VwcG9ydGVkAFByb3RvY29sIGZhbWlseSBub3Qgc3VwcG9ydGVkAEFkZHJlc3MgZmFtaWx5IG5vdCBzdXBwb3J0ZWQgYnkgcHJvdG9jb2wAQWRkcmVzcyBub3QgYXZhaWxhYmxlAE5ldHdvcmsgaXMgZG93bgBOZXR3b3JrIHVucmVhY2hhYmxlAENvbm5lY3Rpb24gcmVzZXQgYnkgbmV0d29yawBDb25uZWN0aW9uIGFib3J0ZWQATm8gYnVmZmVyIHNwYWNlIGF2YWlsYWJsZQBTb2NrZXQgaXMgY29ubmVjdGVkAFNvY2tldCBub3QgY29ubmVjdGVkAENhbm5vdCBzZW5kIGFmdGVyIHNvY2tldCBzaHV0ZG93bgBPcGVyYXRpb24gYWxyZWFkeSBpbiBwcm9ncmVzcwBPcGVyYXRpb24gaW4gcHJvZ3Jlc3MAU3RhbGUgZmlsZSBoYW5kbGUAUmVtb3RlIEkvTyBlcnJvcgBRdW90YSBleGNlZWRlZABObyBtZWRpdW0gZm91bmQAV3JvbmcgbWVkaXVtIHR5cGUATXVsdGlob3AgYXR0ZW1wdGVkAAAAAAClAlsA8AG1BYwFJQGDBh0DlAT/AMcDMQMLBrwBjwF/A8oEKwDaBq8AQgNOA9wBDgQVAKEGDQGUAgsCOAZkArwC/wJdA+cECwfPAssF7wXbBeECHgZFAoUAggJsA28E8QDzAxgF2QDaA0wGVAJ7AZ0DvQQAAFEAFQK7ALMDbQD/AYUELwX5BDgAZQFGAZ8AtwaoAXMCUwEAQfjwAAsMIQQAAAAAAAAAAC8CAEGY8QALBjUERwRWBABBrvEACwKgBABBwvEAC39GBWAFbgVhBgAAzwEAAAAAAAAAAMkG6Qb5BgAAAABMAABqTExMAGoAAAAAAGpqAAAAAGoAAGoAAAAAAAAAABkACgAZGRkAAAAABQAAAAAAAAkAAAAACwAAAAAAAAAAGQARChkZGQMKBwABGwkLGAAACQYLAAALAAYZAAAAGRkZAEHR8gALIQ4AAAAAAAAAABkACg0ZGRkADQAAAgAJDgAAAAkADgAADgBBi/MACwEMAEGX8wALFRMAAAAAEwAAAAAJDAAAAAAADAAADABBxfMACwEQAEHR8wALFQ8AAAAEDwAAAAAJEAAAAAAAEAAAEABB//MACwESAEGL9AALHhEAAAAAEQAAAAAJEgAAAAAAEgAAEgAAGgAAABoaGgBBwvQACw4aAAAAGhoaAAAAAAAACQBB8/QACwEUAEH/9AALFRcAAAAAFwAAAAAJFAAAAAAAFAAAFABBrfUACwEWAEG59QAL0QgVAAAAABUAAAAACRYAAAAAABYAABYAAE4xMF9fY3h4YWJpdjExNl9fc2hpbV90eXBlX2luZm9FAAAAAIw9AADQOgAABD8AAE4xMF9fY3h4YWJpdjExN19fY2xhc3NfdHlwZV9pbmZvRQAAAIw9AAAAOwAA9DoAAE4xMF9fY3h4YWJpdjExN19fcGJhc2VfdHlwZV9pbmZvRQAAAIw9AAAwOwAA9DoAAE4xMF9fY3h4YWJpdjExOV9fcG9pbnRlcl90eXBlX2luZm9FAIw9AABgOwAAVDsAAE4xMF9fY3h4YWJpdjEyMF9fZnVuY3Rpb25fdHlwZV9pbmZvRQAAAACMPQAAkDsAAPQ6AABOMTBfX2N4eGFiaXYxMjlfX3BvaW50ZXJfdG9fbWVtYmVyX3R5cGVfaW5mb0UAAACMPQAAxDsAAFQ7AAAAAAAARDwAANMAAADUAAAA1QAAANYAAADXAAAATjEwX19jeHhhYml2MTIzX19mdW5kYW1lbnRhbF90eXBlX2luZm9FAIw9AAAcPAAA9DoAAHYAAAAIPAAAUDwAAERuAAAIPAAAXDwAAGIAAAAIPAAAaDwAAGMAAAAIPAAAdDwAAGgAAAAIPAAAgDwAAGEAAAAIPAAAjDwAAHMAAAAIPAAAmDwAAHQAAAAIPAAApDwAAGkAAAAIPAAAsDwAAGoAAAAIPAAAvDwAAGwAAAAIPAAAyDwAAG0AAAAIPAAA1DwAAHgAAAAIPAAA4DwAAHkAAAAIPAAA7DwAAGYAAAAIPAAA+DwAAGQAAAAIPAAABD0AAAAAAABQPQAA0wAAANgAAADVAAAA1gAAANkAAABOMTBfX2N4eGFiaXYxMTZfX2VudW1fdHlwZV9pbmZvRQAAAACMPQAALD0AAPQ6AAAAAAAAJDsAANMAAADaAAAA1QAAANYAAADbAAAA3AAAAN0AAADeAAAAAAAAANQ9AADTAAAA3wAAANUAAADWAAAA2wAAAOAAAADhAAAA4gAAAE4xMF9fY3h4YWJpdjEyMF9fc2lfY2xhc3NfdHlwZV9pbmZvRQAAAACMPQAArD0AACQ7AAAAAAAAhDsAANMAAADjAAAA1QAAANYAAADkAAAAAAAAAHg+AACHAAAA5QAAAOYAAAAAAAAAhD4AAIcAAADnAAAA6AAAAAAAAABIPgAAhwAAAOkAAADqAAAAU3Q5ZXhjZXB0aW9uAAAAAGQ9AAA4PgAAU3QyMGJhZF9hcnJheV9uZXdfbGVuZ3RoAFN0OWJhZF9hbGxvYwAAAIw9AABpPgAASD4AAIw9AABQPgAAeD4AAAAAAAC0PgAAwgAAAOsAAADsAAAAU3QxMWxvZ2ljX2Vycm9yAIw9AACkPgAASD4AAAAAAADoPgAAwgAAAO0AAADsAAAAU3QxMmxlbmd0aF9lcnJvcgAAAACMPQAA1D4AALQ+AABTdDl0eXBlX2luZm8AAAAAZD0AAPQ+AEGM/gALDf//////AQAAkFVSANE=";
function _b64U8(s){var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
var _mods={},_cache={};
function _mreq(n){if(_cache[n])return _cache[n].exports;if(!_mods[n])throw new Error("Module not found: "+n);var m={exports:{}};_cache[n]=m;_mods[n](m,m.exports,_mreq);return m.exports;}
_mods["fs-stub"]={exports:{existsSync:function(){return false;}}};
_mods["path-stub"]={exports:{join:function(){return Array.prototype.slice.call(arguments).join("/");}}};
_mods["unrar"]=function(module,exports,require){

var Module = (() => {
  var _scriptDir = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : undefined;
  if (typeof __filename !== 'undefined') _scriptDir = _scriptDir || __filename;
  return (
function(Module) {
  Module = Module || {};

var Module=typeof Module!="undefined"?Module:{};var readyPromiseResolve,readyPromiseReject;Module["ready"]=new Promise(function(resolve,reject){readyPromiseResolve=resolve;readyPromiseReject=reject});var moduleOverrides=Object.assign({},Module);var arguments_=[];var thisProgram="./this.program";var quit_=(status,toThrow)=>{throw toThrow};var ENVIRONMENT_IS_WEB=true;var ENVIRONMENT_IS_WORKER=false;var ENVIRONMENT_IS_NODE=false;var scriptDirectory="";function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;function logExceptionOnExit(e){if(e instanceof ExitStatus)return;let toLog=e;err("exiting due to exception: "+toLog)}var fs;var nodePath;var requireNodeFS;var read_,readAsync,readBinary;var out=Module["print"]||console.log.bind(console);var err=Module["printErr"]||console.warn.bind(console);Object.assign(Module,moduleOverrides);moduleOverrides=null;if(Module["arguments"])arguments_=Module["arguments"];if(Module["thisProgram"])thisProgram=Module["thisProgram"];if(Module["quit"])quit_=Module["quit"];var tempRet0=0;var setTempRet0=value=>{tempRet0=value};var getTempRet0=()=>tempRet0;var wasmBinary;if(Module["wasmBinary"])wasmBinary=Module["wasmBinary"]; else { wasmBinary=_b64U8(_wasmB64); }var noExitRuntime=Module["noExitRuntime"]||true;if(typeof WebAssembly!="object"){abort("no native wasm support detected")}var wasmMemory;var ABORT=false;var EXITSTATUS;function assert(condition,text){if(!condition){abort(text)}}var UTF8Decoder=typeof TextDecoder!="undefined"?new TextDecoder("utf8"):undefined;function UTF8ArrayToString(heapOrArray,idx,maxBytesToRead){var endIdx=idx+maxBytesToRead;var endPtr=idx;while(heapOrArray[endPtr]&&!(endPtr>=endIdx))++endPtr;if(endPtr-idx>16&&heapOrArray.buffer&&UTF8Decoder){return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr))}else{var str="";while(idx<endPtr){var u0=heapOrArray[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heapOrArray[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heapOrArray[idx++]&63;if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2}else{u0=(u0&7)<<18|u1<<12|u2<<6|heapOrArray[idx++]&63}if(u0<65536){str+=String.fromCharCode(u0)}else{var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}}}return str}function UTF8ToString(ptr,maxBytesToRead){return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):""}function stringToUTF8Array(str,heap,outIdx,maxBytesToWrite){if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343){var u1=str.charCodeAt(++i);u=65536+((u&1023)<<10)|u1&1023}if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63}else{if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63}}heap[outIdx]=0;return outIdx-startIdx}function stringToUTF8(str,outPtr,maxBytesToWrite){return stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite)}function lengthBytesUTF8(str){var len=0;for(var i=0;i<str.length;++i){var u=str.charCodeAt(i);if(u>=55296&&u<=57343)u=65536+((u&1023)<<10)|str.charCodeAt(++i)&1023;if(u<=127)++len;else if(u<=2047)len+=2;else if(u<=65535)len+=3;else len+=4}return len}var UTF16Decoder=typeof TextDecoder!="undefined"?new TextDecoder("utf-16le"):undefined;function UTF16ToString(ptr,maxBytesToRead){var endPtr=ptr;var idx=endPtr>>1;var maxIdx=idx+maxBytesToRead/2;while(!(idx>=maxIdx)&&HEAPU16[idx])++idx;endPtr=idx<<1;if(endPtr-ptr>32&&UTF16Decoder){return UTF16Decoder.decode(HEAPU8.subarray(ptr,endPtr))}else{var str="";for(var i=0;!(i>=maxBytesToRead/2);++i){var codeUnit=HEAP16[ptr+i*2>>1];if(codeUnit==0)break;str+=String.fromCharCode(codeUnit)}return str}}function stringToUTF16(str,outPtr,maxBytesToWrite){if(maxBytesToWrite===undefined){maxBytesToWrite=2147483647}if(maxBytesToWrite<2)return 0;maxBytesToWrite-=2;var startPtr=outPtr;var numCharsToWrite=maxBytesToWrite<str.length*2?maxBytesToWrite/2:str.length;for(var i=0;i<numCharsToWrite;++i){var codeUnit=str.charCodeAt(i);HEAP16[outPtr>>1]=codeUnit;outPtr+=2}HEAP16[outPtr>>1]=0;return outPtr-startPtr}function lengthBytesUTF16(str){return str.length*2}function UTF32ToString(ptr,maxBytesToRead){var i=0;var str="";while(!(i>=maxBytesToRead/4)){var utf32=HEAP32[ptr+i*4>>2];if(utf32==0)break;++i;if(utf32>=65536){var ch=utf32-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}else{str+=String.fromCharCode(utf32)}}return str}function stringToUTF32(str,outPtr,maxBytesToWrite){if(maxBytesToWrite===undefined){maxBytesToWrite=2147483647}if(maxBytesToWrite<4)return 0;var startPtr=outPtr;var endPtr=startPtr+maxBytesToWrite-4;for(var i=0;i<str.length;++i){var codeUnit=str.charCodeAt(i);if(codeUnit>=55296&&codeUnit<=57343){var trailSurrogate=str.charCodeAt(++i);codeUnit=65536+((codeUnit&1023)<<10)|trailSurrogate&1023}HEAP32[outPtr>>2]=codeUnit;outPtr+=4;if(outPtr+4>endPtr)break}HEAP32[outPtr>>2]=0;return outPtr-startPtr}function lengthBytesUTF32(str){var len=0;for(var i=0;i<str.length;++i){var codeUnit=str.charCodeAt(i);if(codeUnit>=55296&&codeUnit<=57343)++i;len+=4}return len}function allocateUTF8(str){var size=lengthBytesUTF8(str)+1;var ret=_malloc(size);if(ret)stringToUTF8Array(str,HEAP8,ret,size);return ret}function writeAsciiToMemory(str,buffer,dontAddNull){for(var i=0;i<str.length;++i){HEAP8[buffer++>>0]=str.charCodeAt(i)}if(!dontAddNull)HEAP8[buffer>>0]=0}var buffer,HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64;function updateGlobalBufferAndViews(buf){buffer=buf;Module["HEAP8"]=HEAP8=new Int8Array(buf);Module["HEAP16"]=HEAP16=new Int16Array(buf);Module["HEAP32"]=HEAP32=new Int32Array(buf);Module["HEAPU8"]=HEAPU8=new Uint8Array(buf);Module["HEAPU16"]=HEAPU16=new Uint16Array(buf);Module["HEAPU32"]=HEAPU32=new Uint32Array(buf);Module["HEAPF32"]=HEAPF32=new Float32Array(buf);Module["HEAPF64"]=HEAPF64=new Float64Array(buf)}var INITIAL_MEMORY=Module["INITIAL_MEMORY"]||16777216;var wasmTable;var __ATPRERUN__=[];var __ATINIT__=[];var __ATPOSTRUN__=[];var runtimeInitialized=false;function keepRuntimeAlive(){return noExitRuntime}function preRun(){if(Module["preRun"]){if(typeof Module["preRun"]=="function")Module["preRun"]=[Module["preRun"]];while(Module["preRun"].length){addOnPreRun(Module["preRun"].shift())}}callRuntimeCallbacks(__ATPRERUN__)}function initRuntime(){runtimeInitialized=true;callRuntimeCallbacks(__ATINIT__)}function postRun(){if(Module["postRun"]){if(typeof Module["postRun"]=="function")Module["postRun"]=[Module["postRun"]];while(Module["postRun"].length){addOnPostRun(Module["postRun"].shift())}}callRuntimeCallbacks(__ATPOSTRUN__)}function addOnPreRun(cb){__ATPRERUN__.unshift(cb)}function addOnInit(cb){__ATINIT__.unshift(cb)}function addOnPostRun(cb){__ATPOSTRUN__.unshift(cb)}var runDependencies=0;var runDependencyWatcher=null;var dependenciesFulfilled=null;function addRunDependency(id){runDependencies++;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies)}}function removeRunDependency(id){runDependencies--;if(Module["monitorRunDependencies"]){Module["monitorRunDependencies"](runDependencies)}if(runDependencies==0){if(runDependencyWatcher!==null){clearInterval(runDependencyWatcher);runDependencyWatcher=null}if(dependenciesFulfilled){var callback=dependenciesFulfilled;dependenciesFulfilled=null;callback()}}}function abort(what){{if(Module["onAbort"]){Module["onAbort"](what)}}what="Aborted("+what+")";err(what);ABORT=true;EXITSTATUS=1;what+=". Build with -sASSERTIONS for more info.";var e=new WebAssembly.RuntimeError(what);readyPromiseReject(e);throw e}var dataURIPrefix="data:application/octet-stream;base64,";function isDataURI(filename){return filename.startsWith(dataURIPrefix)}var wasmBinaryFile;wasmBinaryFile="unrar.wasm";if(!isDataURI(wasmBinaryFile)){wasmBinaryFile=locateFile(wasmBinaryFile)}function getBinary(file){try{if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}if(readBinary){return readBinary(file)}else{throw"both async and sync fetching of the wasm failed"}}catch(err){abort(err)}}function getBinaryPromise(){if(!wasmBinary&&(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER)){if(typeof fetch=="function"){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){if(!response["ok"]){throw"failed to load wasm binary file at '"+wasmBinaryFile+"'"}return response["arrayBuffer"]()}).catch(function(){return getBinary(wasmBinaryFile)})}}return Promise.resolve().then(function(){return getBinary(wasmBinaryFile)})}function createWasm(){var info={"a":asmLibraryArg};function receiveInstance(instance,module){var exports=instance.exports;Module["asm"]=exports;wasmMemory=Module["asm"]["ka"];updateGlobalBufferAndViews(wasmMemory.buffer);wasmTable=Module["asm"]["oa"];addOnInit(Module["asm"]["la"]);removeRunDependency("wasm-instantiate")}addRunDependency("wasm-instantiate");function receiveInstantiationResult(result){receiveInstance(result["instance"])}function instantiateArrayBuffer(receiver){return getBinaryPromise().then(function(binary){return WebAssembly.instantiate(binary,info)}).then(function(instance){return instance}).then(receiver,function(reason){err("failed to asynchronously prepare wasm: "+reason);abort(reason)})}function instantiateAsync(){if(!wasmBinary&&typeof WebAssembly.instantiateStreaming=="function"&&!isDataURI(wasmBinaryFile)&&!ENVIRONMENT_IS_NODE&&typeof fetch=="function"){return fetch(wasmBinaryFile,{credentials:"same-origin"}).then(function(response){var result=WebAssembly.instantiateStreaming(response,info);return result.then(receiveInstantiationResult,function(reason){err("wasm streaming compile failed: "+reason);err("falling back to ArrayBuffer instantiation");return instantiateArrayBuffer(receiveInstantiationResult)})})}else{return instantiateArrayBuffer(receiveInstantiationResult)}}if(Module["instantiateWasm"]){try{var exports=Module["instantiateWasm"](info,receiveInstance);return exports}catch(e){err("Module.instantiateWasm callback failed with error: "+e);return false}}instantiateAsync().catch(readyPromiseReject);return{}}function callRuntimeCallbacks(callbacks){while(callbacks.length>0){var callback=callbacks.shift();if(typeof callback=="function"){callback(Module);continue}var func=callback.func;if(typeof func=="number"){if(callback.arg===undefined){getWasmTableEntry(func)()}else{getWasmTableEntry(func)(callback.arg)}}else{func(callback.arg===undefined?null:callback.arg)}}}var wasmTableMirror=[];function getWasmTableEntry(funcPtr){var func=wasmTableMirror[funcPtr];if(!func){if(funcPtr>=wasmTableMirror.length)wasmTableMirror.length=funcPtr+1;wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr)}return func}function ___cxa_allocate_exception(size){return _malloc(size+24)+24}var exceptionCaught=[];function exception_addRef(info){info.add_ref()}var uncaughtExceptionCount=0;function ___cxa_begin_catch(ptr){var info=new ExceptionInfo(ptr);if(!info.get_caught()){info.set_caught(true);uncaughtExceptionCount--}info.set_rethrown(false);exceptionCaught.push(info);exception_addRef(info);return info.get_exception_ptr()}var exceptionLast=0;function ExceptionInfo(excPtr){this.excPtr=excPtr;this.ptr=excPtr-24;this.set_type=function(type){HEAPU32[this.ptr+4>>2]=type};this.get_type=function(){return HEAPU32[this.ptr+4>>2]};this.set_destructor=function(destructor){HEAPU32[this.ptr+8>>2]=destructor};this.get_destructor=function(){return HEAPU32[this.ptr+8>>2]};this.set_refcount=function(refcount){HEAP32[this.ptr>>2]=refcount};this.set_caught=function(caught){caught=caught?1:0;HEAP8[this.ptr+12>>0]=caught};this.get_caught=function(){return HEAP8[this.ptr+12>>0]!=0};this.set_rethrown=function(rethrown){rethrown=rethrown?1:0;HEAP8[this.ptr+13>>0]=rethrown};this.get_rethrown=function(){return HEAP8[this.ptr+13>>0]!=0};this.init=function(type,destructor){this.set_adjusted_ptr(0);this.set_type(type);this.set_destructor(destructor);this.set_refcount(0);this.set_caught(false);this.set_rethrown(false)};this.add_ref=function(){var value=HEAP32[this.ptr>>2];HEAP32[this.ptr>>2]=value+1};this.release_ref=function(){var prev=HEAP32[this.ptr>>2];HEAP32[this.ptr>>2]=prev-1;return prev===1};this.set_adjusted_ptr=function(adjustedPtr){HEAPU32[this.ptr+16>>2]=adjustedPtr};this.get_adjusted_ptr=function(){return HEAPU32[this.ptr+16>>2]};this.get_exception_ptr=function(){var isPointer=___cxa_is_pointer_type(this.get_type());if(isPointer){return HEAPU32[this.excPtr>>2]}var adjusted=this.get_adjusted_ptr();if(adjusted!==0)return adjusted;return this.excPtr}}function ___cxa_free_exception(ptr){return _free(new ExceptionInfo(ptr).ptr)}function exception_decRef(info){if(info.release_ref()&&!info.get_rethrown()){var destructor=info.get_destructor();if(destructor){getWasmTableEntry(destructor)(info.excPtr)}___cxa_free_exception(info.excPtr)}}function ___cxa_end_catch(){_setThrew(0);var info=exceptionCaught.pop();exception_decRef(info);exceptionLast=0}function ___resumeException(ptr){if(!exceptionLast){exceptionLast=ptr}throw ptr}function ___cxa_find_matching_catch_2(){var thrown=exceptionLast;if(!thrown){setTempRet0(0);return 0}var info=new ExceptionInfo(thrown);info.set_adjusted_ptr(thrown);var thrownType=info.get_type();if(!thrownType){setTempRet0(0);return thrown}var typeArray=Array.prototype.slice.call(arguments);for(var i=0;i<typeArray.length;i++){var caughtType=typeArray[i];if(caughtType===0||caughtType===thrownType){break}var adjusted_ptr_addr=info.ptr+16;if(___cxa_can_catch(caughtType,thrownType,adjusted_ptr_addr)){setTempRet0(caughtType);return thrown}}setTempRet0(thrownType);return thrown}function ___cxa_find_matching_catch_3(){var thrown=exceptionLast;if(!thrown){setTempRet0(0);return 0}var info=new ExceptionInfo(thrown);info.set_adjusted_ptr(thrown);var thrownType=info.get_type();if(!thrownType){setTempRet0(0);return thrown}var typeArray=Array.prototype.slice.call(arguments);for(var i=0;i<typeArray.length;i++){var caughtType=typeArray[i];if(caughtType===0||caughtType===thrownType){break}var adjusted_ptr_addr=info.ptr+16;if(___cxa_can_catch(caughtType,thrownType,adjusted_ptr_addr)){setTempRet0(caughtType);return thrown}}setTempRet0(thrownType);return thrown}function ___cxa_find_matching_catch_4(){var thrown=exceptionLast;if(!thrown){setTempRet0(0);return 0}var info=new ExceptionInfo(thrown);info.set_adjusted_ptr(thrown);var thrownType=info.get_type();if(!thrownType){setTempRet0(0);return thrown}var typeArray=Array.prototype.slice.call(arguments);for(var i=0;i<typeArray.length;i++){var caughtType=typeArray[i];if(caughtType===0||caughtType===thrownType){break}var adjusted_ptr_addr=info.ptr+16;if(___cxa_can_catch(caughtType,thrownType,adjusted_ptr_addr)){setTempRet0(caughtType);return thrown}}setTempRet0(thrownType);return thrown}function ___cxa_throw(ptr,type,destructor){var info=new ExceptionInfo(ptr);info.init(type,destructor);exceptionLast=ptr;uncaughtExceptionCount++;throw ptr}var SYSCALLS={varargs:undefined,get:function(){SYSCALLS.varargs+=4;var ret=HEAP32[SYSCALLS.varargs-4>>2];return ret},getStr:function(ptr){var ret=UTF8ToString(ptr);return ret}};function ___syscall_fchownat(dirfd,path,owner,group,flags){}function ___syscall_symlink(target,linkpath){}var structRegistrations={};function runDestructors(destructors){while(destructors.length){var ptr=destructors.pop();var del=destructors.pop();del(ptr)}}function simpleReadValueFromPointer(pointer){return this["fromWireType"](HEAPU32[pointer>>2])}var awaitingDependencies={};var registeredTypes={};var typeDependencies={};var char_0=48;var char_9=57;function makeLegalFunctionName(name){if(undefined===name){return"_unknown"}name=name.replace(/[^a-zA-Z0-9_]/g,"$");var f=name.charCodeAt(0);if(f>=char_0&&f<=char_9){return"_"+name}return name}function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\n"+'    "use strict";'+"    return body.apply(this, arguments);\n"+"};\n")(body)}function extendError(baseErrorType,errorName){var errorClass=createNamedFunction(errorName,function(message){this.name=errorName;this.message=message;var stack=new Error(message).stack;if(stack!==undefined){this.stack=this.toString()+"\n"+stack.replace(/^Error(:[^\n]*)?\n/,"")}});errorClass.prototype=Object.create(baseErrorType.prototype);errorClass.prototype.constructor=errorClass;errorClass.prototype.toString=function(){if(this.message===undefined){return this.name}else{return this.name+": "+this.message}};return errorClass}var InternalError=undefined;function throwInternalError(message){throw new InternalError(message)}function whenDependentTypesAreResolved(myTypes,dependentTypes,getTypeConverters){myTypes.forEach(function(type){typeDependencies[type]=dependentTypes});function onComplete(typeConverters){var myTypeConverters=getTypeConverters(typeConverters);if(myTypeConverters.length!==myTypes.length){throwInternalError("Mismatched type converter count")}for(var i=0;i<myTypes.length;++i){registerType(myTypes[i],myTypeConverters[i])}}var typeConverters=new Array(dependentTypes.length);var unregisteredTypes=[];var registered=0;dependentTypes.forEach((dt,i)=>{if(registeredTypes.hasOwnProperty(dt)){typeConverters[i]=registeredTypes[dt]}else{unregisteredTypes.push(dt);if(!awaitingDependencies.hasOwnProperty(dt)){awaitingDependencies[dt]=[]}awaitingDependencies[dt].push(()=>{typeConverters[i]=registeredTypes[dt];++registered;if(registered===unregisteredTypes.length){onComplete(typeConverters)}})}});if(0===unregisteredTypes.length){onComplete(typeConverters)}}function __embind_finalize_value_object(structType){var reg=structRegistrations[structType];delete structRegistrations[structType];var rawConstructor=reg.rawConstructor;var rawDestructor=reg.rawDestructor;var fieldRecords=reg.fields;var fieldTypes=fieldRecords.map(field=>field.getterReturnType).concat(fieldRecords.map(field=>field.setterArgumentType));whenDependentTypesAreResolved([structType],fieldTypes,fieldTypes=>{var fields={};fieldRecords.forEach((field,i)=>{var fieldName=field.fieldName;var getterReturnType=fieldTypes[i];var getter=field.getter;var getterContext=field.getterContext;var setterArgumentType=fieldTypes[i+fieldRecords.length];var setter=field.setter;var setterContext=field.setterContext;fields[fieldName]={read:ptr=>{return getterReturnType["fromWireType"](getter(getterContext,ptr))},write:(ptr,o)=>{var destructors=[];setter(setterContext,ptr,setterArgumentType["toWireType"](destructors,o));runDestructors(destructors)}}});return[{name:reg.name,"fromWireType":function(ptr){var rv={};for(var i in fields){rv[i]=fields[i].read(ptr)}rawDestructor(ptr);return rv},"toWireType":function(destructors,o){for(var fieldName in fields){if(!(fieldName in o)){throw new TypeError('Missing field:  "'+fieldName+'"')}}var ptr=rawConstructor();for(fieldName in fields){fields[fieldName].write(ptr,o[fieldName])}if(destructors!==null){destructors.push(rawDestructor,ptr)}return ptr},"argPackAdvance":8,"readValueFromPointer":simpleReadValueFromPointer,destructorFunction:rawDestructor}]})}function __embind_register_bigint(primitiveType,name,size,minRange,maxRange){}function getShiftFromSize(size){switch(size){case 1:return 0;case 2:return 1;case 4:return 2;case 8:return 3;default:throw new TypeError("Unknown type size: "+size)}}function embind_init_charCodes(){var codes=new Array(256);for(var i=0;i<256;++i){codes[i]=String.fromCharCode(i)}embind_charCodes=codes}var embind_charCodes=undefined;function readLatin1String(ptr){var ret="";var c=ptr;while(HEAPU8[c]){ret+=embind_charCodes[HEAPU8[c++]]}return ret}var BindingError=undefined;function throwBindingError(message){throw new BindingError(message)}function registerType(rawType,registeredInstance,options={}){if(!("argPackAdvance"in registeredInstance)){throw new TypeError("registerType registeredInstance requires argPackAdvance")}var name=registeredInstance.name;if(!rawType){throwBindingError('type "'+name+'" must have a positive integer typeid pointer')}if(registeredTypes.hasOwnProperty(rawType)){if(options.ignoreDuplicateRegistrations){return}else{throwBindingError("Cannot register type '"+name+"' twice")}}registeredTypes[rawType]=registeredInstance;delete typeDependencies[rawType];if(awaitingDependencies.hasOwnProperty(rawType)){var callbacks=awaitingDependencies[rawType];delete awaitingDependencies[rawType];callbacks.forEach(cb=>cb())}}function __embind_register_bool(rawType,name,size,trueValue,falseValue){var shift=getShiftFromSize(size);name=readLatin1String(name);registerType(rawType,{name:name,"fromWireType":function(wt){return!!wt},"toWireType":function(destructors,o){return o?trueValue:falseValue},"argPackAdvance":8,"readValueFromPointer":function(pointer){var heap;if(size===1){heap=HEAP8}else if(size===2){heap=HEAP16}else if(size===4){heap=HEAP32}else{throw new TypeError("Unknown boolean type size: "+name)}return this["fromWireType"](heap[pointer>>shift])},destructorFunction:null})}function ClassHandle_isAliasOf(other){if(!(this instanceof ClassHandle)){return false}if(!(other instanceof ClassHandle)){return false}var leftClass=this.$$.ptrType.registeredClass;var left=this.$$.ptr;var rightClass=other.$$.ptrType.registeredClass;var right=other.$$.ptr;while(leftClass.baseClass){left=leftClass.upcast(left);leftClass=leftClass.baseClass}while(rightClass.baseClass){right=rightClass.upcast(right);rightClass=rightClass.baseClass}return leftClass===rightClass&&left===right}function shallowCopyInternalPointer(o){return{count:o.count,deleteScheduled:o.deleteScheduled,preservePointerOnDelete:o.preservePointerOnDelete,ptr:o.ptr,ptrType:o.ptrType,smartPtr:o.smartPtr,smartPtrType:o.smartPtrType}}function throwInstanceAlreadyDeleted(obj){function getInstanceTypeName(handle){return handle.$$.ptrType.registeredClass.name}throwBindingError(getInstanceTypeName(obj)+" instance already deleted")}var finalizationRegistry=false;function detachFinalizer(handle){}function runDestructor($$){if($$.smartPtr){$$.smartPtrType.rawDestructor($$.smartPtr)}else{$$.ptrType.registeredClass.rawDestructor($$.ptr)}}function releaseClassHandle($$){$$.count.value-=1;var toDelete=0===$$.count.value;if(toDelete){runDestructor($$)}}function downcastPointer(ptr,ptrClass,desiredClass){if(ptrClass===desiredClass){return ptr}if(undefined===desiredClass.baseClass){return null}var rv=downcastPointer(ptr,ptrClass,desiredClass.baseClass);if(rv===null){return null}return desiredClass.downcast(rv)}var registeredPointers={};function getInheritedInstanceCount(){return Object.keys(registeredInstances).length}function getLiveInheritedInstances(){var rv=[];for(var k in registeredInstances){if(registeredInstances.hasOwnProperty(k)){rv.push(registeredInstances[k])}}return rv}var deletionQueue=[];function flushPendingDeletes(){while(deletionQueue.length){var obj=deletionQueue.pop();obj.$$.deleteScheduled=false;obj["delete"]()}}var delayFunction=undefined;function setDelayFunction(fn){delayFunction=fn;if(deletionQueue.length&&delayFunction){delayFunction(flushPendingDeletes)}}function init_embind(){Module["getInheritedInstanceCount"]=getInheritedInstanceCount;Module["getLiveInheritedInstances"]=getLiveInheritedInstances;Module["flushPendingDeletes"]=flushPendingDeletes;Module["setDelayFunction"]=setDelayFunction}var registeredInstances={};function getBasestPointer(class_,ptr){if(ptr===undefined){throwBindingError("ptr should not be undefined")}while(class_.baseClass){ptr=class_.upcast(ptr);class_=class_.baseClass}return ptr}function getInheritedInstance(class_,ptr){ptr=getBasestPointer(class_,ptr);return registeredInstances[ptr]}function makeClassHandle(prototype,record){if(!record.ptrType||!record.ptr){throwInternalError("makeClassHandle requires ptr and ptrType")}var hasSmartPtrType=!!record.smartPtrType;var hasSmartPtr=!!record.smartPtr;if(hasSmartPtrType!==hasSmartPtr){throwInternalError("Both smartPtrType and smartPtr must be specified")}record.count={value:1};return attachFinalizer(Object.create(prototype,{$$:{value:record}}))}function RegisteredPointer_fromWireType(ptr){var rawPointer=this.getPointee(ptr);if(!rawPointer){this.destructor(ptr);return null}var registeredInstance=getInheritedInstance(this.registeredClass,rawPointer);if(undefined!==registeredInstance){if(0===registeredInstance.$$.count.value){registeredInstance.$$.ptr=rawPointer;registeredInstance.$$.smartPtr=ptr;return registeredInstance["clone"]()}else{var rv=registeredInstance["clone"]();this.destructor(ptr);return rv}}function makeDefaultHandle(){if(this.isSmartPointer){return makeClassHandle(this.registeredClass.instancePrototype,{ptrType:this.pointeeType,ptr:rawPointer,smartPtrType:this,smartPtr:ptr})}else{return makeClassHandle(this.registeredClass.instancePrototype,{ptrType:this,ptr:ptr})}}var actualType=this.registeredClass.getActualType(rawPointer);var registeredPointerRecord=registeredPointers[actualType];if(!registeredPointerRecord){return makeDefaultHandle.call(this)}var toType;if(this.isConst){toType=registeredPointerRecord.constPointerType}else{toType=registeredPointerRecord.pointerType}var dp=downcastPointer(rawPointer,this.registeredClass,toType.registeredClass);if(dp===null){return makeDefaultHandle.call(this)}if(this.isSmartPointer){return makeClassHandle(toType.registeredClass.instancePrototype,{ptrType:toType,ptr:dp,smartPtrType:this,smartPtr:ptr})}else{return makeClassHandle(toType.registeredClass.instancePrototype,{ptrType:toType,ptr:dp})}}function attachFinalizer(handle){if("undefined"===typeof FinalizationRegistry){attachFinalizer=handle=>handle;return handle}finalizationRegistry=new FinalizationRegistry(info=>{releaseClassHandle(info.$$)});attachFinalizer=handle=>{var $$=handle.$$;var hasSmartPtr=!!$$.smartPtr;if(hasSmartPtr){var info={$$:$$};finalizationRegistry.register(handle,info,handle)}return handle};detachFinalizer=handle=>finalizationRegistry.unregister(handle);return attachFinalizer(handle)}function ClassHandle_clone(){if(!this.$$.ptr){throwInstanceAlreadyDeleted(this)}if(this.$$.preservePointerOnDelete){this.$$.count.value+=1;return this}else{var clone=attachFinalizer(Object.create(Object.getPrototypeOf(this),{$$:{value:shallowCopyInternalPointer(this.$$)}}));clone.$$.count.value+=1;clone.$$.deleteScheduled=false;return clone}}function ClassHandle_delete(){if(!this.$$.ptr){throwInstanceAlreadyDeleted(this)}if(this.$$.deleteScheduled&&!this.$$.preservePointerOnDelete){throwBindingError("Object already scheduled for deletion")}detachFinalizer(this);releaseClassHandle(this.$$);if(!this.$$.preservePointerOnDelete){this.$$.smartPtr=undefined;this.$$.ptr=undefined}}function ClassHandle_isDeleted(){return!this.$$.ptr}function ClassHandle_deleteLater(){if(!this.$$.ptr){throwInstanceAlreadyDeleted(this)}if(this.$$.deleteScheduled&&!this.$$.preservePointerOnDelete){throwBindingError("Object already scheduled for deletion")}deletionQueue.push(this);if(deletionQueue.length===1&&delayFunction){delayFunction(flushPendingDeletes)}this.$$.deleteScheduled=true;return this}function init_ClassHandle(){ClassHandle.prototype["isAliasOf"]=ClassHandle_isAliasOf;ClassHandle.prototype["clone"]=ClassHandle_clone;ClassHandle.prototype["delete"]=ClassHandle_delete;ClassHandle.prototype["isDeleted"]=ClassHandle_isDeleted;ClassHandle.prototype["deleteLater"]=ClassHandle_deleteLater}function ClassHandle(){}function ensureOverloadTable(proto,methodName,humanName){if(undefined===proto[methodName].overloadTable){var prevFunc=proto[methodName];proto[methodName]=function(){if(!proto[methodName].overloadTable.hasOwnProperty(arguments.length)){throwBindingError("Function '"+humanName+"' called with an invalid number of arguments ("+arguments.length+") - expects one of ("+proto[methodName].overloadTable+")!")}return proto[methodName].overloadTable[arguments.length].apply(this,arguments)};proto[methodName].overloadTable=[];proto[methodName].overloadTable[prevFunc.argCount]=prevFunc}}function exposePublicSymbol(name,value,numArguments){if(Module.hasOwnProperty(name)){if(undefined===numArguments||undefined!==Module[name].overloadTable&&undefined!==Module[name].overloadTable[numArguments]){throwBindingError("Cannot register public name '"+name+"' twice")}ensureOverloadTable(Module,name,name);if(Module.hasOwnProperty(numArguments)){throwBindingError("Cannot register multiple overloads of a function with the same number of arguments ("+numArguments+")!")}Module[name].overloadTable[numArguments]=value}else{Module[name]=value;if(undefined!==numArguments){Module[name].numArguments=numArguments}}}function RegisteredClass(name,constructor,instancePrototype,rawDestructor,baseClass,getActualType,upcast,downcast){this.name=name;this.constructor=constructor;this.instancePrototype=instancePrototype;this.rawDestructor=rawDestructor;this.baseClass=baseClass;this.getActualType=getActualType;this.upcast=upcast;this.downcast=downcast;this.pureVirtualFunctions=[]}function upcastPointer(ptr,ptrClass,desiredClass){while(ptrClass!==desiredClass){if(!ptrClass.upcast){throwBindingError("Expected null or instance of "+desiredClass.name+", got an instance of "+ptrClass.name)}ptr=ptrClass.upcast(ptr);ptrClass=ptrClass.baseClass}return ptr}function constNoSmartPtrRawPointerToWireType(destructors,handle){if(handle===null){if(this.isReference){throwBindingError("null is not a valid "+this.name)}return 0}if(!handle.$$){throwBindingError('Cannot pass "'+_embind_repr(handle)+'" as a '+this.name)}if(!handle.$$.ptr){throwBindingError("Cannot pass deleted object as a pointer of type "+this.name)}var handleClass=handle.$$.ptrType.registeredClass;var ptr=upcastPointer(handle.$$.ptr,handleClass,this.registeredClass);return ptr}function genericPointerToWireType(destructors,handle){var ptr;if(handle===null){if(this.isReference){throwBindingError("null is not a valid "+this.name)}if(this.isSmartPointer){ptr=this.rawConstructor();if(destructors!==null){destructors.push(this.rawDestructor,ptr)}return ptr}else{return 0}}if(!handle.$$){throwBindingError('Cannot pass "'+_embind_repr(handle)+'" as a '+this.name)}if(!handle.$$.ptr){throwBindingError("Cannot pass deleted object as a pointer of type "+this.name)}if(!this.isConst&&handle.$$.ptrType.isConst){throwBindingError("Cannot convert argument of type "+(handle.$$.smartPtrType?handle.$$.smartPtrType.name:handle.$$.ptrType.name)+" to parameter type "+this.name)}var handleClass=handle.$$.ptrType.registeredClass;ptr=upcastPointer(handle.$$.ptr,handleClass,this.registeredClass);if(this.isSmartPointer){if(undefined===handle.$$.smartPtr){throwBindingError("Passing raw pointer to smart pointer is illegal")}switch(this.sharingPolicy){case 0:if(handle.$$.smartPtrType===this){ptr=handle.$$.smartPtr}else{throwBindingError("Cannot convert argument of type "+(handle.$$.smartPtrType?handle.$$.smartPtrType.name:handle.$$.ptrType.name)+" to parameter type "+this.name)}break;case 1:ptr=handle.$$.smartPtr;break;case 2:if(handle.$$.smartPtrType===this){ptr=handle.$$.smartPtr}else{var clonedHandle=handle["clone"]();ptr=this.rawShare(ptr,Emval.toHandle(function(){clonedHandle["delete"]()}));if(destructors!==null){destructors.push(this.rawDestructor,ptr)}}break;default:throwBindingError("Unsupporting sharing policy")}}return ptr}function nonConstNoSmartPtrRawPointerToWireType(destructors,handle){if(handle===null){if(this.isReference){throwBindingError("null is not a valid "+this.name)}return 0}if(!handle.$$){throwBindingError('Cannot pass "'+_embind_repr(handle)+'" as a '+this.name)}if(!handle.$$.ptr){throwBindingError("Cannot pass deleted object as a pointer of type "+this.name)}if(handle.$$.ptrType.isConst){throwBindingError("Cannot convert argument of type "+handle.$$.ptrType.name+" to parameter type "+this.name)}var handleClass=handle.$$.ptrType.registeredClass;var ptr=upcastPointer(handle.$$.ptr,handleClass,this.registeredClass);return ptr}function RegisteredPointer_getPointee(ptr){if(this.rawGetPointee){ptr=this.rawGetPointee(ptr)}return ptr}function RegisteredPointer_destructor(ptr){if(this.rawDestructor){this.rawDestructor(ptr)}}function RegisteredPointer_deleteObject(handle){if(handle!==null){handle["delete"]()}}function init_RegisteredPointer(){RegisteredPointer.prototype.getPointee=RegisteredPointer_getPointee;RegisteredPointer.prototype.destructor=RegisteredPointer_destructor;RegisteredPointer.prototype["argPackAdvance"]=8;RegisteredPointer.prototype["readValueFromPointer"]=simpleReadValueFromPointer;RegisteredPointer.prototype["deleteObject"]=RegisteredPointer_deleteObject;RegisteredPointer.prototype["fromWireType"]=RegisteredPointer_fromWireType}function RegisteredPointer(name,registeredClass,isReference,isConst,isSmartPointer,pointeeType,sharingPolicy,rawGetPointee,rawConstructor,rawShare,rawDestructor){this.name=name;this.registeredClass=registeredClass;this.isReference=isReference;this.isConst=isConst;this.isSmartPointer=isSmartPointer;this.pointeeType=pointeeType;this.sharingPolicy=sharingPolicy;this.rawGetPointee=rawGetPointee;this.rawConstructor=rawConstructor;this.rawShare=rawShare;this.rawDestructor=rawDestructor;if(!isSmartPointer&&registeredClass.baseClass===undefined){if(isConst){this["toWireType"]=constNoSmartPtrRawPointerToWireType;this.destructorFunction=null}else{this["toWireType"]=nonConstNoSmartPtrRawPointerToWireType;this.destructorFunction=null}}else{this["toWireType"]=genericPointerToWireType}}function replacePublicSymbol(name,value,numArguments){if(!Module.hasOwnProperty(name)){throwInternalError("Replacing nonexistant public symbol")}if(undefined!==Module[name].overloadTable&&undefined!==numArguments){Module[name].overloadTable[numArguments]=value}else{Module[name]=value;Module[name].argCount=numArguments}}function dynCallLegacy(sig,ptr,args){var f=Module["dynCall_"+sig];return args&&args.length?f.apply(null,[ptr].concat(args)):f.call(null,ptr)}function dynCall(sig,ptr,args){if(sig.includes("j")){return dynCallLegacy(sig,ptr,args)}return getWasmTableEntry(ptr).apply(null,args)}function getDynCaller(sig,ptr){var argCache=[];return function(){argCache.length=0;Object.assign(argCache,arguments);return dynCall(sig,ptr,argCache)}}function embind__requireFunction(signature,rawFunction){signature=readLatin1String(signature);function makeDynCaller(){if(signature.includes("j")){return getDynCaller(signature,rawFunction)}return getWasmTableEntry(rawFunction)}var fp=makeDynCaller();if(typeof fp!="function"){throwBindingError("unknown function pointer with signature "+signature+": "+rawFunction)}return fp}var UnboundTypeError=undefined;function getTypeName(type){var ptr=___getTypeName(type);var rv=readLatin1String(ptr);_free(ptr);return rv}function throwUnboundTypeError(message,types){var unboundTypes=[];var seen={};function visit(type){if(seen[type]){return}if(registeredTypes[type]){return}if(typeDependencies[type]){typeDependencies[type].forEach(visit);return}unboundTypes.push(type);seen[type]=true}types.forEach(visit);throw new UnboundTypeError(message+": "+unboundTypes.map(getTypeName).join([", "]))}function __embind_register_class(rawType,rawPointerType,rawConstPointerType,baseClassRawType,getActualTypeSignature,getActualType,upcastSignature,upcast,downcastSignature,downcast,name,destructorSignature,rawDestructor){name=readLatin1String(name);getActualType=embind__requireFunction(getActualTypeSignature,getActualType);if(upcast){upcast=embind__requireFunction(upcastSignature,upcast)}if(downcast){downcast=embind__requireFunction(downcastSignature,downcast)}rawDestructor=embind__requireFunction(destructorSignature,rawDestructor);var legalFunctionName=makeLegalFunctionName(name);exposePublicSymbol(legalFunctionName,function(){throwUnboundTypeError("Cannot construct "+name+" due to unbound types",[baseClassRawType])});whenDependentTypesAreResolved([rawType,rawPointerType,rawConstPointerType],baseClassRawType?[baseClassRawType]:[],function(base){base=base[0];var baseClass;var basePrototype;if(baseClassRawType){baseClass=base.registeredClass;basePrototype=baseClass.instancePrototype}else{basePrototype=ClassHandle.prototype}var constructor=createNamedFunction(legalFunctionName,function(){if(Object.getPrototypeOf(this)!==instancePrototype){throw new BindingError("Use 'new' to construct "+name)}if(undefined===registeredClass.constructor_body){throw new BindingError(name+" has no accessible constructor")}var body=registeredClass.constructor_body[arguments.length];if(undefined===body){throw new BindingError("Tried to invoke ctor of "+name+" with invalid number of parameters ("+arguments.length+") - expected ("+Object.keys(registeredClass.constructor_body).toString()+") parameters instead!")}return body.apply(this,arguments)});var instancePrototype=Object.create(basePrototype,{constructor:{value:constructor}});constructor.prototype=instancePrototype;var registeredClass=new RegisteredClass(name,constructor,instancePrototype,rawDestructor,baseClass,getActualType,upcast,downcast);var referenceConverter=new RegisteredPointer(name,registeredClass,true,false,false);var pointerConverter=new RegisteredPointer(name+"*",registeredClass,false,false,false);var constPointerConverter=new RegisteredPointer(name+" const*",registeredClass,false,true,false);registeredPointers[rawType]={pointerType:pointerConverter,constPointerType:constPointerConverter};replacePublicSymbol(legalFunctionName,constructor);return[referenceConverter,pointerConverter,constPointerConverter]})}function heap32VectorToArray(count,firstElement){var array=[];for(var i=0;i<count;i++){array.push(HEAP32[(firstElement>>2)+i])}return array}function __embind_register_class_constructor(rawClassType,argCount,rawArgTypesAddr,invokerSignature,invoker,rawConstructor){assert(argCount>0);var rawArgTypes=heap32VectorToArray(argCount,rawArgTypesAddr);invoker=embind__requireFunction(invokerSignature,invoker);whenDependentTypesAreResolved([],[rawClassType],function(classType){classType=classType[0];var humanName="constructor "+classType.name;if(undefined===classType.registeredClass.constructor_body){classType.registeredClass.constructor_body=[]}if(undefined!==classType.registeredClass.constructor_body[argCount-1]){throw new BindingError("Cannot register multiple constructors with identical number of parameters ("+(argCount-1)+") for class '"+classType.name+"'! Overload resolution is currently only performed using the parameter count, not actual type info!")}classType.registeredClass.constructor_body[argCount-1]=()=>{throwUnboundTypeError("Cannot construct "+classType.name+" due to unbound types",rawArgTypes)};whenDependentTypesAreResolved([],rawArgTypes,function(argTypes){argTypes.splice(1,0,null);classType.registeredClass.constructor_body[argCount-1]=craftInvokerFunction(humanName,argTypes,null,invoker,rawConstructor);return[]});return[]})}function new_(constructor,argumentList){if(!(constructor instanceof Function)){throw new TypeError("new_ called with constructor type "+typeof constructor+" which is not a function")}var dummy=createNamedFunction(constructor.name||"unknownFunctionName",function(){});dummy.prototype=constructor.prototype;var obj=new dummy;var r=constructor.apply(obj,argumentList);return r instanceof Object?r:obj}function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var argsList="";var argsListWired="";for(var i=0;i<argCount-2;++i){argsList+=(i!==0?", ":"")+"arg"+i;argsListWired+=(i!==0?", ":"")+"arg"+i+"Wired"}var invokerFnBody="return function "+makeLegalFunctionName(humanName)+"("+argsList+") {\n"+"if (arguments.length !== "+(argCount-2)+") {\n"+"throwBindingError('function "+humanName+" called with ' + arguments.length + ' arguments, expected "+(argCount-2)+" args!');\n"+"}\n";if(needsDestructorStack){invokerFnBody+="var destructors = [];\n"}var dtorStack=needsDestructorStack?"destructors":"null";var args1=["throwBindingError","invoker","fn","runDestructors","retType","classParam"];var args2=[throwBindingError,cppInvokerFunc,cppTargetFunc,runDestructors,argTypes[0],argTypes[1]];if(isClassMethodFunc){invokerFnBody+="var thisWired = classParam.toWireType("+dtorStack+", this);\n"}for(var i=0;i<argCount-2;++i){invokerFnBody+="var arg"+i+"Wired = argType"+i+".toWireType("+dtorStack+", arg"+i+"); // "+argTypes[i+2].name+"\n";args1.push("argType"+i);args2.push(argTypes[i+2])}if(isClassMethodFunc){argsListWired="thisWired"+(argsListWired.length>0?", ":"")+argsListWired}invokerFnBody+=(returns?"var rv = ":"")+"invoker(fn"+(argsListWired.length>0?", ":"")+argsListWired+");\n";if(needsDestructorStack){invokerFnBody+="runDestructors(destructors);\n"}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var paramName=i===1?"thisWired":"arg"+(i-2)+"Wired";if(argTypes[i].destructorFunction!==null){invokerFnBody+=paramName+"_dtor("+paramName+"); // "+argTypes[i].name+"\n";args1.push(paramName+"_dtor");args2.push(argTypes[i].destructorFunction)}}}if(returns){invokerFnBody+="var ret = retType.fromWireType(rv);\n"+"return ret;\n"}else{}invokerFnBody+="}\n";args1.push(invokerFnBody);var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}function __embind_register_class_function(rawClassType,methodName,argCount,rawArgTypesAddr,invokerSignature,rawInvoker,context,isPureVirtual){var rawArgTypes=heap32VectorToArray(argCount,rawArgTypesAddr);methodName=readLatin1String(methodName);rawInvoker=embind__requireFunction(invokerSignature,rawInvoker);whenDependentTypesAreResolved([],[rawClassType],function(classType){classType=classType[0];var humanName=classType.name+"."+methodName;if(methodName.startsWith("@@")){methodName=Symbol[methodName.substring(2)]}if(isPureVirtual){classType.registeredClass.pureVirtualFunctions.push(methodName)}function unboundTypesHandler(){throwUnboundTypeError("Cannot call "+humanName+" due to unbound types",rawArgTypes)}var proto=classType.registeredClass.instancePrototype;var method=proto[methodName];if(undefined===method||undefined===method.overloadTable&&method.className!==classType.name&&method.argCount===argCount-2){unboundTypesHandler.argCount=argCount-2;unboundTypesHandler.className=classType.name;proto[methodName]=unboundTypesHandler}else{ensureOverloadTable(proto,methodName,humanName);proto[methodName].overloadTable[argCount-2]=unboundTypesHandler}whenDependentTypesAreResolved([],rawArgTypes,function(argTypes){var memberFunction=craftInvokerFunction(humanName,argTypes,classType,rawInvoker,context);if(undefined===proto[methodName].overloadTable){memberFunction.argCount=argCount-2;proto[methodName]=memberFunction}else{proto[methodName].overloadTable[argCount-2]=memberFunction}return[]});return[]})}var emval_free_list=[];var emval_handle_array=[{},{value:undefined},{value:null},{value:true},{value:false}];function __emval_decref(handle){if(handle>4&&0===--emval_handle_array[handle].refcount){emval_handle_array[handle]=undefined;emval_free_list.push(handle)}}function count_emval_handles(){var count=0;for(var i=5;i<emval_handle_array.length;++i){if(emval_handle_array[i]!==undefined){++count}}return count}function get_first_emval(){for(var i=5;i<emval_handle_array.length;++i){if(emval_handle_array[i]!==undefined){return emval_handle_array[i]}}return null}function init_emval(){Module["count_emval_handles"]=count_emval_handles;Module["get_first_emval"]=get_first_emval}var Emval={toValue:handle=>{if(!handle){throwBindingError("Cannot use deleted val. handle = "+handle)}return emval_handle_array[handle].value},toHandle:value=>{switch(value){case undefined:return 1;case null:return 2;case true:return 3;case false:return 4;default:{var handle=emval_free_list.length?emval_free_list.pop():emval_handle_array.length;emval_handle_array[handle]={refcount:1,value:value};return handle}}}};function __embind_register_emval(rawType,name){name=readLatin1String(name);registerType(rawType,{name:name,"fromWireType":function(handle){var rv=Emval.toValue(handle);__emval_decref(handle);return rv},"toWireType":function(destructors,value){return Emval.toHandle(value)},"argPackAdvance":8,"readValueFromPointer":simpleReadValueFromPointer,destructorFunction:null})}function _embind_repr(v){if(v===null){return"null"}var t=typeof v;if(t==="object"||t==="array"||t==="function"){return v.toString()}else{return""+v}}function floatReadValueFromPointer(name,shift){switch(shift){case 2:return function(pointer){return this["fromWireType"](HEAPF32[pointer>>2])};case 3:return function(pointer){return this["fromWireType"](HEAPF64[pointer>>3])};default:throw new TypeError("Unknown float type: "+name)}}function __embind_register_float(rawType,name,size){var shift=getShiftFromSize(size);name=readLatin1String(name);registerType(rawType,{name:name,"fromWireType":function(value){return value},"toWireType":function(destructors,value){return value},"argPackAdvance":8,"readValueFromPointer":floatReadValueFromPointer(name,shift),destructorFunction:null})}function integerReadValueFromPointer(name,shift,signed){switch(shift){case 0:return signed?function readS8FromPointer(pointer){return HEAP8[pointer]}:function readU8FromPointer(pointer){return HEAPU8[pointer]};case 1:return signed?function readS16FromPointer(pointer){return HEAP16[pointer>>1]}:function readU16FromPointer(pointer){return HEAPU16[pointer>>1]};case 2:return signed?function readS32FromPointer(pointer){return HEAP32[pointer>>2]}:function readU32FromPointer(pointer){return HEAPU32[pointer>>2]};default:throw new TypeError("Unknown integer type: "+name)}}function __embind_register_integer(primitiveType,name,size,minRange,maxRange){name=readLatin1String(name);if(maxRange===-1){maxRange=4294967295}var shift=getShiftFromSize(size);var fromWireType=value=>value;if(minRange===0){var bitshift=32-8*size;fromWireType=value=>value<<bitshift>>>bitshift}var isUnsignedType=name.includes("unsigned");var checkAssertions=(value,toTypeName)=>{};var toWireType;if(isUnsignedType){toWireType=function(destructors,value){checkAssertions(value,this.name);return value>>>0}}else{toWireType=function(destructors,value){checkAssertions(value,this.name);return value}}registerType(primitiveType,{name:name,"fromWireType":fromWireType,"toWireType":toWireType,"argPackAdvance":8,"readValueFromPointer":integerReadValueFromPointer(name,shift,minRange!==0),destructorFunction:null})}function __embind_register_memory_view(rawType,dataTypeIndex,name){var typeMapping=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array];var TA=typeMapping[dataTypeIndex];function decodeMemoryView(handle){handle=handle>>2;var heap=HEAPU32;var size=heap[handle];var data=heap[handle+1];return new TA(buffer,data,size)}name=readLatin1String(name);registerType(rawType,{name:name,"fromWireType":decodeMemoryView,"argPackAdvance":8,"readValueFromPointer":decodeMemoryView},{ignoreDuplicateRegistrations:true})}function __embind_register_std_string(rawType,name){name=readLatin1String(name);var stdStringIsUTF8=name==="std::string";registerType(rawType,{name:name,"fromWireType":function(value){var length=HEAPU32[value>>2];var str;if(stdStringIsUTF8){var decodeStartPtr=value+4;for(var i=0;i<=length;++i){var currentBytePtr=value+4+i;if(i==length||HEAPU8[currentBytePtr]==0){var maxRead=currentBytePtr-decodeStartPtr;var stringSegment=UTF8ToString(decodeStartPtr,maxRead);if(str===undefined){str=stringSegment}else{str+=String.fromCharCode(0);str+=stringSegment}decodeStartPtr=currentBytePtr+1}}}else{var a=new Array(length);for(var i=0;i<length;++i){a[i]=String.fromCharCode(HEAPU8[value+4+i])}str=a.join("")}_free(value);return str},"toWireType":function(destructors,value){if(value instanceof ArrayBuffer){value=new Uint8Array(value)}var getLength;var valueIsOfTypeString=typeof value=="string";if(!(valueIsOfTypeString||value instanceof Uint8Array||value instanceof Uint8ClampedArray||value instanceof Int8Array)){throwBindingError("Cannot pass non-string to std::string")}if(stdStringIsUTF8&&valueIsOfTypeString){getLength=()=>lengthBytesUTF8(value)}else{getLength=()=>value.length}var length=getLength();var ptr=_malloc(4+length+1);HEAPU32[ptr>>2]=length;if(stdStringIsUTF8&&valueIsOfTypeString){stringToUTF8(value,ptr+4,length+1)}else{if(valueIsOfTypeString){for(var i=0;i<length;++i){var charCode=value.charCodeAt(i);if(charCode>255){_free(ptr);throwBindingError("String has UTF-16 code units that do not fit in 8 bits")}HEAPU8[ptr+4+i]=charCode}}else{for(var i=0;i<length;++i){HEAPU8[ptr+4+i]=value[i]}}}if(destructors!==null){destructors.push(_free,ptr)}return ptr},"argPackAdvance":8,"readValueFromPointer":simpleReadValueFromPointer,destructorFunction:function(ptr){_free(ptr)}})}function __embind_register_std_wstring(rawType,charSize,name){name=readLatin1String(name);var decodeString,encodeString,getHeap,lengthBytesUTF,shift;if(charSize===2){decodeString=UTF16ToString;encodeString=stringToUTF16;lengthBytesUTF=lengthBytesUTF16;getHeap=()=>HEAPU16;shift=1}else if(charSize===4){decodeString=UTF32ToString;encodeString=stringToUTF32;lengthBytesUTF=lengthBytesUTF32;getHeap=()=>HEAPU32;shift=2}registerType(rawType,{name:name,"fromWireType":function(value){var length=HEAPU32[value>>2];var HEAP=getHeap();var str;var decodeStartPtr=value+4;for(var i=0;i<=length;++i){var currentBytePtr=value+4+i*charSize;if(i==length||HEAP[currentBytePtr>>shift]==0){var maxReadBytes=currentBytePtr-decodeStartPtr;var stringSegment=decodeString(decodeStartPtr,maxReadBytes);if(str===undefined){str=stringSegment}else{str+=String.fromCharCode(0);str+=stringSegment}decodeStartPtr=currentBytePtr+charSize}}_free(value);return str},"toWireType":function(destructors,value){if(!(typeof value=="string")){throwBindingError("Cannot pass non-string to C++ string type "+name)}var length=lengthBytesUTF(value);var ptr=_malloc(4+length+charSize);HEAPU32[ptr>>2]=length>>shift;encodeString(value,ptr+4,length+charSize);if(destructors!==null){destructors.push(_free,ptr)}return ptr},"argPackAdvance":8,"readValueFromPointer":simpleReadValueFromPointer,destructorFunction:function(ptr){_free(ptr)}})}function __embind_register_value_object(rawType,name,constructorSignature,rawConstructor,destructorSignature,rawDestructor){structRegistrations[rawType]={name:readLatin1String(name),rawConstructor:embind__requireFunction(constructorSignature,rawConstructor),rawDestructor:embind__requireFunction(destructorSignature,rawDestructor),fields:[]}}function __embind_register_value_object_field(structType,fieldName,getterReturnType,getterSignature,getter,getterContext,setterArgumentType,setterSignature,setter,setterContext){structRegistrations[structType].fields.push({fieldName:readLatin1String(fieldName),getterReturnType:getterReturnType,getter:embind__requireFunction(getterSignature,getter),getterContext:getterContext,setterArgumentType:setterArgumentType,setter:embind__requireFunction(setterSignature,setter),setterContext:setterContext})}function __embind_register_void(rawType,name){name=readLatin1String(name);registerType(rawType,{isVoid:true,name:name,"argPackAdvance":0,"fromWireType":function(){return undefined},"toWireType":function(destructors,o){return undefined}})}function __emscripten_date_now(){return Date.now()}function __localtime_js(time,tmPtr){var date=new Date(HEAP32[time>>2]*1e3);HEAP32[tmPtr>>2]=date.getSeconds();HEAP32[tmPtr+4>>2]=date.getMinutes();HEAP32[tmPtr+8>>2]=date.getHours();HEAP32[tmPtr+12>>2]=date.getDate();HEAP32[tmPtr+16>>2]=date.getMonth();HEAP32[tmPtr+20>>2]=date.getFullYear()-1900;HEAP32[tmPtr+24>>2]=date.getDay();var start=new Date(date.getFullYear(),0,1);var yday=(date.getTime()-start.getTime())/(1e3*60*60*24)|0;HEAP32[tmPtr+28>>2]=yday;HEAP32[tmPtr+36>>2]=-(date.getTimezoneOffset()*60);var summerOffset=new Date(date.getFullYear(),6,1).getTimezoneOffset();var winterOffset=start.getTimezoneOffset();var dst=(summerOffset!=winterOffset&&date.getTimezoneOffset()==Math.min(winterOffset,summerOffset))|0;HEAP32[tmPtr+32>>2]=dst}function __mktime_js(tmPtr){var date=new Date(HEAP32[tmPtr+20>>2]+1900,HEAP32[tmPtr+16>>2],HEAP32[tmPtr+12>>2],HEAP32[tmPtr+8>>2],HEAP32[tmPtr+4>>2],HEAP32[tmPtr>>2],0);var dst=HEAP32[tmPtr+32>>2];var guessedOffset=date.getTimezoneOffset();var start=new Date(date.getFullYear(),0,1);var summerOffset=new Date(date.getFullYear(),6,1).getTimezoneOffset();var winterOffset=start.getTimezoneOffset();var dstOffset=Math.min(winterOffset,summerOffset);if(dst<0){HEAP32[tmPtr+32>>2]=Number(summerOffset!=winterOffset&&dstOffset==guessedOffset)}else if(dst>0!=(dstOffset==guessedOffset)){var nonDstOffset=Math.max(winterOffset,summerOffset);var trueOffset=dst>0?dstOffset:nonDstOffset;date.setTime(date.getTime()+(trueOffset-guessedOffset)*6e4)}HEAP32[tmPtr+24>>2]=date.getDay();var yday=(date.getTime()-start.getTime())/(1e3*60*60*24)|0;HEAP32[tmPtr+28>>2]=yday;HEAP32[tmPtr>>2]=date.getSeconds();HEAP32[tmPtr+4>>2]=date.getMinutes();HEAP32[tmPtr+8>>2]=date.getHours();HEAP32[tmPtr+12>>2]=date.getDate();HEAP32[tmPtr+16>>2]=date.getMonth();return date.getTime()/1e3|0}function _tzset_impl(timezone,daylight,tzname){var currentYear=(new Date).getFullYear();var winter=new Date(currentYear,0,1);var summer=new Date(currentYear,6,1);var winterOffset=winter.getTimezoneOffset();var summerOffset=summer.getTimezoneOffset();var stdTimezoneOffset=Math.max(winterOffset,summerOffset);HEAP32[timezone>>2]=stdTimezoneOffset*60;HEAP32[daylight>>2]=Number(winterOffset!=summerOffset);function extractZone(date){var match=date.toTimeString().match(/\(([A-Za-z ]+)\)$/);return match?match[1]:"GMT"}var winterName=extractZone(winter);var summerName=extractZone(summer);var winterNamePtr=allocateUTF8(winterName);var summerNamePtr=allocateUTF8(summerName);if(summerOffset<winterOffset){HEAPU32[tzname>>2]=winterNamePtr;HEAPU32[tzname+4>>2]=summerNamePtr}else{HEAPU32[tzname>>2]=summerNamePtr;HEAPU32[tzname+4>>2]=winterNamePtr}}function __tzset_js(timezone,daylight,tzname){if(__tzset_js.called)return;__tzset_js.called=true;_tzset_impl(timezone,daylight,tzname)}function _abort(){abort("")}function _emscripten_memcpy_big(dest,src,num){HEAPU8.copyWithin(dest,src,src+num)}function getHeapMax(){return 2147483648}function emscripten_realloc_buffer(size){try{wasmMemory.grow(size-buffer.byteLength+65535>>>16);updateGlobalBufferAndViews(wasmMemory.buffer);return 1}catch(e){}}function _emscripten_resize_heap(requestedSize){var oldSize=HEAPU8.length;requestedSize=requestedSize>>>0;var maxHeapSize=getHeapMax();if(requestedSize>maxHeapSize){return false}let alignUp=(x,multiple)=>x+(multiple-x%multiple)%multiple;for(var cutDown=1;cutDown<=4;cutDown*=2){var overGrownHeapSize=oldSize*(1+.2/cutDown);overGrownHeapSize=Math.min(overGrownHeapSize,requestedSize+100663296);var newSize=Math.min(maxHeapSize,alignUp(Math.max(requestedSize,overGrownHeapSize),65536));var replacement=emscripten_realloc_buffer(newSize);if(replacement){return true}}return false}var ENV={};function getExecutableName(){return thisProgram||"./this.program"}function getEnvStrings(){if(!getEnvStrings.strings){var lang=(typeof navigator=="object"&&navigator.languages&&navigator.languages[0]||"C").replace("-","_")+".UTF-8";var env={"USER":"web_user","LOGNAME":"web_user","PATH":"/","PWD":"/","HOME":"/home/web_user","LANG":lang,"_":getExecutableName()};for(var x in ENV){if(ENV[x]===undefined)delete env[x];else env[x]=ENV[x]}var strings=[];for(var x in env){strings.push(x+"="+env[x])}getEnvStrings.strings=strings}return getEnvStrings.strings}function _environ_get(__environ,environ_buf){var bufSize=0;getEnvStrings().forEach(function(string,i){var ptr=environ_buf+bufSize;HEAPU32[__environ+i*4>>2]=ptr;writeAsciiToMemory(string,ptr);bufSize+=string.length+1});return 0}function _environ_sizes_get(penviron_count,penviron_buf_size){var strings=getEnvStrings();HEAPU32[penviron_count>>2]=strings.length;var bufSize=0;strings.forEach(function(string){bufSize+=string.length+1});HEAPU32[penviron_buf_size>>2]=bufSize;return 0}function _getTempRet0(){return getTempRet0()}function _jsClose(handleLo,handleHi){return Module.extractor.close((handleLo>>>0)+handleHi*4294967296)}function _jsCreate(filename){const handle=Module.extractor.create(UTF32ToString(filename));Module.setTempRet0(handle/4294967296|0);return handle%4294967296}function _jsOpen(filename){const handle=Module.extractor.open(UTF32ToString(filename));Module.setTempRet0(handle/4294967296|0);return handle%4294967296}function _jsRead(handleLo,handleHi,buf,size){return Module.extractor.read((handleLo>>>0)+handleHi*4294967296,buf,size)}function _jsSeek(handleLo,handleHi,offsetLo,offsetHi,method){return Module.extractor.seek((handleLo>>>0)+handleHi*4294967296,(offsetLo>>>0)+offsetHi*4294967296,UTF8ToString(method))}function _jsTell(handleLo,handleHi){const pos=Module.extractor.tell((handleLo>>>0)+handleHi*4294967296);Module.setTempRet0(pos/4294967296|0);return pos%4294967296}function _jsWrite(handleLo,handleHi,buf,size){return Module.extractor.write((handleLo>>>0)+handleHi*4294967296,buf,size)}function _llvm_eh_typeid_for(type){return type}function _setTempRet0(val){setTempRet0(val)}InternalError=Module["InternalError"]=extendError(Error,"InternalError");embind_init_charCodes();BindingError=Module["BindingError"]=extendError(Error,"BindingError");init_ClassHandle();init_embind();init_RegisteredPointer();UnboundTypeError=Module["UnboundTypeError"]=extendError(Error,"UnboundTypeError");init_emval();var asmLibraryArg={"p":___cxa_allocate_exception,"r":___cxa_begin_catch,"t":___cxa_end_catch,"c":___cxa_find_matching_catch_2,"d":___cxa_find_matching_catch_3,"l":___cxa_find_matching_catch_4,"ea":___cxa_free_exception,"o":___cxa_throw,"e":___resumeException,"V":___syscall_fchownat,"U":___syscall_symlink,"fa":__embind_finalize_value_object,"F":__embind_register_bigint,"ca":__embind_register_bool,"ia":__embind_register_class,"ha":__embind_register_class_constructor,"w":__embind_register_class_function,"ba":__embind_register_emval,"z":__embind_register_float,"q":__embind_register_integer,"j":__embind_register_memory_view,"y":__embind_register_std_string,"u":__embind_register_std_wstring,"v":__embind_register_value_object,"ga":__embind_register_value_object_field,"da":__embind_register_void,"Y":__emscripten_date_now,"Z":__localtime_js,"_":__mktime_js,"$":__tzset_js,"x":_abort,"aa":_emscripten_memcpy_big,"T":_emscripten_resize_heap,"W":_environ_get,"X":_environ_sizes_get,"a":_getTempRet0,"b":invoke_ii,"h":invoke_iii,"g":invoke_iiii,"n":invoke_iiiii,"E":invoke_iiiiiii,"D":invoke_iiiiiiiiii,"O":invoke_iiiiiijii,"Q":invoke_ji,"A":invoke_v,"m":invoke_vi,"f":invoke_vii,"i":invoke_viii,"C":invoke_viiii,"ja":invoke_viiiii,"B":invoke_viiiiiiiii,"k":invoke_viiiiiiiiii,"P":invoke_vij,"R":invoke_viji,"M":invoke_vj,"N":_jsClose,"K":_jsCreate,"L":_jsOpen,"I":_jsRead,"H":_jsSeek,"G":_jsTell,"J":_jsWrite,"s":_llvm_eh_typeid_for,"S":_setTempRet0};var asm=createWasm();var ___wasm_call_ctors=Module["___wasm_call_ctors"]=function(){return(___wasm_call_ctors=Module["___wasm_call_ctors"]=Module["asm"]["la"]).apply(null,arguments)};var _free=Module["_free"]=function(){return(_free=Module["_free"]=Module["asm"]["ma"]).apply(null,arguments)};var _malloc=Module["_malloc"]=function(){return(_malloc=Module["_malloc"]=Module["asm"]["na"]).apply(null,arguments)};var ___getTypeName=Module["___getTypeName"]=function(){return(___getTypeName=Module["___getTypeName"]=Module["asm"]["pa"]).apply(null,arguments)};var ___embind_register_native_and_builtin_types=Module["___embind_register_native_and_builtin_types"]=function(){return(___embind_register_native_and_builtin_types=Module["___embind_register_native_and_builtin_types"]=Module["asm"]["qa"]).apply(null,arguments)};var _setThrew=Module["_setThrew"]=function(){return(_setThrew=Module["_setThrew"]=Module["asm"]["ra"]).apply(null,arguments)};var stackSave=Module["stackSave"]=function(){return(stackSave=Module["stackSave"]=Module["asm"]["sa"]).apply(null,arguments)};var stackRestore=Module["stackRestore"]=function(){return(stackRestore=Module["stackRestore"]=Module["asm"]["ta"]).apply(null,arguments)};var ___cxa_can_catch=Module["___cxa_can_catch"]=function(){return(___cxa_can_catch=Module["___cxa_can_catch"]=Module["asm"]["ua"]).apply(null,arguments)};var ___cxa_is_pointer_type=Module["___cxa_is_pointer_type"]=function(){return(___cxa_is_pointer_type=Module["___cxa_is_pointer_type"]=Module["asm"]["va"]).apply(null,arguments)};var dynCall_viji=Module["dynCall_viji"]=function(){return(dynCall_viji=Module["dynCall_viji"]=Module["asm"]["wa"]).apply(null,arguments)};var dynCall_ji=Module["dynCall_ji"]=function(){return(dynCall_ji=Module["dynCall_ji"]=Module["asm"]["xa"]).apply(null,arguments)};var dynCall_vij=Module["dynCall_vij"]=function(){return(dynCall_vij=Module["dynCall_vij"]=Module["asm"]["ya"]).apply(null,arguments)};var dynCall_iiiiiijii=Module["dynCall_iiiiiijii"]=function(){return(dynCall_iiiiiijii=Module["dynCall_iiiiiijii"]=Module["asm"]["za"]).apply(null,arguments)};var dynCall_vj=Module["dynCall_vj"]=function(){return(dynCall_vj=Module["dynCall_vj"]=Module["asm"]["Aa"]).apply(null,arguments)};function invoke_vi(index,a1){var sp=stackSave();try{getWasmTableEntry(index)(a1)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_ii(index,a1){var sp=stackSave();try{return getWasmTableEntry(index)(a1)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_iii(index,a1,a2){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_vii(index,a1,a2){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_viii(index,a1,a2,a3){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_iiiii(index,a1,a2,a3,a4){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3,a4)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_iiii(index,a1,a2,a3){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_iiiiiii(index,a1,a2,a3,a4,a5,a6){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_iiiiiiiiii(index,a1,a2,a3,a4,a5,a6,a7,a8,a9){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6,a7,a8,a9)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_viiii(index,a1,a2,a3,a4){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_viiiiiiiii(index,a1,a2,a3,a4,a5,a6,a7,a8,a9){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6,a7,a8,a9)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_v(index){var sp=stackSave();try{getWasmTableEntry(index)()}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_viiiii(index,a1,a2,a3,a4,a5){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4,a5)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_viiiiiiiiii(index,a1,a2,a3,a4,a5,a6,a7,a8,a9,a10){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6,a7,a8,a9,a10)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_viji(index,a1,a2,a3,a4){var sp=stackSave();try{dynCall_viji(index,a1,a2,a3,a4)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_ji(index,a1){var sp=stackSave();try{return dynCall_ji(index,a1)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_vij(index,a1,a2,a3){var sp=stackSave();try{dynCall_vij(index,a1,a2,a3)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_iiiiiijii(index,a1,a2,a3,a4,a5,a6,a7,a8,a9){var sp=stackSave();try{return dynCall_iiiiiijii(index,a1,a2,a3,a4,a5,a6,a7,a8,a9)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}function invoke_vj(index,a1,a2){var sp=stackSave();try{dynCall_vj(index,a1,a2)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0)}}Module["setTempRet0"]=setTempRet0;var calledRun;function ExitStatus(status){this.name="ExitStatus";this.message="Program terminated with exit("+status+")";this.status=status}dependenciesFulfilled=function runCaller(){if(!calledRun)run();if(!calledRun)dependenciesFulfilled=runCaller};function run(args){args=args||arguments_;if(runDependencies>0){return}preRun();if(runDependencies>0){return}function doRun(){if(calledRun)return;calledRun=true;Module["calledRun"]=true;if(ABORT)return;initRuntime();readyPromiseResolve(Module);if(Module["onRuntimeInitialized"])Module["onRuntimeInitialized"]();postRun()}if(Module["setStatus"]){Module["setStatus"]("Running...");setTimeout(function(){setTimeout(function(){Module["setStatus"]("")},1);doRun()},1)}else{doRun()}}Module["run"]=run;if(Module["preInit"]){if(typeof Module["preInit"]=="function")Module["preInit"]=[Module["preInit"]];while(Module["preInit"].length>0){Module["preInit"].pop()()}}run();


  return Module.ready
}
);
})();
if (typeof exports === 'object' && typeof module === 'object')
  module.exports = Module;
else if (typeof define === 'function' && define['amd'])
  define([], function() { return Module; });
else if (typeof exports === 'object')
  exports["Module"] = Module;

};
_mods["unrar.singleton"]=function(module,exports,require){
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUnrar = void 0;
/* eslint-disable @typescript-eslint/no-explicit-any */
const unrar_1 = __importDefault(require("unrar"));
let unrar;
async function getUnrar(options) {
    if (!unrar) {
        unrar = await (0, unrar_1.default)(options);
    }
    return unrar;
}
exports.getUnrar = getUnrar;
//# sourceMappingURL=unrar.singleton.js.map
};
_mods["ExtractorData.helper"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataFile = void 0;
class DataFile {
    constructor(data) {
        this.buffers = [];
        this.pos = 0;
        this.size = 0;
        if (data) {
            this.buffers.push(data);
            this.size = data.byteLength;
            this.pos = 0;
        }
    }
    read(size) {
        this.flatten();
        if (size + this.pos > this.size) {
            // size = this.size - this.pos;
            return null;
        }
        const oldPos = this.pos;
        this.pos += size;
        // return this.buffers[0].subarray(oldPos, this.pos);
        return this.buffers[0].slice(oldPos, this.pos);
    }
    readAll() {
        this.flatten();
        return this.buffers[0] || new Uint8Array();
    }
    write(data) {
        this.buffers.push(data);
        this.size += data.byteLength;
        this.pos += data.byteLength;
        return true;
    }
    tell() {
        return this.pos;
    }
    seek(pos, method) {
        let newPos = this.pos;
        if (method === 'SET') {
            newPos = pos;
        }
        else if (method === 'CUR') {
            newPos += pos;
        }
        else {
            newPos = this.size - pos;
        }
        if (newPos < 0 || newPos > this.size) {
            return false;
        }
        this.pos = newPos;
        return true;
    }
    flatten() {
        if (this.buffers.length <= 1) {
            return;
        }
        const newBuffer = new Uint8Array(this.size);
        let offset = 0;
        for (const buffer of this.buffers) {
            newBuffer.set(buffer, offset);
            offset += buffer.byteLength;
        }
        this.buffers = [newBuffer];
    }
}
exports.DataFile = DataFile;
//# sourceMappingURL=ExtractorData.helper.js.map
};
_mods["ExtractorData"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtractorData = void 0;
const ExtractorData_helper_1 = require("ExtractorData.helper");
const Extractor_1 = require("Extractor");
class ExtractorData extends Extractor_1.Extractor {
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types,@typescript-eslint/no-explicit-any
    constructor(unrar, data, password) {
        super(unrar, password);
        this.dataFiles = {};
        this.dataFileMap = {};
        this.currentFd = 1;
        const rarFile = {
            file: new ExtractorData_helper_1.DataFile(new Uint8Array(data)),
            fd: this.currentFd++,
        };
        this._filePath = '_defaultUnrarJS_.rar';
        this.dataFiles[this._filePath] = rarFile;
        this.dataFileMap[rarFile.fd] = this._filePath;
    }
    extract(options = {}) {
        const { arcHeader, files } = super.extract(options);
        function* getFiles() {
            for (const file of files) {
                if (!file.fileHeader.flags.directory) {
                    file.extraction =
                        this.dataFiles[this.getExtractedFileName(file.fileHeader.name)].file.readAll();
                }
                yield file;
            }
        }
        return { arcHeader, files: getFiles.call(this) };
    }
    getExtractedFileName(filename) {
        return `*Extracted*/${filename}`;
    }
    open(filename) {
        const dataFile = this.dataFiles[filename];
        if (!dataFile) {
            return 0;
        }
        return dataFile.fd;
    }
    create(filename) {
        const fd = this.currentFd++;
        this.dataFiles[this.getExtractedFileName(filename)] = {
            file: new ExtractorData_helper_1.DataFile(),
            fd: this.currentFd++,
        };
        this.dataFileMap[fd] = this.getExtractedFileName(filename);
        return fd;
    }
    closeFile(fd) {
        const fileData = this.dataFiles[this.dataFileMap[fd]];
        if (!fileData) {
            return;
        }
        fileData.file.seek(0, 'SET');
    }
    read(fd, buf, size) {
        const fileData = this.dataFiles[this.dataFileMap[fd]];
        if (!fileData) {
            return -1;
        }
        const data = fileData.file.read(size);
        if (data === null) {
            return -1;
        }
        this.unrar.HEAPU8.set(data, buf);
        return data.byteLength;
    }
    write(fd, buf, size) {
        const fileData = this.dataFiles[this.dataFileMap[fd]];
        if (!fileData) {
            return false;
        }
        fileData.file.write(this.unrar.HEAPU8.slice(buf, buf + size));
        return true;
    }
    tell(fd) {
        const fileData = this.dataFiles[this.dataFileMap[fd]];
        if (!fileData) {
            return -1;
        }
        return fileData.file.tell();
    }
    seek(fd, pos, method) {
        const fileData = this.dataFiles[this.dataFileMap[fd]];
        if (!fileData) {
            return false;
        }
        return fileData.file.seek(pos, method);
    }
}
exports.ExtractorData = ExtractorData;
//# sourceMappingURL=ExtractorData.js.map
};
_mods["ExtractorFile"]=function(module,exports,require){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtractorFile = void 0;
const fs = __importStar(require("fs-stub"));
const path = __importStar(require("path-stub"));
const Extractor_1 = require("Extractor");
class ExtractorFile extends Extractor_1.Extractor {
    constructor(
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types,@typescript-eslint/no-explicit-any
    unrar, filepath, targetPath, password, filenameTransform) {
        super(unrar, password);
        this.filenameTransform = filenameTransform;
        this._filePath = filepath;
        this.fileMap = {};
        this._target = targetPath;
    }
    open(filename) {
        const fd = fs.openSync(filename, 'r');
        this.fileMap[fd] = {
            size: fs.fstatSync(fd).size,
            pos: 0,
            name: filename,
        };
        return fd;
    }
    create(filename) {
        const fullpath = path.join(this._target, this.filenameTransform(filename));
        const dir = path.parse(fullpath).dir;
        // Skip if directory is the current directory
        if (dir !== '') {
            fs.mkdirSync(dir, { recursive: true });
        }
        const fd = fs.openSync(fullpath, 'w');
        this.fileMap[fd] = {
            size: 0,
            pos: 0,
            name: filename,
        };
        return fd;
    }
    closeFile(fd) {
        delete this.fileMap[fd];
        fs.closeSync(fd);
    }
    read(fd, buf, size) {
        const file = this.fileMap[fd];
        const buffer = Buffer.allocUnsafe(size);
        const readed = fs.readSync(fd, buffer, 0, size, file.pos);
        this.unrar.HEAPU8.set(buffer, buf);
        file.pos += readed;
        return readed;
    }
    write(fd, buf, size) {
        const file = this.fileMap[fd];
        const writeNum = fs.writeSync(fd, Buffer.from(this.unrar.HEAPU8.subarray(buf, buf + size)), 0, size);
        file.pos += writeNum;
        file.size += writeNum;
        return writeNum === size;
    }
    tell(fd) {
        return this.fileMap[fd].pos;
    }
    seek(fd, pos, method) {
        const file = this.fileMap[fd];
        let newPos = file.pos;
        if (method === 'SET') {
            newPos = 0;
        }
        else if (method === 'END') {
            newPos = file.size;
        }
        newPos += pos;
        if (newPos < 0 || newPos > file.size) {
            return false;
        }
        file.pos = newPos;
        return true;
    }
}
exports.ExtractorFile = ExtractorFile;
//# sourceMappingURL=ExtractorFile.js.map
};
_mods["Extractor"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Extractor = exports.UnrarError = void 0;
const ERROR_CODE = {
    0: 'ERAR_SUCCESS',
    10: 'ERAR_END_ARCHIVE',
    11: 'ERAR_NO_MEMORY',
    12: 'ERAR_BAD_DATA',
    13: 'ERAR_BAD_ARCHIVE',
    14: 'ERAR_UNKNOWN_FORMAT',
    15: 'ERAR_EOPEN',
    16: 'ERAR_ECREATE',
    17: 'ERAR_ECLOSE',
    18: 'ERAR_EREAD',
    19: 'ERAR_EWRITE',
    20: 'ERAR_SMALL_BUF',
    21: 'ERAR_UNKNOWN',
    22: 'ERAR_MISSING_PASSWORD',
    23: 'ERAR_EREFERENCE',
    24: 'ERAR_BAD_PASSWORD',
};
const ERROR_MSG = {
    ERAR_NO_MEMORY: 'Not enough memory',
    ERAR_BAD_DATA: 'Archive header or data are damaged',
    ERAR_BAD_ARCHIVE: 'File is not RAR archive',
    ERAR_UNKNOWN_FORMAT: 'Unknown archive format',
    ERAR_EOPEN: 'File open error',
    ERAR_ECREATE: 'File create error',
    ERAR_ECLOSE: 'File close error',
    ERAR_EREAD: 'File read error',
    ERAR_EWRITE: 'File write error',
    ERAR_SMALL_BUF: 'Buffer for archive comment is too small, comment truncated',
    ERAR_UNKNOWN: 'Unknown error',
    ERAR_MISSING_PASSWORD: 'Password for encrypted file or header is not specified',
    ERAR_EREFERENCE: 'Cannot open file source for reference record',
    ERAR_BAD_PASSWORD: 'Wrong password is specified',
};
class UnrarError extends Error {
    constructor(reason, message, file) {
        super(message);
        this.reason = reason;
        this.file = file;
    }
}
exports.UnrarError = UnrarError;
class Extractor {
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    constructor(unrar, password = '') {
        this.unrar = unrar;
        this._password = password;
        this._archive = null;
    }
    getFileList() {
        const arcHeader = this.openArc(true);
        function* getFileHeaders() {
            while (true) {
                const arcFile = this.processNextFile(() => true);
                if (arcFile === 'ERAR_END_ARCHIVE') {
                    break;
                }
                yield arcFile.fileHeader;
            }
            this.closeArc();
        }
        return { arcHeader, fileHeaders: getFileHeaders.call(this) };
    }
    extract({ files, password } = {}) {
        const arcHeader = this.openArc(false, password);
        function* getFiles() {
            let count = 0;
            while (true) {
                let shouldSkip = () => false;
                if (Array.isArray(files)) {
                    if (count === files.length) {
                        break;
                    }
                    shouldSkip = ({ name }) => !files.includes(name);
                }
                else if (files) {
                    shouldSkip = (fileHeader) => !files(fileHeader);
                }
                const arcFile = this.processNextFile(shouldSkip);
                if (arcFile === 'ERAR_END_ARCHIVE') {
                    break;
                }
                if (arcFile.extraction === 'skipped') {
                    continue;
                }
                count++;
                yield {
                    fileHeader: arcFile.fileHeader,
                };
            }
            this.closeArc();
        }
        return { arcHeader, files: getFiles.call(this) };
    }
    fileCreated(filename) {
        return;
    }
    close(fd) {
        this.closeFile(fd);
    }
    openArc(listOnly, password) {
        this._archive = new this.unrar.RarArchive();
        const header = this._archive.open(this._filePath, password ? password : this._password, listOnly);
        if (header.state.errCode !== 0) {
            throw this.getFailException(header.state.errCode, header.state.errType);
        }
        return {
            comment: header.comment,
            flags: {
                volume: (header.flags & 0x0001) !== 0,
                lock: (header.flags & 0x0004) !== 0,
                solid: (header.flags & 0x0008) !== 0,
                authInfo: (header.flags & 0x0020) !== 0,
                recoveryRecord: (header.flags & 0x0040) !== 0,
                headerEncrypted: (header.flags & 0x0080) !== 0,
            },
        };
    }
    processNextFile(shouldSkip) {
        function getDateString(dosTime) {
            const bitLen = [5, 6, 5, 5, 4, 7];
            let parts = [];
            for (const len of bitLen) {
                parts.push(dosTime & ((1 << len) - 1));
                dosTime >>= len;
            }
            parts = parts.reverse();
            const pad = (num) => (num < 10 ? '0' + num : '' + num);
            return (`${1980 + parts[0]}-${pad(parts[1])}-${pad(parts[2])}` +
                `T${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5] * 2)}.000`);
        }
        function getMethod(method) {
            const methodMap = {
                0x30: 'Storing',
                0x31: 'Fastest',
                0x32: 'Fast',
                0x33: 'Normal',
                0x34: 'Good',
                0x35: 'Best',
            };
            return methodMap[method] || 'Unknown';
        }
        const arcFileHeader = this._archive.getFileHeader();
        if (arcFileHeader.state.errCode === 10) {
            return 'ERAR_END_ARCHIVE';
        }
        if (arcFileHeader.state.errCode !== 0) {
            throw this.getFailException(arcFileHeader.state.errCode, arcFileHeader.state.errType);
        }
        const fileHeader = {
            name: arcFileHeader.name,
            flags: {
                encrypted: (arcFileHeader.flags & 0x04) !== 0,
                solid: (arcFileHeader.flags & 0x10) !== 0,
                directory: (arcFileHeader.flags & 0x20) !== 0,
            },
            packSize: arcFileHeader.packSize,
            unpSize: arcFileHeader.unpSize,
            // hostOS: arcFileHeader.hostOS
            crc: arcFileHeader.crc,
            time: getDateString(arcFileHeader.time),
            unpVer: `${Math.floor(arcFileHeader.unpVer / 10)}.${arcFileHeader.unpVer % 10}`,
            method: getMethod(arcFileHeader.method),
            comment: arcFileHeader.comment,
            // // fileAttr: arcFileHeader.fileAttr,
        };
        const skip = shouldSkip(fileHeader);
        const fileState = this._archive.readFile(skip);
        if (fileState.errCode !== 0) {
            throw this.getFailException(fileState.errCode, fileState.errType, fileHeader.name);
        }
        return {
            fileHeader,
            extraction: skip ? 'skipped' : 'extracted',
        };
    }
    closeArc() {
        this._archive.delete();
        this._archive = null;
    }
    getFailException(errCode, _errType, file) {
        const reason = ERROR_CODE[errCode];
        this.closeArc();
        return new UnrarError(reason, ERROR_MSG[reason], file);
    }
}
exports.Extractor = Extractor;
//# sourceMappingURL=Extractor.js.map
};
_mods["index.esm"]=function(module,exports,require){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExtractorFromData = void 0;
const ExtractorData_1 = require("ExtractorData");
const unrar_singleton_1 = require("unrar.singleton");
__exportStar(require("Extractor"), exports);
async function createExtractorFromData({ wasmBinary, data, password = '', }) {
    const unrar = await (0, unrar_singleton_1.getUnrar)(wasmBinary && { wasmBinary });
    const extractor = new ExtractorData_1.ExtractorData(unrar, data, password);
    unrar.extractor = extractor;
    return extractor;
}
exports.createExtractorFromData = createExtractorFromData;
//# sourceMappingURL=index.esm.js.map
};

var _esm = _mreq("index.esm");
window._unrarCreate = _esm.createExtractorFromData;
if(window._unrarCreate){
  console.log("unrar ready: createExtractorFromData =", typeof window._unrarCreate);
} else {
  window._unrarError = "createExtractorFromData nem található az index.esm-ben. Exportok: " + Object.keys(_esm).join(",");
  console.warn("unrar error:", window._unrarError);
}
})();