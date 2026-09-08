"""Passer d'un modele qui continue du texte a un modele qui repond.

Un modele pre-entraine ne fait que prolonger ce qu'on lui donne. Pour qu'il
reponde a des instructions, il faut un second entrainement, plus court, sur
des paires demande/reponse : c'est l'ajustement par instructions (SFT).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from .config import TrainConfig
from .model import Transformer
from .tokenizer import Tokenizer
from .train import choisir_device, construire_optimiseur, sauvegarder, taux_apprentissage

Message = dict[str, str]


def format_dialogue(messages: list[Message], amorcer_reponse: bool = True) -> str:
    """Met un dialogue au format que le modele apprend a reconnaitre."""
    morceaux: list[str] = []
    for message in messages:
        role = message.get("role", "user")
        contenu = (message.get("content") or "").strip()
        balise = {"system": "<|system|>", "assistant": "<|assistant|>"}.get(role, "<|user|>")
        morceaux.append(f"{balise}{contenu}<|eos|>")
    if amorcer_reponse:
        morceaux.append("<|assistant|>")
    return "".join(morceaux)


def charger_exemples(chemin: str | Path) -> list[list[Message]]:
    """Lit un JSONL d'exemples : {"messages": [{"role", "content"}, ...]}."""
    dialogues: list[list[Message]] = []
    for ligne in Path(chemin).read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if not ligne:
            continue
        donnees = json.loads(ligne)
        messages = donnees["messages"] if "messages" in donnees else donnees
        if isinstance(messages, list) and messages:
            dialogues.append(messages)
    if not dialogues:
        raise ValueError("aucun exemple exploitable dans le fichier")
    return dialogues


def encoder_exemple(
    dialogue: list[Message], tokenizer: Tokenizer, block_size: int
) -> tuple[list[int], list[int]] | None:
    """Encode un dialogue en (entree, cible).

    Seuls les jetons de la reponse comptent dans la perte : le modele n'a pas
    a apprendre a predire la question qu'on lui pose.
    """
    entree: list[int] = []
    cible: list[int] = []

    for message in dialogue:
        role = message.get("role", "user")
        contenu = (message.get("content") or "").strip()
        balise = {"system": "<|system|>", "assistant": "<|assistant|>"}.get(role, "<|user|>")

        jetons_balise = tokenizer.encode(balise)
        jetons_contenu = tokenizer.encode(contenu, autoriser_speciaux=False)
        fin = [tokenizer.eos_id]

        entree.extend(jetons_balise + jetons_contenu + fin)
        if role == "assistant":
            # -100 = ignore par la fonction de perte.
            cible.extend([-100] * len(jetons_balise) + jetons_contenu + fin)
        else:
            cible.extend([-100] * (len(jetons_balise) + len(jetons_contenu) + 1))

    if all(c == -100 for c in cible):
        return None  # aucun jeton a apprendre

    entree = entree[:block_size]
    cible = cible[:block_size]
    # La cible est decalee : on predit le jeton suivant.
    return entree[:-1], cible[1:]


def preparer_lots(
    dialogues: list[list[Message]], tokenizer: Tokenizer, block_size: int
) -> tuple[np.ndarray, np.ndarray]:
    """Encode et rembourre tous les exemples en deux tableaux rectangulaires."""
    encodes = [e for d in dialogues if (e := encoder_exemple(d, tokenizer, block_size))]
    if not encodes:
        raise ValueError("aucun exemple ne contient de reponse a apprendre")

    longueur = max(len(x) for x, _ in encodes)
    entrees = np.full((len(encodes), longueur), tokenizer.pad_id, dtype=np.int64)
    cibles = np.full((len(encodes), longueur), -100, dtype=np.int64)

    for i, (x, y) in enumerate(encodes):
        entrees[i, : len(x)] = x
        cibles[i, : len(y)] = y
    return entrees, cibles


def ajuster(
    modele: Transformer,
    tokenizer: Tokenizer,
    dialogues: list[list[Message]],
    cfg: TrainConfig,
    sortie: str | Path,
) -> dict[str, float]:
    """Ajuste le modele sur des exemples de dialogue."""
    device = choisir_device(cfg.device)
    torch.manual_seed(cfg.seed)
    modele = modele.to(device).train()

    entrees, cibles = preparer_lots(dialogues, tokenizer, modele.cfg.block_size)
    x_tous = torch.from_numpy(entrees)
    y_tous = torch.from_numpy(cibles)
    n = len(x_tous)

    optimiseur = construire_optimiseur(modele, cfg)
    generateur = torch.Generator().manual_seed(cfg.seed)
    derniere = float("nan")

    print(f"ajustement sur {n} exemples, {cfg.max_steps} etapes", flush=True)

    for etape in range(cfg.max_steps):
        lr = taux_apprentissage(etape, cfg)
        for groupe in optimiseur.param_groups:
            groupe["lr"] = lr

        indices = torch.randint(n, (min(cfg.batch_size, n),), generator=generateur)
        x = x_tous[indices].to(device)
        y = y_tous[indices].to(device)

        optimiseur.zero_grad(set_to_none=True)
        _, perte, _ = modele(x, y)
        perte.backward()
        if cfg.grad_clip > 0:
            torch.nn.utils.clip_grad_norm_(modele.parameters(), cfg.grad_clip)
        optimiseur.step()
        derniere = float(perte.item())

        if etape % 10 == 0 or etape == cfg.max_steps - 1:
            print(f"etape {etape:>5}/{cfg.max_steps}  perte {derniere:.4f}  lr {lr:.2e}", flush=True)

    chemin = Path(sortie) / "chat.pt"
    sauvegarder(chemin, modele, optimiseur, cfg.max_steps, derniere)
    return {"exemples": n, "etapes": cfg.max_steps, "perte_finale": derniere}
