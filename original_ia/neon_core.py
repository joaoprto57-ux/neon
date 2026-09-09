import os
import psycopg2
from neon_config import carregar_env

# Garante o carregamento do .env
carregar_env()

print("Iniciando o Núcleo de Segurança Neon...")

conexao = None

try:
    host = os.environ.get("NEON_DB_HOST", "127.0.0.1")
    port = os.environ.get("NEON_DB_PORT", "5432")
    dbname = os.environ.get("NEON_DB_NAME", "neon_db")
    user = os.environ.get("NEON_DB_USER", "joao")
    senha = os.environ.get("NEON_DB_PASSWORD", "")
    database_url = os.environ.get("DATABASE_URL")

    if database_url:
        log_db = database_url.split("@")[-1] if "@" in database_url else database_url
        print(f"[ INFO ] Conectando via DATABASE_URL ({log_db})...")
        conexao = psycopg2.connect(database_url)
    else:
        print(f"[ INFO ] Conectando ao host {host}:{port} no banco {dbname}...")
        conexao = psycopg2.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=senha
        )
    
    print("[ SUCESSO ] Conexão estabelecida com o cérebro de dados!")

except Exception as erro:
    print(f"[ BLOQUEIO ] Falha na conexão: {erro}")
    print("[ DICA ] Verifique se o serviço PostgreSQL está ativo ou configure as credenciais/DATABASE_URL no arquivo .env.")

finally:
    if conexao is not None:
        conexao.close()
        print("[ INFO ] Conexão encerrada com segurança.")