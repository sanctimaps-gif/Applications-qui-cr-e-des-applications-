"""Serveur HTTP compatible OpenAI, servant VOTRE modele.

C'est la piece qui referme la boucle : Forge sait deja parler a n'importe quel
service `/chat/completions`. En lancant ce serveur et en pointant Forge dessus
(FORGE_CUSTOM_BASE_URL), la chaine complete tourne sans aucune cle et sans
aucun modele exterieur.

Bibliotheque standard uniquement, comme le reste du projet.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch

from .chat import format_dialogue
from .model import Transformer
from .sample import generer_flux
from .tokenizer import Tokenizer
from .train import charger_modele, choisir_device


class Moteur:
    """Modele charge en memoire, protege par un verrou.

    Un seul modele, une seule generation a la fois : sur une machine unique,
    paralleliser les requetes ne ferait que se disputer les memes coeurs.
    """

    def __init__(self, modele: Transformer, tokenizer: Tokenizer, nom: str) -> None:
        self.modele = modele
        self.tokenizer = tokenizer
        self.nom = nom
        self.verrou = threading.Lock()
        self.device = next(modele.parameters()).device

    @classmethod
    def charger(cls, dossier: str | Path, device: str = "auto") -> "Moteur":
        dossier = Path(dossier)
        cible = choisir_device(device)

        point = None
        for candidat in ("chat.pt", "meilleur.pt", "dernier.pt"):
            if (dossier / candidat).exists():
                point = dossier / candidat
                break
        if point is None:
            raise FileNotFoundError(
                f"aucun modele dans {dossier} (attendu : chat.pt, meilleur.pt ou dernier.pt)"
            )

        tokenizer_chemin = dossier / "tokenizer.json"
        if not tokenizer_chemin.exists():
            raise FileNotFoundError(f"tokenizer.json manquant dans {dossier}")

        modele = charger_modele(point, cible)
        return cls(modele, Tokenizer.load(tokenizer_chemin), point.stem)

    def repondre(self, messages: list[dict[str, str]], options: dict):
        """Genere la reponse, jeton par jeton."""
        amorce = format_dialogue(messages)
        return generer_flux(
            self.modele,
            self.tokenizer,
            amorce,
            max_tokens=int(options.get("max_tokens") or 512),
            temperature=float(options.get("temperature", 0.8)),
            top_k=options.get("top_k", 50),
            top_p=float(options.get("top_p", 0.95)),
            device=self.device,
        )


def _handler(moteur: Moteur):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "forge-brain"

        def log_message(self, format: str, *args) -> None:  # silence par defaut
            pass

        # ------------------------------------------------------------- #
        def _json(self, code: int, charge: dict) -> None:
            corps = json.dumps(charge).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(corps)))
            self._cors()
            self.end_headers()
            self.wfile.write(corps)

        def _cors(self) -> None:
            # Permet a une page web locale (l'edition navigateur de Forge)
            # d'appeler ce serveur.
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "authorization, content-type")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.send_header("content-length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") in ("/v1/models", "/models"):
                self._json(
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": moteur.nom,
                                "object": "model",
                                "created": int(time.time()),
                                "owned_by": "forge-brain",
                            }
                        ],
                    },
                )
            elif self.path.rstrip("/") in ("/health", "/v1/health"):
                self._json(200, {"ok": True, "model": moteur.nom, "device": str(moteur.device)})
            else:
                self._json(404, {"error": {"message": "route inconnue"}})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
                self._json(404, {"error": {"message": "route inconnue"}})
                return

            try:
                taille = int(self.headers.get("content-length") or 0)
                requete = json.loads(self.rfile.read(taille) or b"{}")
            except (ValueError, json.JSONDecodeError):
                self._json(400, {"error": {"message": "corps JSON invalide"}})
                return

            messages = requete.get("messages")
            if not isinstance(messages, list) or not messages:
                self._json(400, {"error": {"message": "champ « messages » requis"}})
                return

            identifiant = "chatcmpl-" + uuid.uuid4().hex[:24]
            cree = int(time.time())

            if requete.get("stream"):
                self._diffuser(identifiant, cree, messages, requete)
            else:
                with moteur.verrou:
                    texte = "".join(moteur.repondre(messages, requete))
                entree = len(moteur.tokenizer.encode(format_dialogue(messages)))
                sortie = len(moteur.tokenizer.encode(texte))
                self._json(
                    200,
                    {
                        "id": identifiant,
                        "object": "chat.completion",
                        "created": cree,
                        "model": moteur.nom,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": texte},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": entree,
                            "completion_tokens": sortie,
                            "total_tokens": entree + sortie,
                        },
                    },
                )

        def _diffuser(self, identifiant: str, cree: int, messages: list, requete: dict) -> None:
            # En HTTP/1.1, un corps sans content-length doit etre delimite :
            # sans « connection: close », le client attend indefiniment la fin.
            self.close_connection = True
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self._cors()
            self.end_headers()

            def envoyer(charge: dict) -> None:
                self.wfile.write(f"data: {json.dumps(charge)}\n\n".encode("utf-8"))
                self.wfile.flush()

            gabarit = {
                "id": identifiant,
                "object": "chat.completion.chunk",
                "created": cree,
                "model": moteur.nom,
            }

            try:
                envoyer({**gabarit, "choices": [{"index": 0, "delta": {"role": "assistant"}}]})
                with moteur.verrou:
                    for morceau in moteur.repondre(messages, requete):
                        envoyer({**gabarit, "choices": [{"index": 0, "delta": {"content": morceau}}]})
                envoyer({**gabarit, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # le client est parti : rien a signaler

    return Handler


def servir(dossier: str | Path, host: str = "127.0.0.1", port: int = 8377, device: str = "auto") -> None:
    """Charge le modele et sert l'API jusqu'a interruption."""
    moteur = Moteur.charger(dossier, device)
    parametres = sum(p.numel() for p in moteur.modele.parameters())

    serveur = ThreadingHTTPServer((host, port), _handler(moteur))
    print(
        f"forge-brain sert « {moteur.nom} » ({parametres / 1e6:.2f} M parametres) "
        f"sur http://{host}:{port}/v1\n"
        f"  device : {moteur.device}\n\n"
        f"  Pour brancher Forge dessus, sans aucune cle :\n"
        f"    export FORGE_CUSTOM_BASE_URL=http://{host}:{port}/v1\n"
        f"    export FORGE_PROVIDER_ORDER=custom\n"
        f"    node dist/cli.js new \"...\"\n\n"
        f"Ctrl+C pour arreter.",
        flush=True,
    )
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\narret.")
    finally:
        serveur.server_close()


__all__ = ["Moteur", "servir"]


def _torch_present() -> bool:  # pragma: no cover - garde-fou d'import
    return torch is not None
