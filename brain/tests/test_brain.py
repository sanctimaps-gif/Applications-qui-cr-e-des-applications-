"""Tests de forge-brain. Aucun appel reseau, aucun modele exterieur."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import torch

from brain.chat import encoder_exemple, format_dialogue, preparer_lots
from brain.config import ModelConfig, TrainConfig, chinchilla_tokens, preset, training_flops
from brain.data import Dataset, prepare
from brain.model import Transformer
from brain.sample import generer
from brain.tokenizer import Tokenizer
from brain.train import entrainer, taux_apprentissage

CORPUS = (
    "La forge chauffe le metal jusqu'a le rendre malleable. "
    "Le forgeron frappe, plie, replie, et recommence. "
    "Chaque coup compte, chaque reprise affine la lame. "
    "Le metal refroidit, durcit, garde la forme qu'on lui a donnee. "
) * 60


def petit_tokenizer(vocab: int = 400) -> Tokenizer:
    return Tokenizer().train(CORPUS, vocab_size=vocab)


class TestTokenizer(unittest.TestCase):
    def test_aller_retour_exact(self) -> None:
        tok = petit_tokenizer()
        for texte in [
            "La forge chauffe le metal.",
            "Accents : éàùçôî — et symboles ✓ ×",
            "def additionne(a, b):\n    return a + b\n",
            "",
            "🔥 emoji et 日本語",
        ]:
            self.assertEqual(tok.decode(tok.encode(texte)), texte, f"echec sur : {texte!r}")

    def test_tout_texte_est_encodable(self) -> None:
        # Le niveau octet garantit qu'aucune entree ne peut echouer.
        tok = petit_tokenizer()
        octets = bytes(range(256)).decode("latin-1")
        self.assertEqual(tok.decode(tok.encode(octets)), octets)

    def test_le_decoupage_ne_perd_aucun_caractere(self) -> None:
        """Le motif doit couvrir tout le texte : rien ne disparait en silence."""
        from brain.tokenizer import MOTIF

        for texte in [
            "snake_case_var et __dunder__",
            "def f(x): return x_1 + 2",
            "a_b 1_2 — tiret bas, accents éàç, tabulation\tet retour\n",
            "!@#$%^&*()_+-=[]{}|;:'\",.<>/?`~\\",
        ]:
            self.assertEqual("".join(MOTIF.findall(texte)), texte, f"perte sur : {texte!r}")

    def test_le_code_survit_a_l_aller_retour(self) -> None:
        tok = petit_tokenizer(400)
        code = "def calcule_total(prix_ht, taux_tva=0.2):\n    return prix_ht * (1 + taux_tva)\n"
        self.assertEqual(tok.decode(tok.encode(code)), code)

    def test_les_fusions_compressent(self) -> None:
        brut = len(CORPUS.encode("utf-8"))
        sans = len(Tokenizer().encode(CORPUS))
        avec = len(petit_tokenizer(600).encode(CORPUS))
        self.assertEqual(sans, brut, "sans fusion, un jeton par octet")
        self.assertLess(avec, sans * 0.5, "les fusions doivent au moins doubler la compression")

    def test_jetons_speciaux(self) -> None:
        tok = petit_tokenizer()
        ids = tok.encode("<|user|>bonjour<|eos|>")
        self.assertIn(tok.special_to_id["<|user|>"], ids)
        self.assertIn(tok.eos_id, ids)
        self.assertEqual(tok.decode(ids), "<|user|>bonjour<|eos|>")

        # Desactives, ils redeviennent du texte ordinaire.
        bruts = tok.encode("<|user|>", autoriser_speciaux=False)
        self.assertNotIn(tok.special_to_id["<|user|>"], bruts)

    def test_vocab_size_coherent(self) -> None:
        tok = petit_tokenizer(500)
        self.assertEqual(tok.vocab_size, 256 + len(tok.merges) + len(tok.specials))
        self.assertLessEqual(tok.vocab_size, 500)
        self.assertTrue(all(i < tok.vocab_size for i in tok.encode(CORPUS)))

    def test_persistance(self) -> None:
        tok = petit_tokenizer()
        with tempfile.TemporaryDirectory() as dossier:
            chemin = Path(dossier) / "tokenizer.json"
            tok.save(chemin)
            recharge = Tokenizer.load(chemin)
        self.assertEqual(recharge.merges, tok.merges)
        self.assertEqual(recharge.encode("La forge"), tok.encode("La forge"))

    def test_vocab_trop_petit_refuse(self) -> None:
        with self.assertRaises(ValueError):
            Tokenizer().train(CORPUS, vocab_size=100)


class TestModele(unittest.TestCase):
    def cfg(self, **kw) -> ModelConfig:
        base = dict(vocab_size=128, n_layer=2, n_head=2, n_embd=32, block_size=16)
        base.update(kw)
        return ModelConfig(**base)

    def test_formes_et_perte(self) -> None:
        modele = Transformer(self.cfg())
        x = torch.randint(0, 128, (2, 16))
        logits, perte, caches = modele(x, x)
        self.assertEqual(logits.shape, (2, 16, 128))
        self.assertEqual(len(caches), 2)
        self.assertTrue(torch.isfinite(perte))
        # Avant tout entrainement, la perte vaut environ ln(vocab_size).
        self.assertAlmostEqual(float(perte), torch.tensor(128.0).log().item(), delta=0.8)

    def test_comptage_de_parametres(self) -> None:
        cfg = self.cfg()
        annonce = cfg.parameter_count()
        reel = Transformer(cfg).num_parameters()
        # Les poids lies font compter l'embedding une seule fois.
        self.assertEqual(annonce, reel)

    def test_causalite(self) -> None:
        """Un jeton futur ne doit jamais influencer une prediction passee."""
        torch.manual_seed(0)
        modele = Transformer(self.cfg()).eval()
        x = torch.randint(0, 128, (1, 16))
        with torch.no_grad():
            avant, _, _ = modele(x)
            modifie = x.clone()
            modifie[0, -1] = (modifie[0, -1] + 1) % 128
            apres, _, _ = modele(modifie)
        self.assertTrue(torch.allclose(avant[0, :-1], apres[0, :-1], atol=1e-5))

    def test_le_cache_donne_le_meme_resultat(self) -> None:
        """Generer avec cache doit egaler le calcul complet."""
        torch.manual_seed(0)
        modele = Transformer(self.cfg()).eval()
        x = torch.randint(0, 128, (1, 8))

        with torch.no_grad():
            complet, _, _ = modele(x)

            caches = None
            morceaux = []
            for i in range(8):
                logits, _, caches = modele(x[:, i : i + 1], caches=caches)
                morceaux.append(logits)
            incremental = torch.cat(morceaux, dim=1)

        self.assertTrue(torch.allclose(complet, incremental, atol=1e-4))

    def test_contexte_depasse_refuse(self) -> None:
        modele = Transformer(self.cfg(block_size=8))
        with self.assertRaises(ValueError):
            modele(torch.randint(0, 128, (1, 9)))

    def test_requetes_groupees(self) -> None:
        modele = Transformer(self.cfg(n_head=4, n_kv_head=2, n_embd=32))
        logits, _, _ = modele(torch.randint(0, 128, (1, 8)))
        self.assertEqual(logits.shape, (1, 8, 128))

    def test_config_invalide(self) -> None:
        with self.assertRaises(ValueError):
            ModelConfig(n_embd=30, n_head=4)


class TestApprentissage(unittest.TestCase):
    def test_le_modele_apprend_vraiment(self) -> None:
        """Sur une sequence repetitive, la perte doit s'effondrer."""
        torch.manual_seed(0)
        modele = Transformer(ModelConfig(vocab_size=16, n_layer=2, n_head=2, n_embd=64, block_size=16))
        optimiseur = torch.optim.AdamW(modele.parameters(), lr=3e-3)

        motif = torch.arange(16).repeat(4, 1) % 16
        cibles = torch.roll(motif, -1, dims=1)

        premieres = []
        for etape in range(120):
            _, perte, _ = modele(motif, cibles)
            optimiseur.zero_grad()
            perte.backward()
            optimiseur.step()
            if etape < 3:
                premieres.append(float(perte))

        self.assertLess(float(perte), premieres[0] * 0.3, "la perte doit chuter nettement")

    def test_planning_du_taux(self) -> None:
        cfg = TrainConfig(learning_rate=1e-3, warmup_steps=10, max_steps=100, min_lr_ratio=0.1)
        self.assertLess(taux_apprentissage(0, cfg), cfg.learning_rate)
        self.assertAlmostEqual(taux_apprentissage(9, cfg), cfg.learning_rate, places=6)
        self.assertAlmostEqual(taux_apprentissage(99, cfg), cfg.learning_rate * 0.1, places=4)

    def test_chaine_complete(self) -> None:
        """Tokeniser, preparer, entrainer, sauvegarder, generer."""
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            tok = petit_tokenizer(400)
            tok.save(racine / "tokenizer.json")

            stats = prepare(CORPUS, tok, racine / "donnees")
            self.assertGreater(stats["tokens"], 100)

            cfg = ModelConfig(vocab_size=tok.vocab_size, n_layer=2, n_head=2, n_embd=64, block_size=32)
            dataset = Dataset(racine / "donnees", cfg.block_size, cfg.vocab_size)
            modele = Transformer(cfg)

            resume = entrainer(
                modele,
                dataset,
                TrainConfig(max_steps=30, batch_size=4, eval_every=15, eval_batches=2, save_every=0),
                racine,
            )

            self.assertTrue((racine / "meilleur.pt").exists())
            self.assertTrue((racine / "journal.json").exists())
            self.assertLess(resume["perte_val"], 6.0)

            texte = generer(modele, tok, "La forge", max_tokens=20, temperature=0.8)
            self.assertIsInstance(texte, str)

    def test_corpus_trop_court(self) -> None:
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            tok = petit_tokenizer(300)
            prepare("court", tok, racine / "donnees")
            with self.assertRaises(ValueError):
                Dataset(racine / "donnees", 256, tok.vocab_size)


