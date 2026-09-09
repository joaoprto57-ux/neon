# Neon

**Site no ar → https://joaoprto57-ux.github.io/neon/**

Um projeto de segurança que virou curso. O código roda, e cada erro que
aparece nas aulas quebrou alguma coisa de verdade nesta máquina — com a
foto do terminal na hora em que quebrou.

| | |
|---|---|
| [Do zero ao .gitignore](https://joaoprto57-ux.github.io/neon/seguranca/) | 6 aulas de segurança, do scanner de portas ao `.gitignore` |
| [Uma rede neural em tijolos](https://joaoprto57-ux.github.io/neon/python/) | rede neural em Python puro, sem numpy, até a XOR aprender |
| [Vibração ao vivo](https://joaoprto57-ux.github.io/neon/vibracao/) | laudo de vibração de um motor real: FFT, Nyquist, ISO 10816 |

A pasta [`original_ia/`](original_ia/) guarda a primeira geração do código,
com os defeitos inteiros. Dá para rodar `diff -u original_ia/arquivo.py arquivo.py`
e ver o conserto acontecer — é o "antes" de cada aula.

---

## O que é, por dentro

Sistema de monitoramento de segurança local: vigilância de rede, rastreamento
de processos de IA e triagem de e-mail — com uma API HTTP em Node/TypeScript
por cima dos módulos Python.

## Componentes

| Módulo | Papel |
|---|---|
| `neon_watchdog.py` | Monitora conexões de rede, detecta atividade suspeita e pode suspender a interface. |
| `neon_ai_monitor.py` | Rastreia processos de IA (Antigravity, Claude, Copilot, Ollama…). |
| `neon_interceptor.py` | Varre e-mails via IMAP e pontua indícios de phishing/malware. |
| `neon_emails.py` | Leitura da caixa de entrada (listar / relatório / conteúdo). |
| `neon_core.py` | Teste de conectividade com o PostgreSQL. |
| `neon_daemon.py` | Worker persistente de telemetria (JSON-lines por stdin/stdout). |
| `public/dashboard.html` | Painel ao vivo com terminal. |
| `neon_email_utils.py` | Utilitários compartilhados de e-mail e análise de URL. |
| `neon_config.py` | Carregador de `.env` sem dependências. |
| `src/` | API HTTP (Express 5 + Zod) que expõe os módulos acima. |

## Instalação

```bash
pip install -r requirements.txt   # psutil, psycopg2
npm install
cp .env.example .env              # e preencha
```

Gere o token obrigatório da API:

```bash
openssl rand -hex 32
```

e coloque em `NEON_API_TOKEN` no `.env`.

> **Porta 3000:** o Antigravity (`agy`) também escuta nela. Se a API não
> responder, troque `PORT` no `.env`.


## Aplicativo

O Neon é um app de desktop (Electron). O painel não roda mais numa aba do
navegador: é uma janela própria, com ícone e entrada no menu do sistema.

### Instalar

```bash
npm run dist          # gera AppImage + .deb em release/
./instalar.sh         # instala para o seu usuário, sem sudo
```

O `instalar.sh` copia o AppImage para `~/.local/bin/Neon.AppImage`,
registra ícone e entrada de menu, e **liga o início automático**. Ele
copia para fora de `release/` de propósito: aquela pasta é recriada a
cada build, e um atalho apontando para lá quebraria.

Para instalar sem iniciar junto com o sistema:

```bash
./instalar.sh --sem-autostart
```

Para remover: `./desinstalar.sh` (preserva `~/neon-relatorios`).

Alternativa com sudo, instalando no sistema todo:
`sudo apt install ./release/neon_1.0.0_amd64.deb`

### Sempre presente

O app foi feito para não sair de perto:

| Situação | O que acontece |
|---|---|
| Você liga o PC | Sobe sozinho, **oculto na bandeja** (não rouba a tela no login) |
| Você fecha a janela | Esconde na bandeja e **continua vigiando** |
| O app trava ou é morto | O systemd **reinicia em 5 s** |
| Bandeja → *Sair do Neon* | Aí sim encerra, e **fica fechado** até o próximo login |

Quem cuida disso é um serviço do systemd de usuário, instalado pelo
`instalar.sh` em `~/.config/systemd/user/neon.service`:

```bash
systemctl --user status neon        # ver estado
systemctl --user restart neon       # reiniciar
systemctl --user disable --now neon # desligar de vez
```

Duas decisões deliberadas nele:

- **`Restart=on-failure`, não `always`.** Com `always`, sair pela bandeja
  faria o systemd reabrir o app na sua cara. Assim, saída limpa é
  respeitada; só travamento e `kill` disparam a volta.
- **`WantedBy=default.target`, não `graphical-session.target`.** No
  Cinnamon o alvo de sessão gráfica nunca é ativado — apontar para ele
  faria o serviço jamais subir. Há ainda um `ExecStartPre` que espera o
  `DISPLAY` aparecer no ambiente do systemd, porque o `default.target`
  pode ser alcançado antes de a sessão gráfica exportá-lo.

Em máquinas sem systemd de usuário, o instalador cai para um atalho XDG
em `~/.config/autostart/` — sobe no login, mas sem ressurreição.

## O que o painel mostra

Atualizando a cada 2,5 s: conexões de rede, ameaças, processos de IA e
memória consumida por eles, com minigráficos de tendência; tabela de
conexões filtrável; e botões para suspender e reativar a rede.

### Terminal

Terminal de verdade, com PTY alocado pelo `script` do util-linux e
renderizado com xterm.js. Funcionam cores ANSI, <kbd>Ctrl+C</kbd>,
<kbd>Tab</kbd>, histórico e **aplicações de tela cheia** — `vim`, `htop`,
`top`, `less`. A sessão é persistente: `cd` e variáveis sobrevivem.

Quando algum programa toma conta do terminal — o Claude Code, o Gemini,
um `top` — aparece na barra o botão **■ encerrar _nome_**. Ele manda
SIGTERM para o grupo de processos em primeiro plano (o `tpgid` do shell,
lido em `/proc`) e o shell continua de pé; clicar de novo escala para
SIGKILL. Existe porque nessas TUIs o <kbd>Ctrl+C</kbd> só cancela a
tarefa da vez, e não havia como sair delas pelo painel.

Escolhi o `script` em vez do `node-pty` para não depender de módulo nativo:
nada de compilar nem de `electron-rebuild` a cada atualização do Electron.

O terminal não filtra comandos. A proteção é a fronteira — loopback,
bearer token, CORS restrito e painel servido só para a própria máquina —
não a inspeção do texto digitado. Para desligar: `ENABLE_TERMINAL=false`.

### Ao vivo — espelho do Claude Code

Mostra, em tempo real, o que o Claude Code está escrevendo na sessão
ativa: a explicação primeiro, o código depois, na ordem em que acontece.

| Interruptor | O que mostra |
|---|---|
| explicações | o texto do assistente — o "como funciona" |
| pedidos | o que você pediu, para dar contexto |
| comandos | as linhas de shell executadas (desligado por padrão) |
| seguir | rolagem automática |

Cada bloco de código tem **copiar** e **no editor** (joga o trecho na
aba Editor, já na linguagem certa, pronto para rodar).

**Nada some, e só você apaga.** Cada bloco vira uma linha em
`~/.local/share/neon/historico.jsonl`, gravada com `fsync` — os bytes
descem ao disco antes de o programa seguir, em vez de ficarem no cache
do sistema esperando. Um desligamento na tomada não leva o registro
junto.

A ordem das escritas é deliberada: **primeiro o histórico, só depois a
posição de leitura**. Se a energia cair no meio, na volta o trecho é
relido — nunca pulado. A repetição é barrada por assinatura de conteúdo,
então reler é seguro e perder não é possível.

As posições são salvas de forma atômica (temporário + `fsync` +
`rename`), porque um `posicoes.json` pela metade seria pior que nenhum.

Se a queda pegar a escrita no meio da linha, a linha incompleta é
descartada na próxima gravação — e só ela: tudo antes é preservado, e o
registro seguinte não gruda no pedaço quebrado.

Ao reabrir, o painel retoma exatamente de onde parou, inclusive
recuperando o que aconteceu com o app fechado. Uma transcrição nunca
vista é lida desde o início, então o histórico nasce completo.

O arquivo nunca é sobrescrito: ao passar de 256 MB ele é arquivado como
`historico-<data>.jsonl` e um novo começa. Nenhum comando do painel
apaga histórico — o botão *limpar* esvazia só a tela.

Em memória ficam os últimos 400 blocos; **carregar mais antigos** busca
o resto no disco. O botão *limpar* esvazia só a tela — o arquivo
continua intacto.

O arquivo rotaciona em 256 MB (na prática, ~1 KB por bloco: a sessão que
gerou este README ocupava 580 KB com 458 blocos).

Fica de fora, de propósito: `tool_result` (saída bruta dos comandos, que
já aparece no terminal) e lembretes internos do sistema.

### Scripts do Neon

A aba "Scripts do Neon" roda os módulos do projeto dentro do painel, com
saída ao vivo:

| Script | O que faz |
|---|---|
| Vigilância de rede | `neon_watchdog.py` em varredura contínua |
| Monitor de IA | `neon_ai_monitor.py` contínuo |
| Interceptador de e-mail | uma patrulha IMAP, segundo `INTERCEPTOR_ACAO` |
| Listar e-mails | mensagens não lidas da caixa |
| Teste do banco | conectividade com o PostgreSQL |

O botão **salvar saída** grava o log em `~/neon-relatorios/`, com carimbo
de data e hora. O menu *Neon → Abrir pasta de relatórios* leva até lá.

## Arquitetura

```
   janela Electron
        │  HTTP + SSE (loopback, bearer token)
   Express ├── neon_daemon.py    worker Python persistente (psutil)
           ├── script → PTY      sessão de terminal
           └── python3 neon_*.py scripts sob demanda
```

O `neon_daemon.py` fica de pé em vez de um `python3 -c` por requisição:
88 ms → 46 ms por chamada, e sem criar processo a cada tick do painel.

## Uso

### API HTTP

```bash
npm run dev      # desenvolvimento
npm run build && npm start
npm run lint     # checagem de tipos
```

| Rota | Método | Auth |
|---|---|---|
| `/api/health` | GET | pública |
| `/api/security/connections` | GET | Bearer |
| `/api/security/threats` | GET | Bearer |
| `/api/security/ai-processes` | GET | Bearer |
| `/api/security/network/status` | GET | Bearer |
| `/api/security/network/suspend` | POST | Bearer |
| `/api/security/network/resume` | POST | Bearer |
| `/api/security/snapshot` | GET | Bearer |
| `/api/stream/telemetry` | GET (SSE) | Bearer |
| `/api/stream/terminal` | GET (SSE) | Bearer |
| `/api/terminal/execute` | POST | Bearer + `ENABLE_TERMINAL=true` |
| `/api/terminal/interrupt` | POST | Bearer |
| `/api/terminal/reset` | POST | Bearer |

```bash
curl -H "Authorization: Bearer $NEON_API_TOKEN" \
     http://localhost:3000/api/security/connections
```

### Scripts Python

```bash
python3 neon_watchdog.py              # vigilância contínua
python3 neon_watchdog.py --uma-vez    # uma varredura, saída JSON

python3 neon_ai_monitor.py
python3 neon_ai_monitor.py --uma-vez

python3 neon_interceptor.py --uma-vez # patrulha única de e-mail
python3 neon_emails.py listar -n 25
python3 neon_emails.py conteudo -n 15 -o saida.json
```

## Segurança — padrões escolhidos

O sistema tem autoridade destrutiva (apagar e-mail, derrubar a rede, executar
comandos). Toda ação irreversível é **opt-in**:

| Variável | Padrão | Efeito ao ligar |
|---|---|---|
| `INTERCEPTOR_ACAO` | `relatorio` | `quarentena` move a mensagem; `excluir` apaga de vez. |
| `AUTO_LOCKDOWN` | `false` | Desconecta o Wi-Fi sozinho ao detectar ameaças. |
| `ENABLE_TERMINAL` | `false` | Libera o terminal do painel (shell livre). |
| `HOST` | `127.0.0.1` | Interface de escuta. Só mude se souber por quê. |
| `NEON_API_TOKEN` | vazio | Sem token, `/api/security/*` responde 503. |
| `CORS_ORIGIN` | `http://localhost:3000` | Origens de navegador autorizadas. |

Recomendação: rode o interceptador em `relatorio` por alguns dias e confira o
que ele marcaria antes de passar para `quarentena`. Não use `excluir` sem ter
validado a calibragem — a mensagem não volta.

## Dados sensíveis

`emails_*.json` contêm remetentes, assuntos e corpo de e-mails reais. Estão no
`.gitignore` e não devem ser versionados. O `.env` guarda a senha de app do
e-mail e o token da API.

`neon_sentinela_estado.json` também fica de fora: ele registra os IPs que esta
máquina acessou, com processo e porta — é o mapa da sua rede.

## Histórico

`original_ia/` preserva a primeira geração do código, antes da revisão.
Ver `original_ia/LEIA-ME.md`.

## Licença

O Neon é ISC — ver `LICENSE`.

Duas coisas convivem no repositório, e a diferença importa:

- **Bibliotecas que viajam junto.** `public/vendor/` traz o Monaco Editor e o
  xterm.js em arquivo, para o painel funcionar sem CDN. São MIT e a licença de
  cada uma está ao lado do código — ver `public/vendor/LEIA-ME.md`.
- **Programas que o painel apenas chama.** O `code-server`, o `code`, o Claude
  Code, o Gemini CLI e as extensões do VS Code não estão aqui: o Neon procura o
  binário na máquina e executa. Nada deles é redistribuído por este
  repositório.
