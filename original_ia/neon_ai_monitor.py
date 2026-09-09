#!/usr/bin/env python3
"""
NEON AI MONITOR — Rastreador de Processos de IA
Monitora processos de IA rodando no PC (Antigravity, Claude, Copilot, Ollama, etc).
"""

import os
import time
import json
import psutil
from datetime import datetime
from neon_config import carregar_env

carregar_env()

# Nomes de processos de IA para rastrear
AI_PROCESS_NAMES = {
    "agy": "Antigravity (Gemini)",
    "claude": "Claude Code (Anthropic)",
    "copilot": "GitHub Copilot",
    "ollama": "Ollama (Local LLM)",
    "llama": "LLaMA",
    "openai": "OpenAI",
    "lmstudio": "LM Studio",
    "jan": "Jan AI",
    "gpt4all": "GPT4All",
}

# Diretórios de logs de IA conhecidos
AI_LOG_DIRS = {
    "Antigravity": os.path.expanduser("~/.gemini/antigravity/"),
    "Claude": os.path.expanduser("~/.claude/"),
    "Ollama": os.path.expanduser("~/.ollama/"),
}

SCAN_INTERVAL = int(os.environ.get("AI_MONITOR_INTERVAL", 5))


def log_status(tag: str, mensagem: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{tag}] {mensagem}")


def detectar_processos_ia() -> list[dict]:
    """Detecta e retorna informações detalhadas de todos os processos de IA rodando."""
    processos_ia = []

    for proc in psutil.process_iter(["pid", "name", "cmdline", "cpu_percent", "memory_info",
                                      "create_time", "status", "username"]):
        try:
            nome = proc.info["name"].lower()
            cmdline = " ".join(proc.info["cmdline"] or []).lower()

            # Verificar se é um processo de IA
            ia_detectada = None
            for chave, label in AI_PROCESS_NAMES.items():
                if chave in nome or chave in cmdline:
                    ia_detectada = label
                    break

            # Verificar processo copilot pelo cmdline mais específico
            if not ia_detectada and "copilot" in cmdline:
                ia_detectada = "GitHub Copilot"

            if ia_detectada:
                mem = proc.info["memory_info"]
                mem_mb = mem.rss / (1024 * 1024) if mem else 0
                create_time = datetime.fromtimestamp(proc.info["create_time"])
                uptime = datetime.now() - create_time
                horas = int(uptime.total_seconds() // 3600)
                minutos = int((uptime.total_seconds() % 3600) // 60)

                # Buscar portas abertas por este processo
                portas = []
                try:
                    for conn in proc.net_connections(kind="inet"):
                        if conn.laddr:
                            portas.append(conn.laddr.port)
                except (psutil.AccessDenied, psutil.NoSuchProcess):
                    pass

                processos_ia.append({
                    "nome": ia_detectada,
                    "processo": proc.info["name"],
                    "pid": proc.info["pid"],
                    "cpu_percent": proc.cpu_percent(interval=0.1),
                    "memoria_mb": round(mem_mb, 1),
                    "status": proc.info["status"],
                    "uptime": f"{horas}h {minutos}m",
                    "uptime_seconds": int(uptime.total_seconds()),
                    "portas": list(set(portas)),
                    "cmdline_resumido": " ".join(proc.info["cmdline"][:3]) if proc.info["cmdline"] else "",
                })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    return processos_ia


def verificar_logs_ia() -> list[dict]:
    """Verifica diretórios de logs de IA e retorna informações sobre eles."""
    logs_info = []
    for nome, caminho in AI_LOG_DIRS.items():
        if os.path.exists(caminho):
            try:
                # Conta arquivos e tamanho total
                total_arquivos = 0
                tamanho_total = 0
                arquivo_mais_recente = ""
                data_mais_recente = 0

                for root, dirs, files in os.walk(caminho):
                    for f in files:
                        filepath = os.path.join(root, f)
                        try:
                            stat = os.stat(filepath)
                            total_arquivos += 1
                            tamanho_total += stat.st_size
                            if stat.st_mtime > data_mais_recente:
                                data_mais_recente = stat.st_mtime
                                arquivo_mais_recente = filepath
                        except OSError:
                            pass

                logs_info.append({
                    "nome": nome,
                    "caminho": caminho,
                    "existe": True,
                    "total_arquivos": total_arquivos,
                    "tamanho_mb": round(tamanho_total / (1024 * 1024), 1),
                    "ultimo_arquivo": arquivo_mais_recente,
                    "ultima_modificacao": datetime.fromtimestamp(data_mais_recente).isoformat() if data_mais_recente else ""
                })
            except Exception:
                logs_info.append({"nome": nome, "caminho": caminho, "existe": True, "erro": True})
        else:
            logs_info.append({"nome": nome, "caminho": caminho, "existe": False})

    return logs_info


def obter_relatorio_ia() -> dict:
    """Retorna relatório completo dos processos de IA."""
    processos = detectar_processos_ia()
    logs = verificar_logs_ia()

    return {
        "timestamp": datetime.now().isoformat(),
        "total_processos_ia": len(processos),
        "processos": processos,
        "logs_ia": logs,
        "memoria_total_ia_mb": round(sum(p["memoria_mb"] for p in processos), 1)
    }


def iniciar_monitoramento():
    """Loop de monitoramento de processos de IA."""
    log_status("🤖 NEON AI MONITOR", "Monitor de processos de IA ATIVADO.")

    while True:
        relatorio = obter_relatorio_ia()
        log_status("SCAN", f"{relatorio['total_processos_ia']} processo(s) de IA detectado(s) | Memória total IA: {relatorio['memoria_total_ia_mb']} MB")

        for p in relatorio["processos"]:
            log_status("IA", f"{p['nome']} (PID:{p['pid']}) | CPU:{p['cpu_percent']}% | MEM:{p['memoria_mb']}MB | Uptime:{p['uptime']} | Portas:{p['portas']}")

        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    iniciar_monitoramento()
