# forge-brain — créer une IA à partir de zéro

Tokeniseur, architecture, entraînement, génération, service : chaque pièce est écrite ici. **Aucun
poids pré-entraîné, aucune clé d'API, aucun appel à un modèle extérieur.** À la fin, vous possédez
un modèle que vous avez entraîné, qui tourne sur votre machine, et que Forge utilise comme
fournisseur.

---

## D'abord, la vérité sur l'échelle

Vous voulez une IA aussi capable que les grands assistants actuels. Voici ce que cela demande
réellement — ces chiffres ne sont pas négociables, aucun code ne les contourne :

| | Ce que vous pouvez faire ici | Un grand assistant actuel |
|---|---|---|
| Paramètres | 10⁶ à 10⁹ | ~10¹¹ à 10¹² |
| Tokens d'entraînement | 10⁶ à 10¹⁰ | ~10¹³ à 10¹⁴ |
| Calcul | 10¹⁵ à 10²¹ FLOP | ~10²⁵ à 10²⁶ FLOP |
| Matériel | 1 machine | des milliers de GPU, des mois |
| Coût | l'électricité | dizaines à centaines de millions d'euros |
| Après l'entraînement | — | annotation humaine à grande échelle, alignement, évaluations de sûreté |

L'écart n'est pas de 10 ou 100 fois : il est d'environ **un million de fois** en calcul. C'est la
raison, la seule, pour laquelle ce dossier ne vous donnera pas un assistant de premier plan. Il vous
donne en revanche la chaîne complète, réelle et fonctionnelle, dont ces systèmes sont faits.

### Ce que chaque échelle produit vraiment

```
python3 -m brain tailles
```

| Preset | Paramètres | Matériel | Durée | Corpus | Résultat attendu |
|---|---|---|---|---|---|
| `nano` | ~4 M | un portable | minutes | 1–10 Mo | orthographe, ponctuation, style local |
| `micro` | ~25 M | un GPU quelconque | 1–3 h | 100 Mo–1 Go | phrases cohérentes, formats imités |
| `mini` | ~110 M | 1 GPU 24 Go | 1–3 jours | 5–20 Go | niveau GPT-2 : répond, résume, code simple |
| `small` | ~350 M | 2–8 GPU | 1–3 semaines | 50–150 Go | assistant utilisable sur tâches cadrées |
| `base` | ~1,5 G | 8–64 GPU | 1–3 mois | 300 Go–1 To | niveau des petits modèles ouverts récents |

Le seuil où un modèle devient *utile comme assistant* se situe vers `mini`/`small`, avec un
ajustement par instructions soigné. En dessous, il imite la forme sans porter le sens.

---

## Installation

```bash
pip install -r requirements.txt     # torch et numpy, rien d'autre
```

## La chaîne complète, en cinq commandes

```bash
# 1. Votre tokeniseur, appris sur votre texte (aucun vocabulaire emprunté)
python3 -m brain tokenizer --corpus ./mes-textes --sortie ./mon-ia --vocab 8192

# 2. Le corpus, tokenisé une fois pour toutes
python3 -m brain preparer --corpus ./mes-textes --sortie ./mon-ia

# 3. L'entraînement
python3 -m brain entrainer --sortie ./mon-ia --preset micro --etapes 20000

# 4. Apprendre à répondre plutôt qu'à continuer du texte
python3 -m brain ajuster --sortie ./mon-ia --exemples dialogues.jsonl

# 5. Parler avec, ou le servir
python3 -m brain parler --modele ./mon-ia
python3 -m brain servir --modele ./mon-ia --port 8377
```

### Le format des exemples de dialogue

Un objet JSON par ligne (`.jsonl`). Seuls les jetons de la réponse comptent dans la perte : le
modèle n'a pas à apprendre à prédire vos questions.

```json
{"messages": [{"role": "user", "content": "Qu'est-ce qu'une forge ?"}, {"role": "assistant", "content": "Un atelier où l'on chauffe le métal pour le travailler."}]}
```

## Brancher votre IA dans Forge — sans aucune clé

```bash
python3 -m brain servir --modele ./mon-ia --port 8377 &

export FORGE_CUSTOM_BASE_URL=http://127.0.0.1:8377/v1
export FORGE_PROVIDER_ORDER=custom
node dist/cli.js doctor        # ● custom  API joignable
node dist/cli.js new "..."
```

Le serveur parle le protocole `/v1/chat/completions` (avec flux SSE), celui que Forge utilise déjà.
Rien ne sort de votre machine.

---

## Ce que contient chaque fichier

| Fichier | Rôle |
|---|---|
| `tokenizer.py` | BPE au niveau octet, entraîné de zéro. Aucun texte n'est inencodable. |
| `model.py` | Transformeur décodeur : RMSNorm, RoPE, attention causale à requêtes groupées, SwiGLU, cache KV. |
| `data.py` | Corpus → tokens → fichier binaire lu en mémoire virtuelle. |
| `train.py` | AdamW, décroissance sélective, échauffement + cosinus, accumulation, écrêtage, reprise. |
| `sample.py` | Génération : température, top-k, top-p, pénalité de répétition, recyclage du contexte. |
| `chat.py` | Format de dialogue et ajustement par instructions (SFT). |
| `serve.py` | API compatible OpenAI, bibliothèque standard uniquement. |
| `config.py` | Tailles de modèles et estimation honnête de leur coût. |

## Les tests

```bash
python3 -m unittest discover -s brain/tests -t .
```

34 tests, sans réseau : aller-retour exact du tokeniseur (accents, emoji, code, `snake_case`),
absence de perte de caractères au découpage, **causalité** (aucune fuite d'information du futur),
**équivalence entre génération avec et sans cache**, chute réelle de la perte à l'entraînement,
débordement de contexte, chaîne complète de bout en bout, et contrat du serveur.

## Ce qui manque pour aller plus loin

Honnêtement, dans l'ordre d'importance :

1. **Des données.** C'est le facteur dominant. Un corpus propre, varié et volumineux vaut plus que
   n'importe quel raffinement d'architecture.
2. **Du calcul.** Un GPU change tout : comptez 50 à 200 fois plus rapide qu'un CPU.
3. **De l'apprentissage par préférences** (DPO, RLHF) après l'ajustement : c'est ce qui rend une
   réponse utile plutôt que seulement plausible.
4. **Des évaluations** : sans mesure, on ne sait pas si un changement améliore quoi que ce soit.
5. **De la sûreté** : un modèle qui répond à tout sans discernement n'est pas un progrès.

Ce dossier couvre entièrement les étapes 1 à 3 côté outillage. Les 4 et 5 demandent un travail
humain que l'outillage ne remplace pas.
