"""Ponto de entrada: reconstrói a tábua inteira do zero, de cabeça vazia.

    blender.exe --background --python Props/Plank/scripts/build_all.py

Sem argumento, roda tudo: geometria, materiais, atlas, previews e export.
Com `-- <etapa> [<etapa> ...]` roda só o que se pedir, na ordem em que aparecem:

    ... --python build_all.py -- geo mat
    ... --python build_all.py -- preview

⚠️ **Sempre headless.** Existe uma instância de GUI do Blender aberta no projeto
com o personagem; nada aqui pode encostar nela. Por isso a primeira coisa que o
script faz é `read_factory_settings(use_empty=True)` — o processo começa de uma
cena vazia que ele mesmo criou, e não do que estivesse na tela de alguém.

O pipeline inteiro roda em ~1 minuto (quase tudo é o Cycles dos previews).
"""

import json
import os
import sys
import time

import bpy

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import build_plank  # noqa: E402
import plank_export  # noqa: E402
import plank_finalize  # noqa: E402
import plank_materials  # noqa: E402
import plank_preview  # noqa: E402

STEPS = ["geo", "mat", "atlas", "preview", "export"]


def _geo():
    return build_plank.run()


def _mat():
    return plank_materials.apply_materials()


def _atlas():
    return plank_finalize.run()


def _preview():
    return plank_preview.run()


def _export():
    return plank_export.run()


RUNNERS = {"geo": _geo, "mat": _mat, "atlas": _atlas,
           "preview": _preview, "export": _export}


def run(steps=None):
    # Cena limpa garantida, e não herdada — é o contrato de idempotência.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    steps = steps or STEPS
    report = {}
    for step in steps:
        started = time.perf_counter()
        report[step] = RUNNERS[step]()
        report[f"{step}_s"] = round(time.perf_counter() - started, 2)
        print(f"[plank] {step} ok em {report[f'{step}_s']}s")
    return report


def _args():
    if "--" not in sys.argv:
        return None
    wanted = sys.argv[sys.argv.index("--") + 1:]
    unknown = [w for w in wanted if w not in RUNNERS]
    if unknown:
        raise SystemExit(f"etapa desconhecida: {unknown}. Válidas: {STEPS}")
    return wanted or None


if __name__ == "__main__":
    result = run(_args())
    print("=== RELATÓRIO ===")
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
