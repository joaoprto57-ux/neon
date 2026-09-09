#!/usr/bin/env python3
"""
NEON INTERCEPTOR — Inteligência de Ameaças em E-mail

Varre mensagens não lidas via IMAP, pontua indícios de phishing/malware e
age conforme a política configurada.

Diferenças relevantes em relação à primeira versão:
  * Não marca as mensagens como lidas (BODY.PEEK).
  * Pontua indícios em vez de disparar no primeiro gatilho isolado.
  * A ação padrão é APENAS RELATAR. Quarentena e exclusão são opt-in.
  * Quarentena copia para uma pasta antes de remover da caixa de entrada.
"""

import os
import sys
import time

from neon_config import carregar_env, env_int
from neon_email_utils import (
    CredenciaisAusentes, analisar_url, buscar_ids, buscar_mensagem,
    conectar_imap, contem_frase, decodificar_cabecalho, encerrar_imap,
    extrair_corpo, extrair_urls, listar_anexos, log, normalizar,
    IMAP_SERVER, IMAP_PORT,
)

carregar_env()

PATROL_INTERVAL_SECONDS = env_int("PATROL_INTERVAL", 1800)

# Política de ação: relatorio (padrão) | quarentena | excluir
ACAO = os.environ.get("INTERCEPTOR_ACAO", "relatorio").strip().lower()
PASTA_QUARENTENA = os.environ.get("INTERCEPTOR_PASTA_QUARENTENA", "Neon/Quarentena")

# Pontuação mínima para classificar como ameaça.
LIMIAR_AMEACA = env_int("INTERCEPTOR_LIMIAR", 4)

# ─── Sinais e pesos ───────────────────────────────────────────────────
# Executáveis: praticamente nunca são anexo legítimo em e-mail.
EXTENSOES_CRITICAS = {
    ".exe", ".scr", ".bat", ".cmd", ".com", ".pif", ".vbs", ".vbe",
    ".js", ".jse", ".ps1", ".jar", ".msi", ".hta", ".lnk", ".reg",
}
# Contêineres e documentos com macro: comuns em uso legítimo, então
# pesam pouco sozinhos. Um .zip não pode custar a exclusão da mensagem.
EXTENSOES_ATENCAO = {
    ".zip", ".rar", ".7z", ".iso", ".img", ".htm", ".html",
    ".docm", ".xlsm", ".pptm",
}

PESO_EXTENSAO_CRITICA = 6
PESO_EXTENSAO_ATENCAO = 1
PESO_URL_SUSPEITA = 3
PESO_FRASE = 2

# Frases de engenharia social. Frases inteiras, não palavras soltas —
# "premio" ou "virus" sozinhos marcavam newsletter comum como ameaça.
FRASES_SUSPEITAS = [
    "recuperar sua conta", "verifique sua conta", "confirme sua conta",
    "senha expirada", "sua senha expirou", "atualizacao cadastral",
    "sua conta sera suspensa", "sua conta foi bloqueada",
    "clique aqui para evitar", "cancelamento imediato",
    "resgatar seu premio", "voce ganhou um premio", "ultimo aviso",
    "acao imediata necessaria", "carteira de bitcoin",
    "verify your account", "your account will be suspended",
    "confirm your password", "unusual sign in activity",
]


def inspecionar_mensagem(msg) -> dict:
    """Pontua os indícios de ameaça de uma mensagem."""
    assunto = decodificar_cabecalho(msg.get("Subject")) or "(Sem Assunto)"
    remetente = decodificar_cabecalho(msg.get("From")) or "(Desconhecido)"

    indicios = []
    pontuacao = 0

    # 1. Anexos
    anexos_criticos, anexos_atencao = [], []
    for nome in listar_anexos(msg):
        ext = os.path.splitext(nome)[1].lower()
        if ext in EXTENSOES_CRITICAS:
            anexos_criticos.append(nome)
            pontuacao += PESO_EXTENSAO_CRITICA
            indicios.append(f"Anexo executável: {nome}")
        elif ext in EXTENSOES_ATENCAO:
            anexos_atencao.append(nome)
            pontuacao += PESO_EXTENSAO_ATENCAO
            indicios.append(f"Anexo que merece atenção: {nome}")

    # 2. Links
    corpo = extrair_corpo(msg)
    urls = extrair_urls(corpo)
    links_suspeitos = []
    for url in urls:
        motivos = analisar_url(url)
        if motivos:
            links_suspeitos.append({"url": url[:200], "motivos": motivos})
            pontuacao += PESO_URL_SUSPEITA
            indicios.append(f"Link suspeito ({'; '.join(motivos)}): {url[:120]}")

    # 3. Engenharia social — busca no assunto e no texto visível
    texto = normalizar(assunto + " " + extrair_corpo(msg, apenas_texto=True))
    frases_encontradas = []
    for frase in FRASES_SUSPEITAS:
        if contem_frase(texto, normalizar(frase)):
            frases_encontradas.append(frase)
            pontuacao += PESO_FRASE
            indicios.append(f"Gatilho de engenharia social: '{frase}'")

    return {
        "assunto": assunto,
        "remetente": remetente,
        "pontuacao": pontuacao,
        "limiar": LIMIAR_AMEACA,
        "e_ameaca": pontuacao >= LIMIAR_AMEACA,
        "indicios": indicios,
        "anexos_criticos": anexos_criticos,
        "anexos_atencao": anexos_atencao,
        "links_suspeitos": links_suspeitos,
        "frases_suspeitas": frases_encontradas,
        "total_links": len(urls),
    }


