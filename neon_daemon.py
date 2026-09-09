#!/usr/bin/env python3
"""
NEON DAEMON — Worker persistente de telemetria.

Mantém um único processo Python vivo, respondendo a comandos em
JSON-lines pelo stdin. Substitui o `python3 -c` por request, que
custava ~400 ms de startup a cada chamada e inviabilizava um painel
ao vivo.

Protocolo (uma linha JSON por mensagem):
    entrada : {"id": 1, "cmd": "scan"}
    saída   : {"id": 1, "ok": true, "data": {...}, "ms": 42}

Comandos: ping | scan | ai | status | suspend | resume | email | all
"""

import json
import sys
import time
import traceback

from neon_config import carregar_env
from neon_email_utils import log

carregar_env()

import neon_ai_monitor
import neon_watchdog


def _cmd_all() -> dict:
    """Snapshot completo — o que o painel consome a cada tick."""
    varredura = neon_watchdog.executar_varredura()
    return {
        "rede": varredura,
        "ia": neon_ai_monitor.obter_relatorio_ia(),
    }


COMANDOS = {
    "ping": lambda: {"pong": True, "ts": time.time()},
    "scan": neon_watchdog.executar_varredura,
    "ai": neon_ai_monitor.obter_relatorio_ia,
    "status": neon_watchdog.obter_status_rede,
    "suspend": lambda: {"sucesso": neon_watchdog.suspender_rede()},
    "resume": lambda: {"sucesso": neon_watchdog.reativar_rede()},
    "all": _cmd_all,
}


def responder(payload: dict):
    """Escreve uma resposta no stdout. Uma linha, sempre."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def main():
    log("DAEMON", f"Worker de telemetria pronto. Comandos: {', '.join(COMANDOS)}")
    responder({"id": 0, "ok": True, "evento": "pronto",
               "comandos": list(COMANDOS)})

    for linha in sys.stdin:
        linha = linha.strip()
        if not linha:
            continue

        try:
            req = json.loads(linha)
        except json.JSONDecodeError as e:
            responder({"id": None, "ok": False, "error": f"JSON inválido: {e}"})
            continue

        req_id = req.get("id")
        cmd = req.get("cmd")
        fn = COMANDOS.get(cmd)

        if fn is None:
            responder({"id": req_id, "ok": False,
                       "error": f"Comando desconhecido: {cmd}",
                       "disponiveis": list(COMANDOS)})
            continue

        inicio = time.perf_counter()
        try:
            dados = fn()
            responder({"id": req_id, "ok": True, "data": dados,
                       "ms": round((time.perf_counter() - inicio) * 1000, 1)})
        except Exception as e:
            log("ERRO", f"Comando '{cmd}' falhou: {e}")
            responder({"id": req_id, "ok": False, "error": str(e),
                       "trace": traceback.format_exc(limit=3)})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
