import imaplib
import email
from email.header import decode_header
from neon_config import carregar_env
import os

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

def listar_ultimos_emails(limite=25):
    print(f"📡 Conectando ao Gmail ({EMAIL_USER})...")
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_USER, EMAIL_PASS)
    mail.select("INBOX")

    # Busca as últimas mensagens
    status, mensagens_ids = mail.search(None, "UNSEEN")
    if status != "OK" or not mensagens_ids[0]:
        print("Nenhuma mensagem não lida encontrada.")
        mail.logout()
        return

    ids = mensagens_ids[0].split()
    print(f"\n📧 LISTA DOS ÚLTIMOS {min(limite, len(ids))} E-MAILS NÃO LIDOS DA SUA CAIXA:\n" + "="*70)

    # Pega os mais recentes
    for i, msg_id in enumerate(ids[:limite], 1):
        res, msg_data = mail.fetch(msg_id, "(RFC822.HEADER)")
        if res == "OK":
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    de = decodificar_cabecalho(msg.get("From", "Desconhecido"))
                    assunto = decodificar_cabecalho(msg.get("Subject", "Sem assunto"))
                    data = msg.get("Date", "")
                    print(f"[{i:02d}] DE: {de}")
                    print(f"     ASSUNTO: {assunto}")
                    print(f"     DATA: {data}")
                    print("-" * 70)

    mail.logout()

if __name__ == "__main__":
    listar_ultimos_emails(25)

