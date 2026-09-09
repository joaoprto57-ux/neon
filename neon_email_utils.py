"""
Utilitários compartilhados de e-mail do Neon.

Concentra o que estava duplicado em quatro scripts (decodificação de
cabeçalho, extração de corpo, conexão IMAP) e a análise de URL/conteúdo
usada pelo interceptador.
"""

import email
import imaplib
import ipaddress
import os
import re
import sys
import unicodedata
from datetime import datetime
from email.header import decode_header
from email.message import Message
from urllib.parse import urlsplit

from neon_config import carregar_env, env_int

carregar_env()

IMAP_SERVER = os.environ.get("IMAP_SERVER", "imap.gmail.com")
IMAP_PORT = env_int("IMAP_PORT", 993)
EMAIL_USER = os.environ.get("EMAIL_USER", "").strip()
# Senhas de app do Gmail são exibidas em grupos de 4; o usuário costuma
# colar com espaços.
EMAIL_PASS = os.environ.get("EMAIL_PASS", "").replace(" ", "").strip()


# ─── Logging ──────────────────────────────────────────────────────────
# Logs vão para stderr. stdout fica reservado para saída de dados (JSON),
# que é o que a API em TypeScript consome.

def log(tag: str, mensagem: str, stream=sys.stderr):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{tag}] {mensagem}", file=stream, flush=True)


# ─── Decodificação ────────────────────────────────────────────────────

def decodificar_cabecalho(texto_cabecalho) -> str:
    """Decodifica cabeçalhos MIME (UTF-8, ISO-8859-1, etc)."""
    if not texto_cabecalho:
        return ""
    resultado = ""
    for conteudo, codificacao in decode_header(texto_cabecalho):
        if isinstance(conteudo, bytes):
            try:
                resultado += conteudo.decode(codificacao or "utf-8", errors="replace")
            except (LookupError, UnicodeDecodeError):
                resultado += conteudo.decode("latin1", errors="replace")
        else:
            resultado += str(conteudo)
    return resultado


def _decodificar_payload(part) -> str:
    """Decodifica o payload de uma parte respeitando o charset declarado."""
    payload = part.get_payload(decode=True)
    if not payload:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return payload.decode("utf-8", errors="replace")


def extrair_corpo(msg: Message, apenas_texto=False) -> str:
    """
    Extrai o corpo textual da mensagem.

    apenas_texto=True devolve só as partes text/plain (leitura humana);
    False inclui text/html (necessário para varrer links).
    """
    tipos = {"text/plain"} if apenas_texto else {"text/plain", "text/html"}
    partes = []

    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            # Anexos têm filename; não são corpo.
            if part.get_filename():
                continue
            if part.get_content_type() in tipos:
                partes.append(_decodificar_payload(part))
    else:
        if msg.get_content_type() in tipos or not apenas_texto:
            partes.append(_decodificar_payload(msg))

    return "\n\n".join(p for p in partes if p).strip()


def listar_anexos(msg: Message) -> list[str]:
    """Retorna os nomes de arquivo de todos os anexos da mensagem."""
    nomes = []
    if not msg.is_multipart():
        return nomes
    for part in msg.walk():
        filename = part.get_filename()
        if filename:
            nomes.append(decodificar_cabecalho(filename))
    return nomes


# ─── Análise de URL ───────────────────────────────────────────────────
# A versão original usava regex de substring solta. O padrão 't\.co'
# casava dentro de 'microsoft.com', e o e-mail era APAGADO por isso.
# Aqui a URL é parseada e a checagem é feita contra o hostname, por
# igualdade ou sufixo de domínio — nunca por substring solta.

PADRAO_URL = re.compile(r'https?://[^\s<>"\'\)\]]+', re.IGNORECASE)

ENCURTADORES = {
    "bit.ly", "tinyurl.com", "t.co", "cutt.ly", "is.gd", "rb.gy",
    "ow.ly", "goo.gl", "shorturl.at", "rebrand.ly", "buff.ly", "t.ly",
}

TLDS_SUSPEITOS = {
    ".xyz", ".top", ".tk", ".ml", ".ga", ".cf", ".gq", ".work",
    ".click", ".buzz", ".space", ".site", ".online", ".loan", ".zip",
}


