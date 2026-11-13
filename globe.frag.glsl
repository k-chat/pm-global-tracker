// Globe fragment shader — an original implementation for an eclipse-atlas style globe.
// Layers: ocean tint, land mask, graticule, one soft penumbra wash, atmosphere rim.
// Eclipse corridors themselves are expected to be drawn as separate line geometry on top.

precision highp float;

varying vec3 vObjPos;
varying vec3 vViewNormal;
varying vec3 vViewDir;

uniform sampler2D uLandMask;   // equirectangular, land = white, sea = black
uniform vec3  uOcean;          // e.g. vec3(0.04, 0.06, 0.10)
uniform vec3  uLand;           // e.g. vec3(0.12, 0.15, 0.20)
uniform vec3  uGrid;           // graticule colour
uniform vec3  uRim;            // atmosphere colour
uniform float uGridStep;       // degrees between graticule lines, e.g. 15.0
uniform float uGridAlpha;      // 0..1
uniform float uRimPower;       // e.g. 3.0

// Partial-eclipse penumbra wash: a soft disc on the globe, composited like CSS "screen".
uniform vec3  uPenumbraCenter; // unit vector, object space (point of greatest eclipse)
uniform float uPenumbraRadius; // angular radius in radians (0.0 disables)
uniform vec3  uPenumbraColor;
uniform float uPenumbraAlpha;

const float PI = 3.14159265359;

vec2 lonLat(vec3 p) {
  float lon = atan(p.x, p.z);          // -PI..PI
  float lat = asin(clamp(p.y, -1.0, 1.0));
  return vec2(lon, lat);
}

// Anti-aliased line on a periodic coordinate, width in screen pixels.
float gridLine(float coord, float stepRad) {
  float x = coord / stepRad;
  float d = abs(fract(x - 0.5) - 0.5) / fwidth(x);
  return 1.0 - clamp(d - 0.5, 0.0, 1.0);
}

vec3 screenBlend(vec3 base, vec3 top, float a) {
  vec3 s = 1.0 - (1.0 - base) * (1.0 - top);
  return mix(base, s, a);
}

void main() {
  vec3 p = normalize(vObjPos);
  vec2 ll = lonLat(p);

  // Base: ocean / land
  vec2 uv = vec2(ll.x / (2.0 * PI) + 0.5, ll.y / PI + 0.5);
  float land = smoothstep(0.35, 0.65, texture2D(uLandMask, uv).r);
  vec3 col = mix(uOcean, uLand, land);

  // Graticule (fade out toward the poles where meridians converge)
  float step = radians(uGridStep);
  float poleFade = smoothstep(1.45, 1.1, abs(ll.y));
  float g = max(gridLine(ll.x, step) * poleFade, gridLine(ll.y, step));
  col = mix(col, uGrid, g * uGridAlpha);

  // Penumbra wash with a soft edge
  if (uPenumbraRadius > 0.0) {
    float ang = acos(clamp(dot(p, normalize(uPenumbraCenter)), -1.0, 1.0));
    float wash = 1.0 - smoothstep(uPenumbraRadius * 0.55, uPenumbraRadius, ang);
    col = screenBlend(col, uPenumbraColor, wash * uPenumbraAlpha);
  }

  // Gentle limb darkening so the sphere reads as a ball
  float ndv = clamp(dot(normalize(vViewNormal), normalize(vViewDir)), 0.0, 1.0);
  col *= mix(0.55, 1.0, pow(ndv, 0.6));

  // Atmosphere rim (fresnel)
  float rim = pow(1.0 - ndv, uRimPower);
  col += uRim * rim;

  gl_FragColor = vec4(col, 1.0);
}
