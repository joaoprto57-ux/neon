#!/usr/bin/env python3
"""
NEON WATCHDOG — Vigilante de Rede

Monitora conexões ativas e detecta atividade suspeita. Pode suspender a
interface de rede automaticamente, mas essa ação é opt-in (AUTO_LOCKDOWN)
— na primeira versão as funções de lockdown existiam e nunca eram chamadas.
"""

import ipaddress
import os
import socket
import subprocess
import sys
import time
from datetime import datetime

import psutil

from neon_config import carregar_env, env_bool, env_int, RAIZ_PROJETO

carregar_env()

WIFI_INTERFACE = os.environ.get("WIFI_INTERFACE", "wlx90916470a8ff")
SCAN_INTERVAL = env_int("WATCHDOG_INTERVAL", 10)

# Desconectar a rede sozinho é uma ação destrutiva: derruba downloads,
# chamadas e sessões remotas. Fica desligado até habilitação explícita.
AUTO_LOCKDOWN = env_bool("AUTO_LOCKDOWN", False)
# Nº de ameaças de severidade ALTA numa varredura para disparar o lockdown.
LOCKDOWN_LIMIAR = env_int("LOCKDOWN_LIMIAR", 3)

TRUSTED_PROCESSES = {
    "firefox", "firefox-bin", "code", "agy", "claude", "node", "python3",
    "systemd", "systemd-resolve", "systemd-resolved", "cupsd",
    "avahi-daemon", "NetworkManager", "gnome-shell", "cinnamon", "Xorg",
    "pulseaudio", "pipewire", "ssh-agent", "dbus-daemon", "snapd",
    "chrome", "chromium", "curl", "wget", "git", "npm", "tsx",
    # O próprio painel: o webview da aba de IA abre conexões externas
    # legítimas (Google, Anthropic). Sem isto o Neon se acusa sozinho.
    "neon", "Neon", "electron", "gemini",
}

TRUSTED_PORTS = {
    22, 53, 80, 443, 631, 3000, 5432, 8080, 8443,
    33675, 37753,          # agy
    51352, 33317, 28366,   # code
}

LOG_FILE = RAIZ_PROJETO / "neon_security.log"
LOG_MAX_BYTES = 5 * 1024 * 1024   # rotaciona a 5 MB
LOG_BACKUPS = 3


# ─── Logging com rotação ──────────────────────────────────────────────
# stdout fica livre para JSON; o log humano vai para stderr e arquivo.

def _rotacionar_log():
    try:
        if not LOG_FILE.exists() or LOG_FILE.stat().st_size < LOG_MAX_BYTES:
            return
        for i in range(LOG_BACKUPS - 1, 0, -1):
            origem = LOG_FILE.with_suffix(f".log.{i}")
            destino = LOG_FILE.with_suffix(f".log.{i + 1}")
            if origem.exists():
                origem.replace(destino)
        LOG_FILE.replace(LOG_FILE.with_suffix(".log.1"))
    except OSError:
        pass


