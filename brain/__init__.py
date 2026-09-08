"""forge-brain — creer une IA a partir de zero.

Tokeniseur, architecture, entrainement, generation et service : chaque piece
est ecrite ici. Aucun poids pre-entraine, aucune cle d'API, aucun appel a un
modele exterieur.

    from brain import Tokenizer, Transformer, preset

    tok = Tokenizer().train(mon_texte, vocab_size=4096)
    modele = Transformer(preset("nano", vocab_size=tok.vocab_size))

Les modules qui dependent de PyTorch ne sont importes qu'a la demande, pour
que `brain.tokenizer` et `brain.config` restent utilisables sans lui.
"""

from .config import PRESETS, ModelConfig, TrainConfig, chinchilla_tokens, describe, preset, training_flops
from .tokenizer import SPECIAUX, Tokenizer

__version__ = "0.1.0"

__all__ = [
    "PRESETS",
    "SPECIAUX",
    "ModelConfig",
    "Tokenizer",
    "TrainConfig",
    "chinchilla_tokens",
    "describe",
    "preset",
    "training_flops",
    "__version__",
]


def __getattr__(nom: str):
    """Import paresseux des pieces qui exigent PyTorch."""
    if nom == "Transformer":
        from .model import Transformer

        return Transformer
    if nom in ("generer", "generer_flux"):
        from . import sample

        return getattr(sample, nom)
    if nom in ("entrainer", "charger_modele"):
        from . import train

        return getattr(train, nom)
    raise AttributeError(f"module 'brain' n'a pas d'attribut '{nom}'")
