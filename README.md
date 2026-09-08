# Forge

### ▶ [Ouvrir l'application](https://sanctimaps-gif.github.io/Applications-qui-cr-e-des-applications-/)

Rien à installer : la page s'ouvre dans votre navigateur, vous décrivez une application, elle est
écrite sous vos yeux et se met à tourner. Il vous faut seulement une clé d'API (OpenAI, Anthropic,
Google, Groq, Mistral, DeepSeek, OpenRouter) — ou rien du tout avec Ollama en local. La clé reste
dans votre navigateur.

Cette page est l'**édition navigateur**. L'édition complète, décrite ci-dessous, s'installe sur
votre machine et va beaucoup plus loin.

---

**Une application qui crée des applications.** Vous décrivez ce que vous voulez ; Forge conçoit
l'architecture, écrit tous les fichiers, exécute réellement l'installation, le build et les tests,
corrige ses propres erreurs, puis publie le résultat sur GitHub.

Forge est un logiciel **autonome et indépendant** : il s'exécute sur votre machine, se branche sur
le fournisseur d'IA de votre choix (ou sur un modèle local, sans aucun réseau) et n'a besoin
d'aucun service tiers pour fonctionner.

```bash
forge new "Un raccourcisseur d'URL avec statistiques, API REST et tests" --github
```

---

## Ce qui distingue Forge

| | |
|---|---|
| **Aucune limite de création** | Aucun quota de projets, de fichiers, de tokens ni de boucles de correction. Toutes les limites valent `0` par défaut, ce qui signifie *illimité*. |
| **22 fournisseurs, aucun imposé** | 17 services — OpenAI, Anthropic, Google, Azure, Mistral, Groq, DeepSeek, xAI, Cerebras, Fireworks, Together, Nebius, SambaNova, Cohere, Hugging Face, Perplexity, OpenRouter — 4 moteurs **100 % locaux** (Ollama, LM Studio, vLLM, llama.cpp), et un connecteur universel pour tout service parlant `/chat/completions`. Bascule automatique si l'un tombe. |
| **11 écosystèmes** | Node, Bun, Deno, Python, Go, Rust, Java/Kotlin, Ruby, PHP, .NET, sites statiques — commandes, `.gitignore` et CI adaptés à chacun. |
| **Zéro dépendance d'exécution** | Le `package.json` n'a aucune dépendance runtime. Rien à auditer, rien qui casse, démarrage instantané. |
| **Le code est réellement exécuté** | Forge lance `install`, `lint`, `build` et `test` dans le projet généré. Ce qui est livré a été vérifié, pas supposé. |
| **Il se répare tout seul** | En cas d'échec, il lit la vraie sortie d'erreur, cible les fichiers fautifs, les régénère et relance — jusqu'à ce que ça passe. |
| **Il fait évoluer l'existant** | `forge iterate` modifie un projet déjà généré : plan de changement ciblé, édition, vérification, réparation, commit — et pull request si demandé. |
| **Intégration GitHub complète** | Dépôt, push en un commit via l'API Git Data, branches, pull requests, releases, sujets, GitHub Pages, workflow CI. |

## Performance

La vitesse vient de l'architecture, pas d'un réglage :

- **Génération par vagues parallèles.** Le plan produit un graphe de dépendances entre fichiers ;
  Forge le trie topologiquement et génère en parallèle tous les fichiers d'une même vague.
  Une application de 40 fichiers tient en 5 ou 6 vagues, pas en 40 appels successifs.
- **Routage par palier.** Un `.gitignore` ne mobilise pas le même modèle qu'un moteur de règles
  métier. Chaque fichier est routé vers `fast`, `balanced` ou `deep` selon sa complexité.
- **Contexte minimal et ciblé.** Chaque fichier ne reçoit que ses dépendances déclarées et le
  manifeste du projet — le prompt reste petit même sur un gros projet.
- **Cache de prompt côté fournisseur.** Le contexte projet est marqué comme préfixe réutilisable
  (`cache_control` chez Anthropic) : sur une rafale de fichiers, la latence chute nettement.
- **Cache de réponses à deux niveaux** (mémoire + disque). Régénérer un projet quasi identique
  ne repaie pas ce qui n'a pas changé.
