# Código de terceiros

Estes arquivos **não** são do Neon. Estão aqui porque o painel roda
offline, sem CDN — então as bibliotecas viajam dentro do repositório, e
com elas a licença de cada uma.

| Pasta / arquivo | Projeto | Versão | Licença |
|---|---|---|---|
| `monaco/` | [Monaco Editor](https://github.com/microsoft/monaco-editor) — Microsoft | 0.52.2 | MIT — `monaco/LICENSE` |
| `xterm.js`, `xterm.css` | [xterm.js](https://github.com/xtermjs/xterm.js) | 5.5.0 | MIT — `LICENSE.xterm` |
| `addon-fit.js` | [@xterm/addon-fit](https://github.com/xtermjs/xterm.js) | 0.10.0 | MIT — `LICENSE.addon-fit` |

As três são MIT: pode redistribuir, inclusive em produto fechado, desde
que o texto da licença e o aviso de copyright acompanhem os arquivos.
É exatamente o que este diretório faz.

Nada aqui deve ser editado à mão — para atualizar, troque a versão em
`package.json` e copie de novo de `node_modules/`, junto com a licença.
