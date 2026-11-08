async (page)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    const info={"service":"miniapp-light","version":3,"deviceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Test-Lamp","access":"open","ledCount":116,"maxCurrentMa":500,"maxTimerMinutes":1440,"fireDefaults":{"speed":50,"height":50,"width":50,"smooth":50,"intensity":50,"color":"#ff6000"},"effects":["color","wheel","rainbow","fire","custom"],"layout":{"rows":15,"columns":8,"rowStarts":[0,8,16,23,31,39,46,54,62,69,77,85,92,100,108],"rowLengths":[8,8,7,8,8,7,8,8,7,8,8,7,8,8,8],"serpentine":false,"radiusMm":42,"heightMm":150,"anglesDeg":[0,46.55,93.1,139.66,186.21,232.76,279.31,325.86,12.41,58.97,105.52,152.07,198.62,245.17,291.72,338.28,24.83,71.38,117.93,164.48,211.03,257.59,304.14,350.69,37.24,83.79,130.34,176.9,223.45,270,316.55,3.1,49.66,96.21,142.76,189.31,235.86,282.41,328.97,15.52,62.07,108.62,155.17,201.72,248.28,294.83,341.38,27.93,74.48,121.03,167.59,214.14,260.69,307.24,353.79,40.34,86.9,133.45,180,226.55,273.1,319.66,6.21,52.76,99.31,145.86,192.41,238.97,285.52,332.07,18.62,65.17,111.72,158.28,204.83,251.38,297.93,344.48,31.03,77.59,124.14,170.69,217.24,263.79,310.34,356.9,43.45,90,136.55,183.1,229.66,276.21,322.76,9.31,55.86,102.41,148.97,195.52,242.07,288.62,335.17,21.72,68.28,114.83,161.38,207.93,254.48,301.03,347.59,34.14,80.69,127.24,173.79,220.35,266.9,313.45],"heightsMm":[0,1.3,2.61,3.91,5.22,6.52,7.83,9.13,10.43,11.74,13.04,14.35,15.65,16.96,18.26,19.57,20.87,22.17,23.48,24.78,26.09,27.39,28.7,30,31.3,32.61,33.91,35.22,36.52,37.83,39.13,40.43,41.74,43.04,44.35,45.65,46.96,48.26,49.57,50.87,52.17,53.48,54.78,56.09,57.39,58.7,60,61.3,62.61,63.91,65.22,66.52,67.83,69.13,70.43,71.74,73.04,74.35,75.65,76.96,78.26,79.57,80.87,82.17,83.48,84.78,86.09,87.39,88.7,90,91.3,92.61,93.91,95.22,96.52,97.83,99.13,100.43,101.74,103.04,104.35,105.65,106.96,108.26,109.57,110.87,112.17,113.48,114.78,116.09,117.39,118.7,120,121.3,122.61,123.91,125.22,126.52,127.83,129.13,130.43,131.74,133.04,134.35,135.65,136.96,138.26,139.57,140.87,142.17,143.48,144.78,146.09,147.39,148.7,150]}},id=info.deviceId;
    const state={deviceId:id,on:false,brightness:128,brightnessPercent:50,currentLimitMa:250,color:'#ff8844',effect:'color',rainbowMode:'forward',fire:{...info.fireDefaults},timer:{active:false,minutes:0,remainingSeconds:0},pixels:'000000'.repeat(info.ledCount)};
    const stored=new Map();let allowed=false,online=true,offset=0,started=0;
    function update(){
      state.brightness=Math.round(state.brightnessPercent*255/100);state.currentLimitMa=Math.round(info.maxCurrentMa*state.brightnessPercent/100);
      if(state.timer.active){state.timer.remainingSeconds=Math.max(0,Math.ceil((state.timer.minutes*60000-(Date.now()+offset-started))/1000));if(!state.timer.remainingSeconds){state.timer.active=false;state.on=false;}}
    }
    window.testLamp={state,info,stored,requests:[],setOnline:value=>online=value,advance:ms=>{offset+=ms;update();}};
    window.mini={runtime:{supports:async()=>true},permissions:{query:async name=>name==='network'&&!allowed?'prompt':'granted'},storage:{get:async k=>structuredClone(stored.get(k)??null),set:async(k,v)=>stored.set(k,structuredClone(v))},events:{on:()=>{}},network:{
      discoverDevices:async()=>{allowed=true;return online?[{id:'lamp',deviceId:id,name:info.name,service:'miniapp-light'}]:[];},
      requestDevice:async request=>{
        window.testLamp.requests.push(request);
        if((request.method==='POST'||request.path==='/api/sync')&&window.pendingGate)await window.pendingGate;
        if('token' in request)throw new Error('Unexpected token');if(!online)throw new Error('Device offline');
        update();const response=value=>({ok:true,status:200,body:{data:JSON.stringify(value)}});
        if(request.path==='/api/info')return response(info);if(request.path==='/api/sync')return response({deviceId:id,info,state});
        if(request.method==='POST'){
          const form=new URLSearchParams(request.body);
          for(const [key,value] of form){
            if(key==='on')state.on=value==='1';else if(key==='brightnessPercent')state.brightnessPercent=Number(value);else if(key==='brightness')state.brightnessPercent=Math.round(Number(value)*100/255);
            else if(key==='color')state.color='#'+value;else if(key==='effect'||key==='rainbowMode')state[key]=value;
            else if(key==='fireColor')state.fire.color='#'+value;else if(key.startsWith('fire'))state.fire[key[4].toLowerCase()+key.slice(5)]=Number(value);
          }
          if(form.has('resetFire'))state.fire={...info.fireDefaults};if(form.has('clear'))state.pixels='000000'.repeat(info.ledCount);if(form.has('pixels'))state.pixels=form.get('pixels');
          if(form.has('index')){const n=Number(form.get('index'))*6,color=form.get('pixel'),next=form.has('toggle')&&state.pixels.slice(n,n+6)===color?'000000':color;state.pixels=state.pixels.slice(0,n)+next+state.pixels.slice(n+6);}
          if(form.has('timerMinutes')){state.timer.minutes=Number(form.get('timerMinutes'));state.timer.active=state.timer.minutes>0&&state.on;started=Date.now()+offset;state.timer.remainingSeconds=state.timer.active?state.timer.minutes*60:0;}
          if(!state.on){state.timer.active=false;state.timer.remainingSeconds=0;}
        }
        update();return response(state);
      }
    }};
  });