def log_evento(tag: str, mensagem: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    linha = f"[{timestamp}] [{tag}] {mensagem}"
    print(linha, file=sys.stderr, flush=True)
    try:
        _rotacionar_log()
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(linha + "\n")
    except OSError:
        pass


# ─── Classificação de endereços ───────────────────────────────────────

def e_endereco_interno(ip: str) -> bool:
    """
    True para loopback, redes privadas, link-local e ULA IPv6.

    Substitui o startswith() da versão original, que ignorava
    172.16.0.0/12 (faixa padrão do Docker) e todo o IPv6 privado.
    """
    if not ip:
        return True
    try:
        addr = ipaddress.ip_address(ip.strip("[]"))
    except ValueError:
        return False
    return (addr.is_private or addr.is_loopback or addr.is_link_local
            or addr.is_reserved or addr.is_multicast or addr.is_unspecified)


def obter_conexoes_ativas() -> list[dict]:
    """Lista as conexões de rede ativas com dados do processo dono."""
    conexoes = []
    try:
        brutas = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError):
        log_evento("ALERTA", "Sem permissão para listar conexões. Rode com privilégios elevados.")
        return conexoes

    for conn in brutas:
        nome_proc = "desconhecido"
        if conn.pid:
            try:
                nome_proc = psutil.Process(conn.pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass

        conexoes.append({
            "pid": conn.pid,
            "processo": nome_proc,
            "tipo": "TCP" if conn.type == socket.SOCK_STREAM else "UDP",
            "ip_local": conn.laddr.ip if conn.laddr else "",
            "porta_local": conn.laddr.port if conn.laddr else 0,
            "ip_remoto": conn.raddr.ip if conn.raddr else "",
            "porta_remota": conn.raddr.port if conn.raddr else 0,
            "status": conn.status,
        })
    return conexoes


def _e_loopback(ip: str) -> bool:
    """Endereço que só existe dentro da própria máquina."""
    return bool(ip) and (ip.startswith("127.") or ip == "::1")


def analisar_ameacas(conexoes: list[dict]) -> list[dict]:
    """Avalia cada conexão em busca de atividade suspeita."""
    ameacas = []

    for conn in conexoes:
        local_loopback = _e_loopback(conn["ip_local"])
        remoto = conn["ip_remoto"]

        # Tráfego que não sai da máquina não é superfície de ataque:
        # um serviço em 127.0.0.1 não é alcançável de fora. Sem este
        # corte, cupsd (631) e postgres (5432) eram reportados como
        # "ameaça ALTA" só porque, sem privilégios, o psutil não
        # consegue descobrir de qual processo o socket é.
        if local_loopback and (not remoto or _e_loopback(remoto)):
            continue

        motivos = []
        desconhecido = conn["processo"] == "desconhecido"
        exposto = conn["status"] == "LISTEN" and not local_loopback

        if desconhecido and exposto:
            motivos.append(
                f"Processo não identificado escutando em "
                f"{conn['ip_local']}:{conn['porta_local']}"
            )

        if (conn["processo"] not in TRUSTED_PROCESSES
                and remoto
                and not e_endereco_interno(remoto)
                and conn["status"] == "ESTABLISHED"):
            motivos.append(
                f"Processo '{conn['processo']}' com conexão externa para "
                f"{remoto}:{conn['porta_remota']}"
            )

        if (exposto
                and conn["porta_local"] > 10000
                and conn["porta_local"] not in TRUSTED_PORTS
                and conn["processo"] not in TRUSTED_PROCESSES):
            motivos.append(
                f"Porta alta {conn['porta_local']} exposta por '{conn['processo']}'"
            )

        if motivos:
            ameacas.append({
                **conn,
                "motivos": motivos,
                # Processo não identificado quase sempre significa falta
                # de privilégio para ler o dono do socket, não malícia —
                # só é ALTA quando a porta está de fato exposta.
                "severidade": "ALTA" if (desconhecido and exposto) else "MEDIA",
                "timestamp": datetime.now().isoformat(),
            })

    return ameacas


# ─── Controle da interface ────────────────────────────────────────────

def _nmcli(args: list[str], timeout: int):
    return subprocess.run(["nmcli", *args], capture_output=True,
                          text=True, timeout=timeout)


def suspender_rede() -> bool:
    """Desconecta a interface Wi-Fi, cortando toda a comunicação."""
    log_evento("🔴 LOCKDOWN", f"Desconectando interface {WIFI_INTERFACE}...")
    try:
        r = _nmcli(["device", "disconnect", WIFI_INTERFACE], 10)
        if r.returncode == 0:
            log_evento("🔴 LOCKDOWN", "Rede SUSPENSA. Todas as conexões foram cortadas.")
            return True
        log_evento("ERRO", f"Falha ao suspender rede: {r.stderr.strip()}")
    except (subprocess.SubprocessError, OSError) as e:
        log_evento("ERRO", f"Exceção ao suspender rede: {e}")
    return False


def reativar_rede() -> bool:
    """Reconecta a interface Wi-Fi."""
    log_evento("🟢 RESTAURAÇÃO", f"Reativando interface {WIFI_INTERFACE}...")
    try:
        r = _nmcli(["device", "connect", WIFI_INTERFACE], 15)
        if r.returncode == 0:
            log_evento("🟢 RESTAURAÇÃO", "Rede REATIVADA.")
            return True
        log_evento("ERRO", f"Falha ao reativar rede: {r.stderr.strip()}")
    except (subprocess.SubprocessError, OSError) as e:
        log_evento("ERRO", f"Exceção ao reativar rede: {e}")
    return False


def obter_status_rede() -> dict:
    """Status atual das interfaces de rede."""
    try:
        r = _nmcli(["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"], 5)
        interfaces = []
        for linha in r.stdout.strip().split("\n"):
            partes = linha.split(":")
            if len(partes) >= 3:
                interfaces.append({
                    "device": partes[0], "type": partes[1], "state": partes[2],
                })
        return {
            "interfaces": interfaces,
            # Igualdade exata: "disconnected" CONTÉM "connected", então o
            # 'in' original reportava a interface como ativa mesmo caída.
            "wifi_ativa": any(
                i["device"] == WIFI_INTERFACE and i["state"] == "connected"
                for i in interfaces
            ),
        }
    except (subprocess.SubprocessError, OSError) as e:
        log_evento("ERRO", f"Falha ao consultar status da rede: {e}")
        return {"interfaces": [], "wifi_ativa": False, "erro": str(e)}


# ─── Ciclo ────────────────────────────────────────────────────────────

def executar_varredura() -> dict:
    """Executa uma única varredura de segurança de rede."""
    conexoes = obter_conexoes_ativas()
    ameacas = analisar_ameacas(conexoes)

    tcp = sum(1 for c in conexoes if c["tipo"] == "TCP")
    udp = sum(1 for c in conexoes if c["tipo"] == "UDP")
    listen = sum(1 for c in conexoes if c["status"] == "LISTEN")
    estab = sum(1 for c in conexoes if c["status"] == "ESTABLISHED")

    log_evento("VARREDURA",
               f"Conexões: {len(conexoes)} (TCP:{tcp} UDP:{udp} | "
               f"LISTEN:{listen} ESTABLISHED:{estab})")

    if ameacas:
        for a in ameacas:
            log_evento(f"🚨 AMEAÇA [{a['severidade']}]",
                       f"PID:{a['pid']} {a['processo']} -> {'; '.join(a['motivos'])}")
    else:
        log_evento("✅ SEGURO", "Nenhuma atividade suspeita detectada.")

    return {
        "timestamp": datetime.now().isoformat(),
        "total_conexoes": len(conexoes),
        "resumo": {"tcp": tcp, "udp": udp, "listen": listen, "established": estab},
        "conexoes": conexoes,
        "ameacas": ameacas,
        "status_rede": obter_status_rede(),
    }


def avaliar_lockdown(ameacas: list[dict]) -> bool:
    """Decide e executa a suspensão automática da rede, se habilitada."""
    altas = [a for a in ameacas if a["severidade"] == "ALTA"]
    if not AUTO_LOCKDOWN or len(altas) < LOCKDOWN_LIMIAR:
        if altas and not AUTO_LOCKDOWN:
            log_evento("AVISO",
                       f"{len(altas)} ameaça(s) ALTA. AUTO_LOCKDOWN desligado; "
                       "nenhuma ação tomada.")
        return False

    log_evento("🔴 GATILHO",
               f"{len(altas)} ameaça(s) ALTA >= limiar {LOCKDOWN_LIMIAR}. Suspendendo rede.")
    return suspender_rede()


def iniciar_vigilancia():
    """Loop principal do watchdog."""
    log_evento("🛡️ NEON WATCHDOG", "Sistema de vigilância de rede ATIVADO.")
    log_evento("CONFIGURAÇÃO",
               f"Interface: {WIFI_INTERFACE} | Intervalo: {SCAN_INTERVAL}s | "
               f"Auto-lockdown: {'LIGADO' if AUTO_LOCKDOWN else 'desligado'}")

    while True:
        try:
            resultado = executar_varredura()
            if avaliar_lockdown(resultado["ameacas"]):
                log_evento("PAUSA", "Rede suspensa; vigilância continua.")
        except Exception as e:
            log_evento("ERRO", f"Falha na varredura: {e}")
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    if "--uma-vez" in sys.argv:
        import json
        print(json.dumps(executar_varredura(), ensure_ascii=False, default=str))
    else:
        iniciar_vigilancia()
