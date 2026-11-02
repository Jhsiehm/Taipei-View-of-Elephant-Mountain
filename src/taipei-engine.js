/* TAIPEI / BETWEEN THE LEAVES — renderer
 * Deterministic 20 s loop. Layers: WebGL composite (sky/clouds/city/tower/birds/foliage warp/front objects/grading)
 * then Canvas 2D overlays (falling leaves, fireflies, rain, lantern halo).
 * Requires window.TAIPEI_ASSETS = { illustrated, faithful, cls_illustrated, cls_faithful, plate_illustrated,
 *   plate_faithful, falling: [8 data URIs] }.
 */
(function (global) {
  'use strict';
  var W = 948, H = 1024, LOOP = 20, TAU = Math.PI * 2;

  // ---------- per-mode scene description (native 948x1024 coordinates) ----------
  var MODES = {
    illustrated: {
      label: 'Illustrated',
      center: [540, 560], radii: [430, 540],
      horizon: 515, cloudBand: [130, 470],
      sun: [262, 503, 16], rays: [262, 503],
      spire: [548, 321],
      lantern: [896, 720, 919, 757], lanternC: [908, 738],
      monkey: [776, 772, 818, 832, 812],
      birdsA: { from: [985, 238], to: [90, 300], t0: 7.0, t1: 13.6, n: 5 },
      birdsB: { from: [40, 468], to: [470, 446], t0: 0.0, t1: 6.5, n: 3 },
      leafLanes: [[250, 330, 1], [330, 268, 1], [205, 455, 1], [380, 236, 2], [120, 540, 1],
                  [760, 262, 1], [800, 340, 2], [700, 150, 1], [655, 205, 1], [845, 420, 1]],
      fireflies: [[60, 640, 560, 1000], [560, 660, 900, 1000]]
    },
    faithful: {
      label: 'Photo Study',
      center: [470, 560], radii: [430, 540],
      horizon: 612, cloudBand: [70, 590],
      sun: [0, 0, 0], rays: [300, 590],
      spire: [464, 393],
      lantern: null, lanternC: null, monkey: null,
      birdsA: { from: [760, 330], to: [120, 395], t0: 7.0, t1: 13.4, n: 5 },
      birdsB: { from: [150, 560], to: [420, 548], t0: 0.0, t1: 6.5, n: 3 },
      leafLanes: [[300, 250, 1], [380, 170, 1], [200, 390, 2], [120, 470, 1],
                  [640, 300, 1], [700, 420, 2], [590, 210, 1], [780, 380, 1]],
      fireflies: [[40, 760, 520, 1000], [520, 700, 860, 1000]]
    }
  };

  // ---------- small deterministic PRNG ----------
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mod(a, n) { return ((a % n) + n) % n; }

  // Mood weights: 0 day, 1 golden, 2 blue, 3 night
  function moodWeights(m) {
    return [Math.max(0, 1 - Math.abs(m - 0)), Math.max(0, 1 - Math.abs(m - 1)),
            Math.max(0, 1 - Math.abs(m - 2)), Math.max(0, 1 - Math.abs(m - 3))];
  }

  // Broad scalar wind used by leaves, audio and UI (mirrors shader's gust model at x≈474)
  function gustEnv(tx) {
    var gp = mod(tx - 4.0, LOOP);
    var env = smooth(0, 1.6, gp) * (1 - smooth(2.0, 5.0, gp));
    return env;
  }
  function windScalar(t) {
    var tx = t - 474 / 420;
    var base = 0.55 * Math.sin(TAU * 4 * tx / LOOP) + 0.3 * Math.sin(TAU * 7 * tx / LOOP + 1.7);
    return base * 0.5 + gustEnv(tx) * 1.4;
  }

  // ---------- shaders ----------
  var VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  var FS = [
    'precision highp float;',
    'uniform sampler2D uBase,uCls,uPlate;',
    'uniform vec2 uRes;uniform float uT,uWind,uMood,uRain,uReduced,uVig,uHorizon,uHasLantern,uHasMonkey;',
    'uniform vec2 uPar,uCenter,uRadii,uRays,uSpire,uCloudBand;',
    'uniform vec3 uSun;uniform vec4 uLantern,uMonkey;uniform vec2 uLanternC;uniform float uMonkeyY;',
    'uniform vec4 uGust[6];uniform vec4 uBird[8];uniform vec4 uBirdCol;',
    'const float TAU=6.2831853;',
    'float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}',
    'float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
    ' return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y);}',
    'float fbm(vec2 p){return .55*vnoise(p)+.3*vnoise(p*2.03+7.1)+.15*vnoise(p*4.1+3.3);}',
    'float bayer2(vec2 a){a=floor(a);return fract(dot(a,vec2(.5,a.y*.75)));}',
    'float bayer4(vec2 a){return bayer2(.5*a)*.25+bayer2(a);}',
    'vec4 tex(sampler2D s,vec2 p){return texture2D(s,(clamp(p,vec2(0.),uRes-1.)+.5)/uRes);}',
    'float lum(vec3 c){return dot(c,vec3(.299,.587,.114));}',
    'float wk(float k,float t){return TAU*k*t/20.;}',
    'float depthAt(vec2 p){float d=length((p-uCenter)/uRadii);return .15+.85*smoothstep(.3,.85,d);}',
    // wind displacement (px per unit flex)
    'vec2 wind(vec2 p,float e){',
    ' float t=uT; float tx=t-p.x/420.-e*.35;',
    ' float base=.55*sin(wk(4.,tx)+p.y*.004)+.3*sin(wk(7.,tx)+1.7+p.x*.006)+.15*sin(wk(11.,tx)+p.y*.02);',
    ' float gp=mod(tx-4.,20.);',
    ' float env=smoothstep(0.,1.6,gp)*(1.-smoothstep(2.,5.,gp));',
    ' float ring=gp>3.?exp(-(gp-3.)/1.5)*sin((gp-3.)*4.4):0.;',
    ' float g=env*1.4+ring*.5*e;',
    ' float n=sin(wk(9.,t)+p.x*.031+p.y*.017)*sin(wk(5.,t)+p.y*.023-p.x*.011);',
    ' float n2=sin(wk(13.,t)+p.x*.07-p.y*.05)*e;',
    ' float A=(1.+4.5*uWind)*(1.-.7*uReduced);',
    ' vec2 d=vec2(base*.5+g+.35*n+.25*n2, .35*(.6*sin(wk(6.,t)+p.x*.02+p.y*.013)+.4*n2)+g*.25*e)*A;',
    ' for(int i=0;i<6;i++){vec4 G=uGust[i]; if(G.w<=0.)continue;',
    '  vec2 v=p-G.xy; float r=length(v)+1e-3; float age=G.z; float fr=age*320.;',
    '  float e1=exp(-pow((r-fr)/110.,2.))*exp(-age/2.2);',
    '  float since=age-r/320.; float s=since>0.?exp(-since/1.1)*sin(since*5.5)*.55:0.;',
    '  vec2 dir=normalize(mix(v/r,vec2(sign(v.x+.001),-.15),.45));',
    '  d+=dir*G.w*(e1+s*smoothstep(700.,0.,r))*7.*(1.-.7*uReduced);}',
    ' return d;}',
    // grading
    'vec3 gradeSky(vec3 c,vec2 p,vec4 w){float L=lum(c);float y=clamp(p.y/uHorizon,0.,1.2);',
    ' vec3 day=mix(vec3(.30,.55,.88),vec3(.80,.88,.94),smoothstep(.05,1.,y))*(.72+.5*L);',
    ' day=mix(day,vec3(1.),smoothstep(.78,.97,L)*.55);',
    ' vec3 blue=mix(vec3(.10,.13,.32),vec3(.66,.38,.44),smoothstep(.35,1.05,y))*(.55+.75*L);',
    ' vec3 nig=mix(vec3(.018,.028,.075),vec3(.085,.095,.21),smoothstep(.2,1.05,y))*(.75+.55*L);',
    ' return day*w.x+c*w.y+blue*w.z+nig*w.w;}',
    'vec3 gradeFol(vec3 c,vec4 w){float L=lum(c);',
    ' vec3 day=mix(c,vec3(L)*vec3(.86,1.07,.78),.28)*1.07;',
    ' return day*w.x+c*w.y+c*vec3(.40,.47,.72)*w.z+(c*vec3(.19,.23,.38)+.004)*w.w;}',
    'vec3 gradeCity(vec3 c,vec2 p,vec4 w){float L=lum(c);',
    ' vec3 day=mix(c,vec3(L)*vec3(.95,1.,1.07)*1.12,.55);',
    ' day=mix(day,vec3(.80,.86,.92),.18*smoothstep(uHorizon+120.,uHorizon-20.,p.y));',
    ' return day*w.x+c*w.y+c*vec3(.40,.44,.74)*w.z+c*vec3(.13,.14,.27)*w.w;}',
    'vec3 horizonCol(vec4 w){return vec3(.80,.86,.92)*w.x+vec3(1.,.66,.42)*w.y+vec3(.55,.38,.52)*w.z+vec3(.07,.08,.17)*w.w;}',
    'vec3 cloudCol(vec4 w){return vec3(1.,1.,1.)*w.x+vec3(1.,.78,.6)*w.y+vec3(.78,.56,.66)*w.z+vec3(.20,.22,.36)*w.w;}',
    'void main(){',
    ' vec2 p=vec2(floor(gl_FragCoord.x),floor(uRes.y-gl_FragCoord.y));',
    ' float m=clamp(uMood,0.,3.);',
    ' vec4 w=vec4(max(0.,1.-abs(m)),max(0.,1.-abs(m-1.)),max(0.,1.-abs(m-2.)),max(0.,1.-abs(m-3.)));',
    ' float nightL=smoothstep(1.15,2.9,m);',
    ' float dep=depthAt(p);',
    ' vec2 parF=floor(uPar*(1.+5.*dep)+.5);',
    ' vec2 parB=floor(uPar*1.2+.5);',
    ' vec4 here=tex(uCls,p);',
    ' float flex=here.g;',
    ' vec2 d=flex>0.002?wind(p,flex)*flex:vec2(0.);',
    ' vec3 col; float cls; vec2 srcp=p;',
    // front objects (railing, lantern, sign, trunk, monkey)
    ' vec2 pfr=p-parF;',
    ' if(uHasMonkey>.5&&pfr.x>=uMonkey.x&&pfr.x<=uMonkey.z&&pfr.y>=uMonkey.y&&pfr.y<=uMonkeyY){',
    '  float br=step(.55,.5+.5*sin(wk(3.,uT)));pfr.y+=br;}',
    ' vec4 cf=tex(uCls,pfr);',
    ' bool isFront=cf.r<.5&&abs(cf.b*255.-180.)<20.;',
    ' if(isFront){col=tex(uBase,pfr).rgb;cls=3.;srcp=pfr;}',
    ' else{',
    '  vec2 pf=p-floor(d+.5)-parF;',
    '  vec4 cs=tex(uCls,pf);',
    '  bool fol=cs.r>.5;',
    '  if(fol){col=tex(uBase,pf).rgb;cls=2.;srcp=pf;}',
    '  else{',
    '   vec2 pb=p-parB; vec4 pl=tex(uPlate,pb); vec4 cb=tex(uCls,pb);',
    '   col=pl.a>.5?pl.rgb:tex(uBase,pb).rgb; cls=floor(cb.b*255./60.+.5); srcp=pb;',
    '   if(cls>1.9&&cls<2.1)cls=1.;',
    '  }',
    ' }',
    ' vec3 base=col; float L=lum(col);',
    ' vec3 outc;',
    ' if(cls<.5){',
    // sky: slow dithered cloud shadows + procedural wisps
    '  vec2 q=floor(p/2.)*2.;',
    '  float sh=fbm(vec2(q.x/180.-uT*.004,q.y/60.))-.5;',
    '  col*=1.+.06*sh*step(bayer4(q/2.),.6);',
    '  outc=gradeSky(col,p,w);',
    '  float u=uT/20.; float a=fract(u),b=fract(u+.5);',
    '  float wa=1.-abs(2.*a-1.),wb=1.-abs(2.*b-1.);',
    '  float ca=fbm(vec2((q.x-a*46.)/84.,q.y/16.)+vec2(3.1,1.7));',
    '  float cb2=fbm(vec2((q.x-b*46.)/84.,q.y/16.)+vec2(9.4,5.2));',
    '  float cl=ca*wa+cb2*wb;',
    '  float band=smoothstep(uCloudBand.x,uCloudBand.x+60.,p.y)*(1.-smoothstep(uCloudBand.y-60.,uCloudBand.y,p.y));',
    '  float dens=smoothstep(.56,.74,cl)*band*(1.+uRain*.8);',
    '  float lev=floor(dens*3.+bayer4(q/2.))/3.;',
    '  outc=mix(outc,cloudCol(w)*(.75+.35*L),clamp(lev,0.,1.)*.32);',
    // stars
    '  float st=step(.9978,hash12(p))*w.w*(1.-smoothstep(uHorizon-160.,uHorizon-40.,p.y))*(1.-uRain);',
    '  float tw=.55+.45*sin(wk(floor(hash12(p+3.)*6.)+2.,uT)+hash12(p+9.)*6.28);',
    '  outc+=vec3(.85,.88,1.)*st*tw*.8;',
    // sun suppression after dusk
    '  if(uSun.z>0.){float sd=length(p-uSun.xy);outc=mix(outc,gradeSky(vec3(.85,.55,.4),p,w),(w.z*.6+w.w*.85)*(1.-smoothstep(uSun.z-3.,uSun.z+5.,sd)));}',
    ' } else if(cls<1.5){',
    '  outc=gradeCity(col,p,w);',
    '  float hz=smoothstep(uHorizon+190.,uHorizon-10.,p.y);',
    '  float br=.5+.5*sin(wk(1.,uT)+p.x*.0021)*sin(wk(2.,uT)*.5+p.y*.03);',
    '  float drift=.5+.5*sin(p.x*.021+p.y*.06-wk(5.,uT));',
    '  outc=mix(outc,horizonCol(w),clamp(hz*(.10+.07*br+.05*drift)+uRain*.28*hz,0.,.6));',
    ' } else if(cls<2.5){',
    '  float tip=(.5+.5*sin(wk(7.,uT)+srcp.x*.13+srcp.y*.07))*smoothstep(.45,.8,L);',
    '  col*=1.+.07*tip*flex;',
    '  outc=gradeFol(col,w);',
    ' } else if(cls<3.5){',
    '  outc=gradeFol(col,w);',
    ' } else {',
    '  outc=gradeCity(col,p,w);',
    '  outc+=vec3(.9,.78,.55)*.035*w.w;',
    ' }',
    // window and tower lights
    ' if(cls>.5&&cls<1.5||cls>3.5){',
    '  float A=tex(uCls,srcp).a;',
    '  if(A>0.){',
    '   float h=hash12(srcp*1.37);',
    '   float on=step(A,nightL*1.03);',
    '   float fl=.86+.14*sin(wk(floor(h*7.)+1.,uT)+h*20.);',
    '   fl*=1.-.85*step(.985,fract(h*91.+floor(uT*.5+h*10.)*.37));',
    '   vec3 lc=h>.78?vec3(.82,.9,1.):vec3(1.,.80,.48);',
    '   outc=mix(outc,lc*fl*(.85+.35*h),on*.92*(1.-.35*uRain));',
    '   if(A<.43)outc=mix(outc,vec3(lum(outc))*vec3(.9,.95,1.05)*.75,w.x*.8);',
    '  }',
    ' }',
    // spire beacon
    ' {vec2 sp=p-parB-uSpire; if(abs(sp.x)<.6&&abs(sp.y+1.)<1.6){float bl=step(.5,fract(uT*.5));outc=mix(outc,vec3(1.,.25,.2),bl*nightL);}}',
    // birds (behind foliage)
    ' if(cls!=2.&&cls!=3.){for(int i=0;i<8;i++){vec4 B=uBird[i];if(B.w<=0.)continue;',
    '  vec2 r=p-floor(B.xy+.5); float ax=abs(r.x);',
    '  if(ax<=B.w&&abs(r.y)<=B.w+1.){float wy=floor(-ax*B.z*.8+.5); if(ax<.5)wy=0.;',
    '   if(abs(r.y-wy)<.5)outc=mix(outc,uBirdCol.rgb,uBirdCol.a);}}}',
    // lantern glow and light spill
    ' if(uHasLantern>.5){',
    '  float fl=.86+.08*sin(uT*TAU*1.1)+.05*sin(uT*TAU*2.7+1.)+.04*sin(uT*TAU*4.3);',
    '  bool inL=srcp.x>=uLantern.x&&srcp.x<=uLantern.z&&srcp.y>=uLantern.y&&srcp.y<=uLantern.w&&cls>2.5&&cls<3.5&&L>.42;',
    '  if(inL)outc=mix(outc,base*fl*(1.+.35*nightL),.35+.65*smoothstep(.6,2.2,m));',
    '  float dl=length(p-uLanternC);',
    '  float spill=exp(-dl*dl/(2.*85.*85.))*(.9*w.w+.45*w.z+.08*w.y)*fl;',
    '  if(cls>1.5&&cls<3.5&&!inL)outc+=base*vec3(1.,.66,.32)*spill*.85;',
    ' }',
    // god rays (golden / day)
    ' if(cls<3.5){vec2 v=p-uRays; float ang=atan(v.y,v.x);',
    '  float ray=pow(.5+.5*sin(ang*38.+sin(wk(1.,uT))*.6),10.)*.6+pow(.5+.5*sin(ang*17.-wk(1.,uT)*.5+1.3),12.)*.4;',
    '  float fall=exp(-length(v)/520.)*smoothstep(-.2,.6,v.y/length(v)+.6);',
    '  outc+=vec3(1.,.72,.42)*ray*fall*(.07*w.y+.03*w.x)*(1.-uRain)*(cls>1.5?.6:1.);}',
    // rain grade
    ' {float Lo=lum(outc); outc=mix(outc,vec3(Lo)*vec3(.92,.96,1.04),.32*uRain); outc=mix(vec3(.38,.41,.46)*(.4+.6*(1.-w.w)),outc,1.-.2*uRain); outc*=1.-.12*uRain;}',
    // vignette
    ' {vec2 v=(p/uRes-.5)*vec2(1.,.92); outc*=1.-.2*uVig*smoothstep(.42,.78,length(v));}',
    ' gl_FragColor=vec4(clamp(outc,0.,1.),1.);',
    '}'
  ].join('\n');

  function loadImg(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { (im.decode ? im.decode() : Promise.resolve()).then(function () { res(im); }, function () { res(im); }); };
      im.onerror = rej; im.src = src;
    });
  }

  function trimSprite(img) {
    var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    var x = c.getContext('2d'); x.drawImage(img, 0, 0);
    var d = x.getImageData(0, 0, c.width, c.height).data, x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (var y = 0; y < c.height; y++) for (var i = 0; i < c.width; i++) {
      if (d[(y * c.width + i) * 4 + 3] > 40) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    // keep only the main blob: crop to bbox
    var o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    var ox = o.getContext('2d'); ox.drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    // hard alpha (no soft edges -> crisp pixels)
    var id = ox.getImageData(0, 0, o.width, o.height);
    for (var k = 3; k < id.data.length; k += 4) id.data[k] = id.data[k] > 100 ? 255 : 0;
    ox.putImageData(id, 0, 0);
    return o;
  }

  // ---------- minimal ZIP (store) ----------
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  var DOSDATE = ((2026 - 1980) << 9) | (10 << 5) | 26;
  function makeZip(files) {
    var parts = [], central = [], offset = 0, enc = new TextEncoder();
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true); h.setUint16(12, DOSDATE, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, DOSDATE, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var csize = central.reduce(function (s, a) { return s + a.length; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(e.buffer)]), { type: 'application/zip' });
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  // ---------- ambient audio: a generated subtropical-forest soundscape (Web Audio, no samples) ----------
  // layers: wind in leaves, leaf rustle, distant city hum, rain, an insect chorus (band-limited noise pulsed at
  // insect wing rates), individual katydid/cricket trills, tree frogs, a daytime cicada drone, rare daytime birds.
  function Ambience() { this.ctx = null; this.on = false; }
  Ambience.prototype.start = function () {
    if (!this.ctx) {
      var AC = global.AudioContext || global.webkitAudioContext; if (!AC) return false;
      var ctx = this.ctx = new AC(), rnd = mulberry(4242);
      var len = ctx.sampleRate * 4;
      var brown = ctx.createBuffer(1, len, ctx.sampleRate), bd = brown.getChannelData(0), last = 0;
      for (var i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
      for (var k = 0; k < 2000; k++) { var f = k / 2000; bd[len - 2000 + k] = bd[len - 2000 + k] * (1 - f) + bd[k] * f; }
      var white = ctx.createBuffer(2, len, ctx.sampleRate);
      for (var c = 0; c < 2; c++) { var wd = white.getChannelData(c); for (var j = 0; j < len; j++) wd[j] = Math.random() * 2 - 1; }
      function src(b, off) { var s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.start(0, off || 0); return s; }
      function filt(type, f, q) { var n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; return n; }
      function gain(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
      function panner(p) { var n = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if (n.pan) n.pan.value = p; return n; }
      this.master = gain(0); this.master.connect(ctx.destination);
      // gentle bus compressor keeps the mix even
      var comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.connect(this.master);
      var bus = this.bus = gain(1); bus.connect(comp);

      // wind + rustle + hum + rain
      var wf = filt('bandpass', 420, 0.5); this.windG = gain(0); src(brown).connect(wf); wf.connect(this.windG); this.windG.connect(bus);
      var rf = filt('bandpass', 1900, 0.8); this.rustG = gain(0); src(white, 0.7).connect(rf); rf.connect(this.rustG); this.rustG.connect(bus);
      var hf = filt('lowpass', 150); this.humG = gain(0); src(brown, 1.3).connect(hf); hf.connect(this.humG); this.humG.connect(bus);
      var raf = filt('bandpass', 2200, 0.35); this.rainG = gain(0); src(white, 2.1).connect(raf); raf.connect(this.rainG); this.rainG.connect(bus);

      // insect chorus: narrow noise bands, amplitude-pulsed at wing rates, each slowly swelling
      this.chorusG = gain(0); this.chorusG.connect(bus);
      var bands = [[3600, 22, 31, -0.6], [4400, 28, 47, 0.5], [5300, 30, 63, -0.2], [6600, 34, 82, 0.75], [3000, 16, 18, 0.1]];
      this.chorus = bands.map(function (b, n) {
        var bp = filt('bandpass', b[0], b[1]), bp2 = filt('bandpass', b[0] * 1.004, b[1]);
        var am = gain(0.5), lfo = ctx.createOscillator(); lfo.type = n % 2 ? 'square' : 'sawtooth'; lfo.frequency.value = b[2];
        var lfoAmt = gain(0.5); lfo.connect(lfoAmt); lfoAmt.connect(am.gain); lfo.start();
        var swell = gain(0.4), slow = ctx.createOscillator(); slow.frequency.value = 0.03 + rnd() * 0.09;
        var slowAmt = gain(0.35); slow.connect(slowAmt); slowAmt.connect(swell.gain); slow.start();
        var p = panner(b[3]);
        src(white, rnd() * 3).connect(bp); bp.connect(bp2); bp2.connect(am); am.connect(swell); swell.connect(p); p.connect(this.chorusG);
        return swell;
      }, this);

      // cicada drone for daytime (dense, high, shimmering)
      var cb = filt('bandpass', 5800, 6), cam = gain(0.5), co = ctx.createOscillator(); co.frequency.value = 96; co.type = 'sawtooth';
      var coA = gain(0.5); co.connect(coA); coA.connect(cam.gain); co.start();
      this.cicadaG = gain(0); src(white, 1.7).connect(cb); cb.connect(cam); cam.connect(this.cicadaG); this.cicadaG.connect(bus);

      // individual trillers (katydids / crickets): noise through a resonant band, gated in pulse trains
      this.trillG = gain(0); this.trillG.connect(bus);
      this.trillers = [];
      for (var q = 0; q < 6; q++) {
        var tb = filt('bandpass', 4200 + rnd() * 2200, 18 + rnd() * 14), tb2 = filt('bandpass', tb.frequency.value, 10);
        var gate = gain(0), tp = panner((rnd() * 2 - 1) * 0.9), tl = gain(0.5 + rnd() * 0.6);
        src(white, rnd() * 3).connect(tb); tb.connect(tb2); tb2.connect(gate); gate.connect(tl); tl.connect(tp); tp.connect(this.trillG);
        this.trillers.push({ gate: gate, rate: 18 + rnd() * 26, pulses: 6 + Math.floor(rnd() * 22), duty: 0.45 + rnd() * 0.2,
                             gap: 0.4 + rnd() * 1.6, next: ctx.currentTime + rnd() * 2 });
      }
      // tree frogs: short resonant croak bursts
      this.frogG = gain(0); this.frogG.connect(bus);
      this.frogs = [];
      for (var r = 0; r < 3; r++) {
        var fo = ctx.createOscillator(); fo.type = 'sawtooth'; fo.frequency.value = 380 + rnd() * 500;
        var fb = filt('bandpass', fo.frequency.value * 2.1, 5), fg = gain(0), fp = panner((rnd() * 2 - 1) * 0.8);
        fo.connect(fb); fb.connect(fg); fg.connect(fp); fp.connect(this.frogG); fo.start();
        this.frogs.push({ gate: fg, osc: fo, base: fo.frequency.value, next: ctx.currentTime + 2 + rnd() * 6 });
      }
      this.lastChirp = 0;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.master.gain.setTargetAtTime(0.95, this.ctx.currentTime, 0.8);
    this.on = true; return true;
  };
  Ambience.prototype.stop = function () { if (this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3); this.on = false; };
  Ambience.prototype.update = function (s) {
    if (!this.on || !this.ctx) return;
    var c = this.ctx, now = c.currentTime, w = s.windLevel, nt = s.night, dry = 1 - 0.7 * s.rain;
    this.windG.gain.setTargetAtTime(0.09 + 0.3 * w * (0.4 + s.wind), now, 0.3);
    this.rustG.gain.setTargetAtTime(0.012 * Math.max(0, w - 0.5) * s.wind, now, 0.2);
    this.humG.gain.setTargetAtTime(0.04 + 0.05 * nt, now, 0.6);
    this.rainG.gain.setTargetAtTime(0.12 * s.rain, now, 0.6);
    // the forest wakes up after dusk: chorus and trills swell from a faint daytime bed to full night
    this.chorusG.gain.setTargetAtTime((0.012 + 0.11 * nt) * dry, now, 1.5);
    this.cicadaG.gain.setTargetAtTime(0.022 * (1 - nt) * (1 - s.rain) * (0.6 + 0.4 * Math.sin(now / 9)), now, 1.2);
    this.trillG.gain.setTargetAtTime((0.004 + 0.07 * nt) * dry, now, 1.5);
    this.frogG.gain.setTargetAtTime((0.002 + 0.03 * nt) * (0.6 + 0.8 * s.rain), now, 1.5);
    var active = Math.max(1, Math.round(this.trillers.length * (0.25 + 0.75 * nt)));
    for (var i = 0; i < this.trillers.length; i++) {
      var t = this.trillers[i];
      if (i >= active) { t.next = Math.max(t.next, now + 1); continue; }
      if (t.next < now - 0.1) t.next = now + Math.random() * 0.3;
      while (t.next < now + 0.4) {
        var period = 1 / t.rate, on = period * t.duty, st = t.next, n = t.pulses + Math.floor(Math.random() * 4) - 1;
        for (var p = 0; p < n; p++) {
          var a = st + p * period, amp = Math.min(1, (p + 1) / 3) * (0.8 + Math.random() * 0.2);
          t.gate.gain.setValueAtTime(0, a); t.gate.gain.linearRampToValueAtTime(amp, a + 0.002);
          t.gate.gain.setValueAtTime(amp, a + on - 0.002); t.gate.gain.linearRampToValueAtTime(0, a + on);
        }
        t.next = st + n * period + t.gap * (0.7 + Math.random() * 0.6) + (Math.random() < 0.08 ? 2 + Math.random() * 3 : 0);
      }
    }
    for (var j = 0; j < this.frogs.length; j++) {
      var fr = this.frogs[j];
      if (fr.next < now - 0.1) fr.next = now + 1 + Math.random() * 4;
      if (fr.next < now + 0.4) {
        var bursts = 1 + Math.floor(Math.random() * 3), b0 = fr.next;
        for (var b = 0; b < bursts; b++) {
          var ba = b0 + b * 0.28, pulses = 5 + Math.floor(Math.random() * 5);
          fr.osc.frequency.setValueAtTime(fr.base * (0.97 + Math.random() * 0.06), ba);
          for (var q = 0; q < pulses; q++) {
            var pa = ba + q * 0.022;
            fr.gate.gain.setValueAtTime(0, pa); fr.gate.gain.linearRampToValueAtTime(0.9, pa + 0.004); fr.gate.gain.linearRampToValueAtTime(0, pa + 0.018);
          }
        }
        fr.next = b0 + 2.5 + Math.random() * 7;
      }
    }
    // rare daytime birdsong
    if (s.birdsVisible && nt < 0.3 && s.rain < 0.5 && now - this.lastChirp > 0.6 && Math.random() < 0.04) {
      this.lastChirp = now;
      var o = c.createOscillator(), g = c.createGain(), f0 = 2400 + Math.random() * 1200;
      o.frequency.setValueAtTime(f0, now); o.frequency.exponentialRampToValueAtTime(f0 * 1.3, now + 0.08);
      g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(0.008, now + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      o.connect(g); g.connect(this.bus); o.start(now); o.stop(now + 0.15);
    }
  };

  // ---------- World ----------
  function World(canvas, assets, opts) {
    opts = opts || {};
    this.canvas = canvas; canvas.width = W; canvas.height = H;
    this.ctx = canvas.getContext('2d'); this.ctx.imageSmoothingEnabled = false;
    this.assets = assets;
    this.mode = opts.mode || 'illustrated';
    this.mood = opts.mood != null ? opts.mood : 1;
    this.wind = opts.wind != null ? opts.wind : 0.45;
    this.rain = !!opts.rain; this.rainAmt = this.rain ? 1 : 0;
    this.cycle = false; this.playing = true;
    this.t = 0; this.tAbs = 0;
    this.par = [0, 0]; this.parTarget = [0, 0];
    this.gusts = [];
    this.vignette = opts.vignette != null ? opts.vignette : 1;
    this.reduced = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    this.audio = new Ambience();
    this.listeners = [];
    this.fade = null;
    this.exporting = false;
    this.tintCache = {}; this.tintKey = '';
    this._initGL();
    this._initParticles();
    var self = this;
    this._last = performance.now();
    this._loop = function (now) { self._frame(now); self._raf = requestAnimationFrame(self._loop); };
    this._raf = requestAnimationFrame(this._loop);
  }

  World.prototype._initGL = function () {
    var glc = this.glc = document.createElement('canvas'); glc.width = W; glc.height = H;
    var gl = this.gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) { this.gl = null; return; }
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    var pr = this.prog = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = this.U = {};
    ['uBase', 'uCls', 'uPlate', 'uRes', 'uT', 'uWind', 'uMood', 'uRain', 'uReduced', 'uHorizon', 'uHasLantern', 'uHasMonkey',
     'uPar', 'uCenter', 'uRadii', 'uRays', 'uSpire', 'uCloudBand', 'uSun', 'uLantern', 'uMonkey', 'uLanternC', 'uMonkeyY',
     'uGust', 'uBird', 'uBirdCol', 'uVig'].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    var self = this; this.tex = {};
    function mk(img) {
      var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    ['illustrated', 'faithful'].forEach(function (m) {
      self.tex[m] = { base: mk(self.assets[m]), cls: mk(self.assets['cls_' + m]), plate: mk(self.assets['plate_' + m]) };
    });
    gl.uniform1i(U.uBase, 0); gl.uniform1i(U.uCls, 1); gl.uniform1i(U.uPlate, 2);
    gl.uniform2f(U.uRes, W, H);
    gl.viewport(0, 0, W, H);
  };

  World.prototype._initParticles = function () {
    var r = mulberry(1977);
    this.sprites = this.assets.falling.map(trimSprite);
    // falling leaves: per mode, stable identity per particle
    this.leaves = {};
    var self = this;
    Object.keys(MODES).forEach(function (m) {
      self.leaves[m] = MODES[m].leafLanes.map(function (lane, i) {
        var k = lane[2];
        var T = LOOP / k;
        return {
          x0: lane[0], y0: lane[1], T: T, phase: r(), spr: i % 8,
          drift: (lane[0] < MODES[m].spire[0] ? -1 : 1) * (10 + r() * 50) + 30,
          swayA: 8 + r() * 16, swayF: Math.round(4 + r() * 6) / LOOP * k, flipF: Math.round(6 + r() * 10) / LOOP * k,
          spin: (r() - 0.5) * 2.4, rot0: r() * TAU, scale: 1, phi: r() * TAU,
          fall: 1060 - lane[1]
        };
      });
    });
    // storyboard: bias some leaves into the 7–12 s window
    this.leaves.illustrated.forEach(function (l, i) { if (l.T === LOOP && i % 2 === 0) l.phase = (6.5 + i * 0.4) / LOOP; });
    this.flies = [];
    for (var i = 0; i < 34; i++) this.flies.push({ u: r(), v: r(), z: r(), k1: 1 + Math.floor(r() * 3), k2: 1 + Math.floor(r() * 3), k3: 3 + Math.floor(r() * 8), p1: r() * TAU, p2: r() * TAU, p3: r() * TAU, ax: 10 + r() * 30, ay: 6 + r() * 18 });
    this.drops = [];
    for (var j = 0; j < 260; j++) {
      var z = r(), n = Math.round(16 + z * 18);
      this.drops.push({ x: r() * (W + 400) - 200, y: r() * (H + 120), z: z, v: n * (H + 120) / LOOP, len: 6 + z * 16, a: 0.12 + z * 0.3 });
    }
  };

  World.prototype.on = function (fn) { this.listeners.push(fn); };
  World.prototype._emit = function () { var s = this.getState(); this.listeners.forEach(function (f) { try { f(s); } catch (e) { } }); };
  World.prototype.getState = function () {
    return { mode: this.mode, mood: this.mood, wind: this.wind, rain: this.rain, cycle: this.cycle, playing: this.playing,
             t: this.t, audio: this.audio.on, reduced: this.reduced, exporting: this.exporting };
  };

  // ----- public controls -----
  World.prototype.setMode = function (m) {
    if (!MODES[m] || m === this.mode) return;
    var snap = document.createElement('canvas'); snap.width = W; snap.height = H; snap.getContext('2d').drawImage(this.canvas, 0, 0);
    this.fade = { img: snap, start: performance.now() };
    this.mode = m; this._emit();
  };
  World.prototype.setMood = function (v) { this.mood = clamp(+v, 0, 3); this._emit(); };
  World.prototype.setWind = function (v) { this.wind = clamp(+v, 0, 1); this._emit(); };
  World.prototype.setRain = function (b) { this.rain = !!b; this._emit(); };
  World.prototype.setCycle = function (b) { this.cycle = !!b; if (b) this._cycleBase = { mood: this.mood, at: performance.now() }; this._emit(); };
  World.prototype.setPlaying = function (b) { this.playing = !!b; this._emit(); };
  World.prototype.togglePlay = function () { this.setPlaying(!this.playing); };
  World.prototype.restart = function () { this.t = 0; this._emit(); };
  World.prototype.seek = function (t) { this.t = mod(+t, LOOP); if (!this.playing) this.render(this.t); this._emit(); };
  World.prototype.setPointer = function (nx, ny) { if (this.reduced) return; this.parTarget = [clamp(nx, -1, 1) * -1, clamp(ny, -1, 1) * -1]; };
  World.prototype.gust = function (x, y, strength) {
    if (x == null) { x = 60; y = 520; strength = 1.25; }
    this.gusts.push({ x: x, y: y, t0: this.tAbs, s: strength || 1 });
    if (this.gusts.length > 6) this.gusts.shift();
  };
  World.prototype.setAudio = function (b) { if (b) this.audio.start(); else this.audio.stop(); this._emit(); };
  World.prototype.savePNG = function () {
    var self = this; this.canvas.toBlob(function (b) { download(b, 'taipei_' + self.mode + '_t' + self.t.toFixed(2).replace('.', '-') + '.png'); }, 'image/png');
  };
  World.prototype.exportFrames = function (count, onProgress) {
    count = count || 48; var self = this;
    if (this.exporting) return Promise.reject(new Error('busy'));
    this.exporting = true; var wasPlaying = this.playing; this.playing = false; this._emit();
    var files = [], i = 0, fps = count / LOOP;
    var manifest = { title: 'Taipei / Between the Leaves', width: W, height: H, loopSeconds: LOOP, frames: count, fps: fps,
                     mode: this.mode, mood: this.mood, wind: this.wind, rain: this.rain, files: [] };
    return new Promise(function (resolve) {
      function step() {
        if (i >= count) {
          files.push({ name: 'taipei_frames/manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
          var z = makeZip(files); download(z, 'taipei_frames_' + count + '.zip');
          self.exporting = false; self.playing = wasPlaying; self._emit(); resolve(count); return;
        }
        var t = i / fps;
        self.render(t, { exportMode: true });
        self.canvas.toBlob(function (b) {
          b.arrayBuffer().then(function (ab) {
            var name = 'frame_' + String(i).padStart(4, '0') + '.png';
            files.push({ name: 'taipei_frames/' + name, data: new Uint8Array(ab) });
            manifest.files.push({ file: name, t: +t.toFixed(4) });
            i++; if (onProgress) onProgress(i, count); setTimeout(step, 0);
          });
        }, 'image/png');
      }
      step();
    });
  };
  World.prototype.destroy = function () { cancelAnimationFrame(this._raf); this.audio.stop(); };

  // ----- frame loop -----
  World.prototype._frame = function (now) {
    var dt = Math.min(0.1, (now - this._last) / 1000); this._last = now;
    if (this.exporting) return;
    if (this.playing) { this.t = mod(this.t + dt, LOOP); this.tAbs += dt; }
    var k = 1 - Math.exp(-dt * 4);
    this.par[0] += (this.parTarget[0] - this.par[0]) * k; this.par[1] += (this.parTarget[1] - this.par[1]) * k;
    this.rainAmt += ((this.rain ? 1 : 0) - this.rainAmt) * (1 - Math.exp(-dt * 1.2));
    if (this.cycle && this.playing) {
      var e = (now - this._cycleBase.at) / 1000 / 18 + this._cycleBase.mood; // 18 s per mood step
      var tri = mod(e, 6); this.mood = tri <= 3 ? tri : 6 - tri;
    }
    var self = this;
    this.gusts = this.gusts.filter(function (g) { return self.tAbs - g.t0 < 7; });
    this.render(this.t);
    var wv = moodWeights(this.mood);
    this.audio.update({ windLevel: clamp(0.4 + windScalar(this.t) * 0.5 + this.gusts.length * 0.15, 0, 1.5), wind: this.wind,
                        night: smooth(1.6, 3, this.mood), rain: this.rainAmt, birdsVisible: this._birdsVisible });
    this._tick = (this._tick || 0) + 1;
    if (this._tick % 6 === 0) this._emit();
  };

  World.prototype._birds = function (t, M, night) {
    var out = [], vis = false;
    [M.birdsA, M.birdsB].forEach(function (F, fi) {
      if (t < F.t0 || t > F.t1) return;
      var u = (t - F.t0) / (F.t1 - F.t0);
      for (var i = 0; i < F.n; i++) {
        var lagU = u - i * 0.035; if (lagU < 0 || lagU > 1) continue;
        var x = F.from[0] + (F.to[0] - F.from[0]) * lagU + (i % 2 ? 8 : -6) * (i * 0.6);
        var y = F.from[1] + (F.to[1] - F.from[1]) * lagU + Math.sin(lagU * Math.PI) * (fi ? -10 : -38) + (i % 3) * 6 - i * 2
              + Math.sin(TAU * (6 + i) * t / LOOP + i) * 2;
        var flapHz = fi ? 7 : 6 + (i % 3) * 0.5;
        var glide = 0.5 + 0.5 * Math.sin(TAU * 2 * t / LOOP + i * 1.3);
        var flap = Math.sin(TAU * flapHz * t + i * 1.7) * (glide > 0.75 ? 0.25 : 1);
        var span = fi ? 2 : (i === 0 ? 4 : 3);
        out.push([x, y, flap, span]); vis = true;
      }
    });
    this._birdsVisible = vis && night < 0.5;
    return out.slice(0, 8);
  };

  World.prototype._tints = function (w) {
    var key = w.map(function (v) { return v.toFixed(2); }).join(',');
    if (key === this.tintKey) return this.tintCache;
    var mul = [w[0] * 1.04 + w[1] + w[2] * 0.42 + w[3] * 0.16, w[0] * 1.08 + w[1] + w[2] * 0.48 + w[3] * 0.2, w[0] * 0.95 + w[1] + w[2] * 0.72 + w[3] * 0.34];
    var cache = this.sprites.map(function (s) {
      var c = document.createElement('canvas'); c.width = s.width; c.height = s.height;
      var x = c.getContext('2d'); x.drawImage(s, 0, 0);
      var id = x.getImageData(0, 0, c.width, c.height);
      for (var i = 0; i < id.data.length; i += 4) { id.data[i] *= mul[0]; id.data[i + 1] *= mul[1]; id.data[i + 2] *= mul[2]; }
      x.putImageData(id, 0, 0); return c;
    });
    this.tintKey = key; this.tintCache = cache; return cache;
  };

  // ----- deterministic render at virtual time t -----
  World.prototype.render = function (t, o) {
    o = o || {};
    var M = MODES[this.mode], ctx = this.ctx, gl = this.gl;
    var exp = !!o.exportMode;
    var rain = exp ? (this.rain ? 1 : 0) : this.rainAmt;
    var par = exp ? [0, 0] : this.par;
    var w = moodWeights(this.mood), night = smooth(1.6, 3, this.mood);
    var birds = this._birds(t, M, night);
    if (gl) {
      var U = this.U, T = this.tex[this.mode];
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.base);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.cls);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, T.plate);
      gl.uniform1f(U.uT, t); gl.uniform1f(U.uWind, this.wind); gl.uniform1f(U.uMood, this.mood);
      gl.uniform1f(U.uRain, rain); gl.uniform1f(U.uReduced, this.reduced ? 1 : 0); gl.uniform1f(U.uVig, this.vignette);
      gl.uniform1f(U.uHorizon, M.horizon);
      gl.uniform2f(U.uPar, par[0] * 1.0, par[1] * 0.6);
      gl.uniform2f(U.uCenter, M.center[0], M.center[1]); gl.uniform2f(U.uRadii, M.radii[0], M.radii[1]);
      gl.uniform2f(U.uRays, M.rays[0], M.rays[1]); gl.uniform2f(U.uSpire, M.spire[0], M.spire[1]);
      gl.uniform2f(U.uCloudBand, M.cloudBand[0], M.cloudBand[1]);
      gl.uniform3f(U.uSun, M.sun[0], M.sun[1], M.sun[2]);
      gl.uniform1f(U.uHasLantern, M.lantern ? 1 : 0); gl.uniform1f(U.uHasMonkey, M.monkey ? 1 : 0);
      if (M.lantern) { gl.uniform4f(U.uLantern, M.lantern[0], M.lantern[1], M.lantern[2], M.lantern[3]); gl.uniform2f(U.uLanternC, M.lanternC[0], M.lanternC[1]); }
      if (M.monkey) { gl.uniform4f(U.uMonkey, M.monkey[0], M.monkey[1], M.monkey[2], M.monkey[3]); gl.uniform1f(U.uMonkeyY, M.monkey[4]); }
      var gu = new Float32Array(24);
      if (!exp) { var self = this; this.gusts.forEach(function (g, i) { gu.set([g.x, g.y, self.tAbs - g.t0, g.s], i * 4); }); }
      gl.uniform4fv(U.uGust, gu);
      var bu = new Float32Array(32); birds.forEach(function (b, i) { bu.set(b, i * 4); });
      gl.uniform4fv(U.uBird, bu);
      var ba = (1 - night) * 0.9;
      gl.uniform4f(U.uBirdCol, 0.10 * w[0] + 0.16 * w[1] + 0.07 * w[2] + 0.03 * w[3], 0.11 * w[0] + 0.10 * w[1] + 0.06 * w[2] + 0.03 * w[3], 0.13 * w[0] + 0.13 * w[1] + 0.12 * w[2] + 0.06 * w[3], ba);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.drawImage(this.glc, 0, 0);
    } else {
      ctx.drawImage(this.assets[this.mode], 0, 0);
    }
    this._overlays(t, M, w, night, rain, par, exp);
    if (this.fade && !exp) {
      var a = 1 - (performance.now() - this.fade.start) / 450;
      if (a <= 0) this.fade = null; else { ctx.globalAlpha = a; ctx.drawImage(this.fade.img, 0, 0); ctx.globalAlpha = 1; }
    }
  };

  World.prototype._overlays = function (t, M, w, night, rain, par, exp) {
    var ctx = this.ctx, red = this.reduced, self = this;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // falling leaves (foreground, depth-scaled, stable identity)
    var tints = this._tints(w);
    var gustX = this.wind * 40;
    var leaves = this.leaves[this.mode];
    leaves.forEach(function (l, i) {
      if (red && i % 3) return;
      var u = mod(t / l.T + l.phase, 1);
      var life = 0.82;
      if (u > life) return;
      var s = u / life, tt = s * l.T * life;
      var y = l.y0 + l.fall * (s * 0.85 + s * s * 0.15);
      var gx = gustEnv(t - l.x0 / 420) * gustX * s;
      var x = l.x0 + l.drift * s + gx + l.swayA * Math.sin(TAU * l.swayF * tt + l.phi);
      var a = smooth(0, 0.06, s) * (1 - smooth(0.93, 1, s));
      if (a <= 0.01) return;
      var ang = l.rot0 + l.spin * tt + 0.5 * Math.cos(TAU * l.swayF * tt + l.phi);
      var fx = Math.cos(TAU * l.flipF * tt + l.phi);
      var img = tints[l.spr];
      ctx.globalAlpha = a;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(Math.round(x + par[0] * 6 * l.scale), Math.round(y + par[1] * 4 * l.scale));
      ctx.rotate(ang);
      ctx.scale(l.scale * (Math.abs(fx) < 0.2 ? (fx < 0 ? -0.2 : 0.2) : fx), l.scale);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    });
    ctx.globalAlpha = 1;
    // fireflies (blue hour / night)
    var ff = smooth(1.5, 2.6, this.mood) * (1 - rain * 0.85);
    if (ff > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      this.flies.forEach(function (f, i) {
        if (red && i % 2) return;
        var R = M.fireflies[i % M.fireflies.length];
        var x = R[0] + f.u * (R[2] - R[0]) + f.ax * Math.sin(TAU * f.k1 * t / LOOP + f.p1);
        var y = R[1] + f.v * (R[3] - R[1]) + f.ay * Math.sin(TAU * f.k2 * t / LOOP + f.p2);
        var b = Math.pow(Math.max(0, Math.sin(TAU * f.k3 * t / LOOP + f.p3)), 6) * ff;
        if (b < 0.02) return;
        x = Math.round(x + par[0] * 5); y = Math.round(y + par[1] * 3);
        ctx.fillStyle = 'rgba(190,255,120,' + (0.22 * b).toFixed(3) + ')'; ctx.fillRect(x - 1, y - 1, 3, 3);
        ctx.fillStyle = 'rgba(230,255,170,' + (0.9 * b).toFixed(3) + ')'; ctx.fillRect(x, y, 1 + (f.z > 0.7 ? 1 : 0), 1);
      });
      ctx.globalCompositeOperation = 'source-over';
    }
    // lantern halo (illustrated only)
    if (M.lanternC) {
      var fl = 0.86 + 0.08 * Math.sin(t * TAU * 1.1) + 0.05 * Math.sin(t * TAU * 2.7 + 1) + 0.04 * Math.sin(t * TAU * 4.3);
      var hs = (0.55 * w[3] + 0.3 * w[2] + 0.08 * w[1]) * fl;
      if (hs > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        var g = ctx.createRadialGradient(M.lanternC[0], M.lanternC[1], 2, M.lanternC[0], M.lanternC[1], 46);
        g.addColorStop(0, 'rgba(255,190,90,' + (0.35 * hs).toFixed(3) + ')');
        g.addColorStop(0.35, 'rgba(255,150,60,' + (0.12 * hs).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = g; ctx.fillRect(M.lanternC[0] - 50, M.lanternC[1] - 50, 100, 100);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // rain
    if (rain > 0.01) {
      var slope = 0.12 + 0.55 * this.wind + 0.25 * gustEnv(t - 0.8);
      var light = 0.55 + 0.45 * (1 - night);
      ctx.lineWidth = 1;
      this.drops.forEach(function (d, i) {
        if (red && i % 2) return;
        var y = mod(d.y + d.v * t, H + 120) - 60;
        var x = mod(d.x + slope * y, W + 40) - 20;
        x = Math.round(x + par[0] * (1 + d.z * 5)); y = Math.round(y);
        var L = d.len, al = d.a * rain;
        ctx.strokeStyle = 'rgba(' + Math.round(200 * light) + ',' + Math.round(215 * light) + ',' + Math.round(235 * light) + ',' + al.toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(x + 0.5, y + 0.5); ctx.lineTo(x + 0.5 - slope * L, y + 0.5 - L); ctx.stroke();
      });
      // splash glints on near foliage
      ctx.fillStyle = 'rgba(220,235,255,' + (0.35 * rain * light).toFixed(3) + ')';
      for (var s = 0; s < (red ? 10 : 26); s++) {
        var ph = mod(t * 3 + s * 0.618, 1);
        if (ph > 0.25) continue;
        var sx = Math.round((s * 197.3) % W), sy = Math.round(760 + (s * 89.7) % 250);
        ctx.fillRect(sx, sy, 1, 1); if (ph < 0.1) { ctx.fillRect(sx - 1, sy - 1, 1, 1); ctx.fillRect(sx + 1, sy - 1, 1, 1); }
      }
    }
    ctx.restore();
  };

  function create(canvas, opts) {
    var A = global.TAIPEI_ASSETS;
    if (!A) return Promise.reject(new Error('TAIPEI_ASSETS missing'));
    var keys = ['illustrated', 'faithful', 'cls_illustrated', 'cls_faithful', 'plate_illustrated', 'plate_faithful'];
    var ctx = canvas.getContext('2d'); canvas.width = W; canvas.height = H;
    ctx.fillStyle = '#0c0f0d'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#c9b48a'; ctx.font = '20px monospace'; ctx.textAlign = 'center'; ctx.fillText('loading Taipei…', W / 2, H / 2);
    return Promise.all(keys.map(function (k) { return loadImg(A[k]); }).concat([Promise.all(A.falling.map(loadImg))]))
      .then(function (imgs) {
        var assets = {}; keys.forEach(function (k, i) { assets[k] = imgs[i]; }); assets.falling = imgs[keys.length];
        var w = new World(canvas, assets, opts);
        global.renderAt = function (t) { w.render(mod(t, LOOP), { exportMode: true }); };
        global.exportFrames = function (n) { return w.exportFrames(n); };
        return w;
      });
  }

  global.TaipeiWorld = { create: create, MODES: MODES, W: W, H: H, LOOP: LOOP };
})(window);