await page.goto('http://127.0.0.1:8938/index.html');
await page.getByRole('button',{name:'Разрешить поиск в сети'}).click();await page.locator('#control-screen').waitFor({state:'visible'});
await page.setViewportSize({width:390,height:844});
const change=async(id,value)=>{await page.locator('#'+id).fill(String(value));await page.locator('#'+id).dispatchEvent('change');await page.waitForFunction(()=>!client.connection.writing);};
const mode=async value=>{await page.locator('#effect').selectOption(value);await page.locator('#'+value+'-panel').waitFor({state:'visible'});};
const save=async name=>{await page.locator('#save-preset').click();await page.locator('#preset-name').fill(name);await page.locator('#preset-name-form').getByRole('button',{name:'Сохранить',exact:true}).click();await page.locator('#preset-name-form').waitFor({state:'hidden'});};
await page.locator('#brightness-plus').click();await page.waitForFunction(()=>window.testLamp.state.brightnessPercent===51);if(await page.locator('#brightness-value').textContent()!=='51% · 255 мА')throw Error('plus does not use current cap');
await page.locator('#brightness-minus').click();await page.waitForFunction(()=>window.testLamp.state.brightnessPercent===50);await change('brightness',100);await page.locator('#brightness-plus').click();await page.waitForFunction(()=>!client.connection.writing);if(await page.evaluate(()=>window.testLamp.state.brightnessPercent)!==100)throw Error('brightness overflow');await change('brightness',50);
await page.locator('#power').click();await page.waitForFunction(()=>window.testLamp.state.on);
await mode('rainbow');for(const direction of ['forward','side','down','up']){await page.locator('#rainbow-mode').selectOption(direction);await page.waitForFunction(d=>window.testLamp.state.rainbowMode===d,direction);}await save('Радуга вверх');
await mode('fire');for(const [k,v]of Object.entries({speed:80,height:70,width:25,smooth:10,intensity:65}))await change('fire-'+k,v);await change('fire-color','#00ff00');await save('Зелёный огонь');
await page.locator('#fire-reset').click();await page.waitForFunction(()=>window.testLamp.state.fire.speed===50&&window.testLamp.state.fire.color==='#ff6000');
await mode('custom');await page.locator('#brush-color').fill('#ff0000');await page.locator('#brush-color').dispatchEvent('input');
const clickDot=async()=>{const p=await page.evaluate(()=>{const p=lampView.projected.find(p=>p.index===0),r=document.querySelector('#lamp').getBoundingClientRect();return{x:p.x+r.x,y:p.y+r.y};});await page.mouse.click(p.x,p.y);await page.waitForFunction(()=>!client.connection.writing);};
await page.locator('#lamp').scrollIntoViewIfNeeded();await clickDot();await page.waitForFunction(()=>window.testLamp.state.pixels.startsWith('ff0000'));await clickDot();await page.waitForFunction(()=>window.testLamp.state.pixels.startsWith('000000'));
await page.locator('#brush-color').fill('#0000ff');await page.locator('#brush-color').dispatchEvent('input');await page.locator('#lamp').scrollIntoViewIfNeeded();await clickDot();await page.waitForFunction(()=>window.testLamp.state.pixels.startsWith('0000ff'));await save('Синий LED');
await mode('timer');await page.locator('#timer-hours').fill('1');await page.locator('#timer-minutes').fill('5');await page.locator('#timer-start').click();await page.waitForFunction(()=>window.testLamp.state.timer.active&&window.testLamp.state.timer.minutes===65);await save('Таймер 65 минут');
await page.locator('#timer-cancel').click();await page.waitForFunction(()=>!window.testLamp.state.timer.active);if(!await page.evaluate(()=>window.testLamp.state.on))throw Error('cancel timer turns lamp off');
await page.locator('#timer-hours').fill('0');await page.locator('#timer-minutes').fill('1');await page.locator('#timer-start').click();await page.waitForFunction(()=>window.testLamp.state.timer.active);await page.evaluate(()=>{window.testLamp.advance(60000);});await page.evaluate(()=>client.tick());await page.waitForFunction(()=>!client.connection.state.on&&!client.connection.state.timer.active);
await mode('color');const sizes=await page.locator('#palette button').first().boundingBox();if(Math.abs(sizes.width-sizes.height)>1)throw Error('color swatch not square');await save('Цвет');
await mode('wheel');const wheel=await page.locator('#wheel').boundingBox(),panel=await page.locator('#wheel-panel').boundingBox();if(Math.abs(wheel.width-panel.width)>1)throw Error('wheel not full width');await save('Круг');
await page.locator('#presets-nav').click();await page.locator('#presets-panel').waitFor({state:'visible'});if(await page.locator('.preset-card').count()!==6)throw Error('not six saved mode presets');
const fireCard=page.locator('.preset-card').filter({hasText:'Зелёный огонь'});await fireCard.getByRole('button',{name:'Выбрать',exact:true}).click();await page.waitForFunction(()=>window.testLamp.state.fire.speed===80&&window.testLamp.state.fire.color==='#00ff00');
if(!await page.locator('#presets-panel').isVisible()||await page.locator('#editor-screen').isVisible())throw Error('app leaves preset page after choosing preset');
await page.locator('.preset-card').filter({hasText:'Таймер 65 минут'}).getByRole('button',{name:'Выбрать',exact:true}).click();await page.waitForFunction(()=>window.testLamp.state.timer.active&&window.testLamp.state.timer.minutes===65);if(!await page.locator('#presets-panel').isVisible())throw Error('timer preset navigates away');
await page.locator('.preset-card').filter({hasText:'Радуга вверх'}).getByRole('button',{name:'Выбрать',exact:true}).click();await page.waitForFunction(()=>window.testLamp.state.effect==='rainbow'&&!window.testLamp.state.timer.active);
await fireCard.getByRole('button',{name:'Переименовать',exact:true}).click();await page.locator('#preset-name').fill('Пламя <зелёное>');await page.locator('#preset-name-form').getByRole('button',{name:'Сохранить',exact:true}).click();await page.locator('#preset-name-form').waitFor({state:'hidden'});if(await page.locator('.preset-card strong').filter({hasText:'Пламя <зелёное>'}).count()!==1)throw Error('rename/text escaping fails');
await page.locator('.preset-card').filter({hasText:'Радуга вверх'}).getByRole('button',{name:'Удалить',exact:true}).click();await page.waitForFunction(()=>presetStore.items.length===5);await page.evaluate(async()=>{await presetStore.load();render(view);});if(await page.locator('.preset-card').count()!==5)throw Error('deleted preset returned after reload');
await page.screenshot({path:'Output/playwright/esp-light-presets.png',fullPage:true});
for(const width of [320,390,1000]){await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('preset page overflow '+width);}
await page.locator('#presets-nav').click();await mode('fire');await page.screenshot({path:'Output/playwright/esp-light-fire-controls.png',fullPage:true});
if(errors.length)throw Error(errors.join(' / '));
return{result:'PASS',checks:['percent current budget and +/-1 limits','four rainbow directions','five fire controls and color/reset','LED repeat toggle and repaint','hours/minutes arm/cancel/expire','save in all six modes','preset apply stays on page','timer preset arm and normal preset cancel','rename/delete/storage reload','text-safe names','square swatches','full-width wheel','320/390/1000 no overflow','no script errors']};

}