import os

def carregar_env(caminho_env=".env"):
    """
    Carregador nativo de variáveis de ambiente do arquivo .env.
    Não requer dependências externas.
    """
    if os.path.exists(caminho_env):
        with open(caminho_env, "r", encoding="utf-8") as f:
            for linha in f:
                linha = linha.strip()
                if linha and not linha.startswith("#") and "=" in linha:
                    chave, valor = linha.split("=", 1)
                    chave = chave.strip()
                    valor = valor.strip().strip("'\"")
                    if chave and chave not in os.environ:
                        os.environ[chave] = valor

# Carrega o .env automaticamente ao importar este módulo
carregar_env()

