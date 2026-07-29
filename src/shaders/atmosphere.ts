/**
 * Espalhamento atmosférico (Rayleigh + Mie) por integração numérica.
 *
 * É o mesmo modelo físico que dá o azul do meio-dia, o vermelho do poente e o
 * halo em volta do sol — sem tabela de cores pintada à mão. O custo real é
 * alto para rodar por pixel de tela, então ele é avaliado uma vez por frame
 * numa LUT equirretangular pequena (ver `Sky.ts`); o domo do céu e o reflexo
 * do oceano apenas amostram essa LUT, o que mantém os dois perfeitamente
 * coerentes e baratos.
 */

/**
 * Mapeamento equirretangular ↔ direção.
 *
 * Fica separado do modelo atmosférico porque o oceano precisa apenas ler a LUT
 * — arrastar o raymarch junto só engordaria a compilação do shader do mar.
 */
export const EQUIRECT_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

/** Converte uma direção em UV equirretangular (para ler/escrever a LUT). */
vec2 directionToEquirect(vec3 dir) {
  return vec2(
    atan(dir.z, dir.x) / (2.0 * PI) + 0.5,
    acos(clamp(dir.y, -1.0, 1.0)) / PI
  );
}

/** Inverso de \`directionToEquirect\`. */
vec3 equirectToDirection(vec2 uv) {
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float theta = uv.y * PI;
  float sinTheta = sin(theta);
  return vec3(sinTheta * cos(phi), cos(theta), sinTheta * sin(phi));
}
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

const float PLANET_RADIUS = 6371e3;
const float ATMOSPHERE_RADIUS = 6471e3;
// Coeficientes de espalhamento de Rayleigh por canal (vermelho espalha menos,
// azul espalha mais — é literalmente por isso que o céu é azul).
const vec3 RAYLEIGH_COEFF = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float MIE_COEFF = 21e-6;
const float RAYLEIGH_SCALE_HEIGHT = 8e3;
const float MIE_SCALE_HEIGHT = 1.2e3;
// Assimetria de Mie: positivo concentra o espalhamento para frente, criando o
// brilho difuso em torno do sol.
const float MIE_G = 0.758;

const int PRIMARY_STEPS = 12;
const int LIGHT_STEPS = 4;

// Teto da profundidade óptica ao longo do raio de visão.
//
// Este é um modelo de espalhamento simples: cada fóton espalha uma vez e o
// resto é extinção. Perto do horizonte o raio atravessa centenas de
// quilômetros de ar, a extinção mata o azul e o céu sai cor de caramelo ao
// meio-dia — quando na realidade ele é branco-azulado pálido. O que falta é o
// espalhamento múltiplo: o ar não absorve luz, ele a redistribui, então a
// coluna longa devolve por espalhamento tudo o que tira por extinção.
//
// Limitar a extinção do trajeto de visão captura esse equilíbrio a custo zero.
// A luz do sol (lightDepth) continua sem teto, então o poente vermelho — que
// vem justamente da luz solar rasante — fica intacto.
// O valor foi calibrado nas duas pontas: baixo demais (1.35) devolve azul
// residual suficiente para lavar o poente e deixá-lo prateado; alto demais
// traz o caramelo de volta ao meio-dia.
const vec3 MAX_VIEW_DEPTH = vec3(2.4);

/** Interseção raio-esfera centrada na origem. Retorna (near, far). */
vec2 raySphereIntersect(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e5, -1e5);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

/**
 * Radiância do céu na direção rayDir para um sol em sunDir.
 * sunIntensity controla o brilho geral (usado para escurecer à noite).
 */
