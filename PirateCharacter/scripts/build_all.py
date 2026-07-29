"""Orquestrador: reconstrói o personagem inteiro do zero, de forma idempotente."""

import importlib

import piratelib
import proportions
import build_body
import build_head
import build_gear

MODULES = (piratelib, proportions, build_body, build_head, build_gear)


def run(reload=True):
    if reload:
        for m in MODULES:
            importlib.reload(m)
    stats = {}
    stats["body"] = build_body.run()      # purge_scene acontece aqui
    stats["head"] = build_head.run()
    stats["gear"] = build_gear.run()
    stats["total_tris"] = sum(sum(g.values()) for g in
                              (stats["body"], stats["head"], stats["gear"]))
    stats["objects"] = len(piratelib.bpy.data.collections["Pirate"].objects)
    return stats
