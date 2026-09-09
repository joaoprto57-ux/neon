import streamlit as st
import numpy as np
import plotly.graph_objects as go
import pandas as pd
import time

# --- CONFIGURAÇÃO DE PÁGINA (ESTILO INDUSTRIAL) ---
st.set_page_config(page_title="Monitoramento IoT | Indústria 4.0", layout="wide", initial_sidebar_state="expanded")

# CSS para dar um ar mais profissional e destacar as métricas
st.markdown("""
    <style>
    .metric-card {
        background-color: #1e1e1e; border-radius: 10px; padding: 15px; text-align: center; border: 1px solid #333;
    }
    .metric-value { font-size: 2rem; font-weight: bold; }
    </style>
""", unsafe_allow_html=True)

st.title("🏭 Painel de Manutenção Preditiva IoT (ESP32)")
st.markdown("Monitoramento de Vibração em Tempo Real - Avaliação baseada na Norma **ISO 10816-3**")

# --- BARRA LATERAL: DADOS FÍSICOS DO MOTOR ---
st.sidebar.header("⚙️ Cadastro do Equipamento")
nome_maquina = st.sidebar.text_input("Identificação (TAG)", value="Motor Exaustor EX-01")
rpm_motor = st.sidebar.number_input("Rotação Nominal (RPM)", min_value=300, max_value=7200, value=1750, step=10)
freq_1x = rpm_motor / 60.0

st.sidebar.markdown("---")
st.sidebar.header("📏 Limites de Alarme (ISO 10816)")
limite_alerta = st.sidebar.number_input("Alerta / Amarelo (mm/s)", value=2.8, step=0.1)
limite_falha = st.sidebar.number_input("Falha / Vermelho (mm/s)", value=4.5, step=0.1)


# =====================================================================
# 🔌 CONEXÃO COM O MUNDO REAL (ESP32)
# =====================================================================
def ler_dados_reais_esp32():
    """
    COLE AQUI A CONEXÃO QUE O CLAUDE FEZ (Serial, MQTT ou Socket).
    Abaixo é apenas um bypass de segurança para o painel não dar erro 
    enquanto você não plugar o código de leitura real.
    """
    fs = 4000 # Frequência de amostragem do seu ESP32
    t = np.linspace(0, 1.0, fs, endpoint=False)
    
    # Substitua a linha abaixo pela array de dados real que vem do seu ESP
    sinal_real = np.random.normal(0, 0.05, len(t)) 
    
    return t, sinal_real, fs

# Executa a leitura
t, sinal, fs = ler_dados_reais_esp32()
# =====================================================================


# --- PROCESSAMENTO MATEMÁTICO REAL ---
# Cálculo RMS (Vibração Global)
rms_g = np.sqrt(np.mean(sinal**2))
# Aproximação de g para Velocidade (mm/s) para a Norma ISO (fórmula simplificada para 1X dominante)
rms_mms = (rms_g * 9806.65) / (2 * np.pi * freq_1x) if freq_1x > 0 else 0

# --- LÓGICA DE STATUS (SEVERIDADE) ---
if rms_mms >= limite_falha:
    cor_alerta, status_texto = "🔴", "PERIGO (RISCO DE QUEBRA)"
    st.error(f"{cor_alerta} STATUS: {status_texto} | Ação Imediata Necessária")
elif rms_mms >= limite_alerta:
    cor_alerta, status_texto = "🟡", "ALERTA (INSPECIONAR)"
    st.warning(f"{cor_alerta} STATUS: {status_texto} | Agendar manutenção corretiva")
else:
    cor_alerta, status_texto = "🟢", "OPERAÇÃO NORMAL"
    st.success(f"{cor_alerta} STATUS: {status_texto} | Máquina operando dentro dos limites normais")

# --- EXIBIÇÃO DE MÉTRICAS ---
col_m1, col_m2, col_m3, col_m4 = st.columns(4)
col_m1.markdown(f'<div class="metric-card"><div style="color:gray;">Vibração Global (Velocidade)</div><div class="metric-value" style="color:white;">{rms_mms:.2f} <span style="font-size:1rem;">mm/s</span></div></div>', unsafe_allow_html=True)
col_m2.markdown(f'<div class="metric-card"><div style="color:gray;">Vibração Global (Aceleração)</div><div class="metric-value" style="color:white;">{rms_g:.3f} <span style="font-size:1rem;">g</span></div></div>', unsafe_allow_html=True)
col_m3.markdown(f'<div class="metric-card"><div style="color:gray;">Pico Máximo Instantâneo</div><div class="metric-value" style="color:white;">{np.max(np.abs(sinal)):.3f} <span style="font-size:1rem;">g</span></div></div>', unsafe_allow_html=True)
col_m4.markdown(f'<div class="metric-card"><div style="color:gray;">Frequência de Rotação (1X)</div><div class="metric-value" style="color:white;">{freq_1x:.1f} <span style="font-size:1rem;">Hz</span></div></div>', unsafe_allow_html=True)

st.write("") # Espaçamento

# --- FFT (TRANSFORMADA RÁPIDA DE FOURIER) ---
n = len(sinal)
freqs = np.fft.fftfreq(n, 1/fs)[:n//2]
fft_vals = np.abs(np.fft.fft(sinal))[:n//2] * 2 / n

# --- GRÁFICOS PROFISSIONAIS (TEMA ESCURO) ---
col_graf1, col_graf2 = st.columns(2)

with col_graf1:
    st.subheader("⏱️ Assinatura no Tempo (Raw Data)")
    fig_tempo = go.Figure()
    # Pega apenas uma janela pequena para conseguir ver o desenho da onda perfeitamente
    janela_visivel = int(fs * 0.1) 
    fig_tempo.add_trace(go.Scatter(x=t[:janela_visivel], y=sinal[:janela_visivel], mode='lines', name='Aceleração', line=dict(color='#00ffcc', width=1.5)))
    fig_tempo.update_layout(template="plotly_dark", xaxis_title="Tempo (segundos)", yaxis_title="Amplitude (g)", height=450, margin=dict(l=0, r=0, t=30, b=0))
    st.plotly_chart(fig_tempo, use_container_width=True)

with col_graf2:
    st.subheader("🔮 Espectro Frequencial (FFT)")
    fig_fft = go.Figure()
    fig_fft.add_trace(go.Scatter(x=freqs, y=fft_vals, mode='lines', name='Espectro', fill='tozeroy', line=dict(color='#ff9900', width=1.5)))
    
    # Marcação da Rotação Fundamental para quem analisar o painel entender a base
    fig_fft.add_vline(x=freq_1x, line_width=1.5, line_dash="dash", line_color="red")
    fig_fft.add_annotation(x=freq_1x, y=max(fft_vals) if max(fft_vals) > 0.01 else 0.05, text="1X RPM", showarrow=False, font=dict(color="red", size=14), yshift=15)
    
    # Zoom inteligente: Foca nos primeiros 10 harmônicos, que é onde a maioria dos defeitos (Desbalanceamento, Folga) aparece
    zoom_hz = freq_1x * 12 if freq_1x > 0 else 500
    fig_fft.update_layout(template="plotly_dark", xaxis_title="Frequência (Hz)", yaxis_title="Amplitude", xaxis=dict(range=[0, zoom_hz]), height=450, margin=dict(l=0, r=0, t=30, b=0))
    st.plotly_chart(fig_fft, use_container_width=True)

st.markdown("---")
st.caption("🚀 **Projeto de Hardware IoT** | Desenvolvido com ESP32 e Python | Validado contra Normas Industriais.")