vec3 atmosphere(vec3 rayDir, vec3 sunDir, float sunIntensity) {
  // Observador ao nível do mar, 1 m acima da superfície do planeta.
  vec3 origin = vec3(0.0, PLANET_RADIUS + 1.0, 0.0);

  vec2 hit = raySphereIntersect(origin, rayDir, ATMOSPHERE_RADIUS);
  if (hit.x > hit.y) return vec3(0.0);

  // Raios que batem no planeta param na superfície.
  vec2 planetHit = raySphereIntersect(origin, rayDir, PLANET_RADIUS);
  if (planetHit.x > 0.0) hit.y = min(hit.y, planetHit.x);

  float stepSize = (hit.y - max(hit.x, 0.0)) / float(PRIMARY_STEPS);
  float rayTime = max(hit.x, 0.0);

  vec3 totalRayleigh = vec3(0.0);
  vec3 totalMie = vec3(0.0);
  float opticalDepthR = 0.0;
  float opticalDepthM = 0.0;

  float mu = dot(rayDir, sunDir);
  float mumu = mu * mu;
  float gg = MIE_G * MIE_G;
  // Fases de Rayleigh e Henyey-Greenstein (Mie).
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mumu);
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) /
                 (pow(1.0 + gg - 2.0 * mu * MIE_G, 1.5) * (2.0 + gg));

  for (int i = 0; i < PRIMARY_STEPS; i++) {
    vec3 samplePos = origin + rayDir * (rayTime + stepSize * 0.5);
    float height = length(samplePos) - PLANET_RADIUS;

    float hr = exp(-height / RAYLEIGH_SCALE_HEIGHT) * stepSize;
    float hm = exp(-height / MIE_SCALE_HEIGHT) * stepSize;
    opticalDepthR += hr;
    opticalDepthM += hm;

    // Segunda integração: quanta luz do sol sobrevive até este ponto.
    vec2 lightHit = raySphereIntersect(samplePos, sunDir, ATMOSPHERE_RADIUS);
    float lightStep = lightHit.y / float(LIGHT_STEPS);
    float lightTime = 0.0;
    float lightDepthR = 0.0;
    float lightDepthM = 0.0;

    for (int j = 0; j < LIGHT_STEPS; j++) {
      vec3 lightPos = samplePos + sunDir * (lightTime + lightStep * 0.5);
      float lightHeight = length(lightPos) - PLANET_RADIUS;
      lightDepthR += exp(-lightHeight / RAYLEIGH_SCALE_HEIGHT) * lightStep;
      lightDepthM += exp(-lightHeight / MIE_SCALE_HEIGHT) * lightStep;
      lightTime += lightStep;
    }

    vec3 viewDepth = min(
      MIE_COEFF * opticalDepthM + RAYLEIGH_COEFF * opticalDepthR,
      MAX_VIEW_DEPTH
    );
    vec3 attenuation = exp(
      -(viewDepth + MIE_COEFF * lightDepthM + RAYLEIGH_COEFF * lightDepthR)
    );

    totalRayleigh += hr * attenuation;
    totalMie += hm * attenuation;
    rayTime += stepSize;
  }

  return sunIntensity * (phaseR * RAYLEIGH_COEFF * totalRayleigh + phaseM * MIE_COEFF * totalMie);
}

/**
 * O piso do céu noturno.
 *
 * O espalhamento acima precisa de uma fonte de luz; com o sol posto e a lua
 * ausente ele devolve zero e o céu vira preto absoluto, o que nunca acontece de
 * verdade. O que sobra numa noite sem lua é airglow (o próprio ar emitindo, a
 * ~90 km), luz zodiacal e a soma das estrelas fracas demais para serem contadas
 * uma a uma. Tudo isso sobe na direção do horizonte, onde a coluna de ar é mais
 * longa — o mesmo motivo de o dia clarear ali.
 *
 * A luz da lua não entra aqui: ela é uma fonte direcional de verdade e vai pelo
 * mesmo \`atmosphere\` do sol, só que com intensidade ínfima. É o que faz o halo
 * azulado em volta dela aparecer sozinho.
 */
vec3 nightGlow(vec3 dir) {
  float horizonLift = pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.0);
  return vec3(0.0016, 0.0026, 0.0052) * (0.6 + horizonLift * 1.1);
}
`;
