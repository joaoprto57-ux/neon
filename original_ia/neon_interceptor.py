import os
import time
import imaplib
import email
from email.message import Message
from email.header import decode_header
import re
from datetime import datetime
from neon_config import carregar_env

# Garante o carregamento automático das variáveis do .env
carregar_env()

# ==============================================================================
# CONFIGURAÇÕES DE AMBIENTE & PARÂMETROS TÁTICOS
# ==============================================================================

IMAP_SERVER = os.environ.get("IMAP_SERVER", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", 993))
EMAIL_USER = os.environ.get("EMAIL_USER", "").strip()
EMAIL_PASS = os.environ.get("EMAIL_PASS", "").replace(" ", "").strip()


# Intervalo do ciclo de patrulha (padrão: 30 minutos = 1800 segundos)
PATROL_INTERVAL_SECONDS = int(os.environ.get("PATROL_INTERVAL", 1800))

# Padrões suspeitos em links e extensões de arquivos maliciosos
DANGEROUS_EXTENSIONS = {".exe", ".scr", ".bat", ".vbs", ".js", ".ps1", ".jar", ".iso", ".img", ".htm", ".html", ".zip", ".rar"}
SUSPECT_URL_PATTERN = re.compile(r'https?://[^\s<>"]+|www\.[^\s<>"]+', re.IGNORECASE)

# Encurtadores e domínios/TLDs frequentes em phishing e malwares
SUSPICIOUS_DOMAINS_PATTERNS = [
    r'bit\.ly', r'tinyurl\.com', r't\.co', r'cutt\.ly', r'is\.gd', r'rb\.gy', r'ow\.ly',
    r'\.xyz\b', r'\.top\b', r'\.tk\b', r'\.ml\b', r'\.ga\b', r'\.cf\b', r'\.gq\b',
    r'\.work\b', r'\.click\b', r'\.buzz\b', r'\.space\b', r'\.site\b', r'\.online\b',
    r'https?://\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}'  # IP direto no lugar de domínio
]

SUSPICIOUS_KEYWORDS = [
    "hack", "hacker", "trojan", "malware", "virus", "bitcoin", "wallet", "carteira",
    "recuperar conta", "verifique sua conta", "senha expirada", "suporte de seguranca",
    "atualizacao cadastral", "sua conta sera suspensa", "clique aqui para evitar",
    "cancelamento imediato", "premio", "resgatar", "ganhou"
]

SUSPICIOUS_DOMAINS_REGEX = re.compile("|".join(SUSPICIOUS_DOMAINS_PATTERNS), re.IGNORECASE)


def log_status(tag: str, mensagem: str):
    """Exibe logs operacionais formatados do interceptador."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{tag}] {mensagem}")


def decodificar_cabecalho(texto_cabecalho: str) -> str:
    """Decodifica cabeçalhos de e-mail codificados em UTF-8, ISO, etc."""
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


def inspecionar_mensagem(msg: Message) -> dict:
    """
    Inspeciona cabeçalhos, anexos e links em busca de assinaturas de ameaça.
    """
    assunto = decodificar_cabecalho(msg.get("Subject", "(Sem Assunto)"))
    remetente = decodificar_cabecalho(msg.get("From", "(Remetente Desconhecido)"))
    
    ameacas_detectadas = []
    anexos_suspeitos = []
    links_encontrados = []
    corpo_texto = ""

    # Extrai partes do e-mail (anexos e corpo)
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            filename = part.get_filename()

            if filename:
                nome_anexo = decodificar_cabecalho(filename)
                ext = os.path.splitext(nome_anexo)[1].lower()
                if ext in DANGEROUS_EXTENSIONS:
                    anexos_suspeitos.append(nome_anexo)
                    ameacas_detectadas.append(f"Anexo executável/suspeito: {nome_anexo}")

            elif content_type in ["text/plain", "text/html"]:
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        texto = payload.decode(errors="replace")
                        corpo_texto += " " + texto
                        urls = SUSPECT_URL_PATTERN.findall(texto)
                        links_encontrados.extend(urls)
                except Exception:
                    pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                corpo_texto = payload.decode(errors="replace")
                links_encontrados = SUSPECT_URL_PATTERN.findall(corpo_texto)
        except Exception:
            pass

    # Análise avançada de links
    links_suspeitos = []
    for link in links_encontrados:
        if SUSPICIOUS_DOMAINS_REGEX.search(link):
            links_suspeitos.append(link)
            ameacas_detectadas.append(f"Link suspeito/phishing: {link}")

    # Análise de palavras-chave suspeitas no assunto e corpo
    texto_completo = (assunto + " " + corpo_texto).lower()
    for kw in SUSPICIOUS_KEYWORDS:
        if kw in texto_completo:
            ameacas_detectadas.append(f"Gatilho de engenharia social detectado: '{kw}'")

    e_ameaca = len(ameacas_detectadas) > 0

    return {
        "assunto": assunto,
        "remetente": remetente,
        "e_ameaca": e_ameaca,
        "ameacas": ameacas_detectadas,
        "anexos_suspeitos": anexos_suspeitos,
        "links_suspeitos": links_suspeitos,
        "total_links": len(links_encontrados),
        "amostra_links": links_encontrados[:3]
    }



def executar_varredura_patrulha():
    """
    Realiza o login IMAP na porta 993, varre a caixa de entrada por novas mensagens,
    inspeciona conteúdo e elimina/quarentena ameaças detectadas.
    """
    if not EMAIL_USER or not EMAIL_PASS:
        log_status("ALERTA", "Credenciais EMAIL_USER / EMAIL_PASS não configuradas. Varredura ignorada.")
        return

    log_status("INFILTRAÇÃO", f"Conectando ao servidor IMAP {IMAP_SERVER}:{IMAP_PORT}...")
    mail = None

    try:
        # Conexão SSL criptografada na porta 993
        mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
        mail.login(EMAIL_USER, EMAIL_PASS)
        log_status("AUTENTICAÇÃO", "Login invisível realizado com sucesso.")

        # Seleciona a caixa de entrada
        status, _ = mail.select("INBOX")
        if status != "OK":
            log_status("ERRO", "Falha ao selecionar caixa de entrada (INBOX).")
            return

        # Busca por e-mails não lidos (UNSEEN) ou todos os e-mails recentes
        status, mensagens_ids = mail.search(None, "UNSEEN")
        if status != "OK":
            log_status("PATROL", "Nenhuma mensagem pendente encontrada.")
            return

        lista_ids = mensagens_ids[0].split()
        total_mensagens = len(lista_ids)
        log_status("INSPEÇÃO", f"{total_mensagens} mensagem(ns) não lida(s) identificada(s) para análise.")

        for msg_id in lista_ids:
            # Obtém apenas cabeçalhos e estrutura para análise sem baixar mídia desnecessária
            res, msg_data = mail.fetch(msg_id, "(RFC822)")
            if res != "OK":
                continue

            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    relatorio = inspecionar_mensagem(msg)

                    log_status(
                        "ANALISE",
                        f"Remetente: {relatorio['remetente']} | Assunto: {relatorio['assunto']} | Links ({relatorio['total_links']})"
                    )

                    if relatorio["e_ameaca"]:
                        log_status("🚨 AMEAÇA DETECTADA", f"Gatilhos: {'; '.join(relatorio['ameacas'])}")
                        if relatorio["links_suspeitos"]:
                            log_status("🔗 LINKS SUSPEITOS", f"{', '.join(relatorio['links_suspeitos'][:3])}")
                        log_status("💥 AÇÃO", f"Eliminando/Quarentenando mensagem maliciosa (ID: {msg_id.decode()})...")
                        
                        # Marca como deletada e expurga
                        mail.store(msg_id, "+FLAGS", "\\Deleted")
                    else:
                        log_status("LIMPO", "Nenhum link malicioso ou anexo perigoso identificado.")


        # Aplica exclusão definitiva das mensagens marcadas como \\Deleted
        mail.expunge()
        log_status("CONCLUÍDO", "Varredura de patrulha finalizada.")

    except Exception as e:
        log_status("FALHA PATRULHA", f"Erro durante patrulha IMAP: {e}")

    finally:
        if mail:
            try:
                mail.close()
                mail.logout()
                log_status("SESSÃO", "Conexão IMAP encerrada.")
            except Exception:
                pass


def iniciar_ciclo_patrulha():
    """
    Loop tático contínuo. Executa a varredura a cada 30 minutos.
    """
    log_status("NÚCLEO INTERCEPTADOR", "Módulo de Inteligência de Ameaças ativado.")
    log_status("CONFIGURAÇÃO", f"Frequência de patrulha: {PATROL_INTERVAL_SECONDS // 60} minuto(s).")

    while True:
        executar_varredura_patrulha()
        log_status("AGUARDANDO", f"Próxima patrulha programada para daqui a {PATROL_INTERVAL_SECONDS // 60} minutos.")
        time.sleep(PATROL_INTERVAL_SECONDS)


if __name__ == "__main__":
    iniciar_ciclo_patrulha()
