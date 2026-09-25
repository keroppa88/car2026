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

// Fixed valley elevation: the road climbs through and above the sea of clouds.
export function createMountainAtmosphere(scene, elevation, route, groundHeightAt) {
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
  // Cloud sea: four cumulus shapes are painted once into a 256px atlas, so the
  // fragment shader is a single texture read (no per-pixel noise). Each shape
  // has a lumpy lit top and a flat, shaded base instead of a plain ellipse.
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = atlasCanvas.height = 256;
  const atlas = atlasCanvas.getContext('2d');
  let puffSeed = 20260925;
  const cloudRandom = () => ((puffSeed = (Math.imul(puffSeed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * 128, oy = Math.floor(cell / 2) * 128;
    atlas.save();
    atlas.beginPath();
    atlas.rect(ox, oy, 128, 128);
    atlas.clip();
    // Lobes rise toward the middle to form a dome, with a broad soft skirt.
    for (let i = 0; i < 26; i++) {
      const t = cloudRandom();
      const x = ox + 14 + t * 100;
      const dome = Math.sin(t * Math.PI);
      const r = 10 + dome * 16 + cloudRandom() * 9;
      const y = oy + 96 - dome * (22 + cloudRandom() * 26) + cloudRandom() * 8;
      const g = atlas.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.75)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      atlas.fillStyle = g;
      atlas.fillRect(ox, oy, 128, 128);
    }
    // Shade the underside; source-atop keeps the painted alpha.
    atlas.globalCompositeOperation = 'source-atop';
    const shade = atlas.createLinearGradient(0, oy + 40, 0, oy + 112);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.42)');
    atlas.fillStyle = shade;
    atlas.fillRect(ox, oy, 128, 128);
    // Flatten and soften the base so it melts into the layer below.
    atlas.globalCompositeOperation = 'destination-out';
    const base = atlas.createLinearGradient(0, oy + 98, 0, oy + 124);
    base.addColorStop(0, 'rgba(0,0,0,0)');
    base.addColorStop(1, 'rgba(0,0,0,1)');
    atlas.fillStyle = base;
    atlas.fillRect(ox, oy, 128, 128);
    atlas.restore();
  }
  const cloudAtlas = new THREE.CanvasTexture(atlasCanvas);
  const puffGeometry = new THREE.PlaneGeometry(1, 1);
  const puffCount = 170;
  const puffVariant = new Float32Array(puffCount * 2);
  const puffMaterial = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, cloudAtlas: { value: cloudAtlas } },
    vertexShader: `
      attribute vec2 variant;
      varying vec2 cloudUv;
      varying float cloudRange;
      void main() {
        vec4 center = modelMatrix * instanceMatrix * vec4(0,0,0,1);
        cloudRange = distance(center.xyz, cameraPosition);
        vec4 view = viewMatrix * center;
        view.xy += position.xy * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        vec2 local = vec2(variant.y > 0.5 ? 1.0 - uv.x : uv.x, uv.y);
        // Canvas row 0 is the top half of the texture (flipY).
        cloudUv = (local + vec2(mod(variant.x, 2.0), 1.0 - floor(variant.x / 2.0))) * 0.5;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform sampler2D cloudAtlas;
      uniform vec3 tint;
      varying vec2 cloudUv;
      varying float cloudRange;
      void main() {
        vec4 c = texture2D(cloudAtlas, cloudUv);
        float fade = smoothstep(25.0, 70.0, cloudRange) * (1.0 - smoothstep(850.0, 1150.0, cloudRange));
        float alpha = c.a * 0.85 * fade;
        if (alpha < 0.01) discard;
        vec3 lit = mix(tint * vec3(0.70, 0.76, 0.84), min(tint * 1.18, vec3(1.0)), c.r);
        gl_FragColor = vec4(lit, alpha);
      }`,
    transparent: true, depthWrite: false,
  });
  const puffs = new THREE.InstancedMesh(puffGeometry, puffMaterial, puffCount);
  // Keep every puff clear of the slopes: a billboard cutting into terrain
  // leaves a hard straight edge, which read as a flat sheet.
  const clearOfGround = (x, y, z, halfWidth) => !groundHeightAt
    || [[0, 0], [halfWidth, 0], [-halfWidth, 0], [0, halfWidth], [0, -halfWidth]]
      .every(([dx, dz]) => groundHeightAt(x + dx, z + dz) < y);
  let placed = 0;
  for (let attempt = 0; attempt < puffCount * 12 && placed < puffCount; attempt++) {
    // Lower tier: wide, flat sheet. Upper tier: rounder domes poking out.
    const upper = placed % 3 === 0;
    const width = upper ? 55 + cloudRandom() * 55 : 90 + cloudRandom() * 90;
    const height = width * (upper ? 0.55 + cloudRandom() * 0.2 : 0.32 + cloudRandom() * 0.12);
    const x = bounds.min.x - 250 + cloudRandom() * (size.x + 500);
    const z = bounds.min.z - 250 + cloudRandom() * (size.z + 500);
    const y = elevation + (upper ? 4 + cloudRandom() * 20 : -12 + cloudRandom() * 12);
    if (!clearOfGround(x, y - height * 0.4, z, width * 0.4)) continue;
    transform.makeScale(width, height, 1);
    transform.setPosition(x, y, z);
    puffs.setMatrixAt(placed, transform);
    puffVariant[placed * 2] = Math.floor(cloudRandom() * 4);
    puffVariant[placed * 2 + 1] = cloudRandom() < 0.5 ? 0 : 1;
    placed++;
  }
  puffs.count = placed;
  puffGeometry.setAttribute('variant', new THREE.InstancedBufferAttribute(puffVariant, 2));
  puffs.instanceMatrix.needsUpdate = true;
  puffs.frustumCulled = false;
  puffs.name = 'gunma-cloud-puffs';
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
