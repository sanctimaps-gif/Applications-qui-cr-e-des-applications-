# forge-brain — créer une IA à partir de zéro

> **Vous voulez juste comprendre une phrase et la traduire en code ?**
> Alors ne passez pas par un modèle. Le [compilateur d'intention](#le-compilateur-dintention--du-français-vers-du-code-sans-modèle)
> fait exactement cela, en 30 millisecondes, sans entraînement, sans clé, et
> **correctement à tous les coups** :
>
> ```bash
> python3 -m brain coder "Une liste de tâches avec un titre, une priorité et une échéance, avec recherche"
> ```


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

## L'atelier — un agent de codage, sans aucun modèle

Ce qui fait Claude Code n'est pas seulement le modèle : c'est la **boucle d'agent** — les outils,
l'édition de fichiers, l'exécution des tests, l'itération, l'annulation, les garde-fous. Tout cela
se construit sans IA. `brain/agent/` est cette boucle.

```bash
python3 -m brain atelier --projet ./mon-app
```

```
Atelier Forge  —  aucun modèle, aucune clé, tout en local
projet : /home/vous/mon-app

vous › crée une application de gestion de tâches avec un titre et une priorité
✔ « Application de tâches » créée

vous › ajoute un champ prix
✔ champ « Prix » (nombre) ajouté — 5 fichier(s) mis à jour
  --- a/store.js
  +++ b/store.js
  +      prix: 0,

vous › ajoute une case terminé
✔ champ « Terminé » (booleen) ajouté — 6 fichier(s) mis à jour

vous › teste
✔ tests au vert — 11 passés

vous › annule
✔ dernière modification annulée
```

### Ce qu'il sait faire

| | |
|---|---|
| **Créer** | une application complète à partir d'une phrase |
| **Modifier** | ajouter, supprimer, renommer un champ ou une fonction |
| **Inspecter** | lister les fichiers, décrire le projet, montrer un fichier, voir le diff |
| **Exécuter** | lancer les tests et rendre compte du résultat |
| **Revenir** | annuler la dernière modification, consulter l'historique |

### Pourquoi il ne se trompe pas

Chaque modification passe par la **spécification** du projet (`.forge-intent.json`), pas par une
retouche du code : l'atelier modifie la spécification, puis régénère. Le code reste donc cohérent
par construction, quel que soit le nombre de modifications enchaînées.

### Les garde-fous

- **Écritures confinées** au dossier du projet : `../` et chemins absolus sont refusés (testé).
- **Un seul programme exécutable** : `node --test` sur les fichiers de test du projet. Jamais une
  commande venue d'une instruction.
- **Instantané avant chaque modification**, donc `annule` restaure exactement l'état précédent.
- **Refus explicite** plutôt que devinette : supprimer le dernier champ, retirer une fonction
  indispensable ou nommer un champ inexistant renvoie une erreur qui explique.

### Sans terminal

```bash
python3 -m brain atelier --projet ./mon-app --faire \
  "crée une liste de tâches avec un titre et une priorité" \
  "ajoute un champ prix" "teste"
```

## Le compilateur d'intention — du français vers du code, sans modèle

Comprendre une demande et écrire le code correspondant ne demande pas forcément un modèle de langue.
Sur un domaine délimité, une analyse grammaticale explicite fait mieux : elle est **déterministe**,
**instantanée** et **juste par construction**.

```bash
python3 -m brain coder "Une application de gestion de tâches avec un titre, une priorité, \
  une date d'échéance et une case terminé, avec recherche et export CSV" --sortie ./mon-app

cd mon-app && npm test        # les tests écrits par le générateur
open index.html               # l'application, par simple double-clic
```

Ce qu'il affiche avant d'écrire quoi que ce soit :

```
Compris : Application de tâches
  entite    : Tâche / Tâches
  champs    :
      - Titre : texte
      - Priorité : choix (Basse, Moyenne, Haute, Urgente)
      - Date échéance : date
      - Terminé : booleen
  fonctions : ajout, cochage, export, filtre, liste, persistance, recherche, suppression, tri
  confiance : 100%
```

`--expliquer` s'arrête là, sans rien écrire. La **confiance** et la ligne `ignoré` sont volontaires :
un générateur qui devine en silence est pire qu'un générateur qui avoue.

### Ce qu'il produit

Sept fichiers, une application web autonome : `index.html`, `styles.css`, `store.js` (la logique
métier, pure et testable), `ui.js` (l'affichage), `test/store.test.js`, `package.json`, `README.md`.
Aucune dépendance, aucun réseau, thème clair et sombre, utilisable au clavier.

### Ce qu'il comprend

| Il reconnaît | Exemples |
|---|---|
| L'entité | *gestion de*, *liste de*, *carnet de*, *suivi de*, *catalogue de*… + 30 noms courants, et fléchit les inconnus |
| Les champs | *avec un titre, une priorité et une date* — jusqu'à huit |
| Les types | date, nombre, booléen, choix, texte long, e-mail, URL, texte — déduits du nom du champ |
| Les fonctions | recherche, filtre, tri, suppression, édition, statistiques, export CSV, cochage, sauvegarde |

### Comparé à un petit modèle entraîné localement

| | Compilateur d'intention | Modèle `nano`/`micro` entraîné ici |
|---|---|---|
| Code correct | **toujours** | rarement |
| Vitesse | ~30 ms | secondes à minutes |
| Coût | nul | entraînement + inférence |
| Hors du domaine prévu | le dit franchement | invente |
| Extension | une ligne dans le lexique | réentraîner |

Sa limite est réelle et assumée : il couvre les applications de type fiches (créer, lister,
rechercher, filtrer, trier, exporter). Il ne conçoit pas un moteur de jeu ni un compilateur. Pour
sortir de ce domaine, il faut un modèle — donc l'échelle décrite plus haut.

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
| `intent/lexique.py` | Le vocabulaire français reconnu : entités, types de champs, fonctions. |
| `intent/analyse.py` | Analyse de la phrase vers une spécification, avec confiance et oublis déclarés. |
| `intent/generation.py` | Émission du code : HTML, CSS, logique métier, affichage, tests. |
| `agent/commandes.py` | Instruction française → opération nommée, ou refus argumenté. |
| `agent/atelier.py` | La boucle : outils confinés, régénération, instantanés, tests, historique. |
| `agent/repl.py` | L'interface en console, avec diffs colorés. |

## Les tests

```bash
python3 -m unittest discover -s brain/tests -t .
```

78 tests, sans réseau : aller-retour exact du tokeniseur (accents, emoji, code, `snake_case`),
absence de perte de caractères au découpage, **causalité** (aucune fuite d'information du futur),
**équivalence entre génération avec et sans cache**, chute réelle de la perte à l'entraînement,
débordement de contexte, chaîne complète de bout en bout, et contrat du serveur.

Pour le compilateur d'intention, le test décisif ne se contente pas de lire le code produit :
il **génère quatre applications, les exécute sous Node et fait passer leurs propres tests**.
L'atelier est testé de la même façon : une session complète est jouée, puis les tests du
projet produit doivent passer.

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