def garantir_pasta(mail, pasta: str) -> bool:
    """Cria a pasta de quarentena se ainda não existir."""
    try:
        status, _ = mail.select(f'"{pasta}"', readonly=True)
        if status == "OK":
            return True
    except Exception:
        pass
    try:
        mail.create(f'"{pasta}"')
        return True
    except Exception as e:
        log("ERRO", f"Não foi possível criar a pasta '{pasta}': {e}")
        return False


def aplicar_acao(mail, msg_id: bytes, relatorio: dict) -> str:
    """
    Executa a política configurada sobre uma mensagem classificada
    como ameaça. Devolve a ação efetivamente aplicada.
    """
    ident = msg_id.decode(errors="replace")

    if ACAO == "relatorio":
        log("AÇÃO", f"[relatório] Mensagem {ident} apenas registrada; nada foi alterado.")
        return "relatada"

    if ACAO == "quarentena":
        try:
            status, _ = mail.copy(msg_id, f'"{PASTA_QUARENTENA}"')
            if status != "OK":
                log("ERRO", f"Falha ao copiar {ident} para quarentena; mensagem preservada.")
                return "falha"
            mail.store(msg_id, "+FLAGS", "\\Deleted")
            log("AÇÃO", f"[quarentena] Mensagem {ident} movida para '{PASTA_QUARENTENA}'.")
            return "quarentenada"
        except Exception as e:
            log("ERRO", f"Erro ao quarentenar {ident}: {e}. Mensagem preservada.")
            return "falha"

    if ACAO == "excluir":
        try:
            mail.store(msg_id, "+FLAGS", "\\Deleted")
            log("AÇÃO", f"[exclusão] Mensagem {ident} marcada para remoção.")
            return "excluida"
        except Exception as e:
            log("ERRO", f"Erro ao excluir {ident}: {e}")
            return "falha"

    log("ALERTA", f"Política '{ACAO}' desconhecida; nada foi feito. Use relatorio|quarentena|excluir.")
    return "ignorada"


def executar_varredura_patrulha() -> dict:
    """Executa uma varredura completa da caixa de entrada."""
    resumo = {"analisadas": 0, "ameacas": 0, "acoes": {}, "detalhes": []}
    mail = None

    try:
        log("INFILTRAÇÃO", f"Conectando a {IMAP_SERVER}:{IMAP_PORT}...")
        mail = conectar_imap()
        log("AUTENTICAÇÃO", "Sessão IMAP estabelecida.")

        if ACAO == "quarentena":
            garantir_pasta(mail, PASTA_QUARENTENA)

        status, _ = mail.select("INBOX")
        if status != "OK":
            log("ERRO", "Falha ao selecionar INBOX.")
            return resumo

        ids = buscar_ids(mail, "UNSEEN")
        log("INSPEÇÃO", f"{len(ids)} mensagem(ns) não lida(s) para análise. Política: {ACAO}.")

        for msg_id in ids:
            msg = buscar_mensagem(mail, msg_id)
            if msg is None:
                continue

            relatorio = inspecionar_mensagem(msg)
            resumo["analisadas"] += 1

            log("ANÁLISE",
                f"[{relatorio['pontuacao']}/{LIMIAR_AMEACA}] "
                f"{relatorio['remetente'][:45]} | {relatorio['assunto'][:55]} "
                f"| links: {relatorio['total_links']}")

            if relatorio["e_ameaca"]:
                resumo["ameacas"] += 1
                log("🚨 AMEAÇA", " | ".join(relatorio["indicios"][:4]))
                acao = aplicar_acao(mail, msg_id, relatorio)
                resumo["acoes"][acao] = resumo["acoes"].get(acao, 0) + 1
                relatorio["acao_aplicada"] = acao
                resumo["detalhes"].append(relatorio)
            elif relatorio["indicios"]:
                log("OBSERVAÇÃO",
                    f"Indícios abaixo do limiar, mensagem preservada: {relatorio['indicios'][0]}")

        # Expurgo só faz sentido quando algo foi de fato marcado.
        if ACAO in ("quarentena", "excluir") and resumo["ameacas"] > 0:
            mail.expunge()

        log("CONCLUÍDO",
            f"Varredura finalizada. {resumo['analisadas']} analisada(s), "
            f"{resumo['ameacas']} ameaça(s). Ações: {resumo['acoes'] or 'nenhuma'}.")

    except CredenciaisAusentes as e:
        log("ALERTA", f"{e}. Varredura ignorada.")
    except Exception as e:
        log("FALHA PATRULHA", f"Erro durante a patrulha IMAP: {e}")
    finally:
        encerrar_imap(mail)
        log("SESSÃO", "Conexão IMAP encerrada.")

    return resumo


def iniciar_ciclo_patrulha():
    """Loop contínuo de patrulha."""
    log("NÚCLEO INTERCEPTADOR", "Módulo de Inteligência de Ameaças ativado.")
    log("CONFIGURAÇÃO",
        f"Intervalo: {PATROL_INTERVAL_SECONDS // 60} min | "
        f"Política: {ACAO} | Limiar: {LIMIAR_AMEACA}")

    if ACAO == "excluir":
        log("⚠️ ATENÇÃO",
            "Política 'excluir' remove mensagens PERMANENTEMENTE. "
            "Prefira 'quarentena' até confiar na calibragem.")

    while True:
        executar_varredura_patrulha()
        log("AGUARDANDO", f"Próxima patrulha em {PATROL_INTERVAL_SECONDS // 60} min.")
        time.sleep(PATROL_INTERVAL_SECONDS)


if __name__ == "__main__":
    if "--uma-vez" in sys.argv:
        executar_varredura_patrulha()
    else:
        iniciar_ciclo_patrulha()
