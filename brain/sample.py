"""Generation de texte : c'est ici que le modele « parle ».

Le cache des cles et valeurs evite de recalculer tout le passe a chaque
nouveau jeton : sans lui, une reponse de 500 jetons coute 500 fois plus cher.
"""

from __future__ import annotations

from typing import Iterator

import torch
import torch.nn.functional as F

from .model import Transformer
from .tokenizer import Tokenizer


def _filtre(
    logits: torch.Tensor,
    temperature: float,
    top_k: int | None,
    top_p: float | None,
) -> torch.Tensor:
    """Applique temperature, top-k et top-p (echantillonnage par noyau)."""
    if temperature <= 0:
        # Temperature nulle : on veut l'argmax, pas une division par zero.
        sortie = torch.full_like(logits, float("-inf"))
        sortie.scatter_(-1, logits.argmax(-1, keepdim=True), 0.0)
        return sortie

    logits = logits / temperature

    if top_k:
        k = min(top_k, logits.size(-1))
        seuil = torch.topk(logits, k, dim=-1).values[..., -1, None]
        logits = logits.masked_fill(logits < seuil, float("-inf"))

    if top_p and 0.0 < top_p < 1.0:
        tries, indices = torch.sort(logits, descending=True, dim=-1)
        cumul = torch.softmax(tries, dim=-1).cumsum(dim=-1)
        a_retirer = cumul - torch.softmax(tries, dim=-1) > top_p
        tries = tries.masked_fill(a_retirer, float("-inf"))
        logits = torch.full_like(logits, float("-inf")).scatter_(-1, indices, tries)

    return logits


@torch.no_grad()
def generer_flux(
    modele: Transformer,
    tokenizer: Tokenizer,
    amorce: str,
    max_tokens: int = 256,
    temperature: float = 0.8,
    top_k: int | None = 50,
    top_p: float | None = 0.95,
    penalite_repetition: float = 1.1,
    arret: tuple[int, ...] | None = None,
    device: torch.device | None = None,
    generateur: torch.Generator | None = None,
) -> Iterator[str]:
    """Produit le texte jeton par jeton, au fil de l'eau."""
    modele.eval()
    device = device or next(modele.parameters()).device
    arret = arret if arret is not None else (tokenizer.eos_id,)

    ids = tokenizer.encode(amorce)
    if not ids:
        ids = [tokenizer.bos_id]

    # Le contexte est borne : on garde la fin, la plus pertinente.
    contexte = modele.cfg.block_size
    ids = ids[-(contexte - 1) :]

    entree = torch.tensor([ids], dtype=torch.long, device=device)
    caches: list[tuple[torch.Tensor, torch.Tensor]] | None = None
    produits: list[int] = []
    # Amorce + production : c'est cet historique qu'on retaille quand le
    # contexte deborde, pour ne pas jeter la question en cours de reponse.
    historique: list[int] = list(ids)
    tampon = b""

    for _ in range(max_tokens):
        logits, _, caches = modele(entree, caches=caches)
        logits = logits[:, -1, :].float()

        if penalite_repetition and penalite_repetition != 1.0 and produits:
            vus = torch.tensor(sorted(set(produits)), device=device)
            valeurs = logits[0, vus]
            # Penaliser dans le bon sens selon le signe, sinon on renforce les
            # logits negatifs au lieu de les affaiblir.
            logits[0, vus] = torch.where(
                valeurs > 0, valeurs / penalite_repetition, valeurs * penalite_repetition
            )

        probabilites = F.softmax(_filtre(logits, temperature, top_k, top_p), dim=-1)
        suivant = torch.multinomial(probabilites, num_samples=1, generator=generateur)
        jeton = int(suivant.item())

        if jeton in arret:
            break

        produits.append(jeton)
        historique.append(jeton)

        # L'avancee de l'etat vient AVANT l'emission du texte : un caractere
        # accentue a cheval sur deux jetons ne doit jamais faire sauter la mise
        # a jour de l'entree ni la remise a zero du cache.
        entree = suivant
        if caches and caches[0][0].shape[2] >= contexte - 1:
            # Contexte plein : on repart de la fin de l'historique.
            recents = historique[-(contexte // 2) :] or [jeton]
            entree = torch.tensor([recents], dtype=torch.long, device=device)
            caches = None

        # Un caractere accentue tient sur plusieurs octets, qui peuvent tomber
        # dans deux jetons : on n'emet que ce qui se decode proprement.
        if jeton in tokenizer.id_to_special:
            morceau = tokenizer.id_to_special[jeton].encode("utf-8")
        else:
            morceau = tokenizer.vocab.get(jeton, b"")
        tampon += morceau
        try:
            texte = tampon.decode("utf-8")
        except UnicodeDecodeError:
            continue  # octets incomplets : on attend le jeton suivant
        tampon = b""
        if texte:
            yield texte

    if tampon:
        reste = tampon.decode("utf-8", errors="replace")
        if reste:
            yield reste


def generer(
    modele: Transformer,
    tokenizer: Tokenizer,
    amorce: str,
    **options: object,
) -> str:
    """Version bloquante : renvoie le texte complet."""
    return "".join(generer_flux(modele, tokenizer, amorce, **options))  # type: ignore[arg-type]
