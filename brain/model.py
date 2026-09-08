"""Le transformeur decodeur, ecrit de zero.

Aucune architecture pre-entrainee, aucun poids importe : seulement des couches
assemblees a la main. Les choix suivent l'etat de l'art des modeles recents —
normalisation RMS, positions par rotation (RoPE), portes SwiGLU, attention a
requetes groupees — parce qu'ils entrainent mieux, pas par mimetisme.
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import ModelConfig


class RMSNorm(nn.Module):
    """Normalisation par la moyenne quadratique : moins couteuse que LayerNorm."""

    def __init__(self, dim: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        norme = torch.rsqrt(x.float().pow(2).mean(-1, keepdim=True) + self.eps)
        return (x.float() * norme).type_as(x) * self.weight


def frequences_rotatives(head_dim: int, fin: int, theta: float, device: torch.device) -> torch.Tensor:
    """Table cos/sin des positions, precalculee une fois pour toutes."""
    inverses = 1.0 / (theta ** (torch.arange(0, head_dim, 2, device=device).float() / head_dim))
    positions = torch.arange(fin, device=device).float()
    angles = torch.outer(positions, inverses)
    return torch.stack((angles.cos(), angles.sin()), dim=-1)


def applique_rotation(x: torch.Tensor, table: torch.Tensor) -> torch.Tensor:
    """Encode la position en tournant chaque paire de dimensions.

    x : (batch, tetes, temps, dim_tete) ; table : (temps, dim_tete/2, 2).
    """
    b, h, t, d = x.shape
    x_paires = x.float().reshape(b, h, t, d // 2, 2)
    cos = table[:t, :, 0].view(1, 1, t, d // 2)
    sin = table[:t, :, 1].view(1, 1, t, d // 2)
    x1, x2 = x_paires[..., 0], x_paires[..., 1]
    tourne = torch.stack((x1 * cos - x2 * sin, x1 * sin + x2 * cos), dim=-1)
    return tourne.reshape(b, h, t, d).type_as(x)


class Attention(nn.Module):
    """Attention causale multi-tetes, avec cache pour la generation."""

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.n_head = cfg.n_head
        self.n_kv_head = cfg.n_kv_head or cfg.n_head
        self.head_dim = cfg.head_dim
        self.repetitions = self.n_head // self.n_kv_head

        self.wq = nn.Linear(cfg.n_embd, self.n_head * self.head_dim, bias=False)
        self.wk = nn.Linear(cfg.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.wv = nn.Linear(cfg.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.wo = nn.Linear(self.n_head * self.head_dim, cfg.n_embd, bias=False)
        self.dropout = cfg.dropout

    def forward(
        self,
        x: torch.Tensor,
        rotation: torch.Tensor,
        cache: tuple[torch.Tensor, torch.Tensor] | None = None,
    ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        b, t, _ = x.shape

        q = self.wq(x).view(b, t, self.n_head, self.head_dim).transpose(1, 2)
        k = self.wk(x).view(b, t, self.n_kv_head, self.head_dim).transpose(1, 2)
        v = self.wv(x).view(b, t, self.n_kv_head, self.head_dim).transpose(1, 2)

        # Les positions dependent de ce qui est deja en cache.
        deja = cache[0].shape[2] if cache is not None else 0
        table = rotation[deja : deja + t]
        q = applique_rotation(q, table)
        k = applique_rotation(k, table)

        if cache is not None:
            k = torch.cat((cache[0], k), dim=2)
            v = torch.cat((cache[1], v), dim=2)
        nouveau_cache = (k, v)

        if self.repetitions > 1:  # attention a requetes groupees
            k = k.repeat_interleave(self.repetitions, dim=1)
            v = v.repeat_interleave(self.repetitions, dim=1)

        # Un seul jeton en generation : tout le passe est visible, donc pas de
        # masque causal — l'imposer tronquerait le cache.
        causal = cache is None or t > 1
        sortie = F.scaled_dot_product_attention(
            q, k, v, is_causal=causal, dropout_p=self.dropout if self.training else 0.0
        )
        sortie = sortie.transpose(1, 2).contiguous().view(b, t, self.n_head * self.head_dim)
        return self.wo(sortie), nouveau_cache


class FeedForward(nn.Module):
    """Bloc SwiGLU : une porte multiplicative plutot qu'une simple activation."""

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        hidden = cfg.hidden_dim or 4 * cfg.n_embd
        self.porte = nn.Linear(cfg.n_embd, hidden, bias=False)
        self.montee = nn.Linear(cfg.n_embd, hidden, bias=False)
        self.descente = nn.Linear(hidden, cfg.n_embd, bias=False)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.drop(self.descente(F.silu(self.porte(x)) * self.montee(x)))