class TestGeneration(unittest.TestCase):
    def test_deterministe_a_temperature_nulle(self) -> None:
        torch.manual_seed(0)
        tok = petit_tokenizer(300)
        modele = Transformer(
            ModelConfig(vocab_size=tok.vocab_size, n_layer=2, n_head=2, n_embd=32, block_size=32)
        ).eval()
        a = generer(modele, tok, "La forge", max_tokens=12, temperature=0.0)
        b = generer(modele, tok, "La forge", max_tokens=12, temperature=0.0)
        self.assertEqual(a, b)

    def test_amorce_plus_longue_que_le_contexte(self) -> None:
        """Une amorce qui deborde doit etre retaillee, pas faire tomber le modele."""
        tok = petit_tokenizer(400)
        cfg = ModelConfig(vocab_size=tok.vocab_size, n_layer=2, n_head=2, n_embd=32, block_size=32)
        modele = Transformer(cfg).eval()

        longue = "La forge chauffe le metal. " * 20
        self.assertGreater(len(tok.encode(longue)), cfg.block_size * 3)
        texte = generer(modele, tok, longue, max_tokens=60, temperature=0.9)
        self.assertIsInstance(texte, str)

    def test_generation_longue_recycle_le_contexte(self) -> None:
        """Produire bien plus que le contexte force plusieurs remises a zero."""
        tok = petit_tokenizer(400)
        cfg = ModelConfig(vocab_size=tok.vocab_size, n_layer=2, n_head=2, n_embd=32, block_size=32)
        modele = Transformer(cfg).eval()
        texte = generer(modele, tok, "La", max_tokens=150, temperature=1.0)
        self.assertIsInstance(texte, str)

    def test_respecte_le_budget_de_jetons(self) -> None:
        tok = petit_tokenizer(300)
        modele = Transformer(
            ModelConfig(vocab_size=tok.vocab_size, n_layer=2, n_head=2, n_embd=32, block_size=32)
        ).eval()
        texte = generer(modele, tok, "La", max_tokens=5, temperature=1.0)
        self.assertLessEqual(len(tok.encode(texte)), 12)


