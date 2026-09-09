"""Carregador nativo de variáveis de ambiente, sem dependências externas."""

import os
from pathlib import Path

# Raiz do projeto: resolvida a partir DESTE arquivo, não do diretório de
# trabalho. Sem isso, rodar um script de outro diretório carregava um .env
# inexistente em silêncio, e as credenciais simplesmente não apareciam.
RAIZ_PROJETO = Path(__file__).resolve().parent
CAMINHO_ENV_PADRAO = RAIZ_PROJETO / ".env"

_ja_carregado = False


def _limpar_valor(valor: str) -> str:
    """Remove aspas envolventes e comentário inline de um valor."""
    valor = valor.strip()
    if len(valor) >= 2 and valor[0] == valor[-1] and valor[0] in "\"'":
        # Valor entre aspas: preserva o conteúdo literal, inclusive '#'.
        return valor[1:-1]
    # Fora de aspas, '#' inicia comentário.
    if "#" in valor:
        valor = valor.split("#", 1)[0]
    return valor.strip()


def carregar_env(caminho_env=None, forcar=False) -> dict:
    """
    Lê um arquivo .env e popula os.environ.

    Variáveis já presentes no ambiente têm precedência e não são
    sobrescritas — o .env é fallback, não autoridade.

    Retorna o dicionário de chaves lidas do arquivo.
    """
    global _ja_carregado

    caminho = Path(caminho_env) if caminho_env else CAMINHO_ENV_PADRAO
    lidas = {}

    if not caminho.exists():
        return lidas

    with open(caminho, "r", encoding="utf-8") as f:
        for linha in f:
            linha = linha.strip()
            if not linha or linha.startswith("#") or "=" not in linha:
                continue
            # Aceita a forma "export CHAVE=valor" usada em shells.
            if linha.startswith("export "):
                linha = linha[len("export "):]
            chave, valor = linha.split("=", 1)
            chave = chave.strip()
            if not chave:
                continue
            valor = _limpar_valor(valor)
            lidas[chave] = valor
            if forcar or chave not in os.environ:
                os.environ[chave] = valor

    _ja_carregado = True
    return lidas


def env_bool(chave: str, padrao: bool = False) -> bool:
    """Lê uma variável booleana. Só 1/true/yes/on ligam a flag."""
    valor = os.environ.get(chave)
    if valor is None:
        return padrao
    return valor.strip().lower() in {"1", "true", "yes", "on", "sim"}


def env_int(chave: str, padrao: int) -> int:
    """Lê uma variável inteira, caindo no padrão se estiver malformada."""
    try:
        return int(os.environ.get(chave, padrao))
    except (TypeError, ValueError):
        return padrao


# Carga automática ao importar, mantendo a conveniência original.
carregar_env()
