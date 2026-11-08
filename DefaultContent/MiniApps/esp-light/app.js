'use strict';
const ids=['connection-screen','control-screen','status','control-status','search','grant','devices','device-label','sync','controls','power','brightness','brightness-value','brightness-minus','brightness-plus','effect','lamp-name','color-panel','wheel-panel','rainbow-panel','fire-panel','custom-panel','timer-panel','palette','wheel','wheel-color','lamp','rotate-left','rotate-right','led-select','paint-led','selected-panel','selected-id','pixel-color','pixel-off','brush-color','brush-palette','clear-leds','rainbow-mode','fire-color','fire-reset','presets-nav','editor-screen','presets-panel','presets-list','presets-empty','preset-current','save-preset','preset-name-form','preset-name','preset-name-cancel','timer-hours','timer-minutes','timer-start','timer-cancel','timer-status',...['speed','height','width','smooth','intensity'].flatMap(k=>['fire-'+k,'fire-'+k+'-value'])];
const ui=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
let view={devices:[],busy:false,message:'Подготовка…'},selectedPixel=null,selectionDevice=null,brushColor='#ff8844',client=null,presetStore=null;
let presetsPage=false,modeOverride=null,nameOperation=null,storeBusy=false,presetsSignature='',timerStateTime=0,appliedPreset=null;
const modeNames={color:'Цвет',wheel:'Цветовой круг',rainbow:'Радуга',fire:'Огонь',custom:'Кастом',timer:'Таймер'};
const busy=()=>!!view.busy||storeBusy;
const currentMode=()=>modeOverride||view.state?.effect;
const lampView=new LampVisual.LampView(ui.lamp,index=>{
  if(!view.state||busy())return;
  selectedPixel=index;render(view);action(()=>client.setPixel(index,brushColor,true));
});
const colorWheel=new LampVisual.ColorWheel(ui.wheel,color=>action(()=>client.patch({color})));
function makePalette(element,choose){
  for(const [name,color] of LampVisual.palette){const button=document.createElement('button');button.type='button';button.style.setProperty('--swatch',color);button.dataset.color=color;button.setAttribute('aria-label',name);button.title=name;button.onclick=()=>choose(color);element.append(button);}
}
makePalette(ui.palette,color=>action(()=>client.patch({color})));
makePalette(ui['brush-palette'],color=>{brushColor=color;ui['brush-color'].value=color;render(view);});
function timerDuration(){
  const hours=Number(ui['timer-hours'].value),minutes=Number(ui['timer-minutes'].value),total=hours*60+minutes;
  if(!Number.isInteger(hours)||hours<0||hours>23||!Number.isInteger(minutes)||minutes<0||minutes>59||total<1||total>view.info.maxTimerMinutes)throw new Error('Выберите время: от 1 минуты до 23 часов 59 минут');
  return total;
}
function displayTimer(){
  if(!view.state?.timer?.active){ui['timer-status'].textContent='Таймер не запущен';return;}
  const seconds=Math.max(0,view.state.timer.remainingSeconds-Math.floor((Date.now()-timerStateTime)/1000));
  ui['timer-status'].textContent=seconds===0?'Выключение…':`До выключения: ${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}
function renderPresets(){
  const items=presetStore?.items||[],signature=JSON.stringify(items);
  if(signature!==presetsSignature){
    presetsSignature=signature;ui['presets-list'].replaceChildren();
    for(const p of items){
      const card=document.createElement('div');card.className='preset-card';const title=document.createElement('strong');title.textContent=p.name;
      const details=document.createElement('small');details.textContent=modeNames[p.config.uiMode]+' · '+p.config.brightnessPercent+'%'+(p.config.uiMode!=='timer'&&!p.config.on?' · выключено':'');
      const buttons=document.createElement('div');buttons.className='preset-actions';
      for(const [label,fn] of [
        ['Выбрать',()=>action(async()=>{const connection=client.connection,patch=LampPresets.patchFor(p.config,view.info);await client.patch(patch);if(client.connection!==connection)return;modeOverride=p.config.uiMode==='timer'?'timer':null;appliedPreset=p.id;render(view);})],
        ['Переименовать',()=>openName({kind:'rename',id:p.id},p.name)],
        ['Удалить',()=>storeAction(()=>presetStore.remove(p.id))]
      ]){const b=document.createElement('button');b.type='button';b.textContent=label;b.className='secondary';b.onclick=fn;buttons.append(b);}
      card.append(title,details,buttons);ui['presets-list'].append(card);
    }
  }
  ui['presets-empty'].hidden=items.length>0;
  const applied=items.find(p=>p.id===appliedPreset);ui['preset-current'].textContent=applied?'Выбран: '+applied.name:'';
}
function openName(operation,name=''){
  nameOperation=operation;ui['preset-name-form'].hidden=false;ui['preset-name'].value=name;ui['preset-name'].focus();
}
function render(value){
  if(value.state&&value.info.version<3)value={...value,state:null,message:'Загрузите новый скетч MiniAppLight с подрежимами радуги, настройками огня и таймером.'};
  const previous=view;view=value;const connected=!!value.state;
  if(ui.controls.disabled!==!connected)ui.controls.disabled=!connected;
  ui.controls.setAttribute('aria-busy',String(busy()));
  if(ui.sync.disabled!==!connected)ui.sync.disabled=!connected;
  ui.sync.setAttribute('aria-disabled',String(busy()));if(ui['presets-nav'].disabled!==!connected)ui['presets-nav'].disabled=!connected;
  if(connected&&busy()&&value.state===previous.state&&value.info===previous.info&&value.selected===previous.selected)return;
  if(ui['connection-screen'].hidden!==connected)ui['connection-screen'].hidden=connected;
  if(ui['control-screen'].hidden!==!connected)ui['control-screen'].hidden=!connected;
  ui.status.textContent=value.message;ui['device-label'].hidden=value.devices.length===0;
  const signature=value.devices.map(d=>d.id+':'+d.name).join('|');
  if(ui.devices.dataset.signature!==signature){ui.devices.replaceChildren(new Option('Выберите лампу',''),...value.devices.map(d=>new Option(d.name,d.id)));ui.devices.dataset.signature=signature;}ui.devices.value=value.selected||'';
  if(selectionDevice!==value.selected){selectionDevice=value.selected;selectedPixel=null;modeOverride=null;appliedPreset=null;nameOperation=null;ui['preset-name-form'].hidden=true;}
  if(!connected){lampView.update(null,null,null);colorWheel.update('#000000',false);return;}
  const state=value.state,info=value.info;ui['lamp-name'].textContent=info.name;
  if(state!==previous.state)timerStateTime=Date.now();
  ui['presets-nav'].textContent=presetsPage?'Управление':'Пресеты';ui['editor-screen'].hidden=presetsPage;ui['presets-panel'].hidden=!presetsPage;renderPresets();
  ui.power.textContent=state.on?'Выключить свет':'Включить свет';ui.power.setAttribute('aria-pressed',String(state.on));
  if(document.activeElement!==ui.brightness)ui.brightness.value=state.brightnessPercent;
  ui['brightness-value'].textContent=ui.brightness.value+'% · '+state.currentLimitMa+' мА';ui.effect.value=currentMode();
  for(const mode of Object.keys(modeNames))ui[mode+'-panel'].hidden=currentMode()!==mode;
  ui['rainbow-mode'].value=state.rainbowMode;ui['fire-color'].value=state.fire.color;
  const firePreview=ui['fire-panel'].querySelector('.fire-preview');
  firePreview.style.background=state.fire.color==='#000000'?'#10120f':`radial-gradient(ellipse at 45% 110%,#ffffff 0%,${state.fire.color} 35%,#10120f 83%)`;
  for(const key of ['speed','height','width','smooth','intensity']){
    const field=ui['fire-'+key];if(document.activeElement!==field)field.value=state.fire[key];ui['fire-'+key+'-value'].textContent=field.value+'%';
  }
  if(state.timer.minutes>0&&state.timer.minutes!==previous.state?.timer?.minutes){ui['timer-hours'].value=Math.floor(state.timer.minutes/60);ui['timer-minutes'].value=state.timer.minutes%60;}
  displayTimer();if(ui['timer-cancel'].disabled!==!state.timer.active)ui['timer-cancel'].disabled=!state.timer.active;
  for(const button of ui.palette.children)button.setAttribute('aria-pressed',String(button.dataset.color.toLowerCase()===state.color.toLowerCase()));
  ui['wheel-color'].value=state.color;colorWheel.update(state.color,!busy()&&currentMode()==='wheel');
  const count=info.ledCount;
  if(ui['led-select'].dataset.count!==String(count)){ui['led-select'].replaceChildren(new Option('Выберите LED',''),...Array.from({length:count},(_,i)=>new Option('LED '+(i+1),String(i))));ui['led-select'].dataset.count=String(count);}
  if(selectedPixel!==null&&selectedPixel>=count)selectedPixel=null;
  ui['led-select'].value=selectedPixel===null?'':String(selectedPixel);
  if(ui['paint-led'].disabled!==(selectedPixel===null))ui['paint-led'].disabled=selectedPixel===null;
  ui['selected-panel'].hidden=selectedPixel===null;
  if(selectedPixel!==null){ui['selected-id'].textContent=selectedPixel+1;ui['pixel-color'].value='#'+state.pixels.slice(selectedPixel*6,selectedPixel*6+6);}
  for(const button of ui['brush-palette'].children)button.setAttribute('aria-pressed',String(button.dataset.color===brushColor));
  lampView.update(info,state,selectedPixel);
}
async function action(fn){
  ui['control-status'].hidden=true;
  try{return await fn();}catch(e){const message=e.message||String(e);if(view.state){ui['control-status'].textContent=message;ui['control-status'].hidden=false;}else ui.status.textContent=message;}
}
async function storeAction(fn){
  if(storeBusy)return;storeBusy=true;render(view);
  try{return await action(fn);}finally{storeBusy=false;render(view);}
}
ui['rotate-left'].onclick=()=>lampView.rotate(-.4);ui['rotate-right'].onclick=()=>lampView.rotate(.4);
ui['brush-color'].oninput=()=>{brushColor=ui['brush-color'].value;render(view);};
ui['led-select'].onchange=()=>{selectedPixel=ui['led-select'].value===''?null:Number(ui['led-select'].value);render(view);};
ui['paint-led'].onclick=()=>action(()=>client.setPixel(selectedPixel,brushColor));
ui['pixel-color'].onchange=()=>action(()=>client.setPixel(selectedPixel,ui['pixel-color'].value));
ui['pixel-off'].onclick=()=>action(()=>client.setPixel(selectedPixel,'#000000'));
ui['clear-leds'].onclick=()=>action(()=>client.patch({clear:1}));
ui['presets-nav'].onclick=()=>{if(busy())return;presetsPage=!presetsPage;ui['preset-name-form'].hidden=true;render(view);if(presetsPage&&!presetStore.loaded)storeAction(()=>presetStore.load());};
ui['save-preset'].onclick=()=>action(()=>openName({kind:'create',config:LampPresets.snapshot(view.state,currentMode(),currentMode()==='timer'?timerDuration():0)}));
ui['preset-name-cancel'].onclick=()=>{nameOperation=null;ui['preset-name-form'].hidden=true;};
ui['preset-name-form'].onsubmit=event=>{event.preventDefault();if(!nameOperation||busy())return;const operation=nameOperation,name=ui['preset-name'].value;
  storeAction(async()=>{if(operation.kind==='create')await presetStore.add(name,operation.config);else await presetStore.rename(operation.id,name);nameOperation=null;ui['preset-name-form'].hidden=true;});};
for(const type of ['pointerdown','pointerup','click','keydown','input','change'])ui.controls.addEventListener(type,event=>{
  if(!busy()||(type==='keydown'&&['Tab','Escape'].includes(event.key)))return;event.preventDefault();event.stopImmediatePropagation();
},{capture:true});
const countdownTick=setInterval(()=>{if(!document.hidden&&view.state)displayTimer();},1000);
if(!window.mini){ui.status.textContent='Откройте мини-аппку в MiniApp Runtime 1.5.0 или новее.';ui.search.disabled=true;}
else{
  client=new LightClient(window.mini,render);presetStore=new LampPresets.PresetStore(mini.storage);
  ui.grant.onclick=()=>action(async()=>{ui.grant.hidden=true;if(!await client.start(true))ui.grant.hidden=false;});
  ui.search.onclick=()=>action(()=>client.running?client.search():client.start(true));
  ui.devices.onchange=()=>{if(ui.devices.value)action(()=>client.choose(ui.devices.value));};
  ui.sync.onclick=()=>{if(!busy())action(()=>client.sync());};ui.power.onclick=()=>action(()=>client.patch({on:!view.state.on}));
  const setBrightness=percent=>action(()=>client.patch({brightnessPercent:Math.max(0,Math.min(100,percent))}));
  ui.brightness.oninput=()=>{ui['brightness-value'].textContent=ui.brightness.value+'% · '+Math.round(view.info.maxCurrentMa*Number(ui.brightness.value)/100)+' мА';};
  ui.brightness.onchange=()=>setBrightness(Number(ui.brightness.value));
  ui['brightness-minus'].onclick=()=>setBrightness(view.state.brightnessPercent-1);ui['brightness-plus'].onclick=()=>setBrightness(view.state.brightnessPercent+1);
  ui['wheel-color'].onchange=()=>action(()=>client.patch({color:ui['wheel-color'].value}));
  ui.effect.onchange=()=>{const mode=ui.effect.value;modeOverride=mode==='timer'?'timer':null;if(mode==='timer')render(view);else action(()=>client.patch({effect:mode}));};
  ui['rainbow-mode'].onchange=()=>action(()=>client.patch({rainbowMode:ui['rainbow-mode'].value}));
  ui['fire-color'].onchange=()=>action(()=>client.patch({fireColor:ui['fire-color'].value}));
  for(const key of ['speed','height','width','smooth','intensity']){
    ui['fire-'+key].oninput=()=>{ui['fire-'+key+'-value'].textContent=ui['fire-'+key].value+'%';};
    ui['fire-'+key].onchange=()=>action(()=>client.patch({['fire'+key[0].toUpperCase()+key.slice(1)]:Number(ui['fire-'+key].value)}));
  }
  ui['fire-reset'].onclick=()=>action(()=>client.patch({resetFire:1}));
  ui['timer-start'].onclick=()=>action(()=>client.patch({timerMinutes:timerDuration(),on:true}));ui['timer-cancel'].onclick=()=>action(()=>client.patch({timerMinutes:0}));
  document.addEventListener('visibilitychange',()=>document.hidden?client.pause():action(()=>client.resume()));
  mini.events.on('app.pause',()=>client.pause());mini.events.on('app.resume',()=>action(()=>client.resume()));
  mini.events.on('network.statusChanged',()=>{if(!client.paused&&client.running)action(()=>client.search());});
  window.addEventListener('pagehide',()=>{client.stop();lampView.dispose();colorWheel.dispose();clearInterval(countdownTick);},{once:true});
  action(async()=>{if(!await client.start())ui.grant.hidden=false;});
  action(async()=>{if(await mini.permissions.query('storage')==='granted'){await presetStore.load();render(view);}});
}
