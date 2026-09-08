"""Ligne de commande de forge-brain.

    python -m brain tailles
    python -m brain tokenizer --corpus ./textes --vocab 4096 --sortie ./mon-ia
    python -m brain preparer  --corpus ./textes --sortie ./mon-ia
    python -m brain entrainer --sortie ./mon-ia --preset nano --etapes 2000
    python -m brain ajuster   --sortie ./mon-ia --exemples dialogues.jsonl
    python -m brain parler    --modele ./mon-ia
    python -m brain servir    --modele ./mon-ia --port 8377
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import PRESETS, TrainConfig, describe, preset


def _tailles() -> int:
    print("Tailles disponibles, et ce que chacune demande reellement :\n")
    for nom in PRESETS:
        print(describe(nom))
        print()
    print(
        "Pour situer : un assistant de tout premier plan represente environ 10^25 FLOP\n"
        "d'entrainement, des dizaines de milliers de milliards de tokens, et un budget\n"
        "de plusieurs dizaines de millions d'euros. Aucun de ces presets n'y pretend."
    )
    return 0


def _tokenizer(args: argparse.Namespace) -> int:
    from .data import lire_corpus
    from .tokenizer import Tokenizer

    texte = lire_corpus(args.corpus, tuple(args.extensions) if args.extensions else None)
    print(f"corpus : {len(texte) / 1e6:.2f} M caracteres")

    tokenizer = Tokenizer().train(texte, vocab_size=args.vocab, verbose=True)
    sortie = Path(args.sortie)
    tokenizer.save(sortie / "tokenizer.json")

    echantillon = texte[:200]
    ids = tokenizer.encode(echantillon)
    print(
        f"vocabulaire : {tokenizer.vocab_size} entrees\n"
        f"compression : {len(echantillon.encode('utf-8')) / max(1, len(ids)):.2f} octets par jeton\n"
        f"ecrit       : {sortie / 'tokenizer.json'}"
    )
    return 0


def _preparer(args: argparse.Namespace) -> int:
    from .data import lire_corpus, prepare
    from .tokenizer import Tokenizer

    sortie = Path(args.sortie)
    tokenizer = Tokenizer.load(sortie / "tokenizer.json")
    texte = lire_corpus(args.corpus, tuple(args.extensions) if args.extensions else None)
    stats = prepare(texte, tokenizer, sortie / "donnees", part_validation=args.validation)
    print(
        f"caracteres : {stats['caracteres']:,}\n"
        f"tokens     : {stats['tokens']:,} "
        f"({stats['train']:,} entrainement / {stats['val']:,} validation)"
    )
    return 0


def _entrainer(args: argparse.Namespace) -> int:
    from .data import Dataset
    from .model import Transformer
    from .tokenizer import Tokenizer
    from .train import entrainer

    sortie = Path(args.sortie)
    tokenizer = Tokenizer.load(sortie / "tokenizer.json")
    cfg = preset(args.preset, vocab_size=tokenizer.vocab_size)
    if args.contexte:
        cfg.block_size = args.contexte

    dataset = Dataset(sortie / "donnees", cfg.block_size, cfg.vocab_size)
    modele = Transformer(cfg)

    entrainement = TrainConfig(
        max_steps=args.etapes,
        batch_size=args.batch,
        grad_accum=args.accumulation,
        learning_rate=args.lr,
        eval_every=args.evaluer,
        device=args.device,
        seed=args.seed,
    )
    resume = entrainer(modele, dataset, entrainement, sortie)
    print("\n" + json.dumps(resume, indent=2))
    return 0


def _ajuster(args: argparse.Namespace) -> int:
    from .chat import ajuster, charger_exemples
    from .tokenizer import Tokenizer
    from .train import charger_modele, choisir_device

    sortie = Path(args.sortie)
    device = choisir_device(args.device)
    tokenizer = Tokenizer.load(sortie / "tokenizer.json")

    depart = sortie / "meilleur.pt"
    if not depart.exists():
        depart = sortie / "dernier.pt"
    modele = charger_modele(depart, device)

    cfg = TrainConfig(max_steps=args.etapes, batch_size=args.batch, learning_rate=args.lr, device=args.device)
    resume = ajuster(modele, tokenizer, charger_exemples(args.exemples), cfg, sortie)
    print("\n" + json.dumps(resume, indent=2))
    return 0


def _parler(args: argparse.Namespace) -> int:
    from .chat import format_dialogue
    from .sample import generer_flux
    from .serve import Moteur

    moteur = Moteur.charger(args.modele, args.device)
    print(f"« {moteur.nom} » — Ctrl+C ou une ligne vide pour quitter.\n")

    historique: list[dict[str, str]] = []
    while True:
        try:
            demande = input("vous > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not demande:
            break

        historique.append({"role": "user", "content": demande})
        print("ia   > ", end="", flush=True)
        morceaux: list[str] = []
        for morceau in generer_flux(
            moteur.modele,
            moteur.tokenizer,
            format_dialogue(historique),
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            device=moteur.device,
        ):
            print(morceau, end="", flush=True)
            morceaux.append(morceau)
        print("\n")
        historique.append({"role": "assistant", "content": "".join(morceaux)})
    return 0


def _servir(args: argparse.Namespace) -> int:
    from .serve import servir

    servir(args.modele, host=args.host, port=args.port, device=args.device)
    return 0


def main(argv: list[str] | None = None) -> int:
    parseur = argparse.ArgumentParser(
        prog="brain",
        description="Cree votre propre IA, de zero : tokeniseur, modele, entrainement, service.",
    )
    sous = parseur.add_subparsers(dest="commande", required=True)

    sous.add_parser("tailles", help="tailles de modeles et cout reel de chacune")

    p = sous.add_parser("tokenizer", help="entraine le tokeniseur sur votre corpus")
    p.add_argument("--corpus", nargs="+", required=True)
    p.add_argument("--sortie", required=True)
    p.add_argument("--vocab", type=int, default=4096)
    p.add_argument("--extensions", nargs="*", default=None)

    p = sous.add_parser("preparer", help="tokenise le corpus en donnees d'entrainement")
    p.add_argument("--corpus", nargs="+", required=True)
    p.add_argument("--sortie", required=True)
    p.add_argument("--validation", type=float, default=0.05)
    p.add_argument("--extensions", nargs="*", default=None)

    p = sous.add_parser("entrainer", help="entraine le modele")
    p.add_argument("--sortie", required=True)
    p.add_argument("--preset", default="nano", choices=list(PRESETS))
    p.add_argument("--etapes", type=int, default=2000)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--accumulation", type=int, default=1)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--evaluer", type=int, default=200)
    p.add_argument("--contexte", type=int, default=None)
    p.add_argument("--device", default="auto")
    p.add_argument("--seed", type=int, default=1337)

    p = sous.add_parser("ajuster", help="apprend a repondre a des instructions")
    p.add_argument("--sortie", required=True)
    p.add_argument("--exemples", required=True)
    p.add_argument("--etapes", type=int, default=200)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--device", default="auto")

    p = sous.add_parser("parler", help="dialogue en console avec votre modele")
    p.add_argument("--modele", required=True)
    p.add_argument("--max-tokens", type=int, default=256)
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--device", default="auto")

    p = sous.add_parser("servir", help="expose votre modele en API compatible OpenAI")
    p.add_argument("--modele", required=True)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8377)
    p.add_argument("--device", default="auto")

    args = parseur.parse_args(argv)

    if args.commande == "tailles":
        return _tailles()
    return {
        "tokenizer": _tokenizer,
        "preparer": _preparer,
        "entrainer": _entrainer,
        "ajuster": _ajuster,
        "parler": _parler,
        "servir": _servir,
    }[args.commande](args)


if __name__ == "__main__":
    sys.exit(main())
