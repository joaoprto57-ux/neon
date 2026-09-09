#!/usr/bin/env python3
"""
NEON AI MONITOR — Rastreador de Processos de IA

Monitora processos de IA em execução (Antigravity, Claude, Copilot,
Ollama, etc.), com uso de recursos e portas abertas.
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import psutil

from neon_config import carregar_env, env_int

carregar_env()

# Chaves curtas demais ("jan") geravam falso positivo em qualquer linha
# de comando que as contivesse. Cada entrada agora traz os termos que
# realmente identificam o processo.
AI_PROCESSOS = {
    "Antigravity (Gemini)": {"nomes": {"agy"}, "cmd": {"antigravity"}},
    "Claude Code (Anthropic)": {"nomes": {"claude"}, "cmd": {"claude-code", "@anthropic-ai/claude-code"}},
    "GitHub Copilot": {"nomes": {"copilot"}, "cmd": {"copilot-language-server", "github-copilot"}},
    "Ollama (Local LLM)": {"nomes": {"ollama"}, "cmd": {"ollama serve", "ollama run"}},
    "LM Studio": {"nomes": {"lmstudio", "lm-studio"}, "cmd": {"lmstudio"}},
    "Jan AI": {"nomes": {"jan-ai", "jan"}, "cmd": {"jan-server", "/jan/"}},
    "GPT4All": {"nomes": {"gpt4all"}, "cmd": {"gpt4all"}},
    "LLaMA (llama.cpp)": {"nomes": {"llama-server", "llama-cli", "llamafile"}, "cmd": {"llama.cpp"}},
}

AI_LOG_DIRS = {
    "Antigravity": Path.home() / ".gemini" / "antigravity",
    "Claude": Path.home() / ".claude",
    "Ollama": Path.home() / ".ollama",
}

SCAN_INTERVAL = env_int("AI_MONITOR_INTERVAL", 5)

# Varrer ~/.claude e ~/.ollama inteiros custa muito I/O; esses diretórios
# guardam milhares de arquivos e dezenas de GB. A versão original fazia
# isso a cada 5 s. Aqui o resultado é cacheado.
LOGS_TTL_SEGUNDOS = env_int("AI_LOGS_TTL", 300)
LOGS_MAX_ARQUIVOS = env_int("AI_LOGS_MAX_ARQUIVOS", 20000)

_cache_logs = {"em": 0.0, "dados": None}

# PID deste próprio processo, para não se auto-reportar.
_MEU_PID = os.getpid()


# psutil renomeou Process.connections() para Process.net_connections() na
# versão 6.0. A chamada nova quebra com AttributeError em versões antigas
# (5.9.x), e o except do código original não a capturava — o monitor
# inteiro morria em toda execução. Este shim cobre as duas versões.
def _conexoes_do_processo(proc):
    metodo = getattr(proc, "net_connections", None) or getattr(proc, "connections", None)
    if metodo is None:
        return []
    return metodo(kind="inet")

def log_status(tag: str, mensagem: str):
    """Log humano em stderr; stdout fica reservado para JSON."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{tag}] {mensagem}", file=sys.stderr, flush=True)


def _identificar(nome: str, cmdline: str) -> str | None:
    """Identifica qual IA um processo representa, ou None."""
    for label, regras in AI_PROCESSOS.items():
        # Nome do executável: igualdade ou prefixo, nunca substring solta.
        for n in regras["nomes"]:
            if nome == n or nome.startswith(n + "-") or nome.startswith(n + "."):
                return label
        # Linha de comando: termos longos e específicos.
        for termo in regras["cmd"]:
            if termo in cmdline:
                return label
    return None


