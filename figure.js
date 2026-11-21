// Michel as a vinyl figurine: big rounded head, big round black glasses, open black puffer over a rust shirt.
// Built entirely in code (no downloads). Shared by the site (index.html) and the character lab. Tunables live in character.json.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export const FIG_DEFAULTS = {
  model:  "models/vinyl-figure-split2.glb",                                       // Michel's vinyl figure; set to "" to use the code-built figure below
  rig:    { height:1.8, hipY:.236, shoulderY:.47, shoulderX:.152, pivotX:.157, pivotDY:-.033, pivotDZ:-.008, handY:.195, headY:.5, legX:.06, roughness:.5 },   // joint positions as fractions of height
  colors: { skin:"#efc6a2", hair:"#4e331f", eyes:"#43271c", glasses:"#121212", jacket:"#131313", shirt:"#ad4e3f", pants:"#121111", boots:"#161210" },
  head:   { width:.91, height:.85, depth:.84, round:3 },                    // metres; round = squareness (2 = sphere, higher = boxier)
  face:   { eyeSize:.078, eyeX:.23, eyeY:-.13, browY:0, browW:.2, noseY:-.24, earY:-.12 },
  glasses:{ radius:.19, thickness:.03, y:-.135, oval:.76 },                          // radius to the middle of the rim band
  hair:   { volume:1.4, hairline:.56, wave:.04, back:-.84 },                  // hairline/back in head-relative units (-1..1)
  body:   { width:.6, height:.5, shirtWidth:.2, seams:3, legLength:.26, bootSize:1 },
  anim:   { cadence:3.4, stride:.5, waddle:.06, bob:.03, armSwing:.45 },
  look:   { yaw:.35, pitch:.12 },
  wave:   { raise:118, forward:.42, twist:90, rock:.5, speed:8 },          // degrees up from hanging, forward lean, palm turn (deg), hand rock, rock speed
};
export function mergeFig(base, over){
  const out = JSON.parse(JSON.stringify(base));
  for(const k in (over||{})){
    if(over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && out[k] && typeof out[k] === "object") out[k] = mergeFig(out[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}
export async function loadFigureConfig(url = "character.json"){
  try{ const r = await fetch(url, { cache:"no-store" }); if(r.ok){ const j = await r.json(); if(j && j.figure) return mergeFig(FIG_DEFAULTS, j.figure); } }catch(e){}
  return mergeFig(FIG_DEFAULTS, {});
}

const smooth = (a,b,v)=>{ const t = Math.min(1, Math.max(0, (v-a)/(b-a))); return t*t*(3-2*t); };
const damp = (a,b,l,dt)=>a + (b-a)*(1 - Math.exp(-l*dt));
const lerp = (a,b,t)=>a + (b-a)*t;
const clamp = (v,a,b)=>Math.max(a, Math.min(b, v));
const _hv = new THREE.Vector3(), _dv = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);

// a rounded box with soft, continuous curvature (superellipsoid). p = 2 is a sphere; 3-5 reads as a vinyl "squircle".
function squircle(w, h, d, p = 4, seg = 40){
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg*.75)), a = g.attributes.position, v = new THREE.Vector3();
  for(let i=0;i<a.count;i++){
    v.fromBufferAttribute(a, i);
    const s = Math.pow(Math.pow(Math.abs(v.x),p) + Math.pow(Math.abs(v.y),p) + Math.pow(Math.abs(v.z),p), 1/p) || 1;
    a.setXYZ(i, v.x/s*w/2, v.y/s*h/2, v.z/s*d/2);
  }
  g.computeVertexNormals(); return g;
}
// soft horizontal quilting: pinch the surface inward along a few seam lines
function quilt(g, h, seams, depth = .012, width = .014){
  const a = g.attributes.position, v = new THREE.Vector3();
  for(let i=0;i<a.count;i++){
    v.fromBufferAttribute(a, i); let k = 0;
    for(let j=1;j<=seams;j++){ const ys = -h/2 + h*j/(seams+1); k += Math.exp(-Math.pow((v.y - ys)/width, 2)); }
    const r = Math.hypot(v.x, v.z) || 1, f = 1 - depth*Math.min(1,k)/r;
    a.setXYZ(i, v.x*f, v.y, v.z*f);
  }
  g.computeVertexNormals(); return g;
}
// z of a squircle's front surface at (x, y) (local, centred), to seat features on the face
const surfZ = (w,h,d,p,x,y)=>d/2*Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2*x/w),p) - Math.pow(Math.abs(2*y/h),p)), 1/p);

