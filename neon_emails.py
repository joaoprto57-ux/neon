#!/usr/bin/env python3
"""
NEON EMAILS — Ferramenta unificada de leitura da caixa de entrada.

Substitui listar_emails.py, gerar_relatorio_emails.py e
ler_conteudo_email.py, que eram o mesmo arquivo copiado três vezes.

Uso:
    python3 neon_emails.py listar [-n 25]
    python3 neon_emails.py relatorio [-n 100] [-o emails_extraidos.json]
    python3 neon_emails.py conteudo [-n 15] [-o emails_conteudo_completo.json]

Nenhum modo marca as mensagens como lidas.
"""

import argparse
import json
import sys

from neon_email_utils import (
    CredenciaisAusentes, EMAIL_USER, buscar_ids, buscar_mensagem,
    conectar_imap, decodificar_cabecalho, encerrar_imap, extrair_corpo,
    listar_anexos, log,
)


def coletar(quantidade: int, com_conteudo: bool, criterio="UNSEEN") -> list[dict]:
    """Baixa metadados (e opcionalmente o corpo) das mensagens."""
    mail = None
    try:
        log("CONEXÃO", f"Conectando ao servidor como {EMAIL_USER}...")
        mail = conectar_imap()
        mail.select("INBOX", readonly=not com_conteudo)

        ids = buscar_ids(mail, criterio)
        if not ids:
            log("INFO", "Nenhuma mensagem encontrada para o critério.")
            return []

        # Os IDs vêm em ordem crescente; os mais recentes ficam no fim.
        selecionados = list(reversed(ids[-quantidade:]))
        log("COLETA", f"{len(ids)} mensagem(ns); processando as {len(selecionados)} mais recentes.")

        resultado = []
        for msg_id in selecionados:
            msg = buscar_mensagem(mail, msg_id, somente_cabecalho=not com_conteudo)
            if msg is None:
                continue
            registro = {
                "id": msg_id.decode(errors="replace"),
                "de": decodificar_cabecalho(msg.get("From")) or "Desconhecido",
                "assunto": decodificar_cabecalho(msg.get("Subject")) or "Sem assunto",
                "data": msg.get("Date", ""),
            }
            if com_conteudo:
                corpo = extrair_corpo(msg, apenas_texto=True)
                registro["conteudo"] = corpo or "(Conteúdo apenas em HTML/imagens)"
                registro["anexos"] = listar_anexos(msg)
            resultado.append(registro)
        return resultado

    except CredenciaisAusentes as e:
        log("ERRO", str(e))
        return []
    finally:
        encerrar_imap(mail)


def salvar(dados: list[dict], caminho: str):
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)
    log("OK", f"{len(dados)} registro(s) salvos em '{caminho}'.")
    log("LEMBRETE", "Este arquivo contém dados pessoais e está no .gitignore.")


def main():
    p = argparse.ArgumentParser(description="Ferramenta de leitura de e-mail do Neon.")
    p.add_argument("modo", choices=["listar", "relatorio", "conteudo"])
    p.add_argument("-n", "--quantidade", type=int, default=None)
    p.add_argument("-o", "--saida", default=None)
    p.add_argument("--criterio", default="UNSEEN",
                   help="Critério IMAP (UNSEEN, ALL, FROM x...). Padrão: UNSEEN.")
    args = p.parse_args()

    if args.modo == "listar":
        emails = coletar(args.quantidade or 25, com_conteudo=False, criterio=args.criterio)
        print(f"\n📧 {len(emails)} MENSAGEM(NS)\n" + "=" * 72)
        for i, e in enumerate(emails, 1):
            print(f"[{i:02d}] DE: {e['de']}")
            print(f"     ASSUNTO: {e['assunto']}")
            print(f"     DATA: {e['data']}")
            print("-" * 72)

    elif args.modo == "relatorio":
        emails = coletar(args.quantidade or 100, com_conteudo=False, criterio=args.criterio)
        salvar(emails, args.saida or "emails_extraidos.json")

    else:
        emails = coletar(args.quantidade or 15, com_conteudo=True, criterio=args.criterio)
        salvar(emails, args.saida or "emails_conteudo_completo.json")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
