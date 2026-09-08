"""Tailles de modeles, et ce que chacune coute reellement.

Ce fichier est aussi une piece de documentation : les chiffres qu'il contient
sont la reponse honnete a la question « jusqu'ou peut-on monter ? ».
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Any


@dataclass
class ModelConfig:
    """Architecture d'un transformeur decodeur."""

    vocab_size: int = 8192
    n_layer: int = 6
    n_head: int = 6
    n_kv_head: int | None = None  # None => attention multi-tetes classique
    n_embd: int = 384
    block_size: int = 256
    dropout: float = 0.0
    # Dimension du reseau feed-forward. None => ~8/3 x n_embd, arrondi.
    hidden_dim: int | None = None
    rope_theta: float = 10_000.0
    norm_eps: float = 1e-5
    tie_embeddings: bool = True

    def __post_init__(self) -> None:
        if self.n_embd % self.n_head != 0:
            raise ValueError(f"n_embd ({self.n_embd}) doit etre divisible par n_head ({self.n_head})")
        if self.n_kv_head is None:
            self.n_kv_head = self.n_head
        if self.n_head % self.n_kv_head != 0:
            raise ValueError("n_head doit etre un multiple de n_kv_head")
        if self.hidden_dim is None:
            # Convention SwiGLU : 8/3 x d, arrondi au multiple de 64 superieur.
            approx = int(8 * self.n_embd / 3)
            self.hidden_dim = ((approx + 63) // 64) * 64

    @property
    def head_dim(self) -> int:
        return self.n_embd // self.n_head

    def parameter_count(self) -> int:
        """Nombre de parametres, calcule sans instancier le modele."""
        d, h, kv = self.n_embd, self.head_dim, self.n_kv_head or self.n_head
        embeddings = self.vocab_size * d
        per_layer = (
            d * (self.n_head * h)  # projection des requetes
            + 2 * d * (kv * h)  # projections cles et valeurs
            + (self.n_head * h) * d  # projection de sortie
            + 3 * d * (self.hidden_dim or 0)  # SwiGLU : porte, montee, descente
            + 2 * d  # deux RMSNorm
        )
        head = 0 if self.tie_embeddings else self.vocab_size * d
        return embeddings + self.n_layer * per_layer + d + head

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ModelConfig":
        champs = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in champs})


@dataclass
class TrainConfig:
    """Hyperparametres d'entrainement."""

    batch_size: int = 16
    grad_accum: int = 1
    max_steps: int = 2000
    learning_rate: float = 3e-4
    min_lr_ratio: float = 0.1
    warmup_steps: int = 100
    weight_decay: float = 0.1
    beta1: float = 0.9
    beta2: float = 0.95
    grad_clip: float = 1.0
    eval_every: int = 200
    eval_batches: int = 20
    sample_every: int = 500
    save_every: int = 500
    seed: int = 1337
    device: str = "auto"
    compile: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


#: Presets, du jouet a l'ambitieux. `tokens` suit la regle de Chinchilla
#: (environ 20 tokens d'entrainement par parametre) : en dessous, le modele
#: est sous-entraine et le gachis de calcul est reel.
PRESETS: dict[str, dict[str, Any]] = {
    "nano": {
        "config": dict(n_layer=4, n_head=4, n_embd=256, block_size=256, vocab_size=4096),
        "materiel": "n'importe quel ordinateur portable (CPU)",
        "duree": "quelques minutes",
        "corpus": "1 a 10 Mo de texte",
        "attendu": "apprend l'orthographe, la ponctuation et le style local. Ne raisonne pas.",
    },
    "micro": {
        "config": dict(n_layer=8, n_head=8, n_embd=512, block_size=512, vocab_size=8192),
        "materiel": "CPU costaud, ou n'importe quel GPU",
        "duree": "1 a 3 heures sur GPU",
        "corpus": "100 Mo a 1 Go",
        "attendu": "phrases coherentes, imitation de format. Contenu peu fiable.",
    },
    "mini": {
        "config": dict(n_layer=12, n_head=12, n_embd=768, block_size=1024, vocab_size=16384),
        "materiel": "1 GPU 24 Go",
        "duree": "1 a 3 jours",
        "corpus": "5 a 20 Go (~2 milliards de tokens)",
        "attendu": "niveau GPT-2. Repond, resume, complete du code simple.",
    },
    "small": {
        "config": dict(n_layer=24, n_head=16, n_embd=1024, block_size=2048, vocab_size=32768),
        "materiel": "2 a 8 GPU",
        "duree": "1 a 3 semaines",
        "corpus": "50 a 150 Go (~7 milliards de tokens)",
        "attendu": "assistant utilisable sur des taches courtes et cadrees.",
    },
    "base": {
        "config": dict(n_layer=32, n_head=16, n_embd=2048, block_size=4096, vocab_size=32768),
        "materiel": "8 a 64 GPU",
        "duree": "1 a 3 mois",
        "corpus": "300 Go a 1 To (~30 milliards de tokens)",
        "attendu": "niveau des petits modeles ouverts recents. Suit des instructions.",
    },
}


def preset(nom: str, **surcharges: Any) -> ModelConfig:
    """Construit une configuration a partir d'un preset, surchargeable."""
    if nom not in PRESETS:
        raise KeyError(f"preset inconnu : {nom}. Disponibles : {', '.join(PRESETS)}")
    base = dict(PRESETS[nom]["config"])
    base.update(surcharges)
    return ModelConfig(**base)


def training_flops(params: int, tokens: int) -> float:
    """Cout d'entrainement approximatif : 6 x parametres x tokens."""
    return 6.0 * params * tokens


def chinchilla_tokens(params: int) -> int:
    """Nombre de tokens conseille pour ne pas sous-entrainer un modele."""
    return 20 * params


def describe(nom: str) -> str:
    """Fiche lisible d'un preset, chiffres compris."""
    infos = PRESETS[nom]
    cfg = preset(nom)
    params = cfg.parameter_count()
    tokens = chinchilla_tokens(params)
    flops = training_flops(params, tokens)
    return (
        f"{nom:<6} {params / 1e6:>8.1f} M parametres  "
        f"ctx {cfg.block_size:<5} "
        f"{tokens / 1e9:>6.1f} G tokens conseilles  "
        f"{flops:.1e} FLOP\n"
        f"       materiel : {infos['materiel']}\n"
        f"       duree    : {infos['duree']}\n"
        f"       corpus   : {infos['corpus']}\n"
        f"       attendu  : {infos['attendu']}"
    )
