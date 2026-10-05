/* ═══════════ 87 · Macan News — игры (змейка 87 и пинг-понг 87) ═══════════
   Вынесено из index.html (стенд 2026-09-30): код игр (~40 КБ) и их картинки
   качаются только когда человек открывает раздел «Игры» — раньше всё это
   грузилось на каждом заходе на сайт, даже если в игры никто не шёл.
   Загружает этот файл main-скрипт index.html (loadGames). Общий аркадный
   модуль (звук, приглушение музыки, полноэкранный режим, салют) остался в
   index.html: им пользуются и видео в постах.
   Меняешь файл — меняй и номер в имени (games-40.js → games-41.js) и в
   index.html: так у посетителей не останется старая копия из кэша. */

/* спрайты игр: адреса лежат в data-* и подставляются только сейчас */
(function(){
  var ids=['snHeadSrc','pongTimSrc'];
  for(var i=0;i<ids.length;i++){
    var img=document.getElementById(ids[i]); if(!img) continue;
    var pic=img.parentNode, src=pic && pic.querySelector('source[data-srcset]');
    if(src){ src.setAttribute('srcset', src.getAttribute('data-srcset')); src.removeAttribute('data-srcset'); }
    if(img.getAttribute('data-src')){ img.src=img.getAttribute('data-src'); img.removeAttribute('data-src'); }
  }
})();

