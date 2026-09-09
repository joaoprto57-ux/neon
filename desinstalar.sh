#!/usr/bin/env bash
# Remove o Neon instalado para o usuário atual.
# Não mexe em ~/neon-relatorios nem no código do projeto.
set -uo pipefail

echo "▸ Removendo o Neon"

remover() {
  if [[ -e "$1" ]]; then
    rm -rf "$1"
    echo "  • removido: $1"
  fi
}

# Desliga o serviço antes de remover os arquivos.
if systemctl --user list-unit-files neon.service >/dev/null 2>&1; then
  systemctl --user disable --now neon.service 2>/dev/null && echo "  • serviço systemd desligado"
fi
remover "$HOME/.config/systemd/user/neon.service"
systemctl --user daemon-reload 2>/dev/null || true

# Encerra o app, se ainda estiver rodando.
pkill -f 'Neon\.AppImage' 2>/dev/null && echo "  • app encerrado"

remover "$HOME/.local/bin/Neon.AppImage"
remover "$HOME/.local/share/applications/neon.desktop"
remover "$HOME/.config/autostart/neon.desktop"
for tam in 256 128 64 48 32; do
  remover "$HOME/.local/share/icons/hicolor/${tam}x${tam}/apps/neon.png"
done
remover "$HOME/.config/Neon"

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo
echo "✓ Removido."
echo "  Seus relatórios continuam em ~/neon-relatorios"
