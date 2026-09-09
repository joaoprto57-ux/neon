#!/usr/bin/env bash
# Instala o Neon para o usuário atual — sem sudo.
#
# Copia o AppImage para um lugar estável (release/ é recriado a cada
# build), registra o app no menu do sistema e liga o início automático.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DESTINO="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONES="$HOME/.local/share/icons/hicolor"
AUTOSTART="$HOME/.config/autostart"
ALVO="$DESTINO/Neon.AppImage"

AUTOINICIAR=1
[[ "${1:-}" == "--sem-autostart" ]] && AUTOINICIAR=0

echo "▸ Instalando o Neon para $USER"

# ── 1. Localiza o AppImage ───────────────────────────────────
APPIMAGE="$(ls -t "$RAIZ"/release/Neon-*.AppImage 2>/dev/null | head -1 || true)"
if [[ -z "$APPIMAGE" ]]; then
  echo "  ✗ Nenhum AppImage em release/. Gere primeiro:"
  echo "      npm run dist"
  exit 1
fi
echo "  • origem: $(basename "$APPIMAGE")"

# ── 2. Dependências de runtime ───────────────────────────────
faltando=()
command -v python3 >/dev/null || faltando+=("python3")
command -v script  >/dev/null || faltando+=("util-linux (comando 'script')")
command -v nmcli   >/dev/null || faltando+=("network-manager")
python3 -c "import psutil" 2>/dev/null || faltando+=("psutil (pip install -r requirements.txt)")
if (( ${#faltando[@]} )); then
  echo "  ! Dependências ausentes — o app abre, mas com funções quebradas:"
  printf '      - %s\n' "${faltando[@]}"
fi

# ── 3. Copia o executável ────────────────────────────────────
mkdir -p "$DESTINO"
cp -f "$APPIMAGE" "$ALVO"
chmod +x "$ALVO"
echo "  • executável: $ALVO"

# ── 4. Ícones no tema do sistema ─────────────────────────────
for tam in 256 128 64 48 32; do
  origem="$RAIZ/build/icon-$tam.png"
  [[ $tam == 256 && ! -f "$origem" ]] && origem="$RAIZ/build/icon.png"
  if [[ -f "$origem" ]]; then
    mkdir -p "$ICONES/${tam}x${tam}/apps"
    cp -f "$origem" "$ICONES/${tam}x${tam}/apps/neon.png"
  fi
done
echo "  • ícones instalados"

# ── 5. Entrada no menu ───────────────────────────────────────
mkdir -p "$APPS"
cat > "$APPS/neon.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Neon
GenericName=Painel de vigilância
Comment=Monitora rede, processos de IA e e-mail
Exec=$ALVO
Icon=neon
Terminal=false
Categories=System;Monitor;Security;
StartupWMClass=Neon
DESKTOP
chmod +x "$APPS/neon.desktop"
echo "  • entrada de menu criada"

# ── 6. Início automático + ressurreição ──────────────────────
# Preferimos um serviço do systemd ao atalho de autostart: além de
# subir no login, ele traz o app de volta se travar ou for morto.
# Os dois juntos causariam instância dupla, então só um vai valer.
SYSTEMD_UNITS="$HOME/.config/systemd/user"

if (( AUTOINICIAR )); then
  if systemctl --user is-system-running >/dev/null 2>&1 || \
     [[ "$(systemctl --user is-system-running 2>/dev/null)" == "degraded" ]]; then
    mkdir -p "$SYSTEMD_UNITS"
    cat > "$SYSTEMD_UNITS/neon.service" <<UNIT
[Unit]
Description=Neon — painel local de vigilância
# No Cinnamon o graphical-session.target não é ativado; default.target
# é o alvo que de fato sobe no login gráfico.
After=default.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
# No login o default.target pode ser alcançado antes de a sessão
# gráfica exportar DISPLAY para o systemd do usuário.
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 30); do systemctl --user show-environment | grep -q "^DISPLAY=" && break; sleep 1; done'
ExecStart=%h/.local/bin/Neon.AppImage --oculto
# on-failure, não always: sair pela bandeja (saída limpa) mantém o app
# fechado; travamento ou kill fazem ele voltar.
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=10

[Install]
WantedBy=default.target
UNIT
    rm -f "$AUTOSTART/neon.desktop"
    systemctl --user daemon-reload
    systemctl --user enable neon.service >/dev/null 2>&1
    echo "  • serviço systemd instalado (sobe no login e reinicia se cair)"
  else
    mkdir -p "$AUTOSTART"
    cat > "$AUTOSTART/neon.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Neon
Comment=Painel local de vigilância
Exec=$ALVO --oculto
Icon=neon
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=8
DESKTOP
    echo "  • início automático via atalho XDG (systemd de usuário ausente)"
  fi
else
  echo "  • início automático NÃO configurado (--sem-autostart)"
fi

update-desktop-database "$APPS" 2>/dev/null || true
gtk-update-icon-cache -f -t "$ICONES" 2>/dev/null || true

echo
echo "✓ Instalado."
echo "  Abrir agora:      $ALVO"
echo "  Menu do sistema:  procure por \"Neon\""
echo "  Desinstalar:      $RAIZ/desinstalar.sh"
echo
echo "  Fechar a janela deixa o app na bandeja, vigiando."
echo "  Para sair de vez: menu da bandeja → Sair do Neon."
echo
echo "  Estado do serviço:  systemctl --user status neon"
echo "  Parar de vez:       systemctl --user disable --now neon"
