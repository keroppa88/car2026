import * as THREE from '../lib/three.module.js';

// A single small repeating canopy mask replaces actual trees and shadow passes.
export function createCanopyShade() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 128, 128);
  let seed = 20260924;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  // Wrap each leaf cluster across tile boundaries for seamless shadows.
  for (let i = 0; i < 65; i++) {
    const x = random()*128, y = random()*128;
    const rx = 3+random()*12, ry = 2+random()*5, angle = random()*Math.PI;
    ctx.fillStyle = `rgba(25,35,40,${0.10+random()*0.2})`;
    for (const dx of [-128, 0, 128]) for (const dy of [-128, 0, 128]) {
      ctx.beginPath();
      ctx.ellipse(x+dx, y+dy, rx, ry, angle, 0, Math.PI*2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  const time = { value: 0 }, strength = { value: 1 };
  const materials = new WeakMap();
  return {
    material(source) {
      if (materials.has(source)) return materials.get(source);
      const material = source.clone();
      material.onBeforeCompile = (shader) => {
        shader.uniforms.canopyMap = { value: texture };
        shader.uniforms.canopyTime = time;
        shader.uniforms.canopyStrength = strength;
        shader.vertexShader = 'varying vec3 canopyWorld;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\ncanopyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = 'uniform sampler2D canopyMap;\nuniform float canopyTime, canopyStrength;\nvarying vec3 canopyWorld;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
          #include <color_fragment>
          vec2 shadeUV = canopyWorld.xz * 0.055;
          shadeUV.x += sin(canopyTime*0.35+canopyWorld.z*0.08)*0.012;
          float shade = texture2D(canopyMap, shadeUV).r;
          float grove = smoothstep(-0.4,0.65,sin(canopyWorld.x*0.035+sin(canopyWorld.z*0.048)));
          diffuseColor.rgb *= 1.0 - (1.0-shade)*0.72*grove*canopyStrength;
        `);
      };
      material.customProgramCacheKey = () => 'gunma-canopy-v1';
      materials.set(source, material);
      return material;
    },
    update(dt, dusk) { time.value += dt; strength.value = 1 - dusk; },
  };
}

// Three shallow, world-anchored cloud layers: no extra textures or postprocessing.
// Fixed valley elevation: the road climbs through and above the sea of clouds.
export function createMountainAtmosphere(scene, elevation, route) {
  const group = new THREE.Group();
  group.name = 'gunma-valley-clouds';
  const uniforms = {
    time: { value: 0 },
    tint: { value: new THREE.Color() },
  };
  // Three overlapping ridgelines share one mesh (576 triangles), with no trees,
  // collision surfaces or shadow maps. Fixed world positions preserve parallax.
  const bounds = new THREE.Box3().setFromPoints(route);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.hypot(size.x, size.z) * 0.5 + 450;
  const ridgeVertices = [], ridgeShades = [], ridgeHeights = [], ridgeIndices = [];
  const segments = 96;
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      const r = radius + layer * 85;
      const profile = 0.5 + 0.23*Math.sin(angle*5+layer*1.7)
        + 0.16*Math.sin(angle*11-layer) + 0.11*Math.sin(angle*19+layer);
      const top = bounds.max.y - 30 + layer*35 + profile*95;
      const x = center.x + Math.cos(angle)*r, z = center.z + Math.sin(angle)*r;
      ridgeVertices.push(x, elevation-140, z, x, top, z);
      ridgeShades.push(0.44+layer*0.16, 0.44+layer*0.16);
      ridgeHeights.push(0, 1);
      if (i < segments) {
        const a = layer*(segments+1)*2 + i*2;
        ridgeIndices.push(a,a+1,a+2,a+1,a+3,a+2);
      }
    }
  }
  const ridgeGeometry = new THREE.BufferGeometry();
  ridgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ridgeVertices,3));
  ridgeGeometry.setAttribute('ridgeShade', new THREE.Float32BufferAttribute(ridgeShades,1));
  ridgeGeometry.setAttribute('ridgeHeight', new THREE.Float32BufferAttribute(ridgeHeights,1));
  ridgeGeometry.setIndex(ridgeIndices);
  const ridges = new THREE.Mesh(ridgeGeometry, new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute float ridgeShade, ridgeHeight;
      varying float shade, height;
      void main() {
        shade = ridgeShade; height = ridgeHeight;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `
      uniform vec3 tint;
      varying float shade, height;
      void main() {
        float haze = 1.0-smoothstep(0.18,0.92,height);
        vec3 mountain = tint * vec3(0.83,0.95,1.0) * shade;
        gl_FragColor = vec4(mix(mountain,tint,haze*0.88),1.0);
      }`,
    side: THREE.DoubleSide,
  }));
  ridges.name = 'gunma-distant-ridges';
  scene.add(ridges);
  // Wisps sit above both verges. All 128 soft billboards use one draw call and
  // one 64px mask, rather than a large particle system or individual tree meshes.
  const mistCanvas = document.createElement('canvas');
  mistCanvas.width = mistCanvas.height = 64;
  const mistCtx = mistCanvas.getContext('2d');
  for (let i = 0; i < 12; i++) {
    const x = 16 + (Math.sin(i*12.37)*0.5+0.5)*32;
    const y = 20 + (Math.cos(i*7.19)*0.5+0.5)*24;
    const gradient = mistCtx.createRadialGradient(x,y,0,x,y,15);
    gradient.addColorStop(0,'rgba(255,255,255,0.3)');
    gradient.addColorStop(1,'rgba(255,255,255,0)');
    mistCtx.fillStyle = gradient;
    mistCtx.fillRect(0,0,64,64);
  }
  const mistMask = new THREE.CanvasTexture(mistCanvas);
  const wisps = new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1), new THREE.ShaderMaterial({
    uniforms: { ...uniforms, mistMask: { value: mistMask } },
    vertexShader: `
      uniform float time;
      varying vec2 mistUv;
      varying float mistRange;
      void main() {
        vec4 center = modelMatrix * instanceMatrix * vec4(0,0,0,1);
        center.x += sin(time*0.09+center.z*0.013)*2.0;
        center.z += cos(time*0.07+center.x*0.015)*1.5;
        mistRange = distance(center.xyz,cameraPosition);
        vec4 view = viewMatrix * center;
        view.xy += position.xy * vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
        mistUv = uv;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform sampler2D mistMask;
      uniform vec3 tint;
      varying vec2 mistUv;
      varying float mistRange;
      void main() {
        float fade = smoothstep(6.0,22.0,mistRange)*(1.0-smoothstep(110.0,190.0,mistRange));
        gl_FragColor = vec4(tint,texture2D(mistMask,mistUv).a*0.28*fade);
      }`,
    transparent: true, depthWrite: false,
  }),128);
  const transform = new THREE.Matrix4();
  for (let i = 0; i < 64; i++) {
    const index = Math.floor(i*route.length/64);
    const p = route[index], next = route[(index+1)%route.length];
    const dx = next.x-p.x, dz = next.z-p.z, length = Math.hypot(dx,dz);
    for (let side = 0; side < 2; side++) {
      const offset = (side ? 1 : -1)*(12+(i%4)*2);
      transform.makeScale(32+(i%5)*4,7+(i%3)*2,1);
      transform.setPosition(p.x+dz/length*offset,p.y+2.5,p.z-dx/length*offset);
      wisps.setMatrixAt(i*2+side,transform);
    }
  }
  wisps.name = 'gunma-roadside-wisps';
  // Billboard rotation and wind are shader-driven, outside the CPU bounds.
  wisps.frustumCulled = false;
  scene.add(wisps);
  // Soft billboards distributed through a volume replace the flat cloud sheets.
  const puffMaterial = new THREE.ShaderMaterial({
    uniforms: wisps.material.uniforms,
    vertexShader: wisps.material.vertexShader,
    fragmentShader: `
      uniform sampler2D mistMask;
      uniform vec3 tint;
      uniform float time;
      varying vec2 mistUv;
      varying float mistRange;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p) {
        vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
          mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }
      void main() {
        vec2 p=mistUv*2.0-1.0;
        float feather=1.0-smoothstep(0.28,0.98,length(p));
        vec2 flow=mistUv*4.0+vec2(time*0.025,-time*0.012);
        float n=noise(flow)*0.65+noise(flow*2.7)*0.35;
        float fade=smoothstep(22.0,65.0,mistRange)*(1.0-smoothstep(800.0,1150.0,mistRange));
        float alpha=texture2D(mistMask,mistUv).a*feather*(0.35+n*0.65)*0.44*fade;
        if(alpha<0.002) discard;
        gl_FragColor=vec4(tint*(0.90+n*0.14),alpha);
      }`,
    transparent: true, depthWrite: false,
  });
  const puffs=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),puffMaterial,288);
  let puffSeed=20260925;
  const cloudRandom=()=>((puffSeed=(Math.imul(puffSeed,1664525)+1013904223)>>>0)/4294967296);
  for(let i=0;i<288;i++) {
    const x=bounds.min.x-200+cloudRandom()*(size.x+400);
    const z=bounds.min.z-200+cloudRandom()*(size.z+400);
    const width=65+cloudRandom()*85, height=22+cloudRandom()*30;
    const y=elevation-14+cloudRandom()*35;
    transform.makeScale(width,height,1);
    transform.setPosition(x,y,z);
    puffs.setMatrixAt(i,transform);
  }
  puffs.instanceMatrix.needsUpdate=true;
  puffs.frustumCulled=false;
  puffs.name='gunma-cloud-puffs';
  group.add(puffs);
  scene.add(group);
  return {
    update(dt, camera, color, hidden) {
      uniforms.time.value += dt;
      uniforms.tint.value.copy(color);
      group.visible = !hidden;
      ridges.visible = !hidden;
      wisps.visible = !hidden;
      // Puff centers stay anchored in the valley as the car moves.
    },
  };
}
