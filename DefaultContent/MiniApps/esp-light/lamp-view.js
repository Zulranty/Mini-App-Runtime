(function(root){
  'use strict';
  const palette=[['Белый','#ffffff'],['Красный','#ff0000'],['Оранжевый','#ff8000'],['Жёлтый','#ffff00'],['Лаймовый','#80ff00'],['Зелёный','#00ff00'],['Мятный','#00ff80'],['Бирюзовый','#00ffff'],['Голубой','#0080ff'],['Синий','#0000ff'],['Фиолетовый','#8000ff'],['Пурпурный','#ff00ff'],['Розовый','#ff0080'],['Тёплый','#ffb16b'],['Лавандовый','#c798ff'],['Чёрный','#000000']];
  function hsvToHex(h,s,v=1){
    const hue=((h%360)+360)%360/60,c=v*s,x=c*(1-Math.abs(hue%2-1)),m=v-c;
    const rgb=hue<1?[c,x,0]:hue<2?[x,c,0]:hue<3?[0,c,x]:hue<4?[0,x,c]:hue<5?[x,0,c]:[c,0,x];
    return '#'+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('');
  }
  function hexToHsv(color){
    const [r,g,b]=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
    const h=delta===0?0:max===r?(g-b)/delta:max===g?2+(b-r)/delta:4+(r-g)/delta;
    return {h:(h*60+360)%360,s:max===0?0:delta/max,v:max};
  }
  function buildPoints(info){
    const {rows,columns,rowStarts,rowLengths,serpentine,radiusMm,heightMm,anglesDeg,heightsMm}=info.layout,points=[];
    if(anglesDeg)return anglesDeg.map((degrees,index)=>{
      const angle=degrees*Math.PI/180;
      return {index,x:Math.sin(angle)*radiusMm,y:heightsMm[index]-heightMm/2,z:Math.cos(angle)*radiusMm};
    });
    for(let row=0;row<rows;row++)for(let column=0;column<rowLengths[row];column++){
      const angle=column*2*Math.PI/(columns??rowLengths[row]);
      const index=rowStarts[row]+(serpentine&&row%2?rowLengths[row]-1-column:column);
      points.push({index,x:Math.sin(angle)*radiusMm,y:rows===1?0:(row/(rows-1)-.5)*heightMm,z:Math.cos(angle)*radiusMm});
    }
    return points;
  }
  function projectPoint(point,width,height,layout,yaw,tilt,zoom=1){
    const x=point.x*Math.cos(yaw)+point.z*Math.sin(yaw),z0=point.z*Math.cos(yaw)-point.x*Math.sin(yaw);
    const y=point.y*Math.cos(tilt)-z0*Math.sin(tilt),z=point.y*Math.sin(tilt)+z0*Math.cos(tilt);
    const distance=Math.max(layout.heightMm,layout.radiusMm*2)*3,perspective=distance/(distance-z);
    const scale=Math.min(width/(layout.radiusMm*2.8),height/(layout.heightMm*1.35+layout.radiusMm))*zoom;
    return {...point,x:width/2+x*scale*perspective,y:height/2-y*scale*perspective,depth:z,perspective};
  }
  function hitTest(points,x,y){
    return points.filter(p=>p.depth>=0&&Math.hypot(p.x-x,p.y-y)<=Math.max(12,p.radius+5)).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y)||b.depth-a.depth)[0]?.index??null;
  }
  class LampView{
    constructor(canvas,select){
      this.canvas=canvas;this.select=select;this.yaw=.25;this.tilt=-.12;this.zoom=1;this.info=null;this.state=null;this.selected=null;this.projected=[];
      this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(canvas);
      canvas.addEventListener('pointerdown',e=>{if(!this.info)return;this.pointer={id:e.pointerId,x:e.clientX,y:e.clientY,yaw:this.yaw,tilt:this.tilt,moved:false};canvas.setPointerCapture(e.pointerId);});
      canvas.addEventListener('pointermove',e=>{
        const p=this.pointer;if(!p||p.id!==e.pointerId)return;
        const dx=e.clientX-p.x,dy=e.clientY-p.y;if(Math.hypot(dx,dy)>5)p.moved=true;
        if(p.moved){this.yaw=p.yaw+dx*.012;this.tilt=Math.max(-.65,Math.min(.65,p.tilt+dy*.008));this.draw();}
      });
      canvas.addEventListener('pointerup',e=>{
        const p=this.pointer;this.pointer=null;if(!p||p.id!==e.pointerId||p.moved||!this.info)return;
        const r=canvas.getBoundingClientRect(),index=hitTest(this.projected,e.clientX-r.left,e.clientY-r.top);
        if(index!==null)this.select(index);
      });
      canvas.addEventListener('pointercancel',()=>{this.pointer=null;});
      canvas.addEventListener('wheel',e=>{if(!this.info)return;e.preventDefault();this.zoom=Math.max(.7,Math.min(2,this.zoom-e.deltaY*.001));this.draw();},{passive:false});
      canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();this.rotate(e.key==='ArrowLeft'?-.25:.25);});
    }
    rotate(angle){this.yaw+=angle;this.draw();}
    update(info,state,selected){
      const layout=info?JSON.stringify(info.layout):'';
      const changed=layout!==this.layoutKey||state?.pixels!==this.state?.pixels||state?.on!==this.state?.on||state?.brightness!==this.state?.brightness||selected!==this.selected;
      if(layout!==this.layoutKey)this.pointer=null;
      this.layoutKey=layout;this.info=info;this.state=state;this.selected=selected;
      if(changed)this.draw();
    }
    draw(){
      const r=this.canvas.getBoundingClientRect();if(!r.width||!r.height)return;
      const dpr=Math.min(devicePixelRatio||1,2),width=Math.round(r.width*dpr),height=Math.round(r.height*dpr);
      if(this.canvas.width!==width)this.canvas.width=width;
      if(this.canvas.height!==height)this.canvas.height=height;
      const ctx=this.canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);
      if(!this.info||!this.state){this.projected=[];return;}
      const layout=this.info.layout,project=p=>projectPoint(p,r.width,r.height,layout,this.yaw,this.tilt,this.zoom);
      ctx.strokeStyle='#43493d';ctx.lineWidth=1;
      for(const y of [-layout.heightMm/2,layout.heightMm/2]){
        ctx.beginPath();for(let i=0;i<=64;i++){const a=i*Math.PI*2/64,p=project({x:Math.sin(a)*layout.radiusMm,y,z:Math.cos(a)*layout.radiusMm});if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.stroke();
      }
      for(let i=0;i<8;i++){
        const angle=i*Math.PI/4,x=Math.sin(angle)*layout.radiusMm,z=Math.cos(angle)*layout.radiusMm;
        const a=project({x,y:-layout.heightMm/2,z}),b=project({x,y:layout.heightMm/2,z});ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      }
      this.projected=buildPoints(this.info).map(p=>({...project(p),radius:Math.max(3,Math.min(7,6*Math.sqrt(120/this.info.ledCount)))}));
      for(const p of [...this.projected].sort((a,b)=>a.depth-b.depth)){
        const color='#'+this.state.pixels.slice(p.index*6,p.index*6+6),lit=color!=='#000000'&&this.state.on&&this.state.brightness>0;
        ctx.globalAlpha=p.depth<0?.22:1;ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fillStyle=lit?color:'#242820';ctx.fill();
        ctx.strokeStyle=p.index===this.selected?'#ffffff':lit?color:'#737d64';ctx.lineWidth=p.index===this.selected?2.5:1;ctx.stroke();
        if(p.index===this.selected){ctx.beginPath();ctx.arc(p.x,p.y,p.radius+4,0,Math.PI*2);ctx.stroke();}
      }
      ctx.globalAlpha=1;
    }
    dispose(){this.resize.disconnect();this.pointer=null;}
  }
  class ColorWheel{
    constructor(canvas,change){
      this.canvas=canvas;this.change=change;this.color='#ff0000';this.enabled=true;
      this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(canvas);
      const pick=e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left-r.width/2,y=e.clientY-r.top-r.height/2,radius=Math.min(r.width,r.height)/2-12;this.color=hsvToHex(Math.atan2(y,x)*180/Math.PI,Math.min(1,Math.hypot(x,y)/radius));this.draw();};
      canvas.addEventListener('pointerdown',e=>{if(!this.enabled)return;this.pointer=e.pointerId;canvas.setPointerCapture(e.pointerId);pick(e);});
      canvas.addEventListener('pointermove',e=>{if(this.pointer===e.pointerId&&this.enabled)pick(e);});
      canvas.addEventListener('pointerup',e=>{if(this.pointer!==e.pointerId)return;this.pointer=null;if(this.enabled){pick(e);this.change(this.color);}});
      canvas.addEventListener('pointercancel',()=>{this.pointer=null;});
    }
    update(color,enabled){
      if(!enabled)this.pointer=null;
      const changed=(this.pointer===null||this.pointer===undefined)&&this.color!==color;
      if(this.pointer===null||this.pointer===undefined)this.color=color;
      this.enabled=enabled;if(changed)this.draw();
    }
    draw(){
      const r=this.canvas.getBoundingClientRect();if(!r.width||!r.height)return;
      const size=Math.round(Math.min(r.width,r.height)),radius=size/2-12;
      if(this.canvas.width!==size||this.canvas.height!==size){this.canvas.width=size;this.canvas.height=size;this.image=null;}
      const ctx=this.canvas.getContext('2d');
      if(!this.image){
        this.image=ctx.createImageData(size,size);
        for(let y=0;y<size;y++)for(let x=0;x<size;x++){
          const dx=x-size/2,dy=y-size/2,s=Math.hypot(dx,dy)/radius;if(s>1)continue;
          const color=hsvToHex(Math.atan2(dy,dx)*180/Math.PI,s),i=(y*size+x)*4;
          for(let c=0;c<3;c++)this.image.data[i+c]=parseInt(color.slice(1+c*2,3+c*2),16);this.image.data[i+3]=255;
        }
      }
      ctx.putImageData(this.image,0,0);
      const hsv=hexToHsv(this.color),angle=hsv.h*Math.PI/180,x=size/2+Math.cos(angle)*hsv.s*radius,y=size/2+Math.sin(angle)*hsv.s*radius;
      ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.strokeStyle='#111';ctx.lineWidth=4;ctx.stroke();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
    }
    dispose(){this.resize.disconnect();}
  }
  const api={palette,hsvToHex,hexToHsv,buildPoints,projectPoint,hitTest,LampView,ColorWheel};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.LampVisual=api;
})(typeof globalThis!=='undefined'?globalThis:this);
