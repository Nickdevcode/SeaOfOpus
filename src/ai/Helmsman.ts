/**
 * O timoneiro bot: mantém um rumo comandado girando a mesma roda que o jogador.
 *
 * **O problema não é trivial, e vale dizer por quê.** A roda da Chalupa não é um
 * volante: a entrada de `Rudder` é *taxa de giro*, e o ângulo é estado que fica
 * onde foi deixado (ver `Rudder.ts`). Ligar um controlador direto do erro de rumo
 * na entrada da roda cria dois integradores em série — a roda integra o comando e
 * o casco integra a guinada. Sistema de segunda ordem com ganho puro oscila
 * *sempre*, e o navio sairia costurando o rumo para todo lado.
 *
 * A saída é a dos pilotos automáticos de verdade, e é uma malha em cascata:
 *
 * 1. **Fora**, um PD sobre o erro de rumo decide um **ângulo de roda** — não uma
 *    taxa. É o "meia volta a bombordo" que um timoneiro humano ouve e executa.
 * 2. **Dentro**, a roda é levada até esse ângulo o mais rápido que o batente
 *    permite. Uma conta, sem ganho para ajustar.
 *
 * Com a roda virando posição comandada, o único integrador que sobra é o casco, e
 * um PD estabiliza isso sem drama.
 *
 * **Por que não a classe `PID` de `MathUtils`.** Ela deriva o erro numericamente,
 * e a derivada do rumo é justamente a grandeza que o corpo rígido *já mede*:
 * `angularVelocity.y`. Diferenciar um sinal que se tem exato é trocar precisão por
 * ruído de graça. O termo integral também não entra: o único desvio permanente é
 * o leme de sota de ~0,08°/s que `SailSim` documenta, e o termo proporcional o
 * segura com menos de 1° de erro de rumo. Menos código, e nenhum risco de windup
 * deixando a roda grudada no batente.
 *
 * ## O sinal, que é onde se erra
 *
 * `heading` é rotação em torno de **+Y**, e girar em +Y leva a proa (−Z) para −X,
 * que é **bombordo**. Então rumo crescente é guinar para a esquerda, e o comando
 * de roda positivo (boreste, por `Rudder`) faz o rumo **diminuir**. Todo sinal
 * daqui vem disso, e trocar um deles faz o navio fugir do rumo em vez de buscá-lo
 * — girando cada vez mais rápido, porque a realimentação passa a ser positiva.
 */

import { WHEEL_RATE, MAX_WHEEL } from '../ship/Rudder';
import { angleDelta, clamp } from '../core/MathUtils';
import type { Ship } from '../ship/Ship';

/**
 * Ganho proporcional: radianos de roda por radiano de erro de rumo.
 *
 * 8 põe a roda no batente (π) com 22° de erro. Acima disso o navio já está
 * fazendo tudo que o leme dá, então ganho maior não viraria mais rápido — só
 * atrasaria a saída da curva.
 */
const HELM_KP = 8;

/**
 * Ganho derivativo: radianos de roda por rad/s de guinada.
 *
 * É o freio da curva. Numa guinada carregada a Chalupa gira a ~0,13 rad/s, o que
 * aqui vale 1,4 rad de roda contrária — o suficiente para ela chegar no rumo e
 * parar, em vez de passar dele e voltar. Com 6 o navio derrapa uns 8° além do
 * rumo a cada correção grande; com 20 ele fica preguiçoso e nunca fecha uma curva
 * apertada em tempo de combate.
 */
const HELM_KD = 11;

/**
 * Erro de rumo abaixo do qual o timoneiro considera o navio "no rumo".
 *
 * 4°. Serve ao capitão, não ao controle: é o que decide se já dá para abrir fogo
 * ou se ainda se está fechando a manobra.
 */
const ON_COURSE = 0.07;

export class Helmsman {
  /** Rumo comandado, em radianos, na mesma medida de `Ship.heading`. */
  course = 0;

  /** Erro de rumo do último passo, em radianos. Telemetria e decisão tática. */
  error = 0;

  /** Ângulo de roda que o timoneiro está pedindo. Só telemetria. */
  commandedWheel = 0;

  /** `true` quando a proa já está praticamente no rumo pedido. */
  get onCourse(): boolean {
    return Math.abs(this.error) < ON_COURSE;
  }

  /** Mesmo comando de rumo, dado como uma direção a seguir. */
  setCourse(heading: number): void {
    this.course = heading;
  }

  /**
   * Um passo de governo. Escreve `ship.controls.wheel` e nada mais.
   *
   * @param gain multiplicador de perícia: o grumete corrige mole, a lenda seca.
   */
  update(dt: number, ship: Ship, gain = 1): void {
    this.error = angleDelta(ship.heading, this.course);

    // Guinada medida no eixo do mundo. Rigorosamente a taxa de *rumo* é a
    // projeção de ω no eixo local de guinada, e não `y` puro; com o navio
    // adernado 10° a diferença é 1,5%, bem abaixo do que o ganho derivativo
    // pretende resolver.
    const yawRate = ship.body.angularVelocity.y;

    // Malha externa: PD → ângulo de roda desejado. O sinal negativo no erro é a
    // convenção documentada no topo (roda positiva baixa o rumo).
    const desired = clamp((-HELM_KP * this.error + HELM_KD * yawRate) * gain, -MAX_WHEEL, MAX_WHEEL);
    this.commandedWheel = desired;

    // Malha interna: leva a roda até lá o mais rápido que o batente aguenta. Sem
    // o `dt` no denominador o comando dependeria da taxa de passo, e um `dt`
    // pequeno faria a roda arrastar.
    const room = WHEEL_RATE * dt;
    ship.controls.wheel =
      room > 1e-9 ? clamp((desired - ship.rudder.wheelAngle) / room, -1, 1) : 0;
  }

  /** Larga o timão: roda parada, sem tentar corrigir nada. */
  release(ship: Ship): void {
    ship.controls.wheel = 0;
    this.error = 0;
    this.commandedWheel = 0;
  }
}