class TestDialogue(unittest.TestCase):
    def test_format(self) -> None:
        rendu = format_dialogue([{"role": "user", "content": "Bonjour"}])
        self.assertEqual(rendu, "<|user|>Bonjour<|eos|><|assistant|>")

    def test_seule_la_reponse_est_apprise(self) -> None:
        tok = petit_tokenizer(400)
        entree, cible = encoder_exemple(
            [{"role": "user", "content": "Bonjour"}, {"role": "assistant", "content": "Salut"}],
            tok,
            block_size=128,
        )
        self.assertEqual(len(entree), len(cible))
        self.assertTrue(any(c != -100 for c in cible), "la reponse doit etre apprise")
        # Les premiers jetons (la question) sont ignores par la perte.
        self.assertEqual(cible[0], -100)

    def test_exemple_sans_reponse_ecarte(self) -> None:
        tok = petit_tokenizer(400)
        self.assertIsNone(
            encoder_exemple([{"role": "user", "content": "Bonjour"}], tok, block_size=64)
        )

    def test_lots_rembourres(self) -> None:
        tok = petit_tokenizer(400)
        dialogues = [
            [{"role": "user", "content": "Bonjour"}, {"role": "assistant", "content": "Salut"}],
            [
                {"role": "user", "content": "Explique la forge en detail s'il te plait"},
                {"role": "assistant", "content": "On chauffe le metal puis on le frappe"},
            ],
        ]
        entrees, cibles = preparer_lots(dialogues, tok, block_size=128)
        self.assertEqual(entrees.shape, cibles.shape)
        self.assertEqual(entrees.shape[0], 2)