class Bloc(nn.Module):
    """Une couche : attention puis reseau, chacun en connexion residuelle."""

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.norme_attention = RMSNorm(cfg.n_embd, cfg.norm_eps)
        self.attention = Attention(cfg)
        self.norme_reseau = RMSNorm(cfg.n_embd, cfg.norm_eps)
        self.reseau = FeedForward(cfg)

    def forward(
        self,
        x: torch.Tensor,
        rotation: torch.Tensor,
        cache: tuple[torch.Tensor, torch.Tensor] | None = None,
    ) -> tuple[torch.Tensor, tuple[torch.Tensor, torch.Tensor]]:
        delta, nouveau_cache = self.attention(self.norme_attention(x), rotation, cache)
        x = x + delta
        x = x + self.reseau(self.norme_reseau(x))
        return x, nouveau_cache


class Transformer(nn.Module):
    """Modele de langue complet : jetons en entree, logits en sortie."""

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.cfg = cfg

        self.embeddings = nn.Embedding(cfg.vocab_size, cfg.n_embd)
        self.drop = nn.Dropout(cfg.dropout)
        self.blocs = nn.ModuleList(Bloc(cfg) for _ in range(cfg.n_layer))
        self.norme_finale = RMSNorm(cfg.n_embd, cfg.norm_eps)
        self.tete = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)

        if cfg.tie_embeddings:
            # Partager la matrice d'entree et de sortie economise beaucoup de
            # parametres et ameliore les petits modeles.
            self.tete.weight = self.embeddings.weight

        self.register_buffer(
            "rotation",
            frequences_rotatives(cfg.head_dim, cfg.block_size, cfg.rope_theta, torch.device("cpu")),
            persistent=False,
        )

        self.apply(self._init)
        # Mise a l'echelle des projections residuelles : sans elle, la variance
        # croit avec la profondeur et les modeles profonds divergent.
        for nom, parametre in self.named_parameters():
            if nom.endswith("wo.weight") or nom.endswith("descente.weight"):
                nn.init.normal_(parametre, mean=0.0, std=0.02 / math.sqrt(2 * cfg.n_layer))

    @staticmethod
    def _init(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def num_parameters(self, entrainables_seulement: bool = True) -> int:
        return sum(p.numel() for p in self.parameters() if p.requires_grad or not entrainables_seulement)

    def forward(
        self,
        idx: torch.Tensor,
        cibles: torch.Tensor | None = None,
        caches: list[tuple[torch.Tensor, torch.Tensor]] | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor | None, list[tuple[torch.Tensor, torch.Tensor]]]:
        b, t = idx.shape
        deja = caches[0][0].shape[2] if caches else 0
        if deja + t > self.cfg.block_size:
            raise ValueError(
                f"sequence de {deja + t} jetons au-dela du contexte du modele ({self.cfg.block_size})"
            )

        rotation = self.rotation
        if rotation.device != idx.device:
            rotation = rotation.to(idx.device)
            self.rotation = rotation

        x = self.drop(self.embeddings(idx))
        nouveaux: list[tuple[torch.Tensor, torch.Tensor]] = []
        for i, bloc in enumerate(self.blocs):
            x, cache = bloc(x, rotation, caches[i] if caches else None)
            nouveaux.append(cache)

        x = self.norme_finale(x)
        logits = self.tete(x)

        perte = None
        if cibles is not None:
            perte = F.cross_entropy(
                logits.view(-1, logits.size(-1)), cibles.reshape(-1), ignore_index=-100
            )
        return logits, perte, nouveaux

    @torch.no_grad()
    def estime_flops_par_token(self) -> float:
        """Cout d'un token en entrainement : environ 6 x parametres."""
        return 6.0 * self.num_parameters()
