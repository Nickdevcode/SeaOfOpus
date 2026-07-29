/**
 * A câmera: converte a pose do jogador (local, no navio) em pose de mundo.
 *
 * O detalhe que decide se o jogo parece sólido ou barato está numa linha só:
 * o rig lê `ship.model.root`, e **não** `ship.body`. O corpo guarda a pose do
 * último passo de física, a 60 Hz; o modelo guarda a pose interpolada pelo
 * `alpha` do frame. Compor a câmera com o corpo enquanto o convés é desenhado
 * com o modelo faz o navio inteiro tremer diante dos olhos do jogador em telas
 * de 144 Hz — um jitter de milímetros que não some com nenhuma suavização.
 *
 * A troca de estação (convés → timão → canhão) é interpolada **em coordenadas
 * locais**, não no mundo: durante a transição o navio continua jogando na onda,
 * e o que se quer é a cabeça andando pelo convés, não a câmera se soltando dele.
 */

import * as THREE from 'three';
import { damp } from '../core/MathUtils';
import type { Ship } from '../ship/Ship';
import type { PlayerController } from './PlayerController';

export type CameraMode = 'player' | 'cinematic' | 'detached';

/**
 * Duração da transição ao assumir ou largar uma estação, em segundos.
 *
 * Exportada porque o corpo do jogador tem de percorrer o mesmo caminho no mesmo
 * tempo: em primeira pessoa, câmera e corpo que chegam ao timão em instantes
 * diferentes leem como o personagem andando sozinho na direção do jogador. Ver
 * `PlayerAvatar`.
 */
export const STATION_BLEND = 0.28;
/** Convergência do campo de visão, em 1/s. */
const FOV_LAMBDA = 9;

/** Órbita do menu: raio, altura e velocidade angular. */
const CINEMATIC_RADIUS = 26;
const CINEMATIC_HEIGHT = 7.5;
const CINEMATIC_SPEED = 0.055;
const CINEMATIC_LOOK_Y = 5.5;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _target = new THREE.Vector3();

export class CameraRig {
  mode: CameraMode = 'player';

  private readonly blendPosition = new THREE.Vector3();
  private readonly blendQuaternion = new THREE.Quaternion();
  /** 1 = transição terminada. Começa pronto para o primeiro frame não saltar. */
  private blend = 1;
  private lastStationChange = -1;

  private cinematicAngle = 0.6;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  /** Volta a câmera para os olhos do jogador. */
  attachPlayer(): void {
    this.mode = 'player';
    this.blend = 1;
    this.lastStationChange = -1;
  }

  /** Órbita cinematográfica em volta do navio — o fundo do menu. */
  cinematic(): void {
    this.mode = 'cinematic';
  }

  /** Solta a câmera: quem quiser posicionar escreve nela direto (bancada DEV). */
  detach(): void {
    this.mode = 'detached';
  }

  update(dt: number, player: PlayerController, ship: Ship): void {
    if (this.mode === 'detached') return;
    if (this.mode === 'cinematic') {
      this.updateCinematic(dt, ship);
      return;
    }

    this.updateStationBlend(dt, player);

    // A pose visual do navio, interpolada. `localToWorld` já atualiza a matriz
    // de mundo do modelo, então não há um frame de atraso aqui.
    ship.model.root.localToWorld(_position.copy(this.blendPosition));
    _quaternion.copy(ship.model.root.quaternion).multiply(this.blendQuaternion);

    this.camera.position.copy(_position);
    this.camera.quaternion.copy(_quaternion);

    this.updateFov(dt, player.fov);
  }

  private updateStationBlend(dt: number, player: PlayerController): void {
    if (player.stationChangeCount !== this.lastStationChange) {
      // Primeira vez (spawn) não tem de onde vir: começa já no lugar.
      this.blend = this.lastStationChange < 0 ? 1 : 0;
      this.lastStationChange = player.stationChangeCount;
      if (this.blend === 1) {
        this.blendPosition.copy(player.eyeLocal);
        this.blendQuaternion.copy(player.eyeQuaternion);
        return;
      }
    }

    if (this.blend >= 1) {
      this.blendPosition.copy(player.eyeLocal);
      this.blendQuaternion.copy(player.eyeQuaternion);
      return;
    }

    this.blend = Math.min(this.blend + dt / STATION_BLEND, 1);
    // Suavização de entrada e saída: linear puro denuncia o começo e o fim do
    // movimento, e uma câmera que "liga e desliga" lê como corte, não como passo.
    const s = this.blend * this.blend * (3 - 2 * this.blend);
    this.blendPosition.lerp(player.eyeLocal, s);
    this.blendQuaternion.slerp(player.eyeQuaternion, s);
  }

  private updateCinematic(dt: number, ship: Ship): void {
    this.cinematicAngle += dt * CINEMATIC_SPEED;

    const origin = ship.model.root.position;
    this.camera.position.set(
      origin.x + Math.sin(this.cinematicAngle) * CINEMATIC_RADIUS,
      origin.y + CINEMATIC_HEIGHT,
      origin.z + Math.cos(this.cinematicAngle) * CINEMATIC_RADIUS,
    );
    _target.set(origin.x, origin.y + CINEMATIC_LOOK_Y, origin.z);
    this.camera.lookAt(_target);

    this.updateFov(dt, 48);
  }

  private updateFov(dt: number, target: number): void {
    const next = damp(this.camera.fov, target, FOV_LAMBDA, dt);
    // Recompor a matriz de projeção custa; abaixo de um décimo de grau ninguém
    // vê a diferença, e assim ela só é refeita durante o zoom de mira.
    if (Math.abs(next - this.camera.fov) < 0.01) return;
    this.camera.fov = next;
    this.camera.updateProjectionMatrix();
  }
}