export class Figure {
  constructor(cfg = FIG_DEFAULTS){
    this.object = new THREE.Group();
    this.phase = 0; this.t = 0; this.wave = 0; this.walkS = 0; this.runS = 0; this.hy = 0; this.hx = 0;
    this.build(cfg);
  }
  // (re)build every mesh from the config; cheap enough to call live from the lab
  build(cfg){
    this.cfg = cfg = mergeFig(FIG_DEFAULTS, cfg);
    if(this.hips){ this.object.remove(this.hips); this.hips.traverse(o=>{ if(o.isMesh) o.geometry.dispose(); }); }
    const C = cfg.colors, H = cfg.head, F = cfg.face, G = cfg.glasses, B = cfg.body, HR = cfg.hair;
    const mat = (c, r = .55, extra = {})=>new THREE.MeshStandardMaterial({ color:c, roughness:r, metalness:0, ...extra });
    const skin = mat(C.skin, .5), eyes = mat(C.eyes, .85), shirt = mat(C.shirt, .8), pants = mat(C.pants, .8), boots = mat(C.boots, .55),
          glass = mat(C.glasses, .28), jacket = mat(C.jacket, .55), hairM = mat(C.hair, .5, { side: THREE.DoubleSide });
    const add = (parent, geo, m, x=0, y=0, z=0)=>{ const o = new THREE.Mesh(geo, m); o.position.set(x,y,z); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o; };

    // ---- hips, short legs, chunky boots ----
    const legL = B.legLength, hipY = .2 + legL;
    const hips = this.hips = new THREE.Group(); hips.position.y = hipY; this.object.add(hips);
    add(hips, squircle(.4, .16, .3, 3), pants, 0, .02, 0);
    this.legs = [-1, 1].map(s=>{
      const hip = new THREE.Group(); hip.position.set(s*.11, 0, 0); hips.add(hip);
      add(hip, squircle(.2, legL + .08, .22, 2.6), pants, 0, -legL/2, 0);
      const boot = new THREE.Group(); boot.position.y = -legL - .1; hip.add(boot);
      const bs = B.bootSize;
      add(boot, squircle(.22*bs, .2*bs, .3*bs, 2.4), boots, 0, .015, -.01);                 // shaft
      add(boot, squircle(.25*bs, .13*bs, .38*bs, 2.6), boots, 0, -.035*bs, .05*bs);          // foot with a rounded toe
      return hip;
    });

    // ---- open puffer jacket over the rust shirt ----
    const spine = this.spine = new THREE.Group(); hips.add(spine);
    const tw = B.width, th = B.height, td = .44, ty = th/2 - .06, open = B.shirtWidth;
    add(spine, squircle(open + .08, th*.9, td*.8, 2.6), shirt, 0, ty + .01, 0);
    const jg = quilt(squircle(tw, th, td, 3.3, 56), th, B.seams, .014, .013);
    const jm = jacket.clone(); jm.side = THREE.DoubleSide;
    jm.onBeforeCompile = sh=>{        // cut the front open where the shirt shows
      sh.uniforms.uOpen = { value: open/2 };
      sh.vertexShader = "varying vec3 vLP;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vLP = position;");
      sh.fragmentShader = "varying vec3 vLP; uniform float uOpen;\n" + sh.fragmentShader.replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n if(abs(vLP.x) < uOpen && vLP.z > 0.) discard;");
    };
    jm.customProgramCacheKey = ()=>"jacket-open";
    add(spine, jg, jm, 0, ty, 0);
    const fz = surfZ(tw, th, td, 3.3, open/2, 0);
    for(const s of [-1,1]) add(spine, squircle(.04, th*.92, .028, 3, 24), jacket, s*(open/2 + .016), ty, fz - .02);   // flat front edges
    // hood behind the neck and a thick scarf under the chin
    const neckY = ty + th/2 - .02;
    add(spine, squircle(.38, .22, .24, 2.4), jacket, 0, neckY + .02, -.14);
    add(spine, new THREE.TorusGeometry(.14, .07, 18, 44), jacket, 0, neckY + .01, .02).rotation.x = Math.PI/2;

