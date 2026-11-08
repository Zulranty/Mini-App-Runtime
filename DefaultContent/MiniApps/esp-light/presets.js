(function(root){
  'use strict';
  const KEY='light.presets.v1',MAX_PRESETS=100;
  const hex=value=>typeof value==='string'&&value.length===7&&/^#[0-9a-f]{6}$/i.test(value);
  function validConfig(c){
    return c&&typeof c.on==='boolean'&&Number.isInteger(c.brightnessPercent)&&c.brightnessPercent>=0&&c.brightnessPercent<=100&&hex(c.color)&&
      ['color','wheel','rainbow','fire','custom'].includes(c.effect)&&['forward','side','down','up'].includes(c.rainbowMode)&&
      (c.uiMode===c.effect||c.uiMode==='timer')&&Number.isInteger(c.timerMinutes)&&c.timerMinutes>=0&&c.timerMinutes<=1440&&
      (c.uiMode!=='timer'||c.timerMinutes>0)&&c.fire&&hex(c.fire.color)&&
      ['speed','height','width','smooth','intensity'].every(k=>Number.isInteger(c.fire[k])&&c.fire[k]>=(['smooth','intensity'].includes(k)?0:1)&&c.fire[k]<=100)&&
      (c.effect!=='custom'||(Number.isInteger(c.ledCount)&&c.ledCount>=1&&c.ledCount<=512&&typeof c.pixels==='string'&&c.pixels.length===c.ledCount*6&&!/[^0-9a-f]/i.test(c.pixels)));
  }
  function snapshot(state,uiMode,timerMinutes){
    const c={on:state.on,brightnessPercent:state.brightnessPercent,color:state.color,effect:state.effect,rainbowMode:state.rainbowMode,
      fire:{...state.fire},uiMode,timerMinutes:uiMode==='timer'?timerMinutes:0};
    if(c.effect==='custom'){c.ledCount=state.pixels.length/6;c.pixels=state.pixels;}
    if(!validConfig(c))throw new Error('Проверьте настройки и время таймера');
    return c;
  }
  function patchFor(c,info){
    if(!validConfig(c))throw new Error('Некорректный пресет');
    if(c.effect==='custom'&&c.ledCount!==info.ledCount)throw new Error('Этот рисунок сохранён для лампы с другим числом LED');
    if(c.timerMinutes>info.maxTimerMinutes)throw new Error('Лампа не поддерживает такую длительность таймера');
    return {on:c.uiMode==='timer'?true:c.on,brightnessPercent:c.brightnessPercent,color:c.color,effect:c.effect,rainbowMode:c.rainbowMode,
      fireSpeed:c.fire.speed,fireHeight:c.fire.height,fireWidth:c.fire.width,fireSmooth:c.fire.smooth,fireIntensity:c.fire.intensity,fireColor:c.fire.color,
      timerMinutes:c.timerMinutes,...(c.effect==='custom'?{pixels:c.pixels}:{})};
  }
  class PresetStore{
    constructor(storage){this.storage=storage;this.items=[];this.loaded=false;this.queue=Promise.resolve();}
    async read(){
      this.loaded=false;
      const data=await this.storage.get(KEY);
      if(data!==null&&data!==undefined&&(!Array.isArray(data)||data.length>MAX_PRESETS||!data.every(p=>typeof p.id==='string'&&p.id.length<=80&&typeof p.name==='string'&&p.name.trim().length>0&&p.name.length<=60&&validConfig(p.config))||new Set(data.map(p=>p.id)).size!==data.length))
        throw new Error('Не удалось прочитать сохранённые пресеты');
      this.items=structuredClone(data||[]);this.loaded=true;return this.items;
    }
    load(){const task=this.queue.catch(()=>{}).then(()=>this.read());this.queue=task;return task;}
    change(fn){
      const task=this.queue.catch(()=>{}).then(async()=>{if(!this.loaded)await this.read();const items=structuredClone(this.items);const result=fn(items);await this.storage.set(KEY,items);this.items=items;return result;});
      this.queue=task;return task;
    }
    add(name,config){return this.change(items=>{name=this.name(name);if(!validConfig(config))throw new Error('Некорректный пресет');if(items.length>=MAX_PRESETS)throw new Error('Можно сохранить до 100 пресетов');
      const id=globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);items.push({id,name,config:structuredClone(config)});return id;});}
    rename(id,name){return this.change(items=>{const p=items.find(p=>p.id===id);if(!p)throw new Error('Пресет уже удалён');p.name=this.name(name);});}
    remove(id){return this.change(items=>{const i=items.findIndex(p=>p.id===id);if(i<0)throw new Error('Пресет уже удалён');items.splice(i,1);});}
    name(value){const name=String(value).trim();if(!name||name.length>60)throw new Error('Название: от 1 до 60 символов');return name;}
  }
  const api={PresetStore,snapshot,patchFor,validConfig};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.LampPresets=api;
})(typeof globalThis!=='undefined'?globalThis:this);
