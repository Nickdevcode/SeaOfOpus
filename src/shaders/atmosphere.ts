/**
 * Atmospheric scattering (Rayleigh + Mie) by numerical integration.
 *
 * It is the same physical model that gives noon's blue, the sunset's red and the halo
 * around the sun — with no hand-painted color table. The real cost is too high to run per
 * screen pixel, so it is evaluated once per frame into a small equirectangular LUT (see
 * `Sky.ts`); the sky dome and the ocean's reflection only sample that LUT, which keeps
 * both perfectly consistent and cheap.
 */

/**
 * Equirectangular ↔ direction mapping.
 *
 * It is kept apart from the atmospheric model because the ocean only needs to read the
 * LUT — dragging the raymarch along would only fatten the sea shader's compilation.
 */
export const EQUIRECT_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

/** Converts a direction into equirectangular UV (to read/write the LUT). */
vec2 directionToEquirect(vec3 dir) {
  return vec2(
    atan(dir.z, dir.x) / (2.0 * PI) + 0.5,
    acos(clamp(dir.y, -1.0, 1.0)) / PI
  );
}

/** The inverse of \`directionToEquirect\`. */
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
// Rayleigh scattering coefficients per channel (red scatters less, blue scatters more —
// it is literally why the sky is blue).
const vec3 RAYLEIGH_COEFF = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float MIE_COEFF = 21e-6;
const float RAYLEIGH_SCALE_HEIGHT = 8e3;
const float MIE_SCALE_HEIGHT = 1.2e3;
// Mie asymmetry: positive concentrates the scattering forward, creating the diffuse glow
// around the sun.
const float MIE_G = 0.758;

const int PRIMARY_STEPS = 12;
const int LIGHT_STEPS = 4;

// Ceiling on the optical depth along the view ray.
//
// This is a single-scattering model: each photon scatters once and the rest is
// extinction. Near the horizon the ray crosses hundreds of kilometers of air, the
// extinction kills the blue and the sky comes out caramel-colored at noon — when in
// reality it is a pale bluish white. What is missing is multiple scattering: the air does
// not absorb light, it redistributes it, so the long column gives back by scattering
// everything it takes away by extinction.
//
// Capping the view path's extinction captures that balance at zero cost. The sunlight
// (lightDepth) stays uncapped, so the red sunset — which comes precisely from grazing
// sunlight — is left intact.
//
// The value was calibrated at both ends: too low (1.35) gives back enough residual blue
// to wash the sunset out and leave it silvery; too high brings the caramel back at
// noon.
const vec3 MAX_VIEW_DEPTH = vec3(2.4);

/** Ray-sphere intersection centered at the origin. Returns (near, far). */
vec2 raySphereIntersect(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e5, -1e5);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

/**
 * The sky's radiance in the direction rayDir for a sun at sunDir.
 * sunIntensity controls the overall brightness (used to darken at night).
 */
vec3 atmosphere(vec3 rayDir, vec3 sunDir, float sunIntensity) {
  // Observer at sea level, 1 m above the planet's surface.
  vec3 origin = vec3(0.0, PLANET_RADIUS + 1.0, 0.0);

  vec2 hit = raySphereIntersect(origin, rayDir, ATMOSPHERE_RADIUS);
  if (hit.x > hit.y) return vec3(0.0);

  // Rays that hit the planet stop at the surface.
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
  // Rayleigh and Henyey-Greenstein (Mie) phases.
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

    // Second integration: how much sunlight survives as far as this point.
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
 * The night sky's floor.
 *
 * The scattering above needs a light source; with the sun set and the moon absent it
 * returns zero and the sky becomes absolute black, which never happens in reality. What
 * is left on a moonless night is airglow (the air itself emitting, at ~90 km), zodiacal
 * light and the sum of the stars too faint to be counted one by one. All of it rises
 * toward the horizon, where the air column is longest — the same reason the day brightens
 * there.
 *
 * The moon's light does not come in here: it is a real directional source and goes
 * through the same \`atmosphere\` as the sun, only with a minute intensity. That is what
 * makes the bluish halo around it appear on its own.
 */
vec3 nightGlow(vec3 dir) {
  float horizonLift = pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.0);
  return vec3(0.0016, 0.0026, 0.0052) * (0.6 + horizonLift * 1.1);
}
`;
