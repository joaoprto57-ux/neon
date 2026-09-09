#!/usr/bin/env python3
"""
NEON SENTINELA — Vigilância de rede com resposta automática.

Desenho em quatro camadas, cada uma testável sozinha:

    COLETORES  →  REGRAS  →  CORRELAÇÃO  →  RESPOSTA
                                  ↓
                               PAINEL

  Coletores   leem o estado bruto do sistema (conexões, portas, ARP,
              falhas de autenticação). Não julgam nada.
  Regras      transformam estado em suspeitas, cada uma isolada e com
              um peso. Uma regra errada não contamina as outras.
  Correlação  soma pesos por origem numa janela de tempo, com
              decaimento. É o que separa ruído de ataque: um evento é
              acaso, dez do mesmo IP em dois minutos não é.
  Resposta    age de forma graduada — observar, bloquear o IP, isolar
              a máquina — e nunca passa do teto configurado.

Uso:
    python3 neon_sentinela.py                 # painel ao vivo, só observa
    python3 neon_sentinela.py --armar         # derruba a rede em ataque
    python3 neon_sentinela.py --acao bloquear # só bloqueia o IP ofensor
    python3 neon_sentinela.py --uma-vez       # uma varredura, saída JSON
    python3 neon_sentinela.py --restaurar     # religa a rede e limpa bloqueios
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path

import psutil

from neon_config import carregar_env, env_bool, env_int, RAIZ_PROJETO

carregar_env()

# ──────────────────────────────────────────────────────────────────────
# CONFIGURAÇÃO
# ──────────────────────────────────────────────────────────────────────

INTERVALO = env_int("SENTINELA_INTERVALO", 3)
JANELA_SEGUNDOS = env_int("SENTINELA_JANELA", 120)
LIMIAR_ACAO = env_int("SENTINELA_LIMIAR", 10)
MEIA_VIDA = env_int("SENTINELA_MEIA_VIDA", 60)
COOLDOWN = env_int("SENTINELA_COOLDOWN", 300)
# Multiplicador do limiar para um único alvo derrubar a rede sozinho.
FATOR_ISOLAMENTO = float(os.environ.get("SENTINELA_FATOR_ISOLAMENTO", "2.0"))
INTERFACE = os.environ.get("WIFI_INTERFACE", "wlx90916470a8ff")
ARQ_ESTADO = RAIZ_PROJETO / "neon_sentinela_estado.json"
ARQ_LOG = RAIZ_PROJETO / "neon_sentinela.log"

# Processos cujo tráfego externo é esperado.
CONFIAVEIS = {
    "firefox", "firefox-bin", "chrome", "chromium", "code", "agy", "claude",
    "gemini", "node", "python3", "neon", "electron", "curl", "wget", "git",
    "npm", "apt", "snapd", "systemd-resolve", "systemd-resolved",
    "NetworkManager", "avahi-daemon", "cupsd", "dbus-daemon", "gnome-shell",
    "cinnamon", "Xorg", "pipewire", "pulseaudio", "ssh-agent", "code-server",
}

# Portas que o próprio sistema usa e não devem soar alarme.
PORTAS_ESPERADAS = {22, 53, 80, 443, 631, 5353, 5432, 3000, 8080, 8443}


def agora() -> float:
    return time.time()


def registrar(tag: str, msg: str, stream=sys.stderr) -> None:
    linha = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] [{tag}] {msg}"
    print(linha, file=stream, flush=True)
    try:
        with open(ARQ_LOG, "a", encoding="utf-8") as f:
            f.write(linha + "\n")
    except OSError:
        pass


def e_interno(ip: str) -> bool:
    """Endereço que não sai da máquina ou da rede local."""
    if not ip:
        return True
    try:
        addr = ipaddress.ip_address(ip.strip("[]"))
    except ValueError:
        return False
    return (addr.is_private or addr.is_loopback or addr.is_link_local
            or addr.is_reserved or addr.is_multicast or addr.is_unspecified)


def e_loopback(ip: str) -> bool:
    return bool(ip) and (ip.startswith("127.") or ip == "::1")


# ──────────────────────────────────────────────────────────────────────
# MODELO
# ──────────────────────────────────────────────────────────────────────

@dataclass
class Suspeita:
    """Uma observação isolada. Sozinha não significa ataque."""
    regra: str
    origem: str            # IP, MAC ou nome do processo — a quem atribuir
    peso: int              # 1 = ruído, 10 = grave sozinho
    descricao: str
    detalhe: dict = field(default_factory=dict)
    ts: float = field(default_factory=agora)


@dataclass
class Alvo:
    """Uma origem acumulando suspeitas ao longo do tempo."""
    origem: str
    pontos: float = 0.0
    suspeitas: deque = field(default_factory=lambda: deque(maxlen=40))
    primeiro: float = field(default_factory=agora)
    ultimo: float = field(default_factory=agora)

    @property
    def regras(self) -> list[str]:
        return sorted({s.regra for s in self.suspeitas})

    def resumo(self) -> dict:
        return {
            "origem": self.origem,
            "pontos": round(self.pontos, 1),
            "regras": self.regras,
            "eventos": len(self.suspeitas),
            "primeiro": datetime.fromtimestamp(self.primeiro).isoformat(),
            "ultimo": datetime.fromtimestamp(self.ultimo).isoformat(),
            "ultima_descricao": self.suspeitas[-1].descricao if self.suspeitas else "",
        }


# ──────────────────────────────────────────────────────────────────────
# CAMADA 1 — COLETORES
# Leem o sistema e devolvem fatos. Nenhum julgamento aqui.
# ──────────────────────────────────────────────────────────────────────

class Coletores:
    def __init__(self) -> None:
        self._pos_auth = 0
        self._arp_conhecido: dict[str, str] = {}
        self._escutas_base: set[tuple[str, int]] | None = None

    # ── conexões e portas ────────────────────────────────────────────
    @staticmethod
    def conexoes() -> list[dict]:
        saida = []
        try:
            brutas = psutil.net_connections(kind="inet")
        except (psutil.AccessDenied, PermissionError):
            return saida
        for c in brutas:
            nome = "desconhecido"
            if c.pid:
                try:
                    nome = psutil.Process(c.pid).name()
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    pass
            saida.append({
                "pid": c.pid,
                "processo": nome,
                "tipo": "TCP" if c.type == socket.SOCK_STREAM else "UDP",
                "ip_local": c.laddr.ip if c.laddr else "",
                "porta_local": c.laddr.port if c.laddr else 0,
                "ip_remoto": c.raddr.ip if c.raddr else "",
                "porta_remota": c.raddr.port if c.raddr else 0,
                "status": c.status,
            })
        return saida

    def escutas_novas(self, conexoes: list[dict]) -> list[dict]:
        """Portas que passaram a escutar depois do início da vigilância."""
        atuais = {
            (c["ip_local"], c["porta_local"]): c
            for c in conexoes
            if c["status"] == "LISTEN" and not e_loopback(c["ip_local"])
        }
        if self._escutas_base is None:
            # A primeira leitura vira linha de base: o que já estava de pé
            # quando ligamos não é novidade.
            self._escutas_base = set(atuais)
            return []
        novas = [v for k, v in atuais.items() if k not in self._escutas_base]
        self._escutas_base |= set(atuais)
        return novas

    # ── vizinhança (ARP) ─────────────────────────────────────────────
    @staticmethod
    def arp() -> list[dict]:
        vizinhos = []
        try:
            linhas = Path("/proc/net/arp").read_text().splitlines()[1:]
        except OSError:
            return vizinhos
        for l in linhas:
            campos = l.split()
            if len(campos) >= 6 and campos[3] != "00:00:00:00:00:00":
                vizinhos.append({"ip": campos[0], "mac": campos[3], "iface": campos[5]})
        return vizinhos

    def arp_mudancas(self, vizinhos: list[dict]) -> list[tuple[str, str, str]]:
        """
        Devolve (ip, mac_antigo, mac_novo) quando um IP troca de MAC.

        É o sinal clássico de interceptação: alguém se anuncia como o
        roteador para ficar no meio do seu tráfego.
        """
        trocas = []
        for v in vizinhos:
            anterior = self._arp_conhecido.get(v["ip"])
            if anterior and anterior != v["mac"]:
                trocas.append((v["ip"], anterior, v["mac"]))
            self._arp_conhecido[v["ip"]] = v["mac"]
        return trocas

    # ── autenticação ─────────────────────────────────────────────────
    PADRAO_FALHA = re.compile(
        r"(authentication failure|Failed password|Invalid user|"
        r"POSSIBLE BREAK-IN|Connection closed by authenticating user)",
        re.IGNORECASE,
    )
    PADRAO_IP = re.compile(r"(?:rhost=|from )(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{4,})")

    def falhas_autenticacao(self) -> list[dict]:
        """Novas linhas de falha em /var/log/auth.log desde a última leitura."""
        caminho = Path("/var/log/auth.log")
        try:
            tamanho = caminho.stat().st_size
        except OSError:
            return []
        if self._pos_auth == 0:
            self._pos_auth = tamanho      # começa do fim: histórico não é ataque
            return []
        if tamanho < self._pos_auth:
            self._pos_auth = 0            # log rotacionou
        if tamanho == self._pos_auth:
            return []

        try:
            with open(caminho, "r", errors="replace") as f:
                f.seek(self._pos_auth)
                novo = f.read()
                self._pos_auth = tamanho
        except OSError:
            return []

        eventos = []
        for linha in novo.splitlines():
            if not self.PADRAO_FALHA.search(linha):
                continue
            m = self.PADRAO_IP.search(linha)
            eventos.append({
                "linha": linha.strip()[:200],
                "ip": m.group(1) if m else "local",
                "servico": "ssh" if "sshd" in linha else ("sudo" if "sudo" in linha else "pam"),
            })
        return eventos


# ──────────────────────────────────────────────────────────────────────
# CAMADA 2 — REGRAS
# Cada regra recebe fatos e devolve suspeitas. Puras e independentes.
# ──────────────────────────────────────────────────────────────────────

def regra_porta_exposta(novas: list[dict]) -> list[Suspeita]:
    """Serviço novo escutando num endereço alcançável de fora."""
    out = []
    for c in novas:
        if c["porta_local"] in PORTAS_ESPERADAS:
            continue
        confiavel = c["processo"] in CONFIAVEIS
        out.append(Suspeita(
            regra="porta_exposta",
            origem=c["processo"],
            peso=4 if confiavel else 8,
            descricao=f"porta {c['porta_local']} passou a escutar em {c['ip_local']} ({c['processo']})",
            detalhe=c,
        ))
    return out


def regra_conexao_entrante(conexoes: list[dict], meus_ips: set[str]) -> list[Suspeita]:
    """Alguém de fora conectou a um serviço seu."""
    out = []
    for c in conexoes:
        if c["status"] != "ESTABLISHED" or not c["ip_remoto"]:
            continue
        if e_loopback(c["ip_local"]) or e_interno(c["ip_remoto"]):
            continue
        # Porta local baixa e fixa = você é o servidor; a outra ponta veio até você.
        if c["porta_local"] < 10000 and c["porta_remota"] > 10000:
            out.append(Suspeita(
                regra="conexao_entrante",
                origem=c["ip_remoto"],
                peso=7,
                descricao=f"{c['ip_remoto']} conectou na sua porta {c['porta_local']} ({c['processo']})",
                detalhe=c,
            ))
    return out


def regra_varredura(conexoes: list[dict]) -> list[Suspeita]:
    """Um mesmo IP remoto tocando em várias portas suas."""
    portas_por_ip: dict[str, set[int]] = defaultdict(set)
    for c in conexoes:
        if c["ip_remoto"] and not e_interno(c["ip_remoto"]) and c["porta_local"] < 10000:
            portas_por_ip[c["ip_remoto"]].add(c["porta_local"])
    return [
        Suspeita(
            regra="varredura",
            origem=ip,
            peso=9,
            descricao=f"{ip} tocou em {len(portas)} portas suas: {sorted(portas)[:8]}",
            detalhe={"portas": sorted(portas)},
        )
        for ip, portas in portas_por_ip.items() if len(portas) >= 3
    ]


def regra_processo_estranho(conexoes: list[dict]) -> list[Suspeita]:
    """Processo fora da lista conhecida falando com a internet."""
    vistos = set()
    out = []
    for c in conexoes:
        if c["status"] != "ESTABLISHED" or not c["ip_remoto"]:
            continue
        if e_interno(c["ip_remoto"]) or c["processo"] in CONFIAVEIS:
            continue
        chave = (c["processo"], c["ip_remoto"])
        if chave in vistos:
            continue
        vistos.add(chave)
        desconhecido = c["processo"] == "desconhecido"
        out.append(Suspeita(
            regra="processo_estranho",
            origem=c["processo"],
            # "desconhecido" quase sempre é falta de privilégio para ler
            # o dono do socket, não malícia. Pesa menos.
            peso=3 if desconhecido else 6,
            descricao=f"'{c['processo']}' falando com {c['ip_remoto']}:{c['porta_remota']}",
            detalhe=c,
        ))
    return out


def regra_falha_auth(falhas: list[dict]) -> list[Suspeita]:
    """Tentativas de autenticação malsucedidas."""
    return [
        Suspeita(
            regra="falha_autenticacao",
            origem=f["ip"],
            peso=5 if f["servico"] == "ssh" else 2,
            descricao=f"falha de autenticação ({f['servico']}) de {f['ip']}",
            detalhe=f,
        )
        for f in falhas
    ]


def regra_arp_trocado(trocas: list[tuple[str, str, str]], gateway: str) -> list[Suspeita]:
    """MAC de um vizinho mudou — no gateway, é interceptação até prova em contrário."""
    out = []
    for ip, antigo, novo in trocas:
        do_gateway = (ip == gateway)
        out.append(Suspeita(
            regra="arp_trocado",
            origem=ip,
            peso=10 if do_gateway else 4,
            descricao=(f"{'GATEWAY' if do_gateway else 'vizinho'} {ip} trocou de MAC: "
                       f"{antigo} → {novo}"),
            detalhe={"ip": ip, "mac_antigo": antigo, "mac_novo": novo},
        ))
    return out


# ──────────────────────────────────────────────────────────────────────
# CAMADA 3 — CORRELAÇÃO
# Soma pesos por origem, com decaimento. Um evento é acaso.
# ──────────────────────────────────────────────────────────────────────

class Correlacionador:
    def __init__(self, meia_vida: int = MEIA_VIDA) -> None:
        self.alvos: dict[str, Alvo] = {}
        self.meia_vida = max(1, meia_vida)
        self._ultimo_decaimento = agora()

    def decair(self) -> None:
        """Pontos caem pela metade a cada meia-vida sem novos eventos."""
        t = agora()
        passou = t - self._ultimo_decaimento
        if passou < 1:
            return
        fator = 0.5 ** (passou / self.meia_vida)
        for alvo in list(self.alvos.values()):
            alvo.pontos *= fator
            if alvo.pontos < 0.5 and (t - alvo.ultimo) > JANELA_SEGUNDOS:
                del self.alvos[alvo.origem]
        self._ultimo_decaimento = t

    def registrar(self, suspeitas: list[Suspeita]) -> None:
        for s in suspeitas:
            alvo = self.alvos.get(s.origem)
            if alvo is None:
                alvo = Alvo(origem=s.origem)
                self.alvos[s.origem] = alvo
            alvo.pontos += s.peso
            alvo.suspeitas.append(s)
            alvo.ultimo = s.ts

    def criticos(self, limiar: int = LIMIAR_ACAO) -> list[Alvo]:
        return sorted(
            (a for a in self.alvos.values() if a.pontos >= limiar),
            key=lambda a: a.pontos, reverse=True,
        )

    def ranking(self, n: int = 10) -> list[Alvo]:
        return sorted(self.alvos.values(), key=lambda a: a.pontos, reverse=True)[:n]


# ──────────────────────────────────────────────────────────────────────
# CAMADA 4 — RESPOSTA
# Graduada e com teto. Nunca faz mais do que foi autorizado.
# ──────────────────────────────────────────────────────────────────────

NIVEIS = ["observar", "bloquear", "isolar"]


class Resposta:
    """
    observar  — só registra e mostra
    bloquear  — descarta o tráfego do IP ofensor (precisa de root)
    isolar    — desconecta a interface: a máquina sai do ar
    """

    def __init__(self, teto: str = "observar", interface: str = INTERFACE,
                 fator_isolamento: float = FATOR_ISOLAMENTO) -> None:
        if teto not in NIVEIS:
            raise ValueError(f"teto inválido: {teto}. Use um de {NIVEIS}.")
        self.teto = teto
        self.interface = interface
        # Quantas vezes o limiar um único alvo precisa alcançar para
        # derrubar a rede sozinho. 1.0 = pega leve no gatilho.
        self.fator_isolamento = max(1.0, fator_isolamento)
        self.bloqueados: set[str] = set()
        self.isolado_em: float | None = None
        self._avisados: set[str] = set()
        self.pode_bloquear = self._checar_bloqueio()
        self.gateway = self._descobrir_gateway()
        # Nunca bloquear a própria infraestrutura: cortar o gateway ou o
        # DNS derruba a rede inteira em vez do invasor.
        self.intocaveis = {self.gateway, "127.0.0.1", "::1"} - {""}

    # ── capacidades ──────────────────────────────────────────────────
    @staticmethod
    def _checar_bloqueio() -> bool:
        if not shutil.which("nft") and not shutil.which("iptables"):
            return False
        return os.geteuid() == 0

    @staticmethod
    def _descobrir_gateway() -> str:
        try:
            saida = subprocess.run(["ip", "route"], capture_output=True,
                                   text=True, timeout=5).stdout
            for linha in saida.splitlines():
                if linha.startswith("default via "):
                    return linha.split()[2]
        except (subprocess.SubprocessError, OSError, IndexError):
            pass
        return ""

    # ── ações ────────────────────────────────────────────────────────
    def bloquear_ip(self, ip: str) -> bool:
        if ip in self.intocaveis or ip in self.bloqueados:
            return False
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            return False   # origem é nome de processo, não IP
        if not self.pode_bloquear:
            # Uma vez por IP: repetir a cada ciclo entulharia o log.
            if ip not in self._avisados:
                self._avisados.add(ip)
                registrar("BLOQUEIO", f"{ip} seria bloqueado, mas falta root. "
                                      "Sem isso, a resposta possível é o isolamento.")
            return False
        try:
            subprocess.run(["nft", "add", "rule", "inet", "filter", "input",
                            "ip", "saddr", ip, "drop"],
                           capture_output=True, timeout=10, check=True)
            self.bloqueados.add(ip)
            registrar("🚫 BLOQUEADO", f"tráfego de {ip} descartado")
            return True
        except (subprocess.SubprocessError, OSError) as e:
            registrar("ERRO", f"falha ao bloquear {ip}: {e}")
            return False

    def isolar(self, motivo: str) -> bool:
        if self.isolado_em:
            return False
        registrar("🔴 ISOLAMENTO", f"desconectando {self.interface} — {motivo}")
        try:
            r = subprocess.run(["nmcli", "device", "disconnect", self.interface],
                               capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                self.isolado_em = agora()
                registrar("🔴 ISOLAMENTO", "máquina fora do ar. "
                                           "Use --restaurar para religar.")
                return True
            registrar("ERRO", f"nmcli recusou: {r.stderr.strip()}")
        except (subprocess.SubprocessError, OSError) as e:
            registrar("ERRO", f"falha ao isolar: {e}")
        return False

    def restaurar(self) -> bool:
        ok = True
        if self.isolado_em:
            try:
                r = subprocess.run(["nmcli", "device", "connect", self.interface],
                                   capture_output=True, text=True, timeout=25)
                ok = r.returncode == 0
                registrar("🟢 RESTAURAÇÃO",
                          "rede religada" if ok else f"falhou: {r.stderr.strip()}")
                if ok:
                    self.isolado_em = None
            except (subprocess.SubprocessError, OSError) as e:
                registrar("ERRO", f"falha ao religar: {e}")
                ok = False
        if self.bloqueados and self.pode_bloquear:
            try:
                subprocess.run(["nft", "flush", "chain", "inet", "filter", "input"],
                               capture_output=True, timeout=10)
                registrar("🟢 RESTAURAÇÃO", f"{len(self.bloqueados)} bloqueio(s) removido(s)")
                self.bloqueados.clear()
            except (subprocess.SubprocessError, OSError):
                ok = False
        return ok

    # ── decisão ──────────────────────────────────────────────────────
    def aplicar(self, criticos: list[Alvo]) -> list[str]:
        """Escolhe a ação para cada alvo crítico, respeitando o teto."""
        acoes = []
        if not criticos:
            return acoes

        if self.teto == "observar":
            for a in criticos:
                acoes.append(f"observado: {a.origem} ({a.pontos:.0f} pts)")
            registrar("⚠ ALERTA",
                      f"{len(criticos)} alvo(s) acima do limiar. Teto em 'observar', "
                      "nenhuma ação tomada. Use --armar para reagir.")
            return acoes

        ips = [a for a in criticos if a.origem not in self.intocaveis]
        for a in ips:
            if self.bloquear_ip(a.origem):
                acoes.append(f"bloqueado: {a.origem}")

        # Isolar é o último recurso. Duas portas de entrada:
        #  - o ataque é amplo (vários alvos), ou
        #  - um alvo passou bem do limiar.
        #
        # Sem root não há bloqueio cirúrgico, então o isolamento é a
        # única resposta possível — mas aí a exigência sobe, senão um
        # único alvo raspando o limiar derruba a internet e você
        # desliga o vigia na terceira vez que isso acontecer.
        if self.teto == "isolar":
            pior = criticos[0]
            amplo = len(criticos) >= 3
            exigencia = LIMIAR_ACAO * self.fator_isolamento
            decisivo = pior.pontos >= exigencia

            if amplo or decisivo:
                motivo = (f"{pior.origem} com {pior.pontos:.0f} pts "
                          f"({', '.join(pior.regras)})"
                          + (f" · {len(criticos)} alvos simultâneos" if amplo else ""))
                if self.isolar(motivo):
                    acoes.append("rede isolada")
            else:
                registrar("⚠ ALERTA",
                          f"{pior.origem} em {pior.pontos:.0f} pts — abaixo de "
                          f"{exigencia:.0f} para isolar. Vigiando.")
        return acoes


# ──────────────────────────────────────────────────────────────────────
# PAINEL — onde está a movimentação
# ──────────────────────────────────────────────────────────────────────

C = {
    "reset": "\033[0m", "dim": "\033[2m", "neg": "\033[1m",
    "vrm": "\033[31m", "vrd": "\033[32m", "amr": "\033[33m",
    "azl": "\033[36m", "rox": "\033[35m",
}


def barra(valor: float, maximo: float, largura: int = 18) -> str:
    if maximo <= 0:
        return " " * largura
    cheio = int(largura * min(valor / maximo, 1.0))
    return "█" * cheio + "·" * (largura - cheio)


def desenhar_painel(estado: dict, correlacionador: Correlacionador,
                    resposta: Resposta) -> None:
    print("\033[H\033[J", end="")   # topo e limpa
    r = estado["resumo"]

    cor_teto = {"observar": C["azl"], "bloquear": C["amr"], "isolar": C["vrm"]}[resposta.teto]
    situacao = (f"{C['vrm']}ISOLADA{C['reset']}" if resposta.isolado_em
                else f"{C['vrd']}no ar{C['reset']}")

    print(f"{C['neg']}{C['azl']}NEON SENTINELA{C['reset']}  "
          f"{C['dim']}{datetime.now():%H:%M:%S}{C['reset']}   "
          f"rede: {situacao}   "
          f"resposta: {cor_teto}{resposta.teto}{C['reset']}")
    print(f"{C['dim']}{'─' * 74}{C['reset']}")

    print(f"  conexões {C['neg']}{r['total']}{C['reset']}"
          f"  ·  estabelecidas {r['established']}"
          f"  ·  escutando {r['listen']}"
          f"  ·  externas {C['amr']}{r['externas']}{C['reset']}"
          f"  ·  bloqueios {len(resposta.bloqueados)}")
    print()

    # ── para onde a máquina está falando ─────────────────────────────
    print(f"{C['neg']}ONDE ESTÁ A MOVIMENTAÇÃO{C['reset']}")
    destinos = estado["destinos"][:8]
    if destinos:
        maxc = max(d["conexoes"] for d in destinos)
        for d in destinos:
            nome = d["host"] or d["ip"]
            print(f"  {C['azl']}{barra(d['conexoes'], maxc)}{C['reset']} "
                  f"{d['conexoes']:>3}  {nome[:34]:<34} "
                  f"{C['dim']}{', '.join(d['processos'][:2])}{C['reset']}")
    else:
        print(f"  {C['dim']}nenhuma conexão externa{C['reset']}")
    print()

    # ── alvos suspeitos ──────────────────────────────────────────────
    ranking = correlacionador.ranking(6)
    exigencia = LIMIAR_ACAO * resposta.fator_isolamento
    print(f"{C['neg']}SUSPEITAS ACUMULADAS{C['reset']}  "
          f"{C['dim']}(alerta em {LIMIAR_ACAO} pts"
          + (f" · isola em {exigencia:.0f}" if resposta.teto == "isolar" else "")
          + f"){C['reset']}")
    if ranking:
        for a in ranking:
            cor = C["vrm"] if a.pontos >= LIMIAR_ACAO else (
                C["amr"] if a.pontos >= LIMIAR_ACAO / 2 else C["dim"])
            print(f"  {cor}{barra(a.pontos, max(LIMIAR_ACAO * 2, a.pontos))}{C['reset']} "
                  f"{a.pontos:>5.1f}  {a.origem[:26]:<26} "
                  f"{C['dim']}{', '.join(a.regras)[:30]}{C['reset']}")
    else:
        print(f"  {C['vrd']}nada suspeito{C['reset']}")
    print()

    ultimas = estado["ultimas"][-5:]
    if ultimas:
        print(f"{C['neg']}ÚLTIMOS EVENTOS{C['reset']}")
        for s in ultimas:
            print(f"  {C['dim']}{datetime.fromtimestamp(s['ts']):%H:%M:%S}{C['reset']} "
                  f"{s['descricao'][:66]}")
    print(f"\n{C['dim']}Ctrl+C encerra · --armar reage · --restaurar religa{C['reset']}")


# ──────────────────────────────────────────────────────────────────────
# ORQUESTRAÇÃO
# ──────────────────────────────────────────────────────────────────────

class Sentinela:
    def __init__(self, teto: str = "observar", interface: str = INTERFACE,
                 fator: float = FATOR_ISOLAMENTO) -> None:
        self.coletores = Coletores()
        self.correlacionador = Correlacionador()
        self.resposta = Resposta(teto=teto, interface=interface,
                                 fator_isolamento=fator)
        self.ultimas: deque[Suspeita] = deque(maxlen=40)
        self._dns: dict[str, str] = {}

    def _host(self, ip: str) -> str:
        """Nome reverso, com cache. Falha rápido para não travar o ciclo."""
        if ip in self._dns:
            return self._dns[ip]
        nome = ""
        try:
            socket.setdefaulttimeout(0.4)
            nome = socket.gethostbyaddr(ip)[0]
        except (OSError, socket.herror, socket.gaierror):
            pass
        finally:
            socket.setdefaulttimeout(None)
        self._dns[ip] = nome
        return nome

    def ciclo(self) -> dict:
        """Uma rodada completa: coleta, avalia, correlaciona, responde."""
        conexoes = self.coletores.conexoes()
        vizinhos = self.coletores.arp()
        meus_ips = {c["ip_local"] for c in conexoes if c["ip_local"]}

        suspeitas: list[Suspeita] = []
        suspeitas += regra_porta_exposta(self.coletores.escutas_novas(conexoes))
        suspeitas += regra_conexao_entrante(conexoes, meus_ips)
        suspeitas += regra_varredura(conexoes)
        suspeitas += regra_processo_estranho(conexoes)
        suspeitas += regra_falha_auth(self.coletores.falhas_autenticacao())
        suspeitas += regra_arp_trocado(self.coletores.arp_mudancas(vizinhos),
                                       self.resposta.gateway)

        self.correlacionador.decair()
        self.correlacionador.registrar(suspeitas)
        self.ultimas.extend(suspeitas)

        criticos = self.correlacionador.criticos()
        acoes = self.resposta.aplicar(criticos) if criticos else []

        # Para onde a máquina está falando, agrupado por destino.
        por_ip: dict[str, dict] = {}
        for c in conexoes:
            ip = c["ip_remoto"]
            if not ip or e_interno(ip):
                continue
            d = por_ip.setdefault(ip, {"ip": ip, "conexoes": 0, "processos": [], "portas": []})
            d["conexoes"] += 1
            if c["processo"] not in d["processos"]:
                d["processos"].append(c["processo"])
            if c["porta_remota"] not in d["portas"]:
                d["portas"].append(c["porta_remota"])
        destinos = sorted(por_ip.values(), key=lambda d: d["conexoes"], reverse=True)
        for d in destinos[:8]:
            d["host"] = self._host(d["ip"])

        return {
            "timestamp": datetime.now().isoformat(),
            "resumo": {
                "total": len(conexoes),
                "established": sum(1 for c in conexoes if c["status"] == "ESTABLISHED"),
                "listen": sum(1 for c in conexoes if c["status"] == "LISTEN"),
                "externas": len(por_ip),
            },
            "destinos": destinos,
            "vizinhos": vizinhos,
            "suspeitas": [asdict(s) for s in suspeitas],
            "ultimas": [asdict(s) for s in self.ultimas],
            "alvos": [a.resumo() for a in self.correlacionador.ranking(10)],
            "criticos": [a.resumo() for a in criticos],
            "acoes": acoes,
            "rede_isolada": self.resposta.isolado_em is not None,
            "bloqueados": sorted(self.resposta.bloqueados),
        }

    def vigiar(self, intervalo: int = INTERVALO, painel: bool = True) -> None:
        registrar("🛡️ SENTINELA", f"vigilância iniciada · resposta '{self.resposta.teto}' "
                                  f"· interface {self.resposta.interface}")
        if self.resposta.teto != "observar" and not self.resposta.pode_bloquear:
            registrar("AVISO", "sem root: bloqueio por IP indisponível, "
                               "só o isolamento total funciona.")
        try:
            while True:
                estado = self.ciclo()
                if painel:
                    desenhar_painel(estado, self.correlacionador, self.resposta)
                self._salvar(estado)
                time.sleep(intervalo)
        except KeyboardInterrupt:
            print()
            registrar("SENTINELA", "vigilância encerrada.")

    @staticmethod
    def _salvar(estado: dict) -> None:
        """Último estado em disco, para o painel do Neon consumir."""
        try:
            tmp = ARQ_ESTADO.with_suffix(".tmp")
            tmp.write_text(json.dumps(estado, ensure_ascii=False, default=str))
            tmp.replace(ARQ_ESTADO)
        except OSError:
            pass


def main() -> int:
    p = argparse.ArgumentParser(
        description="Vigilância de rede com resposta automática.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""exemplos:
  %(prog)s                      painel ao vivo, apenas observa
  %(prog)s --armar              derruba a rede sob ataque
  %(prog)s --acao bloquear      bloqueia o IP ofensor (precisa de root)
  %(prog)s --uma-vez            uma varredura, saída JSON
  %(prog)s --restaurar          religa a rede e limpa bloqueios""")
    p.add_argument("--acao", choices=NIVEIS,
                   default=os.environ.get("SENTINELA_ACAO", "observar"),
                   help="até onde a resposta pode ir (padrão: observar)")
    p.add_argument("--armar", action="store_true",
                   help="atalho para --acao isolar")
    p.add_argument("--fator", type=float, default=FATOR_ISOLAMENTO,
                   help=f"múltiplo do limiar para um alvo isolar sozinho "
                        f"(padrão: {FATOR_ISOLAMENTO})")
    p.add_argument("--paranoico", action="store_true",
                   help="isola no limiar simples — reage a qualquer tentativa")
    p.add_argument("--intervalo", type=int, default=INTERVALO)
    p.add_argument("--interface", default=INTERFACE)
    p.add_argument("--uma-vez", action="store_true", help="uma varredura, JSON no stdout")
    p.add_argument("--sem-painel", action="store_true", help="só log, sem tela")
    p.add_argument("--restaurar", action="store_true",
                   help="religa a rede e remove bloqueios")
    args = p.parse_args()

    teto = "isolar" if (args.armar or args.paranoico) else args.acao
    fator = 1.0 if args.paranoico else args.fator

    if args.restaurar:
        r = Resposta(teto="isolar", interface=args.interface)
        r.isolado_em = agora()          # força a tentativa de religar
        return 0 if r.restaurar() else 1

    sentinela = Sentinela(teto=teto, interface=args.interface, fator=fator)

    if args.uma_vez:
        # Duas rodadas: a primeira só estabelece a linha de base.
        sentinela.ciclo()
        time.sleep(1)
        print(json.dumps(sentinela.ciclo(), ensure_ascii=False, default=str))
        return 0

    sentinela.vigiar(intervalo=args.intervalo, painel=not args.sem_painel)
    return 0


if __name__ == "__main__":
    sys.exit(main())
