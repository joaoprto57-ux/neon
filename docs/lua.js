/* ============================================================
   A LUA QUE EXPLODE — a abertura de cada aula.

   Como funciona, em três frases:

   1. Uma esfera é montada com triângulos SOLTOS (toNonIndexed),
      cada um sabendo para que lado ele voaria se explodisse.
   2. Um "shader" — um programinha que roda dentro da placa de
      vídeo — empurra cada triângulo nessa direção. O quanto ele
      empurra é um número só: uExplosion.
   3. Esse número é a rolagem da página. Você rola, ela explode.

   Se a placa de vídeo não der conta, ou se a pessoa pediu menos
   animação no sistema, a capa continua bonita — só fica parada.
   ============================================================ */

(function () {
  const canvas = document.getElementById('lua');
  // A textura mora ao lado deste script, não ao lado da página que o
  // chamou. Sem isto, /seguranca/aula.html procuraria lua.jpg dentro
  // de /seguranca/ e não acharia.
  const aqui = document.currentScript ? document.currentScript.src : location.href;
  if (!canvas || typeof THREE === 'undefined') return;

  // Quem pediu "menos movimento" no sistema operacional não recebe
  // animação nenhuma. Acessibilidade não é enfeite.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let cena, camera, renderizador, lua, rolagem = 0;

  try {
    cena = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);
    camera.position.z = 5;

    renderizador = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderizador.setSize(innerWidth, innerHeight);
    renderizador.setPixelRatio(Math.min(devicePixelRatio, 2));  // 2 já basta; 3 só esquenta o celular

    const textura = new THREE.TextureLoader().load(new URL('lua.jpg', aqui).href);

    // Solta os triângulos e dá a cada um a sua direção de fuga.
    const geo = new THREE.IcosahedronGeometry(2, 20).toNonIndexed();
    const n = geo.attributes.position.count;
    const direcoes = new Float32Array(n * 3);
    const p = geo.attributes.position;

    for (let i = 0; i < n; i += 3) {
      // o centro do triângulo aponta para fora da esfera
      const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
      const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
      const forca = Math.random() * 2 + 1;      // cada caco com a sua pressa
      for (let j = 0; j < 3; j++) {
        direcoes[(i + j) * 3]     = x * forca;
        direcoes[(i + j) * 3 + 1] = y * forca;
        direcoes[(i + j) * 3 + 2] = z * forca;
      }
    }
    geo.setAttribute('aDirecao', new THREE.BufferAttribute(direcoes, 3));

    const material = new THREE.ShaderMaterial({
      uniforms: { uTextura: { value: textura }, uExplosao: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        attribute vec3 aDirecao;
        uniform float uExplosao;
        void main() {
          vUv = uv;
          vec3 nova = position + (aDirecao * uExplosao);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(nova, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D uTextura;
        void main() { gl_FragColor = texture2D(uTextura, vUv); }`,
      side: THREE.DoubleSide,
    });

    lua = new THREE.Mesh(geo, material);
    cena.add(lua);
  } catch (e) {
    canvas.style.display = 'none';   // sem placa de vídeo, sem lua. A página segue.
    return;
  }

  // A explosão acompanha a PRIMEIRA tela, não a página inteira.
  // Assim ela termina exatamente quando a aula começa — e não tem
  // divisão por zero quando a página é curta.
  function aoRolar() {
    rolagem = Math.min(scrollY / Math.max(innerHeight, 1), 1);
  }

  function aoRedimensionar() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderizador.setSize(innerWidth, innerHeight);
  }

  function quadro() {
    requestAnimationFrame(quadro);
    lua.material.uniforms.uExplosao.value = rolagem * 4.0;
    lua.rotation.y += 0.002;
    lua.position.x = rolagem * 2;
    canvas.style.opacity = String(1 - rolagem);   // some junto com a capa
    renderizador.render(cena, camera);
  }

  addEventListener('scroll', aoRolar, { passive: true });
  addEventListener('resize', aoRedimensionar);
  aoRolar();
  quadro();
})();