- **Reprise et bascule automatiques.** Backoff exponentiel avec jitter, respect de `Retry-After`,
  puis passage au fournisseur suivant. Un service en panne ne fait pas échouer la génération.
- **Publication GitHub en un commit.** Les blobs partent en parallèle : publier 60 fichiers prend
  le temps du plus lent, pas la somme des soixante.

---

## Votre propre IA, sans aucune clé

Le dossier [`brain/`](brain/) contient de quoi **créer une IA à partir de zéro** : votre tokeniseur,
votre architecture, vos poids, entraînés sur votre texte. Aucun poids emprunté, aucune clé, aucun
appel sortant. Une fois entraînée, elle se sert en local et Forge l'utilise comme n'importe quel
fournisseur :

```bash
pip install -r requirements.txt
python3 -m brain tokenizer --corpus ./mes-textes --sortie ./mon-ia --vocab 8192
python3 -m brain preparer  --corpus ./mes-textes --sortie ./mon-ia
python3 -m brain entrainer --sortie ./mon-ia --preset micro --etapes 20000
python3 -m brain servir    --modele ./mon-ia --port 8377

export FORGE_CUSTOM_BASE_URL=http://127.0.0.1:8377/v1
export FORGE_PROVIDER_ORDER=custom
node dist/cli.js doctor      # ● custom  API joignable
```

Un avertissement honnête, détaillé dans [`brain/README.md`](brain/README.md) : l'écart de calcul
entre ce que vous pouvez entraîner sur une machine et un grand assistant actuel est d'environ **un
million de fois**. Ce dossier vous donne la chaîne complète et réelle ; il ne vous donne pas
l'échelle, que seul un centre de calcul procure.

## Les deux éditions