def detectar_processos_ia() -> list[dict]:
    """Detecta processos de IA em execução com detalhes de uso."""
    processos_ia = []
    campos = ["pid", "name", "cmdline", "memory_info", "create_time",
              "status", "username"]

    for proc in psutil.process_iter(campos):
        try:
            info = proc.info
            if info["pid"] == _MEU_PID:
                continue

            nome = (info.get("name") or "").lower()
            cmdline_lista = info.get("cmdline") or []
            cmdline = " ".join(cmdline_lista).lower()
            if not nome and not cmdline:
                continue

            label = _identificar(nome, cmdline)
            if not label:
                continue

            mem = info.get("memory_info")
            mem_mb = round(mem.rss / (1024 * 1024), 1) if mem else 0.0

            criado = datetime.fromtimestamp(info["create_time"])
            uptime = datetime.now() - criado
            horas, resto = divmod(int(uptime.total_seconds()), 3600)

            portas = set()
            try:
                for conn in _conexoes_do_processo(proc):
                    if conn.laddr:
                        portas.add(conn.laddr.port)
            except (psutil.AccessDenied, psutil.NoSuchProcess, AttributeError, OSError):
                pass

            processos_ia.append({
                "nome": label,
                "processo": info.get("name") or "?",
                "pid": info["pid"],
                # cpu_percent sem intervalo não bloqueia: mede desde a
                # chamada anterior. Com intervalo=0.1 por processo, uma
                # varredura com 10 processos travava 1 segundo.
                "cpu_percent": proc.cpu_percent(),
                "memoria_mb": mem_mb,
                "status": info.get("status", "?"),
                "usuario": info.get("username") or "?",
                "uptime": f"{horas}h {resto // 60}m",
                "uptime_seconds": int(uptime.total_seconds()),
                "portas": sorted(portas),
                "cmdline_resumido": " ".join(cmdline_lista[:3])[:200],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied,
                psutil.ZombieProcess, OSError):
            continue

    return sorted(processos_ia, key=lambda p: p["memoria_mb"], reverse=True)


def _medir_diretorio(caminho: Path) -> dict:
    """Percorre um diretório somando arquivos, com teto de segurança."""
    total_arquivos = 0
    tamanho_total = 0
    mais_recente = ""
    data_recente = 0.0
    truncado = False

    for root, _dirs, files in os.walk(caminho):
        for f in files:
            if total_arquivos >= LOGS_MAX_ARQUIVOS:
                truncado = True
                break
            try:
                st = os.stat(os.path.join(root, f))
            except OSError:
                continue
            total_arquivos += 1
            tamanho_total += st.st_size
            if st.st_mtime > data_recente:
                data_recente = st.st_mtime
                mais_recente = os.path.join(root, f)
        if truncado:
            break

    return {
        "existe": True,
        "total_arquivos": total_arquivos,
        "truncado": truncado,
        "tamanho_mb": round(tamanho_total / (1024 * 1024), 1),
        "ultimo_arquivo": mais_recente,
        "ultima_modificacao": (
            datetime.fromtimestamp(data_recente).isoformat() if data_recente else ""
        ),
    }


def verificar_logs_ia(forcar=False) -> list[dict]:
    """Inspeciona os diretórios de log de IA, com cache por TTL."""
    agora = time.time()
    if (not forcar and _cache_logs["dados"] is not None
            and agora - _cache_logs["em"] < LOGS_TTL_SEGUNDOS):
        return _cache_logs["dados"]

    logs_info = []
    for nome, caminho in AI_LOG_DIRS.items():
        if not caminho.exists():
            logs_info.append({"nome": nome, "caminho": str(caminho), "existe": False})
            continue
        try:
            logs_info.append({"nome": nome, "caminho": str(caminho),
                              **_medir_diretorio(caminho)})
        except OSError as e:
            logs_info.append({"nome": nome, "caminho": str(caminho),
                              "existe": True, "erro": str(e)})

    _cache_logs["dados"] = logs_info
    _cache_logs["em"] = agora
    return logs_info


def obter_relatorio_ia() -> dict:
    """Relatório completo de processos de IA."""
    processos = detectar_processos_ia()
    return {
        "timestamp": datetime.now().isoformat(),
        "total_processos_ia": len(processos),
        "processos": processos,
        "logs_ia": verificar_logs_ia(),
        "memoria_total_ia_mb": round(sum(p["memoria_mb"] for p in processos), 1),
    }


def iniciar_monitoramento():
    """Loop de monitoramento."""
    log_status("🤖 NEON AI MONITOR", "Monitor de processos de IA ATIVADO.")
    log_status("CONFIGURAÇÃO",
               f"Intervalo: {SCAN_INTERVAL}s | Cache de logs: {LOGS_TTL_SEGUNDOS}s")

    while True:
        rel = obter_relatorio_ia()
        log_status("SCAN", f"{rel['total_processos_ia']} processo(s) de IA | "
                           f"Memória total: {rel['memoria_total_ia_mb']} MB")
        for p in rel["processos"]:
            log_status("IA", f"{p['nome']} (PID:{p['pid']}) | CPU:{p['cpu_percent']}% | "
                             f"MEM:{p['memoria_mb']}MB | Up:{p['uptime']} | "
                             f"Portas:{p['portas'] or '—'}")
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    if "--uma-vez" in sys.argv:
        print(json.dumps(obter_relatorio_ia(), ensure_ascii=False, default=str))
    else:
        iniciar_monitoramento()
