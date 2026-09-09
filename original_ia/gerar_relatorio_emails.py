import imaplib
import email
from email.header import decode_header
from neon_config import carregar_env
import os
import json

carregar_env()

IMAP_SERVER = os.environ.get("IMAP_SERVER", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", 993))
EMAIL_USER = os.environ.get("EMAIL_USER", "").strip()
EMAIL_PASS = os.environ.get("EMAIL_PASS", "").replace(" ", "").strip()

def decodificar_cabecalho(texto_cabecalho: str) -> str:
    if not texto_cabecalho:
        return ""
    partes = decode_header(texto_cabecalho)
    resultado = ""
    for conteudo, codificacao in partes:
        if isinstance(conteudo, bytes):
            try:
                resultado += conteudo.decode(codificacao or "utf-8", errors="replace")
            except Exception:
                resultado += conteudo.decode("latin1", errors="replace")
        else:
            resultado += str(conteudo)
    return resultado

def extrair_todos_os_emails(max_emails=100):
    print(f"📡 Conectando ao Gmail ({EMAIL_USER}) para relatorio de todos os e-mails...")
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_USER, EMAIL_PASS)
    mail.select("INBOX")

    status, mensagens_ids = mail.search(None, "UNSEEN")
    if status != "OK" or not mensagens_ids[0]:
        print("Nenhuma mensagem não lida encontrada.")
        mail.logout()
        return

    ids = mensagens_ids[0].split()
    total = len(ids)
    print(f"Encontrados {total} e-mails não lidos. Processando os últimos {min(max_emails, total)}...")

    lista_emails = []
    # Pega os mais recentes invertidos (mais novos primeiro)
    for i, msg_id in enumerate(reversed(ids[-max_emails:]), 1):
        res, msg_data = mail.fetch(msg_id, "(RFC822.HEADER)")
        if res == "OK":
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    de = decodificar_cabecalho(msg.get("From", "Desconhecido"))
                    assunto = decodificar_cabecalho(msg.get("Subject", "Sem assunto"))
                    data = msg.get("Date", "")
                    lista_emails.append({
                        "id": msg_id.decode(),
                        "de": de,
                        "assunto": assunto,
                        "data": data
                    })

    mail.logout()

    # Salva o arquivo JSON e HTML
    with open("emails_extraidos.json", "w", encoding="utf-8") as f:
        json.dump(lista_emails, f, ensure_ascii=False, indent=2)

    print(f"✅ Relatório com {len(lista_emails)} e-mails exportado com sucesso para 'emails_extraidos.json'.")

if __name__ == "__main__":
    extrair_todos_os_emails(100)

