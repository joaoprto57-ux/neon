#!/usr/bin/env python3
"""
NEON CORE — Verificação de conectividade com o banco de dados.

A versão original executava tudo no nível do módulo: bastava um
`import neon_core` para abrir uma conexão de banco como efeito colateral.
Aqui a lógica está em função e só roda quando o script é chamado.
"""

import os
import sys

from neon_config import carregar_env

carregar_env()


def montar_parametros() -> tuple[str, dict | str]:
    """Devolve (descrição, parâmetros) para a conexão."""
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        # Nunca logar a URL completa: ela carrega usuário e senha.
        destino = database_url.split("@")[-1] if "@" in database_url else "(local)"
        return f"DATABASE_URL ({destino})", database_url

    params = {
        "host": os.environ.get("NEON_DB_HOST", "127.0.0.1"),
        "port": os.environ.get("NEON_DB_PORT", "5432"),
        "dbname": os.environ.get("NEON_DB_NAME", "neon_db"),
        "user": os.environ.get("NEON_DB_USER") or os.environ.get("USER", "postgres"),
        "password": os.environ.get("NEON_DB_PASSWORD", ""),
    }
    return f"{params['host']}:{params['port']}/{params['dbname']}", params


def testar_conexao() -> bool:
    """Abre, valida e fecha uma conexão. True se o banco respondeu."""
    try:
        import psycopg2
    except ImportError:
        print("[ BLOQUEIO ] psycopg2 não instalado. Rode: pip install -r requirements.txt")
        return False

    descricao, params = montar_parametros()
    print(f"[ INFO ] Conectando via {descricao}...")

    conexao = None
    try:
        conexao = (psycopg2.connect(params) if isinstance(params, str)
                   else psycopg2.connect(**params))
        with conexao.cursor() as cur:
            cur.execute("SELECT version();")
            versao = cur.fetchone()[0]
        print("[ SUCESSO ] Conexão estabelecida.")
        print(f"[ INFO ] {versao.split(',')[0]}")
        return True
    except Exception as erro:
        print(f"[ BLOQUEIO ] Falha na conexão: {erro}")
        print("[ DICA ] Verifique se o PostgreSQL está ativo e se DATABASE_URL "
              "está correta no .env.")
        return False
    finally:
        if conexao is not None:
            conexao.close()
            print("[ INFO ] Conexão encerrada com segurança.")


if __name__ == "__main__":
    print("Iniciando o Núcleo de Segurança Neon...")
    sys.exit(0 if testar_conexao() else 1)
