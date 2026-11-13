// Globe vertex shader (WebGL / three.js ShaderMaterial)
// Passes object-space position (for lat/long lookups) and view-space data (for rim light).

varying vec3 vObjPos;     // unit-sphere position, rotates with the globe
varying vec3 vViewNormal; // normal in view space
varying vec3 vViewDir;    // direction from surface to camera, view space

void main() {
  vObjPos = normalize(position);

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);

  gl_Position = projectionMatrix * mv;
}