def extrair_hostname(url: str) -> str:
    """Devolve o hostname de uma URL, em minúsculas, sem porta."""
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host.lower().rstrip(".")


def _e_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


def analisar_url(url: str) -> list[str]:
    """
    Devolve a lista de motivos pelos quais a URL é suspeita.
    Lista vazia = URL sem indício.
    """
    host = extrair_hostname(url)
    if not host:
        return []

    motivos = []

    # Encurtador: compara o hostname inteiro ou sufixo de domínio.
    # 'microsoft.com' NÃO termina em '.t.co' nem é igual a 't.co'.
    for curto in ENCURTADORES:
        if host == curto or host.endswith("." + curto):
            motivos.append(f"Encurtador de link ({curto})")
            break

    # TLD de baixa reputação, verificado como sufixo real do hostname.
    for tld in TLDS_SUSPEITOS:
        if host.endswith(tld):
            motivos.append(f"TLD de baixa reputação ({tld})")
            break

    # IP no lugar de domínio.
    if _e_ip_literal(host):
        motivos.append(f"IP literal no lugar de domínio ({host})")

    # Ofuscação por credencial embutida: http://banco.com@malicioso.com
    if "@" in urlsplit(url).netloc:
        motivos.append("URL com credencial embutida (ofuscação de domínio)")

    # Punycode: domínio homográfico.
    if host.startswith("xn--") or ".xn--" in host:
        motivos.append(f"Domínio punycode/homográfico ({host})")

    return motivos


def extrair_urls(texto: str) -> list[str]:
    """Extrai todas as URLs http(s) de um texto."""
    return PADRAO_URL.findall(texto or "")


# ─── Análise de texto ─────────────────────────────────────────────────

def normalizar(texto: str) -> str:
    """Minúsculas sem acento, para casar 'prêmio' com 'premio'."""
    texto = unicodedata.normalize("NFD", (texto or "").lower())
    return "".join(c for c in texto if unicodedata.category(c) != "Mn")


def contem_frase(texto_normalizado: str, frase: str) -> bool:
    """
    Casa a frase respeitando limites de palavra.
    Evita que 'hack' case dentro de 'hackathon'.
    """
    padrao = r"\b" + r"\s+".join(re.escape(p) for p in frase.split()) + r"\b"
    return re.search(padrao, texto_normalizado) is not None


# ─── Conexão IMAP ─────────────────────────────────────────────────────

class CredenciaisAusentes(RuntimeError):
    pass


def conectar_imap() -> imaplib.IMAP4_SSL:
    """Abre uma conexão IMAP sobre SSL e autentica."""
    if not EMAIL_USER or not EMAIL_PASS:
        raise CredenciaisAusentes(
            "EMAIL_USER / EMAIL_PASS não configurados no .env"
        )
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_USER, EMAIL_PASS)
    return mail


def buscar_ids(mail: imaplib.IMAP4_SSL, criterio="UNSEEN") -> list[bytes]:
    """Devolve os IDs das mensagens que satisfazem o critério."""
    status, dados = mail.search(None, criterio)
    if status != "OK" or not dados or not dados[0]:
        return []
    return dados[0].split()


def buscar_mensagem(mail: imaplib.IMAP4_SSL, msg_id: bytes,
                    somente_cabecalho=False) -> Message | None:
    """
    Baixa uma mensagem SEM marcá-la como lida.

    Usa BODY.PEEK[] — o RFC822 da versão original setava a flag \\Seen,
    zerando o "não lido" da caixa inteira a cada varredura.
    """
    item = "(BODY.PEEK[HEADER])" if somente_cabecalho else "(BODY.PEEK[])"
    status, dados = mail.fetch(msg_id, item)
    if status != "OK":
        return None
    for parte in dados:
        if isinstance(parte, tuple):
            return email.message_from_bytes(parte[1])
    return None


def encerrar_imap(mail):
    """Fecha a sessão IMAP sem propagar erro de estado."""
    if not mail:
        return
    try:
        mail.close()
    except Exception:
        pass
    try:
        mail.logout()
    except Exception:
        pass
