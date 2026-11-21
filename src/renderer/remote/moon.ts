/**
 * 月相渲染(talking-to-the-moon 原版移植):
 * - Three.js 球体 + moon_color/moon_normal 贴图;
 * - 按真实日期算月相(简化天文算法),太阳平行光随相角走位;
 * - iOS Safari DPR 上限 2(原版同款处理);
 * - speaking 时转速加倍。
 * 改动仅为:TS 化、贴图路径改为 ./assets/moon/、THREE 走 vendor 全局。
 */

declare const THREE: any;

function toJulianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normalizeAngle(deg: number): number {
  while (deg < 0) deg += 360;
  while (deg >= 360) deg -= 360;
  return deg;
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface MoonPhase {
  date: string;
  age: number;
  phaseAngle: number;
  illumination: number;
  name: string;
}

export function getMoonPhase(dateStr: string): MoonPhase {
  const date = new Date(dateStr + 'T12:00:00Z');
  const JD = toJulianDay(date);
  const T = (JD - 2451545.0) / 36525;

  const L0 = normalizeAngle(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = normalizeAngle(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const Mrad = degToRad(M);
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);
  const sunLongitude = normalizeAngle(L0 + C);

  const Lp = normalizeAngle(
    218.3164477 +
      481267.88123421 * T -
      0.0015786 * T * T +
      (T * T * T) / 538841 -
      (T * T * T * T) / 65194000,
  );
  const Mp = normalizeAngle(
    134.9633964 +
      477198.8675055 * T +
      0.0087414 * T * T +
      (T * T * T) / 69699 -
      (T * T * T * T) / 14712000,
  );
  const F = normalizeAngle(
    93.272095 +
      483202.0175233 * T -
      0.0036539 * T * T +
      (T * T * T) / 3526000 +
      (T * T * T * T) / 863310000,
  );
  const D = normalizeAngle(Lp - sunLongitude);

  const Lprad = degToRad(Lp);
  const Mprad = degToRad(Mp);
  const Frad = degToRad(F);
  const Drad = degToRad(D);
  const MradSun = degToRad(M);

  const longitudeMoon = normalizeAngle(
    Lp +
      6.289 * Math.sin(Mprad) +
      1.274 * Math.sin(2 * Drad - Mprad) +
      0.658 * Math.sin(2 * Drad) +
      0.214 * Math.sin(2 * Mprad) -
      0.186 * Math.sin(MradSun) -
      0.114 * Math.sin(2 * Frad),
  );

  const phaseAngle = normalizeAngle(longitudeMoon - sunLongitude);
  const illumination = (1 - Math.cos(degToRad(phaseAngle))) / 2;
  const moonAge = (phaseAngle / 360) * 29.53059;

  return { date: dateStr, age: moonAge, phaseAngle, illumination, name: getPhaseName(moonAge) };
}

function getPhaseName(moonAge: number): string {
  const synodic = 29.53059;
  const a = ((moonAge % synodic) + synodic) % synodic;
  if (a < 1 || a > synodic - 1) return '新月';
  if (a < 6.382) return '蛾眉月';
  if (a < 8.382) return '上弦月';
  if (a < 13.765) return '盈凸月';
  if (a < 15.765) return '满月';
  if (a < 21.147) return '亏凸月';
  if (a < 23.147) return '下弦月';
  return '残月';
}

export class MoonRenderer {
  private container: HTMLElement;
  private scene: any;
  private camera: any;
  private renderer: any;
  private sunLight: any;
  private moonMesh: any = null;
  private isSpeaking = false;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      45,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      1000,
    );
    this.camera.position.set(0, 0, 7.5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    // iOS Safari 性能:DPR 上限 2(原版同款)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.sunLight = new THREE.DirectionalLight(0xfff8e7, 2.4);
    this.scene.add(this.sunLight);

    const ambientLight = new THREE.AmbientLight(0x2a2a35, 0.12);
    this.scene.add(ambientLight);

    const earthshine = new THREE.DirectionalLight(0x6a7a9a, 0.15);
    earthshine.position.set(0, 0, 8);
    this.scene.add(earthshine);

    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  async init(): Promise<void> {
    const loader = new THREE.TextureLoader();
    const [colorMap, normalMap]: [any, any] = await Promise.all([
      new Promise((resolve, reject) =>
        loader.load('./assets/moon/moon_color.jpg', resolve, undefined, () =>
          reject(new Error('Failed to load moon color texture')),
        ),
      ),
      new Promise((resolve, reject) =>
        loader.load('./assets/moon/moon_normal.jpg', resolve, undefined, () =>
          reject(new Error('Failed to load moon normal texture')),
        ),
      ),
    ]);

    colorMap.colorSpace = THREE.SRGBColorSpace;

    const geometry = new THREE.SphereGeometry(2, 128, 128);
    const material = new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.92,
      metalness: 0.02,
      bumpMap: normalMap,
      bumpScale: 0.015,
    });

    this.moonMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.moonMesh);
    this.updateForDate(formatDate(new Date()));
  }

  updateForDate(dateStr: string): MoonPhase {
    const phase = getMoonPhase(dateStr);
    const angle = degToRad(phase.phaseAngle);
    const distance = 8;
    this.sunLight.position.set(distance * Math.sin(angle), 0, -distance * Math.cos(angle));
    return phase;
  }

  setSpeaking(speaking: boolean): void {
    this.isSpeaking = speaking;
  }

  private resize(): void {
    this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());
    if (this.moonMesh) {
      this.moonMesh.rotation.y += this.isSpeaking ? 0.003 : 0.001;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
