#!/usr/bin/env python3
"""
NEON WATCHDOG — Vigilante de Rede
Monitora conexões ativas, detecta intrusões e suspende a rede automaticamente.
"""

import os
import time
import subprocess
import json
import psutil
from datetime import datetime
from neon_config import carregar_env

carregar_env()

# Interface de rede Wi-Fi detectada no sistema
WIFI_INTERFACE = os.environ.get("WIFI_INTERFACE", "wlx90916470a8ff")

# Intervalo de varredura (segundos)
SCAN_INTERVAL = int(os.environ.get("WATCHDOG_INTERVAL", 10))

# Processos confiáveis (baseline do sistema)
TRUSTED_PROCESSES = {
    "firefox", "firefox-bin", "code", "agy", "claude", "node", "python3",
    "systemd", "systemd-resolve", "cupsd", "avahi-daemon", "NetworkManager",
    "gnome-shell", "cinnamon", "Xorg", "pulseaudio", "pipewire",
    "ssh-agent", "dbus-daemon", "snapd"
}

# Portas confiáveis (serviços locais conhecidos)
TRUSTED_PORTS = {
    22, 53, 80, 443, 631, 3000, 5432, 8080, 8443,
    33675, 37753,  # agy
    51352, 33317, 28366,  # code
}

# Log de segurança
LOG_FILE = os.path.join(os.path.dirname(__file__), "neon_security.log")


