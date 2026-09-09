/* ============================================================
   OS EFEITOS DE ENTRADA

   Uma regra só: o efeito pertence ao DESTINO.
   Clicou em Python, vem efeito de Python. Clicou em segurança,
   vem o terminal. Clicou em vibração, vem a onda.

   Como usar, em qualquer botão de qualquer página:

       <div onclick="efeito('python', 'python/')">Python</div>
       <div onclick="efeito('glitch', 'seguranca/')">Segurança</div>
       <div onclick="efeito('onda',   'vibracao/')">Vibração</div>

   Para criar um efeito novo, acrescente uma função em EFEITOS
   lá embaixo. Não precisa mexer em mais nada.
   ============================================================ */

const EFEITOS = {};

/* A tela preta onde todo efeito acontece. */
function _palco() {
  const d = document.createElement('div');
  d.style.cssText = `position:fixed;inset:0;z-index:9999;background:#000;
    overflow:hidden;font-family:'Fira Code',ui-monospace,monospace;`;
  document.body.appendChild(d);
  return d;
}

function efeito(nome, destino, duracao = 1500) {
  const fn = EFEITOS[nome];
  // Sem o efeito, ou com "menos animação" ligado no sistema: vai direto.
  if (!fn || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    location.href = destino;
    return;
  }
  const palco = _palco();
  const parar = fn(palco);
  setTimeout(() => {
    if (typeof parar === 'function') parar();
    location.href = destino;
  }, duracao);
}


/* ---------- SEGURANÇA: o terminal cuspindo erro ---------- */
EFEITOS.glitch = (palco) => {
  palco.style.color = '#ff3e3e';
  palco.style.padding = '40px';
  const linhas = ['CRITICAL_ERROR', 'STACK_TRACE_EXPOSED',
                  'VULNERABILITY_FOUND', 'ROOT_ACCESS_DENIED'];
  const t = setInterval(() => {
    const d = document.createElement('div');
    d.textContent = `> ${linhas[Math.floor(Math.random() * linhas.length)]}`
                  + ` at 0x${Math.random().toString(16).substr(2, 8)}`;
    palco.appendChild(d);
    if (palco.children.length > 30) palco.removeChild(palco.firstChild);
  }, 50);
  return () => clearInterval(t);
};


/* ---------- PYTHON: a indentação se montando ----------

   A cara do Python não é cobra: é o RECUO. É a única linguagem
   grande onde o espaço no começo da linha decide o que está
   dentro do quê. Então o efeito é o bloco se montando, recuo
   por recuo, e o >>> do terminal no fim.                      */
EFEITOS.python = (palco) => {
  const AZUL = '#3776ab', AMARELO = '#ffd43b';
  palco.style.cssText += `padding:6vh 8vw;font-size:clamp(13px,2.2vw,20px);
    line-height:1.9;color:${AZUL};`;

  // Código de verdade, do estudo_ia.py — não é texto de enfeite.
  const codigo = [
    [0, 'import math'],
    [0, ''],
    [0, 'def neuronio(entradas, pesos, vies):'],
    [1, 'total = 0'],
    [1, 'for i in range(len(entradas)):'],
    [2, 'total = total + entradas[i] * pesos[i]'],
    [1, 'total = total + vies'],
    [1, 'return total'],
  ];

  let i = 0;
  const t = setInterval(() => {
    if (i >= codigo.length) return;
    const [nivel, texto] = codigo[i++];
    const d = document.createElement('div');
    d.textContent = '    '.repeat(nivel) + texto;
    d.style.cssText = `white-space:pre;opacity:0;transform:translateX(-18px);
      transition:.28s ease-out;color:${nivel ? AZUL : AMARELO};`;
    palco.appendChild(d);
    requestAnimationFrame(() => { d.style.opacity = 1; d.style.transform = 'none'; });
  }, 110);

  // O prompt do interpretador, piscando no fim.
  setTimeout(() => {
    const p = document.createElement('div');
    p.innerHTML = `<span style="color:${AMARELO}">&gt;&gt;&gt;</span> `
                + `<span style="border-right:2px solid ${AMARELO};padding-right:2px"></span>`;
    p.style.marginTop = '1.2em';
    palco.appendChild(p);
  }, 1000);

  return () => clearInterval(t);
};


/* ---------- VIBRAÇÃO: a onda atravessando a tela ----------

   Aqui o efeito não é inventado: é a forma do sinal que o
   sensor lê de verdade — a componente de 66 Hz com ruído
   por cima, que é exatamente o que o painel desenha.          */
EFEITOS.onda = (palco) => {
  const c = document.createElement('canvas');
  c.width = innerWidth; c.height = innerHeight;
  c.style.cssText = 'display:block;width:100%;height:100%';
  palco.appendChild(c);
  const ctx = c.getContext('2d');

  const rotulo = document.createElement('div');
  rotulo.textContent = '66.0 Hz';
  rotulo.style.cssText = `position:absolute;left:8vw;top:12vh;color:#ff77c8;
    font-size:clamp(28px,6vw,64px);letter-spacing:.04em;`;
  palco.appendChild(rotulo);

  let x = 0;
  const meio = c.height / 2, amp = c.height * 0.16;
  const t = setInterval(() => {
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k < 14 && x < c.width; k++, x += 2) {
      // seno dominante + ruído: a onda "cheia" das telas do painel
      const y = meio
        + Math.sin(x * 0.09) * amp
        + Math.sin(x * 0.31) * amp * 0.28
        + (Math.random() - 0.5) * amp * 0.35;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (x >= c.width) { x = 0; ctx.clearRect(0, 0, c.width, c.height); }
  }, 16);

  return () => clearInterval(t);
};
