import imaplib
import email
from email.header import decode_header
from neon_config import carregar_env
import os
import json
import html

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

def extrair_conteudo_corpo(msg):
    corpo_texto = ""
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            if content_type == "text/plain":
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        corpo_texto += payload.decode(errors="replace") + "\n\n"
                except Exception:
                    pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                corpo_texto = payload.decode(errors="replace")
        except Exception:
            pass
    return corpo_texto.strip()

def baixar_emails_com_conteudo(quantidade=15):
    print(f"📡 Conectando ao Gmail ({EMAIL_USER}) para baixar o conteúdo dos e-mails...")
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_USER, EMAIL_PASS)
    mail.select("INBOX")

    status, mensagens_ids = mail.search(None, "UNSEEN")
    if status != "OK" or not mensagens_ids[0]:
        print("Nenhuma mensagem não lida encontrada.")
        mail.logout()
        return []

    ids = mensagens_ids[0].split()
    ids_selecionados = list(reversed(ids[-quantidade:]))

    emails_completos = []
    print(f"Baixando conteúdo dos últimos {len(ids_selecionados)} e-mails...")

    for i, msg_id in enumerate(ids_selecionados, 1):
        res, msg_data = mail.fetch(msg_id, "(RFC822)")
        if res == "OK":
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    de = decodificar_cabecalho(msg.get("From", "Desconhecido"))
                    assunto = decodificar_cabecalho(msg.get("Subject", "Sem assunto"))
                    data = msg.get("Date", "")
                    corpo = extrair_conteudo_corpo(msg)
                    
                    emails_completos.append({
                        "id": msg_id.decode(),
                        "de": de,
                        "assunto": assunto,
                        "data": data,
                        "conteudo": corpo or "(Conteúdo em formato HTML/Imagens)"
                    })

    mail.logout()
    return emails_completos

if __name__ == "__main__":
    lista = baixar_emails_com_conteudo(15)
    with open("emails_conteudo_completo.json", "w", encoding="utf-8") as f:
        json.dump(lista, f, ensure_ascii=False, indent=2)
    print("✅ Conteúdo extraído com sucesso para 'emails_conteudo_completo.json'.")

