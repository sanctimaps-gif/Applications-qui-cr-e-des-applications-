"""La boucle d'entrainement : c'est ici que le modele apprend.

Rien d'exotique, mais rien d'omis non plus : AdamW avec decroissance de poids
selective, echauffement puis decroissance cosinus, accumulation de gradient,
ecretage, precision mixte, reprise sur point de sauvegarde.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Callable

import torch

from .config import ModelConfig, TrainConfig
from .data import Dataset
from .model import Transformer


def choisir_device(demande: str = "auto") -> torch.device:
    if demande != "auto":
        return torch.device(demande)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def construire_optimiseur(modele: Transformer, cfg: TrainConfig) -> torch.optim.Optimizer:
    """AdamW, avec decroissance de poids sur les matrices seulement.

    Appliquer la decroissance aux biais et aux gains de normalisation degrade
    l'entrainement : ce sont des parametres d'echelle, pas des poids.
    """
    decroissants, constants = [], []
    for parametre in modele.parameters():
        if not parametre.requires_grad:
            continue
        (decroissants if parametre.dim() >= 2 else constants).append(parametre)

    return torch.optim.AdamW(
        [
            {"params": decroissants, "weight_decay": cfg.weight_decay},
            {"params": constants, "weight_decay": 0.0},
        ],
        lr=cfg.learning_rate,
        betas=(cfg.beta1, cfg.beta2),
    )


def taux_apprentissage(etape: int, cfg: TrainConfig) -> float:
    """Echauffement lineaire, puis decroissance cosinus jusqu'a un plancher."""
    if etape < cfg.warmup_steps:
        return cfg.learning_rate * (etape + 1) / max(1, cfg.warmup_steps)
    progression = (etape - cfg.warmup_steps) / max(1, cfg.max_steps - cfg.warmup_steps)
    progression = min(1.0, max(0.0, progression))
    plancher = cfg.learning_rate * cfg.min_lr_ratio
    return plancher + 0.5 * (1 + math.cos(math.pi * progression)) * (cfg.learning_rate - plancher)


@torch.no_grad()
def perte_validation(
    modele: Transformer, dataset: Dataset, cfg: TrainConfig, device: torch.device
) -> dict[str, float]:
    modele.eval()
    resultats: dict[str, float] = {}
    for partie in ("train", "val"):
        total = 0.0
        for _ in range(cfg.eval_batches):
            x, y = dataset.batch(partie, cfg.batch_size, device)
            _, perte, _ = modele(x, y)
            total += float(perte.item())
        resultats[partie] = total / cfg.eval_batches
    modele.train()
    return resultats


def sauvegarder(
    chemin: Path,
    modele: Transformer,
    optimiseur: torch.optim.Optimizer,
    etape: int,
    meilleure: float,
) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model": modele.state_dict(),
            "optimizer": optimiseur.state_dict(),
            "config": modele.cfg.to_dict(),
            "step": etape,
            "best_val": meilleure,
        },
        chemin,
    )


def charger_modele(chemin: str | Path, device: torch.device) -> Transformer:
    """Recharge un modele entraine depuis un point de sauvegarde."""
    point = torch.load(chemin, map_location=device, weights_only=False)
    modele = Transformer(ModelConfig.from_dict(point["config"]))
    modele.load_state_dict(point["model"])
    return modele.to(device).eval()


def entrainer(
    modele: Transformer,
    dataset: Dataset,
    cfg: TrainConfig,
    sortie: str | Path,
    rappel: Callable[[int, dict[str, float]], None] | None = None,
) -> dict[str, float]:
    """Entraine le modele et renvoie un resume de la session."""
    sortie = Path(sortie)
    sortie.mkdir(parents=True, exist_ok=True)
    device = choisir_device(cfg.device)
    torch.manual_seed(cfg.seed)

    modele = modele.to(device)
    modele.train()
    optimiseur = construire_optimiseur(modele, cfg)

    # La precision mixte n'a de sens que sur GPU ; sur CPU elle ralentit.
    amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=amp)

    if cfg.compile and hasattr(torch, "compile"):
        modele = torch.compile(modele)  # type: ignore[assignment]

    parametres = sum(p.numel() for p in modele.parameters())
    tokens_par_etape = cfg.batch_size * cfg.grad_accum * modele.cfg.block_size  # type: ignore[union-attr]
    print(
        f"modele  : {parametres / 1e6:.2f} M parametres\n"
        f"corpus  : {dataset.tokens('train') / 1e6:.2f} M tokens d'entrainement\n"
        f"device  : {device}\n"
        f"etape   : {tokens_par_etape} tokens ({cfg.batch_size} x {cfg.grad_accum} x "
        f"{modele.cfg.block_size})",  # type: ignore[union-attr]
        flush=True,
    )

    journal: list[dict[str, float]] = []
    meilleure = float("inf")
    depart = time.time()

    for etape in range(cfg.max_steps):
        lr = taux_apprentissage(etape, cfg)
        for groupe in optimiseur.param_groups:
            groupe["lr"] = lr

        optimiseur.zero_grad(set_to_none=True)
        perte_cumulee = 0.0

        for _ in range(cfg.grad_accum):
            x, y = dataset.batch("train", cfg.batch_size, device)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=amp):
                _, perte, _ = modele(x, y)
            perte_cumulee += float(perte.item()) / cfg.grad_accum
            scaler.scale(perte / cfg.grad_accum).backward()

        if cfg.grad_clip > 0:
            scaler.unscale_(optimiseur)
            torch.nn.utils.clip_grad_norm_(modele.parameters(), cfg.grad_clip)

        scaler.step(optimiseur)
        scaler.update()

        if etape % 10 == 0 or etape == cfg.max_steps - 1:
            ecoule = time.time() - depart
            print(
                f"etape {etape:>6}/{cfg.max_steps}  perte {perte_cumulee:.4f}  "
                f"lr {lr:.2e}  {ecoule:.0f}s",
                flush=True,
            )

        if cfg.eval_every and (etape + 1) % cfg.eval_every == 0:
            pertes = perte_validation(modele, dataset, cfg, device)
            journal.append({"step": etape + 1, **pertes})
            print(
                f"  evaluation : train {pertes['train']:.4f}  val {pertes['val']:.4f}",
                flush=True,
            )
            if rappel:
                rappel(etape + 1, pertes)
            if pertes["val"] < meilleure:
                meilleure = pertes["val"]
                sauvegarder(sortie / "meilleur.pt", modele, optimiseur, etape + 1, meilleure)

        if cfg.save_every and (etape + 1) % cfg.save_every == 0:
            sauvegarder(sortie / "dernier.pt", modele, optimiseur, etape + 1, meilleure)

    sauvegarder(sortie / "dernier.pt", modele, optimiseur, cfg.max_steps, meilleure)
    if not (sortie / "meilleur.pt").exists():
        sauvegarder(sortie / "meilleur.pt", modele, optimiseur, cfg.max_steps, meilleure)

    finales = perte_validation(modele, dataset, cfg, device)
    resume = {
        "parametres": parametres,
        "etapes": cfg.max_steps,
        "tokens_vus": cfg.max_steps * tokens_par_etape,
        "perte_train": finales["train"],
        "perte_val": finales["val"],
        "meilleure_val": min(meilleure, finales["val"]),
        "secondes": time.time() - depart,
    }
    (sortie / "journal.json").write_text(
        json.dumps({"resume": resume, "evaluations": journal}, indent=2), encoding="utf-8"
    )
    return resume