class TestConfig(unittest.TestCase):
    def test_presets_coherents(self) -> None:
        for nom in ("nano", "micro", "mini", "small", "base"):
            cfg = preset(nom)
            self.assertGreater(cfg.parameter_count(), 0)
            self.assertEqual(cfg.n_embd % cfg.n_head, 0)

    def test_les_tailles_croissent(self) -> None:
        tailles = [preset(n).parameter_count() for n in ("nano", "micro", "mini", "small", "base")]
        self.assertEqual(tailles, sorted(tailles))

    def test_estimation_de_cout(self) -> None:
        params = preset("nano").parameter_count()
        self.assertEqual(chinchilla_tokens(params), 20 * params)
        self.assertAlmostEqual(training_flops(2, 3), 36.0)

    def test_aller_retour_dict(self) -> None:
        cfg = preset("nano")
        self.assertEqual(ModelConfig.from_dict(cfg.to_dict()).to_dict(), cfg.to_dict())


class TestServeur(unittest.TestCase):
    def test_contrat_openai(self) -> None:
        """Le serveur repond bien au format que Forge attend."""
        from brain.serve import Moteur, _handler

        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            tok = petit_tokenizer(300)
            tok.save(racine / "tokenizer.json")
            cfg = ModelConfig(vocab_size=tok.vocab_size, n_layer=2, n_head=2, n_embd=32, block_size=32)
            modele = Transformer(cfg).eval()
            torch.save(
                {"model": modele.state_dict(), "config": cfg.to_dict(), "step": 0, "best_val": 0.0},
                racine / "dernier.pt",
            )

            moteur = Moteur.charger(racine, device="cpu")
            self.assertIsNotNone(_handler(moteur))

            reponse = "".join(
                moteur.repondre([{"role": "user", "content": "Bonjour"}], {"max_tokens": 8})
            )
            self.assertIsInstance(reponse, str)

    def test_journal_json_valide(self) -> None:
        # Garde-fou : le journal ecrit par l'entrainement doit rester lisible.
        with tempfile.TemporaryDirectory() as dossier:
            racine = Path(dossier)
            tok = petit_tokenizer(400)
            prepare(CORPUS, tok, racine / "donnees")
            cfg = ModelConfig(vocab_size=tok.vocab_size, n_layer=1, n_head=2, n_embd=32, block_size=16)
            entrainer(
                Transformer(cfg),
                Dataset(racine / "donnees", cfg.block_size, cfg.vocab_size),
                TrainConfig(max_steps=4, batch_size=2, eval_every=2, eval_batches=1, save_every=0),
                racine,
            )
            journal = json.loads((racine / "journal.json").read_text(encoding="utf-8"))
            self.assertIn("resume", journal)
            self.assertIn("evaluations", journal)


if __name__ == "__main__":
    unittest.main(verbosity=2)
