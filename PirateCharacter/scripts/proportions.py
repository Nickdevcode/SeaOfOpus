"""Proporções do personagem, medidas na arte de referência e convertidas para metros.

Método: a referência tem 1024x1536 px. Ancorando o topo do crânio em y=235 px e a
sola em y=1245 px (1010 px de corpo) numa altura-alvo de 1.80 m, a escala é
1 px = 0.00178 m. Todos os landmarks abaixo vêm dessa conversão — é isso que
garante que a silhueta bata com o desenho em vez de virar "um pirata genérico".

Observações da referência que importam para a leitura do personagem:
  - Pernas curtas (entrepernas a 44% da altura, contra 47-48% do humano médio):
    é daí que vem o aspecto atarracado/robusto.
  - Quadril mais largo que os ombros por causa do cinto + abas do casaco.
  - Envergadura ~= altura (anatomicamente correto), braços em T-pose.
  - Pés bem afastados (~0.24 m do eixo), pose plantada.
"""

# --- Escala geral -----------------------------------------------------------
HEIGHT = 1.80            # altura sem chapéu
PX = 0.00178             # metro por pixel da referência

# --- Landmarks verticais (Z, chão = 0) --------------------------------------
Z_SOLE = 0.000
Z_SOLE_TOP = 0.030       # topo da sola / entressola
Z_ANKLE = 0.115
Z_BOOT_SHAFT = 0.300     # meio do cano da bota
Z_KNEE = 0.435
Z_BOOT_CUFF_TOP = 0.480  # topo da dobra larga da bota
Z_THIGH = 0.640
Z_CROTCH = 0.795
Z_COAT_HEM = 0.800       # barra das abas do casaco
Z_SASH_BOT = 0.845
Z_HIP = 0.900
Z_BELT_BOT = 0.910
Z_BELT_TOP = 1.060
Z_SASH_TOP = 1.110
Z_WAIST = 1.150
Z_CHEST = 1.375
Z_ARMPIT = 1.330
Z_SHOULDER = 1.480       # topo do trapézio / raiz do braço
Z_SHOULDER_PIVOT = 1.430  # altura do eixo do braço em T-pose
Z_NECK_BASE = 1.470
Z_NECK_TOP = 1.560
Z_CHIN = 1.585
Z_MOUTH = 1.640
Z_NOSE = 1.678
Z_EYE = 1.712
Z_BROW = 1.735
Z_HEAD_TOP = 1.800
Z_HAT_BRIM = 1.745      # altura da aba do tricórnio nas pontas
Z_HAT_TOP = 1.888       # topo da copa
Z_HAT_PEAK = 1.938      # topo das dobras da aba (passam acima da copa)

# --- Torso (raios; rx = meia-largura em X, ry = meia-profundidade em Y) -----
R_NECK = 0.062
R_SHOULDER_X = 0.250     # meia-largura do casaco na linha do ombro
R_CHEST_X, R_CHEST_YF, R_CHEST_YB = 0.212, 0.150, 0.132
R_WAIST_X, R_WAIST_YF, R_WAIST_YB = 0.196, 0.143, 0.126
R_HIP_X, R_HIP_YF, R_HIP_YB = 0.213, 0.152, 0.140
R_BELT_X, R_BELT_Y = 0.252, 0.178
R_SASH_X, R_SASH_Y = 0.238, 0.168
R_SKIRT_X, R_SKIRT_Y = 0.255, 0.185   # abas do casaco na barra

# --- Braço (T-pose, ao longo de +X) ----------------------------------------
X_SHOULDER = 0.240
X_ELBOW = 0.500
X_WRIST = 0.762
X_FINGERTIP = 0.870
R_DELTOID = 0.071        # medido na referência: manga bem cheia no ombro
R_UPPERARM = 0.050
R_ELBOW = 0.045
R_FOREARM = 0.042
R_CUFF = 0.055           # punho dobrado da manga
R_WRIST = 0.031

# --- Mão --------------------------------------------------------------------
# A referência tem mão pequena e estilizada (~0.11 m do punho à ponta do dedo,
# contra ~0.19 m de uma mão humana real). Mantido pequeno para não trair o
# desenho, mas com dedos ainda longos o bastante para receber dois bones cada.
HAND_LEN = 0.062         # palma
HAND_W = 0.058
HAND_T = 0.030           # espessura
FINGER_LEN = 0.048
FINGER_R = 0.0115

# --- Perna ------------------------------------------------------------------
X_HIP = 0.120            # afastamento do eixo da perna no quadril
X_KNEE = 0.175
X_ANKLE = 0.215
R_THIGH_TOP = 0.106
R_THIGH = 0.096
R_KNEE = 0.086
R_CALF = 0.090
R_BOOT_SHAFT = 0.096
R_BOOT_CUFF = 0.112      # dobra larga do cano
R_ANKLE = 0.074

# --- Pé ---------------------------------------------------------------------
FOOT_LEN = 0.290
FOOT_W = 0.115
FOOT_TOE_Y = -0.205      # ponta do pé (frente = -Y)
FOOT_HEEL_Y = 0.085

# --- Cabeça -----------------------------------------------------------------
R_HEAD_X = 0.093         # meia-largura do crânio
R_HEAD_YF = 0.098        # face (frente)
R_HEAD_YB = 0.105        # occipital
R_JAW_X = 0.078
R_CRANIUM_X = 0.091

# --- Chapéu tricórnio -------------------------------------------------------
HAT_CROWN_R = 0.108
HAT_BRIM_R = 0.208       # raio da aba (a peça mais larga da cabeça)
HAT_BRIM_T = 0.016

# --- Cores base (linear, sRGB convertido) -----------------------------------
# Amostradas da referência. Valores em espaço linear para o Principled BSDF.
COL = {
    "skin":        (0.545, 0.305, 0.185),
    "skin_shadow": (0.395, 0.212, 0.126),
    "beard":       (0.055, 0.038, 0.028),
    "brow":        (0.046, 0.031, 0.022),
    "eye_dark":    (0.016, 0.013, 0.011),
    "eye_white":   (0.620, 0.585, 0.545),
    "coat":        (0.046, 0.045, 0.044),   # casaco cinza-carvão
    "coat_light":  (0.098, 0.095, 0.090),   # painéis/facetas claras do casaco
    "hat":         (0.040, 0.039, 0.039),
    "trim":        (0.320, 0.268, 0.175),   # vivos/costuras bege do casaco
    "shirt":       (0.660, 0.605, 0.480),
    "leather":     (0.078, 0.050, 0.030),   # couro escuro (cinto, bandoleira)
    "leather_mid": (0.118, 0.080, 0.048),
    "pants":       (0.082, 0.062, 0.042),
    "boot":        (0.070, 0.048, 0.030),
    "boot_cuff":   (0.145, 0.098, 0.060),
    "sash":        (0.230, 0.040, 0.026),   # faixa vermelho-tijolo
    "metal":       (0.580, 0.580, 0.595),   # fivelas prateadas
    "brass":       (0.400, 0.290, 0.110),   # botões
}


def lerp(a, b, t):
    return a + (b - a) * t