/* ═══════════ Змейка 87 — аркадный модуль (vanilla, без зависимостей) ═══════════ */
(function(){
  "use strict";
  var view = document.getElementById('view-games');
  if(!view) return;
  var $ = function(id){ return document.getElementById(id); };

  var gallery=$('arcadeGallery'), stage=$('arcadeStage'), backBtn=$('arcadeBack'),
      canvas=$('snCanvas'), hudScore=$('snScore'), hudLen=$('snLen'), hudBest=$('snBest'),
      scrStart=$('snStart'), scrWin=$('snWin'), scrLose=$('snLose'),
      startBtn=$('snStartBtn'), winAgain=$('snWinAgain'), winBack=$('snWinBack'),
      loseAgain=$('snLoseAgain'), loseBack=$('snLoseBack'),
      dpad=$('snDpad'), sfxBtn=$('snSfx'), fsBtn=$('snFs'), root=$('snake87'),
      headSrc=$('snHeadSrc'), cardHead=$('snCardHead');
  if(!canvas) return;
  var ctx = canvas.getContext('2d');

  /* preload Jigan head into card + game (png-фолбэк, если webp не декодится) */
  var headImg = new Image();
  if(headSrc) window.MNpicSrc(headSrc, function(_hs){
    var _png=headSrc.src||_hs;
    headImg.onerror=function(){ if(_png && headImg.src!==_png){ headImg.onerror=null; headImg.src=_png; } };
    headImg.src = _hs; if(cardHead) cardHead.src = _hs;
  });

  /* ── конфигурация ── */
  var GRID=16, WIN_LEN=87, START_LEN=3;
  var DIFFS={ easy:{base:175,min:110,drop:0.6}, classic:{base:140,min:78,drop:1.1}, hard:{base:105,min:55,drop:1.7} };
  var diff='classic', wrap=false;
  try{ var sd=localStorage.getItem('snake87_diff'); if(sd&&DIFFS[sd]) diff=sd; }catch(e){}
  try{ wrap = localStorage.getItem('snake87_wrap')==='1'; }catch(e){}

  /* ── состояние ── */
  var snake, prev, dir, turnQ=[], food, score, best, tickMs, lastStep, raf=null,
      running=false, paused=false, eatPop=0, cell=0, sizePx=0, foods=0,
      fsActive=false, fsPlaceholder=null;

  /* ── рекорд ── */
  try{ best = parseInt(localStorage.getItem('snake87_best'),10)||0; }catch(e){ best=0; }
  if(hudBest) hudBest.textContent = best;

  /* ── звук (Web Audio, синтез) ── */
  var actx=null, sfxOn=true;
  try{ sfxOn = localStorage.getItem('snake87_sfx')!=='0'; }catch(e){}
  function syncSfxBtn(){ if(sfxBtn) sfxBtn.classList.toggle('off', !sfxOn); }
  syncSfxBtn();
  function AC(){
    if(window.__arcadeAC) return window.__arcadeAC();
    if(actx===null){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ actx=false; } }
    if(actx && actx.state==='suspended'){ actx.resume(); }
    return actx||null;
  }
  function tone(freq, t0, dur, type, vol){
    var a=AC(); if(!a) return;
    var o=a.createOscillator(), g=a.createGain();
    o.type=type||'square'; o.frequency.setValueAtTime(freq, a.currentTime+t0);
    g.gain.setValueAtTime(0.0001, a.currentTime+t0);
    g.gain.exponentialRampToValueAtTime((vol||0.12), a.currentTime+t0+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime+t0+dur);
    o.connect(g); g.connect(a.destination);
    o.start(a.currentTime+t0); o.stop(a.currentTime+t0+dur+0.02);
  }
  function sEat(){ if(!sfxOn) return; tone(660,0,0.06,'square',0.10); tone(990,0.045,0.07,'square',0.10); }
  function sWin(){ if(!sfxOn) return; var n=[523,659,784,1046,1318]; for(var i=0;i<n.length;i++) tone(n[i], i*0.11, 0.16,'square',0.11); }
  function sLose(){ if(!sfxOn) return;
    var a=AC(); if(!a) return;
    var o=a.createOscillator(), g=a.createGain();
    o.type='sawtooth';
    o.frequency.setValueAtTime(380, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(70, a.currentTime+0.55);
    g.gain.setValueAtTime(0.16, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime+0.6);
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime+0.62);
  }

  /* ── размеры (DPR, квадрат) ── */
  function fit(){
    var wrap = canvas.parentElement;
    var w = wrap ? wrap.clientWidth : 0;
    if(!w){ return false; }
    sizePx = w;
    var dpr = Math.min(window.devicePixelRatio||1, 2);
    canvas.width = Math.round(sizePx*dpr);
    canvas.height = Math.round(sizePx*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    cell = sizePx/GRID;
    render(performance.now());
    return true;
  }

  /* ── утилиты ── */
  function cc(x,y){ return { cx:(x+0.5)*cell, cy:(y+0.5)*cell }; }
  function lerp(a,b,t){ return a+(b-a)*t; }
  function eq(a,b){ return a.x===b.x && a.y===b.y; }

  function placeFood(){
    var free=[];
    for(var y=0;y<GRID;y++) for(var x=0;x<GRID;x++){
      var on=false; for(var i=0;i<snake.length;i++){ if(snake[i].x===x&&snake[i].y===y){on=true;break;} }
      if(!on) free.push({x:x,y:y});
    }
    food = free.length ? free[(Math.random()*free.length)|0] : null;
  }

  function reset(){
    var m=(GRID/2)|0;
    snake=[]; for(var i=0;i<START_LEN;i++) snake.push({x:m-i, y:m});
    prev = snake.map(function(s){ return {x:s.x,y:s.y}; });
    dir={x:1,y:0}; turnQ=[];
    score=0; foods=0; tickMs=DIFFS[diff].base; eatPop=0;
    placeFood();
    updateHud();
  }

  function updateHud(){
    if(hudScore) hudScore.textContent = score;
    if(hudLen) hudLen.innerHTML = snake.length + '<small style="font-size:.5em;opacity:.6">/'+WIN_LEN+'</small>';
    if(hudBest) hudBest.textContent = best;
  }

  function setDir(nx,ny){
    if(!running||paused) return;
    var lastD = turnQ.length ? turnQ[turnQ.length-1] : dir;
    if(nx===-lastD.x && ny===-lastD.y) return;   // запрет разворота на 180°
    if(nx===lastD.x && ny===lastD.y) return;     // тот же курс — игнор
    if(turnQ.length>=2) return;                  // буфер не больше двух поворотов
    turnQ.push({x:nx,y:ny});
  }

  function step(){
    if(turnQ.length) dir = turnQ.shift();
    prev = snake.map(function(s){ return {x:s.x,y:s.y}; });
    var head=snake[0], nh={x:head.x+dir.x, y:head.y+dir.y};
    if(wrap){ nh.x=(nh.x+GRID)%GRID; nh.y=(nh.y+GRID)%GRID; }
    else if(nh.x<0||nh.y<0||nh.x>=GRID||nh.y>=GRID){ return die(); }
    var willEat = food && nh.x===food.x && nh.y===food.y;
    // тело, с которым возможно столкновение (хвост уйдёт, если не едим)
    var body = willEat ? snake : snake.slice(0, snake.length-1);
    for(var i=0;i<body.length;i++){ if(body[i].x===nh.x&&body[i].y===nh.y){ return die(); } }
    snake.unshift(nh);
    if(willEat){
      foods++; score+=10; eatPop=1; sEat();
      tickMs = Math.max(DIFFS[diff].min, DIFFS[diff].base - foods*DIFFS[diff].drop);
      if(snake.length>=WIN_LEN){ updateHud(); return win(); }
      placeFood();
    } else {
      snake.pop();
    }
    updateHud();
  }

  function commitBest(){
    if(score>best){ best=score; try{ localStorage.setItem('snake87_best',String(best)); }catch(e){} }
    updateHud();
  }
  function win(){ running=false; commitBest(); showScreen('win'); sWin(); }
  function die(){ running=false; commitBest(); showScreen('lose'); sLose(); }

  /* ── отрисовка ── */
  function roundRect(x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  function render(now){
    if(!cell) return;
    ctx.clearRect(0,0,sizePx,sizePx);
    // сетка
    ctx.strokeStyle='rgba(247,244,238,.05)'; ctx.lineWidth=1;
    for(var i=1;i<GRID;i++){
      ctx.beginPath(); ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,sizePx); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,i*cell); ctx.lineTo(sizePx,i*cell); ctx.stroke();
    }
    var t = (running && !paused) ? Math.min(1,(now-lastStep)/tickMs) : 1;
    // еда "87"
    if(food){
      var f=cc(food.x,food.y), pr=cell*0.92, p=1+0.07*Math.sin(now/210);
      ctx.save(); ctx.translate(f.cx,f.cy); ctx.scale(p,p);
      ctx.fillStyle=window.MNgc('food','#F7F4EE');
      ctx.font='800 '+(cell*0.62).toFixed(0)+"px 'Schibsted Grotesk',ui-monospace,monospace";
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('87',0,cell*0.03);
      ctx.restore();
    }
    // тело (от хвоста к голове, с интерполяцией)
    for(var s=snake.length-1; s>=1; s--){
      var pp = prev[s] || prev[prev.length-1] || snake[s];
      var cur=snake[s];
      var tt = (Math.abs(cur.x-pp.x)>1 || Math.abs(cur.y-pp.y)>1) ? 1 : t;
      var x=lerp((pp.x+0.5)*cell,(cur.x+0.5)*cell,tt);
      var y=lerp((pp.y+0.5)*cell,(cur.y+0.5)*cell,tt);
      var ratio = s/Math.max(1,snake.length-1);
      var col = mixGold(ratio);
      var sz = cell*(0.86 - ratio*0.18);
      ctx.fillStyle=col;
      ctx.fillRect(x-sz/2, y-sz/2, sz, sz);
    }
    // голова = Джиган
    var hp = prev[0] || snake[0], hc=snake[0];
    var ht = (Math.abs(hc.x-hp.x)>1 || Math.abs(hc.y-hp.y)>1) ? 1 : t;
    var hx=lerp((hp.x+0.5)*cell,(hc.x+0.5)*cell,ht);
    var hy=lerp((hp.y+0.5)*cell,(hc.y+0.5)*cell,ht);
    drawHead(hx,hy);
    // вспышка при поедании
    if(eatPop>0 && food===null){}
    if(eatPop>0){
      eatPop -= 0.06;
      if(eatPop<0) eatPop=0;
    }
  }
  function mixGold(r){
    // r=0 голова(ярко) … r=1 хвост(темнее) — цвета из текущей темы
    var c1=window.MNhex2rgb(window.MNgc('head','#FDA4C2')), c2=window.MNhex2rgb(window.MNgc('tail','#6E3A4E'));
    var R=Math.round(lerp(c1[0],c2[0],r)), G=Math.round(lerp(c1[1],c2[1],r)), B=Math.round(lerp(c1[2],c2[2],r));
    return 'rgb('+R+','+G+','+B+')';
  }
  /* голова — квадратный аватар с розовой обводкой, как на карточке игры */
  function drawHead(px,py){
    var d=cell*1.18, x=px-d/2, y=py-d/2;
    ctx.fillStyle='#050505'; ctx.fillRect(x,y,d,d);
    if(headImg.complete && headImg.naturalWidth){
      ctx.drawImage(headImg, x, y, d, d);
    } else {
      ctx.fillStyle=window.MNgc('head','#FDA4C2'); ctx.fillRect(x,y,d,d);
    }
    var lw=Math.max(1.5,cell*0.08);
    ctx.lineWidth=lw; ctx.strokeStyle='#FDA4C2';
    ctx.strokeRect(x+lw/2, y+lw/2, d-lw, d-lw);
  }

  /* ── цикл ── */
  function active(){ return view.classList.contains('active') && !stage.hidden; }
  function loop(now){
    if(!active() || document.hidden){ raf=null; lastStep=now; return; }  // авто-стоп вне раздела/вкладки
    raf = requestAnimationFrame(loop);
    if(running && !paused){
      if(now-lastStep >= tickMs){ step(); lastStep=now; }
    }
    render(now);
  }
  function kick(){ if(raf===null){ lastStep=performance.now(); raf=requestAnimationFrame(loop); } }
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) kick(); });
  window.addEventListener('hashchange', function(){ if(active()) kick(); });

  /* ── экраны ── */
  function showScreen(which){
    scrStart.hidden = which!=='start';
    scrWin.hidden  = which!=='win';
    scrLose.hidden = which!=='lose';
    // перезапуск анимации экрана
    if(which==='win'){ scrWin.classList.remove('win'); void scrWin.offsetWidth; scrWin.classList.add('win'); if(window.__arcadeWinFX) window.__arcadeWinFX(scrWin); }
    if(which==='lose'){ var c=scrLose.querySelector('.sn-cross'); if(c){ var n=c.cloneNode(true); c.parentNode.replaceChild(n,c); } }
  }
  function startRun(){
    AC();
    scrStart.hidden=true; scrWin.hidden=true; scrLose.hidden=true;
    reset();
    running=true; paused=false;
    if(!fit()){ requestAnimationFrame(function(){ fit(); }); }
    lastStep=performance.now(); kick();
  }
  function launch(){
    gallery.style.display='none';
    stage.hidden=false;
    try{ root.scrollIntoView({block:'center'}); }catch(e){}
    if(window.__arcadeMusic) window.__arcadeMusic.duck();
    running=false; paused=false;
    reset();
    requestAnimationFrame(function(){ if(!fit()) requestAnimationFrame(fit); });
    showScreen('start');
    kick();
  }
  function backToGallery(){
    if(fsActive) exitFS();
    running=false; paused=false;
    stage.hidden=true;
    gallery.style.display='';
    if(window.__arcadeMusic) window.__arcadeMusic.restore();
  }

  /* ── ввод ── */
  var KEYS={ ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],
             w:[0,-1],s:[0,1],a:[-1,0],d:[1,0], ц:[0,-1],ы:[0,1],ф:[-1,0],в:[1,0] };
  document.addEventListener('keydown', function(e){
    if(e.key==='Escape' && fsActive){ exitFS(); return; }
    if(!active()) return;
    var k=e.key, low=(k&&k.length===1)?k.toLowerCase():k;
    var v=KEYS[k]||KEYS[low];
    if(v){ e.preventDefault(); if(running&&!paused) setDir(v[0],v[1]); return; }
    if((k===' '||k==='Enter')){
      if(!scrStart.hidden){ e.preventDefault(); startRun(); }
      else if(!scrWin.hidden||!scrLose.hidden){ e.preventDefault(); startRun(); }
    }
  });
  if(dpad){
    function dpadDir(px,py){
      var r=dpad.getBoundingClientRect(), dx=px-(r.left+r.width/2), dy=py-(r.top+r.height/2);
      if(Math.abs(dx)<5 && Math.abs(dy)<5) return;
      if(Math.abs(dx)>Math.abs(dy)) setDir(dx>0?1:-1,0); else setDir(0,dy>0?1:-1);
    }
    dpad.addEventListener('pointerdown', function(e){
      e.preventDefault();
      var b=e.target.closest('[data-dir]');
      if(b){ var m={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[b.getAttribute('data-dir')]; if(m){ setDir(m[0],m[1]); return; } }
      dpadDir(e.clientX, e.clientY);   // попадание мимо кнопки — берём направление по позиции нажатия
    });
  }
  // свайпы по доске — низкий порог, можно свайпать подряд не отрывая палец
  var tsx=0,tsy=0,tracking=false;
  canvas.addEventListener('touchstart', function(e){ var t=e.changedTouches[0]; tsx=t.clientX; tsy=t.clientY; tracking=true; }, {passive:true});
  canvas.addEventListener('touchmove', function(e){
    if(!tracking) return;
    var t=e.changedTouches[0], dx=t.clientX-tsx, dy=t.clientY-tsy;
    if(Math.abs(dx)<15 && Math.abs(dy)<15) return;
    e.preventDefault();
    if(Math.abs(dx)>Math.abs(dy)) setDir(dx>0?1:-1,0); else setDir(0,dy>0?1:-1);
    tsx=t.clientX; tsy=t.clientY;   // переустанавливаем якорь для следующего свайпа
  }, {passive:false});
  canvas.addEventListener('touchend', function(){ tracking=false; }, {passive:true});

  /* ── кнопки ── */
  function bindLaunch(el){ if(el) el.addEventListener('click', function(e){ e.preventDefault(); launch(); }); }
  // карточка + кнопка "Играть"
  if(gallery){
    gallery.addEventListener('click', function(e){
      var t=e.target.closest('[data-game="snake87"]'); if(!t) return;
      if(t.tagName==='BUTTON' && t.hasAttribute('disabled')) return;
      e.preventDefault(); launch();
    });
  }
  if(backBtn) backBtn.addEventListener('click', function(e){ e.preventDefault(); backToGallery(); });
  if(startBtn) startBtn.addEventListener('click', function(e){ e.preventDefault(); startRun(); });
  if(winAgain) winAgain.addEventListener('click', function(e){ e.preventDefault(); startRun(); });
  if(loseAgain) loseAgain.addEventListener('click', function(e){ e.preventDefault(); startRun(); });
  if(winBack) winBack.addEventListener('click', function(e){ e.preventDefault(); backToGallery(); });
  if(loseBack) loseBack.addEventListener('click', function(e){ e.preventDefault(); backToGallery(); });
  if(sfxBtn) sfxBtn.addEventListener('click', function(e){
    e.preventDefault(); sfxOn=!sfxOn; syncSfxBtn();
    try{ localStorage.setItem('snake87_sfx', sfxOn?'1':'0'); }catch(err){}
    if(sfxOn) AC();
  });

  /* ── полноэкранный режим ── */
  function syncFsBtn(){
    if(!fsBtn) return;
    fsBtn.classList.toggle('fs-on', fsActive);
    fsBtn.setAttribute('aria-label', fsActive?'Выйти из полноэкранного режима':'На весь экран');
    fsBtn.title = fsActive?'Выйти':'На весь экран';
  }
  // глушим прокрутку/жесты страницы под игрой, не мешая кнопкам
  function blockTouch(e){
    if(e.target && e.target.closest && e.target.closest('button')) return;
    if(e.cancelable) e.preventDefault();
  }
  function blockWheel(e){ if(e.cancelable) e.preventDefault(); }
  function enterFS(){
    if(fsActive || !root) return;
    fsPlaceholder = document.createComment('sn-fs');
    root.parentNode.insertBefore(fsPlaceholder, root);   // запоминаем место
    document.body.appendChild(root);                      // выносим поверх всего
    root.classList.add('sn-fs');
    document.documentElement.classList.add('sn-fs-lock');
    document.body.classList.add('sn-fs-lock');
    window.addEventListener('touchmove', blockTouch, {passive:false});
    window.addEventListener('wheel', blockWheel, {passive:false});
    fsActive=true; syncFsBtn();
    try{ var rq=root.requestFullscreen||root.webkitRequestFullscreen;
         if(rq){ var pr=rq.call(root); if(pr&&pr.catch) pr.catch(function(){}); } }catch(e){}
    requestAnimationFrame(function(){ fit(); requestAnimationFrame(fit); });
  }
  function exitFS(){
    if(!fsActive) return;
    fsActive=false;
    root.classList.remove('sn-fs');
    document.documentElement.classList.remove('sn-fs-lock');
    document.body.classList.remove('sn-fs-lock');
    window.removeEventListener('touchmove', blockTouch, {passive:false});
    window.removeEventListener('wheel', blockWheel, {passive:false});
    if(fsPlaceholder && fsPlaceholder.parentNode){
      fsPlaceholder.parentNode.insertBefore(root, fsPlaceholder);   // возвращаем на место
      fsPlaceholder.parentNode.removeChild(fsPlaceholder);
    }
    fsPlaceholder=null;
    try{ if(document.fullscreenElement||document.webkitFullscreenElement){
           (document.exitFullscreen||document.webkitExitFullscreen).call(document); } }catch(e){}
    syncFsBtn();
    requestAnimationFrame(function(){ fit(); requestAnimationFrame(fit); });
  }
  function toggleFS(){ if(fsActive) exitFS(); else enterFS(); }
  if(fsBtn) fsBtn.addEventListener('click', function(e){ e.preventDefault(); toggleFS(); });
  function onFsChange(){ var fe=document.fullscreenElement||document.webkitFullscreenElement; if(!fe && fsActive) exitFS(); }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  /* ── выбор режима игры (сложность + границы) ── */
  (function initOpts(){
    var dr=$('snDiff'), wr=$('snWrap');
    function wire(group, attr, getCur, setCur, key){
      if(!group) return;
      var btns=group.querySelectorAll('button');
      Array.prototype.forEach.call(btns, function(b){
        b.classList.toggle('on', b.getAttribute(attr)===getCur());
        b.addEventListener('click', function(e){
          e.preventDefault(); setCur(b.getAttribute(attr));
          try{ localStorage.setItem(key, b.getAttribute(attr)); }catch(err){}
          Array.prototype.forEach.call(btns, function(x){ x.classList.toggle('on', x===b); });
        });
      });
    }
    wire(dr,'data-diff', function(){return diff;}, function(v){ if(DIFFS[v]) diff=v; }, 'snake87_diff');
    wire(wr,'data-wrap', function(){return wrap?'1':'0';}, function(v){ wrap=(v==='1'); }, 'snake87_wrap');
  })();

  /* ── интеграция с SPA ── */
  window.addEventListener('hashchange', function(){
    if(fsActive) exitFS();
    requestAnimationFrame(function(){ if(active()){ if(!fit()) requestAnimationFrame(fit); } });
  });
  window.addEventListener('resize', function(){ if(active()) fit(); });
  document.addEventListener('visibilitychange', function(){ if(document.hidden){ paused=true; } else if(active()){ paused=false; lastStep=performance.now(); } });

  // первичная подгонка карточного превью головы
  headImg.addEventListener('load', function(){ if(active()) render(performance.now()); });

  /* ── тест-хук (не в UI) ── */
  window.__sn87 = {
    launch:launch, start:startRun, back:backToGallery,
    setDir:function(n){ var m={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[n]; if(m) setDir(m[0],m[1]); },
    toggleFS:function(){ toggleFS(); }, enterFS:function(){ enterFS(); }, exitFS:function(){ exitFS(); },
    setMode:function(d,w){ if(DIFFS[d]) diff=d; wrap=!!w; },
    forceWin:function(){ if(snake){ while(snake.length<WIN_LEN-1){ snake.push({x:0,y:0}); } score=999; running=true; paused=false; turnQ=[]; food={x:snake[0].x+dir.x,y:snake[0].y+dir.y}; if(food.x<0||food.x>=GRID||food.y<0||food.y>=GRID){ dir={x:-1,y:0}; turnQ=[]; food={x:snake[0].x-1,y:snake[0].y}; } step(); } },
    forceLose:function(){ running=true; paused=false; dir={x:1,y:0}; turnQ=[]; snake=[{x:GRID-1,y:0}]; prev=snake.slice(); step(); },
    state:function(){ return { running:running, len:snake?snake.length:0, score:score, best:best,
      start:!scrStart.hidden, win:!scrWin.hidden, lose:!scrLose.hidden, stageHidden:stage.hidden, fs:fsActive, diff:diff, wrap:wrap,
      dir:{x:dir.x,y:dir.y}, head:snake?{x:snake[0].x,y:snake[0].y}:null, q:turnQ.length }; }
  };
})();
/* ═══════════ Пинг-понг 87 — Тимати (белые) против Джигана (розовые) ═══════════ */
(function(){
  "use strict";
  var view=document.getElementById('view-games'); if(!view) return;
  var $=function(id){ return document.getElementById(id); };
  var gallery=$('arcadeGallery'), stage=$('arcadeStagePong'), backBtn=$('pongBack'),
      canvas=$('pongCanvas'), youEl=$('pongYou'), aiEl=$('pongAi'),
      scrStart=$('pongStart'), scrWin=$('pongWin'), scrLose=$('pongLose'),
      startBtn=$('pongStartBtn'), winAgain=$('pongWinAgain'), winBack=$('pongWinBack'),
      loseAgain=$('pongLoseAgain'), loseBack=$('pongLoseBack'),
      dpad=$('pongDpad'), sfxBtn=$('pongSfx'), fsBtn=$('pongFs'), root=$('pong87'),
      headSrc=$('snHeadSrc'), timSrc=$('pongTimSrc'), cardHead=$('pongCardHead'), cardTim=$('pongCardTim');
  if(!canvas) return;
  var ctx=canvas.getContext('2d');
  /* аватары (Джиган/Тимати): грузим надёжно — при сбое webp падаем на png,
     на onload перерисовываем корт, чтобы лицо гарантированно проявилось */
  function loadAvatar(pic, card){
    var img=new Image();
    if(pic) window.MNpicSrc(pic, function(pref){
      var png=pic.src||pref;
      img.onload=function(){ try{ render(); }catch(e){} };
      img.onerror=function(){ if(png && img.src!==png){ img.onerror=null; img.src=png; } };
      img.src=pref; if(card) card.src=pref;
    });
    return img;
  }
  var headImg=loadAvatar(headSrc, cardHead);   // Джиган (красные)
  var timImg=loadAvatar(timSrc, cardTim);       // Тимати (белые)

  var WIN_SCORE=7, padW=0.26, padH=0.042, ballR=0.023, TOP=0.085, BOT=0.915;
  var DIFFS={
    easy:    { ai:0.75, ball:0.72, max:1.15, err:0.30,  lead:0.05 },
    classic: { ai:1.05, ball:0.86, max:1.50, err:0.19,  lead:0.12 },
    hard:    { ai:1.45, ball:1.00, max:1.90, err:0.075, lead:0.18 }
  };
  var diff='classic';
  try{ var sd=localStorage.getItem('pong87_diff'); if(sd&&DIFFS[sd]) diff=sd; }catch(e){}

  var sizePx=0, you=0.5, youTarget=0.5, ai=0.5, ball=null, youScore=0, aiScore=0,
      running=false, raf=null, last=0, keyDir=0, aiErr=0, aiTracking=false, auto=false;

  /* ── звук ── */
  var actx=null, sfxOn=true;
  try{ sfxOn=localStorage.getItem('snake87_sfx')!=='0'; }catch(e){}
  function syncSfx(){ if(sfxBtn) sfxBtn.classList.toggle('off',!sfxOn); }
  syncSfx();
  function AC(){ if(window.__arcadeAC) return window.__arcadeAC(); if(actx===null){ try{ actx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ actx=false; } } if(actx&&actx.state==='suspended') actx.resume(); return actx||null; }
  function tone(f,t0,dur,type,vol){ var a=AC(); if(!a) return; var o=a.createOscillator(),g=a.createGain(); o.type=type||'square'; o.frequency.setValueAtTime(f,a.currentTime+t0); g.gain.setValueAtTime(0.0001,a.currentTime+t0); g.gain.exponentialRampToValueAtTime(vol||0.1,a.currentTime+t0+0.01); g.gain.exponentialRampToValueAtTime(0.0001,a.currentTime+t0+dur); o.connect(g); g.connect(a.destination); o.start(a.currentTime+t0); o.stop(a.currentTime+t0+dur+0.02); }
  function sHitYou(){ if(sfxOn) tone(540,0,0.05,'square',0.12); }
  function sHitAi(){ if(sfxOn) tone(360,0,0.05,'square',0.12); }
  function sWall(){ if(sfxOn) tone(760,0,0.03,'triangle',0.07); }
  function sScore(){ if(sfxOn) tone(300,0,0.13,'sawtooth',0.10); }
  function sWin(){ if(!sfxOn) return; var n=[523,659,784,1046,1318]; for(var i=0;i<n.length;i++) tone(n[i],i*0.11,0.16,'square',0.11); }
  function sLose(){ if(!sfxOn) return; var a=AC(); if(!a) return; var o=a.createOscillator(),g=a.createGain(); o.type='sawtooth'; o.frequency.setValueAtTime(360,a.currentTime); o.frequency.exponentialRampToValueAtTime(70,a.currentTime+0.55); g.gain.setValueAtTime(0.16,a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001,a.currentTime+0.6); o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime+0.62); }

  /* ── размеры ── */
  function fit(){ var wrap=canvas.parentElement, w=wrap?wrap.clientWidth:0; if(!w) return false; sizePx=w;
    var dpr=Math.min(window.devicePixelRatio||1,2); canvas.width=Math.round(sizePx*dpr); canvas.height=Math.round(sizePx*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0); render(); return true; }

  function clampPad(v){ return Math.max(padW/2, Math.min(1-padW/2, v)); }
  function resetBall(dir){ var d=DIFFS[diff], ang=(Math.random()*0.7-0.35), sp=d.ball;
    ball={ x:0.5, y:0.5, vx:Math.sin(ang)*sp, vy:(dir||(Math.random()<0.5?1:-1))*Math.abs(Math.cos(ang))*sp }; }
  function reset(){ you=0.5; youTarget=0.5; ai=0.5; youScore=0; aiScore=0; keyDir=0; aiErr=0; aiTracking=false; resetBall(); updateHud(); }
  function updateHud(){ if(youEl) youEl.textContent=youScore; if(aiEl) aiEl.textContent=aiScore; }

  function bounce(center, vyDir, d){
    var off=Math.max(-1,Math.min(1,(ball.x-center)/(padW/2)));
    var sp=Math.min(d.max, Math.hypot(ball.vx,ball.vy)*1.05);
    var ang=off*1.05;
    ball.vx=Math.sin(ang)*sp;
    ball.vy=vyDir*Math.abs(Math.cos(ang))*sp;
    if(Math.abs(ball.vy)<sp*0.4){ ball.vy=vyDir*sp*0.4; }
  }
  function step(dt){
    var d=DIFFS[diff];
    // игрок (Тимати)
    if(auto && ball) youTarget=clampPad(ball.x);
    if(keyDir) youTarget=clampPad(youTarget+keyDir*1.7*dt);
    you += (youTarget-you)*Math.min(1,dt*18); you=clampPad(you);
    // ИИ (Джиган) — реагирует, когда мяч летит вверх
    // ИИ Джигана: на каждый заход мяча выбирает прицел со своей ошибкой (зависит от уровня)
    if(ball.vy<0){
      if(!aiTracking){ aiTracking=true; aiErr=(Math.random()*2-1)*d.err; }
      var target = clampPad(ball.x + ball.vx*d.lead + aiErr);
      var mv = d.ai*dt;
      ai += Math.max(-mv, Math.min(mv, target-ai));
    } else {
      aiTracking=false;
      ai += (0.5-ai)*Math.min(1, dt*1.0);   // мяч уходит — лениво к центру
    }
    ai=clampPad(ai);
    // мяч
    ball.x+=ball.vx*dt; ball.y+=ball.vy*dt;
    if(ball.x<ballR){ ball.x=ballR; ball.vx=Math.abs(ball.vx); sWall(); }
    else if(ball.x>1-ballR){ ball.x=1-ballR; ball.vx=-Math.abs(ball.vx); sWall(); }
    if(ball.vy<0 && ball.y-ballR<=TOP+padH/2 && ball.y>TOP-padH){
      if(Math.abs(ball.x-ai)<=padW/2+ballR){ bounce(ai,1,d); ball.y=TOP+padH/2+ballR; sHitAi(); }
    }
    if(ball.vy>0 && ball.y+ballR>=BOT-padH/2 && ball.y<BOT+padH){
      if(Math.abs(ball.x-you)<=padW/2+ballR){ bounce(you,-1,d); ball.y=BOT-padH/2-ballR; sHitYou(); }
    }
    if(ball.y<-0.03){ youScore++; updateHud(); sScore(); if(youScore>=WIN_SCORE) return win(); resetBall(1); }
    else if(ball.y>1.03){ aiScore++; updateHud(); sScore(); if(aiScore>=WIN_SCORE) return lose(); resetBall(-1); }
  }

  /* ── отрисовка ── */
  function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  function render(){
    if(!sizePx) return; var S=sizePx;
    ctx.clearRect(0,0,S,S);
    // рамка корта
    ctx.strokeStyle='rgba(247,244,238,.22)'; ctx.lineWidth=Math.max(1.5,S*0.004);
    ctx.strokeRect(S*0.02, S*0.02, S*0.96, S*0.96);
    // центральная сетка
    ctx.strokeStyle='rgba(247,244,238,.18)'; ctx.lineWidth=2; ctx.setLineDash([S*0.022,S*0.022]);
    ctx.beginPath(); ctx.moveTo(S*0.04,S*0.5); ctx.lineTo(S*0.96,S*0.5); ctx.stroke(); ctx.setLineDash([]);
    // зоны ворот (тонкая подсветка краёв)
    var _ai='rgba('+(getComputedStyle(document.documentElement).getPropertyValue('--flash-ai').trim()||'253,164,194'), _you='rgba('+(getComputedStyle(document.documentElement).getPropertyValue('--flash-you').trim()||'247,244,238');
    var g1=ctx.createLinearGradient(0,0,0,S*0.05); g1.addColorStop(0,_ai+',.18)'); g1.addColorStop(1,_ai+',0)');
    ctx.fillStyle=g1; ctx.fillRect(0,0,S,S*0.05);
    var g2=ctx.createLinearGradient(0,S*0.95,0,S); g2.addColorStop(0,_you+',0)'); g2.addColorStop(1,_you+',.18)');
    ctx.fillStyle=g2; ctx.fillRect(0,S*0.95,S,S*0.05);
    // мяч
    // мяч — плоский квадрат, без свечения
    if(ball){ var bx=ball.x*S, by=ball.y*S, br=ballR*S;
      ctx.fillStyle='#F7F4EE'; ctx.fillRect(bx-br,by-br,br*2,br*2); }
    drawPaddle(ai, TOP, window.MNgc('p2','#FDA4C2'), headImg);
    drawPaddle(you, BOT, window.MNgc('p1','#F7F4EE'), timImg);
  }
  /* ракетка — плоский прямоугольник, аватар — квадрат с обводкой цвета игрока
     (свечения shadowBlur убраны: и не в стиле, и дорого на каждом кадре) */
  function drawPaddle(cx, cy, color, img){
    var S=sizePx, w=padW*S, h=padH*S, x=cx*S, y=cy*S;
    ctx.fillStyle=color; ctx.fillRect(x-w/2,y-h/2,w,h);
    var r=Math.min(S*0.062, w*0.4), d=r*2;
    ctx.fillStyle='#050505'; ctx.fillRect(x-r,y-r,d,d);
    if(img && img.complete && img.naturalWidth){ ctx.drawImage(img, x-r, y-r, d, d); }
    else { ctx.fillStyle=color; ctx.fillRect(x-r,y-r,d,d); }
    var lw=Math.max(2,S*0.009);
    ctx.lineWidth=lw; ctx.strokeStyle=color; ctx.strokeRect(x-r+lw/2, y-r+lw/2, d-lw, d-lw);
  }

  /* ── цикл ── */
  function active(){ return view.classList.contains('active') && !stage.hidden; }
  function loop(now){
    if(!active() || document.hidden){ raf=null; last=now; return; }  // авто-стоп вне раздела/вкладки
    raf=requestAnimationFrame(loop);
    var dt=(now-last)/1000; last=now; if(dt>0.05) dt=0.05; if(dt<0) dt=0;
    if(running){ step(dt); }
    render();
  }
  function kick(){ if(raf===null){ last=performance.now(); raf=requestAnimationFrame(loop); } }
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) kick(); });
  window.addEventListener('hashchange', function(){ if(active()) kick(); });

  /* ── экраны ── */
  function showScreen(w){
    scrStart.hidden=w!=='start'; scrWin.hidden=w!=='win'; scrLose.hidden=w!=='lose';
    if(w==='win'){ scrWin.classList.remove('win'); void scrWin.offsetWidth; scrWin.classList.add('win'); if(window.__arcadeWinFX) window.__arcadeWinFX(scrWin); }
    if(w==='lose'){ var c=scrLose.querySelector('.sn-cross'); if(c){ var n=c.cloneNode(true); c.parentNode.replaceChild(n,c); } }
  }
  function startRun(){ AC(); scrStart.hidden=true; scrWin.hidden=true; scrLose.hidden=true; reset(); running=true; if(!fit()) requestAnimationFrame(fit); last=performance.now(); kick(); }
  function win(){ running=false; showScreen('win'); sWin(); }
  function lose(){ running=false; showScreen('lose'); sLose(); }
  function launch(){
    gallery.style.display='none'; stage.hidden=false;
    try{ root.scrollIntoView({block:'center'}); }catch(e){}
    if(window.__arcadeMusic) window.__arcadeMusic.duck();
    running=false; reset();
    requestAnimationFrame(function(){ if(!fit()) requestAnimationFrame(fit); });
    showScreen('start'); kick();
  }
  function backToGallery(){
    if(window.__arcadeFS && window.__arcadeFS.isActive()) window.__arcadeFS.exit();
    running=false; stage.hidden=true; gallery.style.display='';
    if(window.__arcadeMusic) window.__arcadeMusic.restore();
  }

  /* ── ввод ── */
  var KEYS={ ArrowLeft:-1, ArrowRight:1, a:-1, d:1, ф:-1, в:1 };
  document.addEventListener('keydown', function(e){
    if(e.key==='Escape' && window.__arcadeFS && window.__arcadeFS.isActive()){ window.__arcadeFS.exit(); return; }
    if(!active()) return;
    var k=e.key, low=(k&&k.length===1)?k.toLowerCase():k, v=KEYS[k]; if(v===undefined) v=KEYS[low];
    if(v!==undefined){ e.preventDefault(); if(running) keyDir=v; return; }
    if(k===' '||k==='Enter'){ if(!scrStart.hidden){ e.preventDefault(); startRun(); } else if(!scrWin.hidden||!scrLose.hidden){ e.preventDefault(); startRun(); } }
  });
  document.addEventListener('keyup', function(e){ if(!active()) return; var k=e.key, low=(k&&k.length===1)?k.toLowerCase():k, v=KEYS[k]; if(v===undefined) v=KEYS[low]; if(v!==undefined) keyDir=0; });
  if(dpad){
    dpad.addEventListener('pointerdown', function(e){
      e.preventDefault();
      var b=e.target.closest('[data-dir]');
      if(b){ keyDir = b.getAttribute('data-dir')==='left'?-1:1; return; }
      var r=dpad.getBoundingClientRect();         // мимо кнопки — по половине области
      keyDir = (e.clientX < r.left+r.width/2) ? -1 : 1;
    });
    var clr=function(){ keyDir=0; };
    dpad.addEventListener('pointerup',clr); dpad.addEventListener('pointerleave',clr); dpad.addEventListener('pointercancel',clr);
  }
  function setFromX(clientX){ var r=canvas.getBoundingClientRect(); if(!r.width) return; youTarget=clampPad((clientX-r.left)/r.width); }
  canvas.addEventListener('pointermove', function(e){ if(running) setFromX(e.clientX); });
  canvas.addEventListener('pointerdown', function(e){ if(running) setFromX(e.clientX); });
  canvas.addEventListener('touchmove', function(e){ if(!running) return; var t=e.changedTouches[0]; setFromX(t.clientX); if(e.cancelable) e.preventDefault(); }, {passive:false});

  /* ── кнопки ── */
  if(gallery){ gallery.addEventListener('click', function(e){ var t=e.target.closest('[data-game="pong87"]'); if(!t) return; if(t.tagName==='BUTTON'&&t.hasAttribute('disabled')) return; e.preventDefault(); launch(); }); }
  if(backBtn) backBtn.addEventListener('click', function(e){ e.preventDefault(); backToGallery(); });
  if(startBtn) startBtn.addEventListener('click', function(e){ e.preventDefault(); startRun(); });
  if(winAgain) winAgain.addEventListener('click', function(e){ e.preventDefault(); startRun(); });
  if(loseAgain) loseAgain.addEventListener('click', function(e){ e.preventDefault(); startRun(); });
  if(winBack) winBack.addEventListener('click', function(e){ e.preventDefault(); backToGallery(); });
  if(loseBack) loseBack.addEventListener('click', function(e){ e.preventDefault(); backToGallery(); });
  if(sfxBtn) sfxBtn.addEventListener('click', function(e){ e.preventDefault(); sfxOn=!sfxOn; syncSfx(); try{ localStorage.setItem('snake87_sfx', sfxOn?'1':'0'); }catch(err){} if(sfxOn) AC(); });
  if(fsBtn) fsBtn.addEventListener('click', function(e){ e.preventDefault(); if(window.__arcadeFS) window.__arcadeFS.toggle(root, fsBtn, function(){ fit(); requestAnimationFrame(fit); }); });

  /* ── выбор сложности ── */
  (function(){ var dr=$('pongDiff'); if(!dr) return; var btns=dr.querySelectorAll('button');
    Array.prototype.forEach.call(btns, function(b){
      b.classList.toggle('on', b.getAttribute('data-diff')===diff);
      b.addEventListener('click', function(e){ e.preventDefault(); var v=b.getAttribute('data-diff'); if(DIFFS[v]) diff=v;
        try{ localStorage.setItem('pong87_diff', diff); }catch(err){}
        Array.prototype.forEach.call(btns, function(x){ x.classList.toggle('on', x===b); }); });
    });
  })();

  /* ── SPA ── */
  window.addEventListener('hashchange', function(){ requestAnimationFrame(function(){ if(active()){ if(!fit()) requestAnimationFrame(fit); } }); });
  window.addEventListener('resize', function(){ if(active()) fit(); });
  headImg.addEventListener('load', function(){ if(active()) render(); });
  timImg.addEventListener('load', function(){ if(active()) render(); });

  /* ── тест-хук ── */
  window.__pong87 = {
    _auto:function(v){ auto=!!v; },
    launch:launch, start:startRun, back:backToGallery,
    setDiff:function(d){ if(DIFFS[d]) diff=d; },
    forceWin:function(){ youScore=WIN_SCORE-1; running=true; ball={x:0.5,y:-0.05,vx:0,vy:-0.6}; step(0.02); },
    forceLose:function(){ aiScore=WIN_SCORE-1; running=true; ball={x:0.5,y:1.05,vx:0,vy:0.6}; step(0.02); },
    state:function(){ return { running:running, you:youScore, ai:aiScore, start:!scrStart.hidden, win:!scrWin.hidden, lose:!scrLose.hidden, stageHidden:stage.hidden, fs:(window.__arcadeFS?window.__arcadeFS.isActive():false), diff:diff }; }
  };
})();

/* доп. эффекты игр: вспышка поля при наборе очков (наблюдатель, логика игр не трогается) */
(function(){
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  function flash(board, kind){
    if(!board) return;
    var f=document.createElement('div'); f.className='mn-flash '+kind;
    board.appendChild(f);
    setTimeout(function(){ if(f.parentNode) f.parentNode.removeChild(f); }, 560);
  }
  function watch(id, getBoard, kind){
    var el=document.getElementById(id); if(!el) return;
    var lastN=parseInt(el.textContent,10); if(isNaN(lastN)) lastN=0;
    new MutationObserver(function(){
      var n=parseInt(el.textContent,10); if(isNaN(n)) return;
      if(n>lastN) flash(getBoard(), kind);
      lastN=n;
    }).observe(el,{childList:true,characterData:true,subtree:true});
  }
  function snB(){ return document.querySelector('#snake87 .sn-board-wrap'); }
  function pgB(){ return document.querySelector('#pong87 .sn-board-wrap'); }
  function init(){ watch('snScore', snB, 'go'); watch('pongYou', pgB, 'goblue'); watch('pongAi', pgB, 'gored'); }
  if(document.readyState!=='loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