    // ---- sleeves (soft seams) and hands ----
    this.arms = [-1, 1].map(s=>{
      const sh = new THREE.Group(); sh.position.set(s*(tw/2 - .03), th - .1, 0); spine.add(sh);
      add(sh, quilt(squircle(.17, .4, .18, 2.3, 40), .4, 2, .01, .012), jacket, s*.012, -.16, 0);
      const hand = new THREE.Group(); hand.position.set(s*.012, -.41, .005); hand.scale.setScalar(1.3); sh.add(hand);
      add(hand, squircle(.1, .12, .085, 2.4, 24), skin, 0, .01, 0);
      for(let f=0; f<3; f++) add(hand, new THREE.CapsuleGeometry(.018, .04, 4, 8), skin, s*(-.028 + f*.028), -.06, .005);   // fingers
      add(hand, new THREE.CapsuleGeometry(.018, .03, 4, 8), skin, -s*.045, -.005, .03).rotation.z = -s*.5;               // thumb
      sh.rotation.z = s*.06;
      return { sh, hand };
    });

    // ---- head: deep, rounded at the bottom ----
    const head = this.head = new THREE.Group(); head.position.y = neckY + .07; spine.add(head);
    const hw = H.width, hh = H.height, hd = H.depth, hp = H.round, hc = hh/2;
    add(head, squircle(hw, hh, hd, hp, 64), skin, 0, hc, 0);
    const face = (x, y, lift = .004)=>surfZ(hw, hh, hd, hp, x, y) + lift;
    // eyes (shallow domes), nose, ears
    for(const s of [-1,1]){
      const ex = s*F.eyeX;
      const ez = face(ex, F.eyeY, 0), en = new THREE.Vector3(                       // lay the eye flat on the face, facing along the surface normal
        Math.sign(ex)*Math.pow(Math.abs(2*ex/hw), hp-1)/hw, Math.sign(F.eyeY)*Math.pow(Math.abs(2*F.eyeY/hh), hp-1)/hh, Math.pow(Math.abs(2*ez/hd), hp-1)/hd).normalize();
      const eye = add(head, new THREE.CircleGeometry(F.eyeSize, 40), eyes, ex + en.x*.004, hc + F.eyeY + en.y*.004, ez + en.z*.004);
      eye.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), en);
      const ear = add(head, new THREE.CylinderGeometry(.075, .075, .04, 28, 1, false, 0, Math.PI), skin, s*(hw/2 + .005), hc + F.earY, -.03);
      ear.rotation.z = Math.PI/2; ear.rotation.y = s > 0 ? 0 : Math.PI; ear.scale.set(1, 1, 1.25);
    }
    const nose = add(head, new THREE.ConeGeometry(.035, .06, 3), skin, 0, hc + F.noseY, face(0, F.noseY, .015));
    nose.rotation.x = Math.PI/2;
    // brows peeking above the rims
    for(const s of [-1,1]){
      const by = G.y + G.radius*(G.oval ?? 1) + G.thickness*.6 + .012 + F.browY, R = .24, arc = 2*Math.asin(Math.min(.95, F.browW/(2*R)));
      const brow = add(head, new THREE.TorusGeometry(R, .027, 10, 28, arc), mat(C.hair, .6), s*F.eyeX, hc + by - R, face(s*F.eyeX, by, .006));
      brow.rotation.z = Math.PI/2 - arc/2; brow.scale.z = .45;
    }
    // big black round glasses: wide flat rims that almost meet, short bridge, arms straight back over the ears
    for(const s of [-1,1]){
      const gx = s*F.eyeX, gz = face(gx, G.y, .03);
      const rim = add(head, new THREE.TorusGeometry(G.radius, G.thickness, 16, 64), glass, gx, hc + G.y, gz); rim.scale.set(1, G.oval ?? 1, .42);
      const outer = F.eyeX + G.radius + G.thickness*.6;
      const armLen = gz + .1;
      const arm = add(head, squircle(.022, .034, armLen, 2.5, 16), glass, s*(hw/2 + .012), hc + G.y + .03, gz - armLen/2);
      add(head, squircle(Math.max(.02, hw/2 + .02 - outer), .034, .03, 2.5, 12), glass, s*(outer + (hw/2 + .02 - outer)/2), hc + G.y + .04, gz - .005);
    }
    const gap = Math.max(.02, 2*(F.eyeX - G.radius - G.thickness) + .02);
    add(head, squircle(gap, .03, .03, 2.5, 12), glass, 0, hc + G.y + .045, face(0, G.y + .05, .035));
    // hair (from the reference): a thick shell with a full swept top, scalloped front hairline, hair down at the temples,
    // a rounded sideburn in front of each ear, full coverage over the back, and soft strand grooves
    const hx = hw*.525, hy2 = hh*.535, hz = hd*.525, V = HR.volume;
    const hg = squircle(hx*2, hy2*2, hz*2, hp, 88), ha = hg.attributes.position;
    const sm = (a,b,v)=>{ const t = Math.min(1, Math.max(0, (v-a)/(b-a))); return t*t*(3-2*t); };
    for(let i=0;i<ha.count;i++){
      let x = ha.getX(i), y = ha.getY(i), z = ha.getZ(i); const nx = x/hx, ny = y/hy2, nz = z/hz;
      y += hh*.075*V*sm(.05, .95, ny)*(.75 + .25*nz);                                    // volume on top
      y += hh*.018*V*Math.sin(nx*5.5 + 1.2)*sm(.45, 1, ny)*sm(-.2, 1, nz);              // the swept wave across the top
      z += hd*.035*V*sm(.25, .9, ny)*sm(.1, .9, nz);                                    // front overhangs the forehead a little
      x *= 1 + .02*V*sm(.2, .9, ny);                                                     // top is a touch wider than the face
      ha.setXYZ(i, x, y, z);
    }
    hg.computeVertexNormals();
    const hm = hairM.clone();
    hm.onBeforeCompile = sh=>{
      Object.assign(sh.uniforms, { uHalf:{ value:new THREE.Vector3(hx, hy2, hz) }, uLine:{ value:HR.hairline }, uWave:{ value:HR.wave }, uBack:{ value:HR.back } });
      sh.vertexShader = "varying vec3 vLP;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vLP = position;");
      sh.fragmentShader = "varying vec3 vLP; uniform vec3 uHalf; uniform float uLine, uWave, uBack;\n" + sh.fragmentShader
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        { vec3 n = vLP/uHalf; float ax = abs(n.x);
          float line = uLine - uWave*pow(abs(sin(n.x*5.2 + .4)), .7)                  // scalloped front edge
                       - .5*smoothstep(.78, .99, ax)                                    // hair comes down at the temples
                       - .25*clamp(-n.z, 0., 1.);
          bool top = n.y > line;
          float zb = mix(-.12, .55, smoothstep(-.45, .5, n.y));                         // side edge: behind the ear, rising to the temple
          bool side = n.z < zb && n.y > uBack;
          vec2 t = vec2((n.z - .16)/.11, (n.y + .02)/.27);                              // rounded sideburn in front of the ear
          bool burn = ax > .7 && dot(t, t) < 1.;
          if(!(top || side || burn)) discard; }`)
        .replace("#include <color_fragment>", `#include <color_fragment>
        { float g = sin((vLP.x*1. + vLP.z*.25)*92. + sin(vLP.z*14. + vLP.y*9.)*2.2);       // soft strand grooves
          diffuseColor.rgb *= .88 + .12*smoothstep(-.7, .7, g); }`);
    };
    hm.customProgramCacheKey = ()=>"hair-shell-2";
    add(head, hg, hm, 0, hc + .012, -.004);
  }
  // speed: m/s along the path · camPose unused (kept for the site's API) · look: cursor -1..1
  update(dt, speed, camPose, look){
    const A = this.cfg.anim, L = this.cfg.look, t = this.t += dt;
    this.walkS = damp(this.walkS, smooth(.05, .7, speed), 7, dt); this.runS = damp(this.runS, smooth(2.6, 4.6, speed), 4, dt);
    const walk = this.walkS, run = this.runS, idle = 1 - walk;
    this.phase += dt*(speed*A.cadence*(1 - run*.25) + idle*0);
    const p = this.phase, s = Math.sin(p), c = Math.cos(p), amp = A.stride*walk*(1 + run*.35);
    // little waddle: legs swing, hips bob and roll, body counter-twists
    this.legs[0].rotation.x = s*amp; this.legs[1].rotation.x = -s*amp;
    this.hips.position.y = .2 + this.cfg.body.legLength + Math.abs(c)*A.bob*walk*(1 + run) + idle*Math.sin(t*1.8)*.004;
    this.hips.rotation.z = s*A.waddle*walk;
    this.spine.rotation.x = run*.18 + walk*.03;
    this.spine.rotation.y = -s*.12*walk;
    this.spine.scale.y = 1 + idle*Math.sin(t*1.8)*.008;
    // arms swing; right arm waves (arm up and out, swaying)
    this.wave = Math.max(0, this.wave - dt); const we = 2.4 - this.wave, wv = this.wave > 0 ? smooth(0, .4, we)*smooth(0, .5, this.wave) : 0;
    const sway = wv*smooth(.3, .55, we)*Math.sin(we*8);
    this.arms[1].sh.rotation.x = -s*A.armSwing*walk; this.arms[1].sh.rotation.z = .1 + idle*Math.sin(t*1.8)*.01;
    this.arms[0].sh.rotation.x = lerp(s*A.armSwing*walk, -.25, wv);
    this.arms[0].sh.rotation.z = lerp(-.1 - idle*Math.sin(t*1.8)*.01, -2.55 + sway*.35, wv);
    this.arms[0].hand.rotation.z = sway*.5;
    // head: bobs with the step, tilts into the wave, drifts toward the cursor when facing you
    const facing = Math.cos(this.object.rotation.y) > .55 ? 1 : 0, k = idle*facing;
    this.hy = damp(this.hy, (look ? look.x : 0)*L.yaw*k, 3, dt); this.hx = damp(this.hx, -(look ? look.y : 0)*L.pitch*k, 3, dt);
    this.head.rotation.y = this.hy + s*.05*walk;
    this.head.rotation.x = this.hx + walk*.03;
    this.head.rotation.z = -s*.035*walk + wv*.08 + idle*Math.sin(t*.7)*.015;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The vinyl figure model (models/vinyl-figure.glb), rigged at load time with a small skeleton so it can walk and wave.
export class VinylRig {
  constructor(gltf, cfg){
    this.isRig = true; this.object = new THREE.Group();
    this.phase = 0; this.t = 0; this.wave = 0; this.walkS = 0; this.runS = 0; this.hy = 0; this.hx = 0;
    // bake the model into plain float geometry: its own transform applied, scaled to height, standing on y = 0, centred
    gltf.scene.updateMatrixWorld(true);
    const bake = src=>{
      const g0 = src.geometry, n = g0.attributes.position.count, P = new Float32Array(n*3), N = new Float32Array(n*3), v = new THREE.Vector3();
      const nm = new THREE.Matrix3().getNormalMatrix(src.matrixWorld);
      for(let i=0;i<n;i++){ v.fromBufferAttribute(g0.attributes.position, i).applyMatrix4(src.matrixWorld); P.set([v.x,v.y,v.z], i*3);
        v.fromBufferAttribute(g0.attributes.normal, i).applyMatrix3(nm).normalize(); N.set([v.x,v.y,v.z], i*3); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(P,3)); geo.setAttribute("normal", new THREE.BufferAttribute(N,3));
      const uv = g0.attributes.uv, U = new Float32Array(n*2); for(let i=0;i<n;i++){ U[i*2] = uv.getX(i); U[i*2+1] = uv.getY(i); } geo.setAttribute("uv", new THREE.BufferAttribute(U,2));
      geo.setIndex(Array.from(g0.index.array)); return geo;
    };
    const parts = {}; let src;
    gltf.scene.traverse(o=>{ if(o.isMesh){ parts[o.name] = bake(o); if(!src) src = o; } });
    // the file may hold the body and its two arms as separate pieces (so the arms can move freely), or one single mesh
    const geo = parts.body || Object.values(parts)[0];
    this.armGeos = parts.armR && parts.armL ? [parts.armR, parts.armL] : null;
    const all = new THREE.Box3(); Object.values(parts).forEach(g=>{ g.computeBoundingBox(); all.union(g.boundingBox); });
    const c = all.getCenter(new THREE.Vector3()), k = (cfg.rig.height)/(all.max.y - all.min.y);
    Object.values(parts).forEach(g=>{ g.translate(-c.x, -all.min.y, -c.z); g.scale(k, k, k); g.computeBoundingSphere(); });
    this.geo = geo;
    const m = src.material; this.mat = new THREE.MeshStandardMaterial({ map: m.map, roughness: cfg.rig.roughness, metalness: 0, side: THREE.DoubleSide });
    this.build(cfg);
  }
  // (re)place the joints and recompute every vertex's bone weights; cheap enough to run live from the lab
  build(cfg){
    this.cfg = cfg = mergeFig(FIG_DEFAULTS, cfg); const R = cfg.rig, h = R.height;
    if(this.mesh){ this.object.remove(this.mesh); this.mesh.skeleton.dispose(); }
    const bone = (x,y,z,parent)=>{ const b = new THREE.Bone(); b.position.set(x,y,z); if(parent) parent.add(b); return b; };
    const hipY = R.hipY*h, shY = R.shoulderY*h, shX = R.shoulderX*h, headY = R.headY*h, legX = R.legX*h;
    const root = bone(0,0,0), hips = bone(0,hipY,0,root), spine = bone(0,.01*h,0,hips), head = bone(0,headY-hipY-.01*h,0,spine);
    const pvX = (R.pivotX ?? R.shoulderX)*h;
    const pvY = shY-hipY-.01*h + (R.pivotDY ?? 0)*h, pvZ = (R.pivotDZ ?? 0)*h;   // the joint sits in the middle of the shoulder, so the sleeve turns in place
    const armR = bone(-pvX, pvY, pvZ, spine), armL = bone(pvX, pvY, pvZ, spine);
    const legR = bone(-legX, 0, 0, hips), legL = bone(legX, 0, 0, hips);
    const bones = [root, hips, spine, head, armR, armL, legR, legL];
    const pos = this.geo.attributes.position, n = pos.count, SI = new Uint16Array(n*4), SW = new Float32Array(n*4);
    const sm = (a,b,v)=>{ const t = Math.min(1, Math.max(0, (v-a)/(b-a))); return t*t*(3-2*t); };
    for(let i=0;i<n;i++){
      const x = pos.getX(i)/h, y = pos.getY(i)/h, ax = Math.abs(x);
      const wH = sm(R.headY - .018, R.headY + .004, y);
      const band = sm(R.shoulderX - .003, R.shoulderX + .003, ax)*sm(R.shoulderY + .03, R.shoulderY + .01, y)*sm((R.handY ?? .195) - .01, R.handY ?? .195, y);
      // plus anything close to the arm's own axis (catches the fingertips tucked against the body)
      const px = (R.pivotX ?? R.shoulderX), ty = Math.min(1, Math.max(0, (R.shoulderY - y)/(R.shoulderY - (R.handY ?? .195) + .02)));
      const dx = ax - (px + .015*ty), dy = y - lerp(R.shoulderY, (R.handY ?? .195) - .02, ty), dist = Math.hypot(dx, dy < 0 && ty >= 1 ? dy : 0);
      const near = sm(.05, .04, dist)*sm(R.shoulderY - .02, R.shoulderY - .06, y);
      const wA = this.armGeos ? 0 : (1 - wH)*Math.max(band, near);   // sleeve + whole hand (only when the arms are part of the body mesh)
      const wL = (1 - wA)*sm(R.hipY + .012, R.hipY - .012, y)*Math.max(sm(R.shoulderX + .004, R.shoulderX - .02, ax), sm(R.hipY - .02, R.hipY - .04, y));   // legs, but never the hands
      const wS = Math.max(0, 1 - wH - wA - wL);
      const side = x < 0 ? 0 : 1;
      SI.set([3, 4 + side, 6 + side, 2], i*4); SW.set([wH, wA, wL, wS], i*4);
    }
    this.geo.setAttribute("skinIndex", new THREE.BufferAttribute(SI, 4)); this.geo.setAttribute("skinWeight", new THREE.BufferAttribute(SW, 4));
    const mesh = this.mesh = new THREE.SkinnedMesh(this.geo, this.mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    mesh.add(root); mesh.bind(new THREE.Skeleton(bones)); this.object.add(mesh);
    if(this.armGeos){
      mesh.updateMatrixWorld(true);
      [armR, armL].forEach((b, i)=>{
        this.object.updateMatrixWorld(true); const pv = this.object.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
        const g = this.armGeos[i].clone(); g.translate(-pv.x, -pv.y, -pv.z);
        const am = new THREE.Mesh(g, this.mat); am.castShadow = true; am.receiveShadow = true; b.add(am);
      });
    }
    this.mat.roughness = R.roughness;
    Object.assign(this, { hips, spine, head, hipBase: hipY });
    armR.rotation.order = armL.rotation.order = "XZY";   // twist along the arm, then raise, then swing
    this.legs = [legR, legL]; this.arms = [{ sh: armR }, { sh: armL }];
  }
  update(dt, speed, camPose, look){
    const A = this.cfg.anim, L = this.cfg.look, t = this.t += dt;
    this.walkS = damp(this.walkS, smooth(.05, .7, speed), 7, dt); this.runS = damp(this.runS, smooth(2.6, 4.6, speed), 4, dt);
    const walk = this.walkS, run = this.runS, idle = 1 - walk;
    this.phase += dt*speed*A.cadence*(1 - run*.25);
    const p = this.phase, s = Math.sin(p), c = Math.cos(p), amp = A.stride*walk*(1 + run*.35);
    this.legs[0].rotation.x = s*amp; this.legs[1].rotation.x = -s*amp;
    this.hips.position.y = this.hipBase + Math.abs(c)*A.bob*walk*(1 + run) + idle*Math.sin(t*1.8)*.004;
    this.hips.rotation.z = s*A.waddle*walk;
    this.spine.rotation.x = run*.16 + walk*.03; this.spine.rotation.y = -s*.12*walk;
    this.spine.scale.y = 1 + idle*Math.sin(t*1.8)*.006;
    this.wave = Math.max(0, this.wave - dt); const we = 2.4 - this.wave, wv = this.wave > 0 ? smooth(0, .4, we)*smooth(0, .5, this.wave) : 0;
    const W = Object.assign({ raise:118, forward:.42, twist:90, rock:.5, speed:8 }, this.cfg.wave || {});
    const sway = wv*smooth(.3, .55, we)*Math.sin(we*W.speed);
    this.arms[1].sh.rotation.x = -s*A.armSwing*walk; this.arms[1].sh.rotation.z = idle*Math.sin(t*1.8)*.01;
    const up = this.armGeos ? 1 : 0;   // with free arms he can raise his hand up beside his head
    this.arms[0].sh.rotation.x = lerp(s*A.armSwing*walk, lerp(-.5, W.forward, up), wv);   // raised arm leans forward, in front of the head (not behind it)
    this.arms[0].sh.rotation.y = wv*up*(-W.twist*Math.PI/180 + sway*W.rock);   // palm turns to face forward, and rocks side to side like a real wave
    this.arms[0].sh.rotation.z = lerp(-idle*Math.sin(t*1.8)*.01, lerp(-.8, -W.raise*Math.PI/180, up) + sway*.1, wv);
    // press: a short forward reach at hand height (set this.reach 0..1 from the site)
    const rc = this.reach || 0; if(rc > 0){ const P = this.cfg.press || {}; this.arms[0].sh.rotation.x = lerp(this.arms[0].sh.rotation.x, P.x ?? -.62, rc); this.arms[0].sh.rotation.z = lerp(this.arms[0].sh.rotation.z, P.z ?? .06, rc); this.spine.rotation.x += rc*.05; }
    // head: follows a point in the world (the cursor, or you while you talk to him); falls back to screen-space look
    let ty = 0, tx = 0;
    if(this.lookTarget){
      const hp = this.head.getWorldPosition(_hv), d = _dv.copy(this.lookTarget).sub(hp).applyAxisAngle(_Y, -this.object.rotation.y);
      const yw = Math.atan2(d.x, d.z), pt = -Math.atan2(d.y, Math.hypot(d.x, d.z));
      if(Math.abs(yw) < 1.9){ ty = clamp(yw*.6, -.3, .3)*idle; tx = clamp(pt*.5, -.1, .08)*idle; }   // a gentle turn, never enough to pull the neck out of shape; never looks behind himself
    } else { const facing = Math.cos(this.object.rotation.y) > .55 ? 1 : 0, k = idle*facing; ty = (look ? look.x : 0)*L.yaw*k; tx = -(look ? look.y : 0)*L.pitch*k; }
    // slow, eased follow: the target itself is smoothed first, then the head eases toward it (no snapping when the cursor jumps)
    this.ty2 = damp(this.ty2 || 0, ty, 1.6, dt); this.tx2 = damp(this.tx2 || 0, tx, 1.6, dt);
    this.hy = damp(this.hy, this.ty2, 2.2, dt); this.hx = damp(this.hx, this.tx2, 2.2, dt);
    this.head.rotation.y = this.hy + s*.05*walk;
    this.head.rotation.x = this.hx + walk*.03;
    this.head.rotation.z = -s*.035*walk + wv*.08 + idle*Math.sin(t*.7)*.015;
    // nod: set this.nod = .7 for one friendly double nod
    if(this.nod > 0){ this.nod = Math.max(0, this.nod - dt); const u = 1 - this.nod/.7; this.head.rotation.x += Math.sin(u*Math.PI*2)*Math.sin(u*Math.PI)*.2; }
    // small idle moments and reactions: this.gesture("shrug" | "look" | "stretch" | "double")
    if(this.gest){ const G = this.gest; G.t += dt; const u = G.t/G.d, e = smooth(0, .22, u)*(1 - smooth(.75, 1, u));
      if(u >= 1) this.gest = null;
      else if(G.name === "shrug"){ const a0 = this.arms[0].sh, a1 = this.arms[1].sh, b = Math.sin(Math.min(1, u*1.6)*Math.PI)*e;   // a little shrug, head tilted
        a0.rotation.z = lerp(a0.rotation.z, -.55, b); a1.rotation.z = lerp(a1.rotation.z, .55, b); a0.rotation.x -= b*.25; a1.rotation.x -= b*.25;
        this.hips.position.y += b*.012; this.head.rotation.z += e*.12; }
      else if(G.name === "look"){ this.head.rotation.y += e*Math.sin(u*Math.PI*2)*.75; this.head.rotation.x -= e*.12; }   // takes in the view, one side then the other
      else if(G.name === "stretch"){ const a0 = this.arms[0].sh, a1 = this.arms[1].sh;   // a quick stretch, arms up
        a0.rotation.z = lerp(a0.rotation.z, -2.6, e); a1.rotation.z = lerp(a1.rotation.z, 2.6, e); a0.rotation.x = lerp(a0.rotation.x, .1, e); a1.rotation.x = lerp(a1.rotation.x, .1, e);
        this.spine.scale.y += e*.03; this.head.rotation.x -= e*.18; }
      else if(G.name === "double"){ this.head.rotation.y += Math.sin(u*Math.PI*3)*(1 - u)*.55; this.head.rotation.x -= e*.08; }   // wait, what? a quick double-take
    }
    // talking: easy hand gestures in time with his voice (set this.talking and this.talkLv 0..1 from the site)
    this.talkS = damp(this.talkS || 0, this.talking ? 1 : 0, 3, dt); this.lvS = damp(this.lvS || 0, this.talkLv || 0, 10, dt);
    if(this.talkS > .01 && !(this.reach > 0) && !this.gest){ const T = this.talkS*idle, v = this.lvS;
      const a0 = this.arms[0].sh, a1 = this.arms[1].sh;
      const g0 = .5 + .5*Math.sin(t*2.3), g1 = .5 + .5*Math.sin(t*1.9 + 2.1);   // hands open out from his sides, one then the other, bigger on louder words
      a0.rotation.x += -T*(.35 + .2*g0 + v*.25); a0.rotation.z += -T*(.18 + .3*g0*(.6 + v));
      a1.rotation.x += -T*(.3 + .2*g1 + v*.2); a1.rotation.z += T*(.14 + .26*g1*(.6 + v));
      this.head.rotation.x += T*v*.07*Math.sin(t*8); this.head.rotation.z += T*.035*Math.sin(t*1.1); }
  }
  gesture(name, d){ if(this.gest && this.gest.name !== "double") return; this.gest = { name, t: 0, d: d || { shrug: 1.8, look: 3.2, stretch: 2.2, double: .9 }[name] || 2 }; }
  static async load(cfg){
    const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
    return new VinylRig(await loader.loadAsync(cfg.model), cfg);
  }
}
// the site's character: the vinyl figure when the model loads, otherwise the code-built figure
export async function loadHero(url = "character.json"){
  const cfg = await loadFigureConfig(url);
  if(cfg.model){ try{ return await VinylRig.load(cfg); }catch(e){ console.warn("Vinyl figure failed to load, using the built figure.", e); } }
  return new Figure(cfg);
}
