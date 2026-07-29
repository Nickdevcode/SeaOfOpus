/// <reference types="vite/client" />

/**
 * As variáveis de ambiente que o jogo lê.
 *
 * ⚠️ O Vite **embute** estes valores no pacote durante o `build`, e não os lê em
 * tempo de execução. Trocar a URL do servidor de sala na hospedagem exige um build
 * novo — republicar o mesmo artefato mantém o valor antigo lá dentro.
 */
interface ImportMetaEnv {
  /**
   * Servidor de sala do duelo em rede: `ws://127.0.0.1:8787` em desenvolvimento,
   * `wss://<worker>.workers.dev` publicado.
   *
   * Ausente, o modo online nasce apagado com o motivo na tela — ver
   * `Menu.setOnlineAvailable`. É de propósito: um jogo que abre normal e só falha
   * depois de dois cliques é pior que um que diz na primeira tela o que falta.
   */
  readonly VITE_ROOM_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