def log_evento(tag: str, mensagem: str):
    """Registra evento no terminal e no arquivo de log."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    linha = f"[{timestamp}] [{tag}] {mensagem}"
    print(linha)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(linha + "\n")
    except Exception:
        pass


def obter_conexoes_ativas() -> list[dict]:
    """Retorna lista de conexões de rede ativas com detalhes do processo."""
    conexoes = []
    for conn in psutil.net_connections(kind="inet"):
        try:
            proc = psutil.Process(conn.pid) if conn.pid else None
            nome_proc = proc.name() if proc else "desconhecido"
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            nome_proc = "desconhecido"

        info = {
            "pid": conn.pid,
            "processo": nome_proc,
            "tipo": "TCP" if conn.type == 1 else "UDP",
            "ip_local": conn.laddr.ip if conn.laddr else "",
            "porta_local": conn.laddr.port if conn.laddr else 0,
            "ip_remoto": conn.raddr.ip if conn.raddr else "",
            "porta_remota": conn.raddr.port if conn.raddr else 0,
            "status": conn.status,
        }
        conexoes.append(info)
    return conexoes


def analisar_ameacas(conexoes: list[dict]) -> list[dict]:
    """Analisa conexões em busca de atividade suspeita."""
    ameacas = []

    for conn in conexoes:
        motivos = []

        # Ignora loopback
        if conn["ip_local"].startswith("127.") or conn["ip_local"] == "::1":
            continue

        # Processo desconhecido com porta aberta
        if conn["processo"] == "desconhecido" and conn["status"] == "LISTEN":
            motivos.append("Processo desconhecido escutando em porta")

        # Processo não confiável com conexão estabelecida para IP externo
        if (conn["processo"] not in TRUSTED_PROCESSES
                and conn["ip_remoto"]
                and not conn["ip_remoto"].startswith("127.")
                and not conn["ip_remoto"].startswith("192.168.")
                and not conn["ip_remoto"].startswith("10.")
                and conn["ip_remoto"] != "::1"
                and conn["status"] == "ESTABLISHED"):
            motivos.append(f"Processo '{conn['processo']}' com conexão externa para {conn['ip_remoto']}")

        # Porta alta suspeita escutando (possível reverse shell)
        if (conn["status"] == "LISTEN"
                and conn["porta_local"] > 10000
                and conn["porta_local"] not in TRUSTED_PORTS
                and conn["processo"] not in TRUSTED_PROCESSES):
            motivos.append(f"Porta alta suspeita {conn['porta_local']} aberta por '{conn['processo']}'")

        if motivos:
            ameacas.append({
                **conn,
                "motivos": motivos,
                "severidade": "ALTA" if "desconhecido" in conn["processo"] else "MEDIA",
                "timestamp": datetime.now().isoformat()
            })

    return ameacas


def suspender_rede():
    """Desconecta a interface Wi-Fi para bloquear toda comunicação de rede."""
    log_evento("🔴 LOCKDOWN", f"SUSPENDENDO REDE — Desconectando interface {WIFI_INTERFACE}...")
    try:
        result = subprocess.run(
            ["nmcli", "device", "disconnect", WIFI_INTERFACE],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            log_evento("🔴 LOCKDOWN", "Rede SUSPENSA com sucesso. Todas as conexões foram cortadas.")
            return True
        else:
            log_evento("ERRO", f"Falha ao suspender rede: {result.stderr}")
            return False
    except Exception as e:
        log_evento("ERRO", f"Exceção ao suspender rede: {e}")
        return False


def reativar_rede():
    """Reconecta a interface Wi-Fi."""
    log_evento("🟢 RESTAURAÇÃO", f"Reativando interface {WIFI_INTERFACE}...")
    try:
        result = subprocess.run(
            ["nmcli", "device", "connect", WIFI_INTERFACE],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0:
            log_evento("🟢 RESTAURAÇÃO", "Rede REATIVADA com sucesso.")
            return True
        else:
            log_evento("ERRO", f"Falha ao reativar rede: {result.stderr}")
            return False
    except Exception as e:
        log_evento("ERRO", f"Exceção ao reativar rede: {e}")
        return False


def obter_status_rede() -> dict:
    """Retorna status atual da interface de rede."""
    try:
        result = subprocess.run(
            ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"],
            capture_output=True, text=True, timeout=5
        )
        interfaces = []
        for linha in result.stdout.strip().split("\n"):
            partes = linha.split(":")
            if len(partes) >= 3:
                interfaces.append({
                    "device": partes[0],
                    "type": partes[1],
                    "state": partes[2]
                })
        return {"interfaces": interfaces, "wifi_ativa": any(
            i["device"] == WIFI_INTERFACE and "connected" in i["state"] for i in interfaces
        )}
    except Exception:
        return {"interfaces": [], "wifi_ativa": False}


def executar_varredura():
    """Executa uma única varredura de segurança de rede."""
    conexoes = obter_conexoes_ativas()
    ameacas = analisar_ameacas(conexoes)

    total_tcp = sum(1 for c in conexoes if c["tipo"] == "TCP")
    total_udp = sum(1 for c in conexoes if c["tipo"] == "UDP")
    total_listen = sum(1 for c in conexoes if c["status"] == "LISTEN")
    total_established = sum(1 for c in conexoes if c["status"] == "ESTABLISHED")

    log_evento("VARREDURA", f"Conexões: {len(conexoes)} (TCP:{total_tcp} UDP:{total_udp} | LISTEN:{total_listen} ESTABLISHED:{total_established})")

    if ameacas:
        for a in ameacas:
            log_evento(f"🚨 AMEAÇA [{a['severidade']}]", f"PID:{a['pid']} Processo:{a['processo']} -> {'; '.join(a['motivos'])}")
    else:
        log_evento("✅ SEGURO", "Nenhuma atividade suspeita detectada.")

    return {
        "timestamp": datetime.now().isoformat(),
        "total_conexoes": len(conexoes),
        "conexoes": conexoes,
        "ameacas": ameacas,
        "status_rede": obter_status_rede()
    }


def iniciar_vigilancia():
    """Loop principal do watchdog."""
    log_evento("🛡️ NEON WATCHDOG", "Sistema de vigilância de rede ATIVADO.")
    log_evento("CONFIGURAÇÃO", f"Interface monitorada: {WIFI_INTERFACE} | Intervalo: {SCAN_INTERVAL}s")

    while True:
        try:
            executar_varredura()
        except Exception as e:
            log_evento("ERRO", f"Falha na varredura: {e}")
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    iniciar_vigilancia()