| | Édition navigateur | Édition complète |
|---|---|---|
| Accès | [un lien](https://sanctimaps-gif.github.io/Applications-qui-cr-e-des-applications-/), rien à installer | `npm install` puis `forge serve` |
| Ce qu'elle construit | applications web autonomes (HTML/CSS/JS) | n'importe quelle pile : Node, Python, Go, Rust, .NET… |
| Exécute et teste le code | non | oui, et corrige ses propres erreurs |
| Publie sur GitHub | non | dépôt, branche, pull request, release, Pages |
| Fournisseurs | 8, votre clé dans le navigateur | 22, dont 4 entièrement locaux |
| Limite de création | celle de votre fournisseur | **aucune** |

Le fichier de l'édition navigateur est [`index.html`](index.html) : un seul fichier, sans
dépendance, qui fonctionne aussi hors ligne si vous le téléchargez et l'ouvrez directement.

## Installation

Node.js 20.6 ou plus récent.

```bash
git clone https://github.com/sanctimaps-gif/applications-qui-cr-e-des-applications-.git
cd applications-qui-cr-e-des-applications-
npm install
npm run build
npm link          # rend la commande `forge` disponible partout
```

Puis configurez au moins un fournisseur :

```bash
cp .env.example .env
# et renseignez UNE de ces lignes
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_API_KEY=...
export MISTRAL_API_KEY=...
export GROQ_API_KEY=...
export DEEPSEEK_API_KEY=...
export OPENROUTER_API_KEY=...
```

**Ou aucun fournisseur externe du tout** — Forge tourne hors ligne avec un modèle local :

```bash
ollama serve
ollama pull qwen2.5-coder:32b
export OLLAMA_HOST=http://127.0.0.1:11434
```

Pour GitHub, un jeton avec les droits `repo` et `workflow` :

```bash
export GITHUB_TOKEN=ghp_...
```

Vérifiez l'ensemble :

```bash
forge doctor
```

---

## Utilisation

### Ligne de commande

```bash
# Une application, dans le dossier de travail
forge new "Une API de gestion de tâches avec authentification par jeton et tests"

# Pile imposée, dépôt GitHub public, workflow CI
forge new "Un jeu de la vie avec rendu terminal" --stack "Rust" --github --public --ci

# Site statique publié sur GitHub Pages avec une release
forge new "Un portfolio statique" --github --public --pages --release v1.0.0

# Modèle local, sans vérification, sortie machine
forge new "Un convertisseur Markdown vers HTML" --provider ollama --no-verify --json

# Faire évoluer un projet existant
forge iterate ./mon-app "Ajoute une pagination et les tests correspondants"
forge iterate ./mon-app "Passe la base en PostgreSQL" --github --branch feat/pg --pr

# Publier après coup un projet déjà généré
forge publish ./forge-projects/mon-app --repo mon-app

# Inspecter la configuration
forge doctor      # fournisseurs joignables, GitHub, limites
forge providers   # modèles retenus par palier
forge stacks      # écosystèmes reconnus et leurs commandes
```

Options principales de `forge new` et `forge iterate` :

| Option | Effet |
|---|---|
| `--out <dir>` | Répertoire de sortie |
| `--name <nom>` / `--stack <pile>` | Impose le nom ou la pile technique |
| `--provider <nom>` | Force un fournisseur |
| `--no-verify` | N'exécute pas `install` / `build` / `test` |
| `--repair <n>` | Nombre de boucles de correction (`0` = illimité, défaut) |
| `--github` `--repo` `--owner` `--public` | Publication GitHub |
| `--branch <nom>` `--pr` | Pousse sur une branche et ouvre une pull request |
| `--release <tag>` `--topics <a,b>` `--pages` | Release, sujets, GitHub Pages |
| `--ci` | Workflow GitHub Actions adapté à l'écosystème |
| `--json` / `--quiet` | Sortie machine / journal allégé (le résumé final reste affiché) |

### Interface web

```bash
forge serve            # http://127.0.0.1:7331
```

Une page unique : vous décrivez l'application, vous suivez la génération en direct (SSE), vous
récupérez le lien du dépôt. La file d'attente est **non bornée** ; seul le parallélisme est réglé,
pour ne pas saturer la machine.

Pour l'exposer sur un réseau, protégez-la :

```bash
FORGE_AUTH_TOKEN=un-secret FORGE_HOST=0.0.0.0 forge serve
```

### API HTTP

| Route | Rôle |
|---|---|
| `POST /api/projects` | Lance une génération (`{ "prompt": "...", "github": true }`) |
| `GET /api/projects` | Historique des générations |
| `GET /api/projects/:id` | État détaillé, spécification, vérification |
| `GET /api/projects/:id/events` | Flux SSE en direct (rejoue l'historique) |
| `POST /api/projects/:id/iterate` | Fait évoluer le projet (`{ "request": "..." }`), suivi en SSE |
| `POST /api/projects/:id/publish` | Publie sur GitHub après coup |
| `POST /api/projects/:id/cancel` | Annule une génération en cours |
| `GET /api/health`, `GET /api/providers` | État du service |

### Bibliothèque

```ts
import { createForge, buildApp, iterateProject } from 'forge-ai';

const forge = createForge();
forge.bus.onEvent((event) => console.log(event));

const result = await buildApp(forge, {
  prompt: 'Un tableau de bord de métriques avec API REST et tests',
  github: true,
  withCi: true,
});
console.log(result.projectDir, result.repo?.url, result.verification.ok);

// Puis le faire évoluer, avec une pull request à la clé
const change = await iterateProject(forge, {
  dir: result.projectDir,
  request: 'Ajoute un export CSV et les tests correspondants',
  github: true,
  branch: 'feat/export-csv',
  pullRequest: true,
});
console.log(change.summary, change.modified, change.repo?.pullRequestUrl);
```

---

## Comment ça marche

```
        demande en langage naturel
                   │
    ┌──────────────▼──────────────┐
    │ 1. PLAN        modèle deep  │  architecture, arborescence,
    │                             │  graphe de dépendances, commandes
    └──────────────┬──────────────┘
    ┌──────────────▼──────────────┐
    │ 2. GÉNÉRATION   en parallèle│  tri topologique → vagues
    │                             │  routage fast / balanced / deep
    └──────────────┬──────────────┘
    ┌──────────────▼──────────────┐
    │ 3. VÉRIFICATION   réelle    │  install · lint · build · test
    └──────────────┬──────────────┘
              échec │ succès
    ┌──────────────▼──────────────┐
    │ 4. RÉPARATION    en boucle  │  diagnostic sur l'erreur réelle,
    │                             │  régénération ciblée, re-test
    └──────────────┬──────────────┘
    ┌──────────────▼──────────────┐
    │ 5. GIT + GITHUB             │  commit local, dépôt, push, CI
    └─────────────────────────────┘
```

`forge iterate` suit le même principe sur un projet existant, en deux temps pour
garder le contexte petit : le modèle choisit d'abord les fichiers qu'il doit
lire, puis planifie les changements sur cette seule base — un dépôt entier n'est
jamais envoyé.

Structure du code :

```
src/
├── config.ts            configuration ; 0 = illimité partout
├── recipes.ts           11 écosystèmes : commandes, .gitignore, CI
├── providers/           OpenAI-compatible, Anthropic, Google, Azure, SSE
├── llm/                 client (retry, bascule, comptabilité) + cache
├── pipeline/            plan · graphe · génération · vérification · réparation · itération
├── fs/                  espace de travail confiné, exécution de commandes
├── git/                 client GitHub REST, git local
├── server/              file d'attente, API HTTP, interface web
└── cli.ts               commande `forge`
```

## Sécurité

Forge exécute du code écrit par un modèle. Les garde-fous sont explicites :

- **Écritures confinées.** Tout chemin est normalisé et validé ; `../`, chemin absolu ou évasion
  hors du répertoire du projet sont rejetés (couvert par les tests).
- **Commandes filtrées.** Une liste de motifs destructeurs (`rm -rf /`, `curl | sh`, `sudo`,
  `git push`…) n'est jamais exécutée, même si le plan la propose.
- **Aucun secret dans le code généré.** Les valeurs sensibles sont déclarées comme variables
  d'environnement.
- **Jetons jamais écrits sur disque.** Ils restent dans l'environnement du processus.

Cela dit, le code généré reste du code inconnu : pour des demandes arbitraires, faites tourner
Forge dans un conteneur ou une machine dédiée.

## Configuration

Tout se règle par variables d'environnement (voir `.env.example`) ou via `~/.forge/config.json`.

| Variable | Défaut | Rôle |
|---|---|---|
| `FORGE_MAX_FILES`, `FORGE_MAX_PROJECTS`, `FORGE_MAX_REPAIR_ATTEMPTS`, `FORGE_MAX_TOKENS` | `0` | **`0` = aucune limite** |
| `FORGE_CONCURRENCY` | `0` (auto : cpus × 4) | Fichiers générés en parallèle |
| `FORGE_JOB_CONCURRENCY` | `0` (auto : cpus) | Projets générés en parallèle |
| `FORGE_PROVIDER_ORDER` | local d'abord, puis les services | Ordre de préférence |
| `FORGE_CACHE` | `1` | Cache des réponses |
| `FORGE_VERIFY` | `1` | Exécution réelle des commandes |
| `FORGE_WORKSPACE` | `~/forge-projects` | Racine des projets |
| `FORGE_AUTH_TOKEN` | — | Protège l'API et l'interface web |

Les identifiants de modèles se surchargent par palier, par exemple :

```bash
export FORGE_OPENAI_MODEL_DEEP=gpt-5
export FORGE_OLLAMA_MODEL_BALANCED=qwen2.5-coder:32b
```

## Développement

```bash
npm run dev -- new "..."   # exécution directe en TypeScript
npm run typecheck
npm test                   # 49 tests, aucun appel réseau sortant
npm run build
```

Les tests couvrent le tri topologique, l'extraction JSON tolérante, le confinement des chemins,
le pool de concurrence, le transport HTTP des fournisseurs (JSON, SSE, 429, bascule), le pipeline
complet avec un fournisseur simulé, la boucle de réparation (correction réussie et arrêt sur
erreur bloquée), les recettes d'écosystèmes, l'itération sur projet existant (création,
modification, suppression, rejet des chemins hors projet), le client GitHub contre une API
simulée (commit initial sans parent, mise à jour sur historique, reprise sur erreur serveur,
branches, sujets, releases, pull requests), ainsi que l'API du serveur.

## Licence

MIT.
