# Forge

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
| **Aucun fournisseur imposé** | OpenAI, Anthropic, Google, Mistral, Groq, DeepSeek, xAI, Together, OpenRouter — ou **100 % local** via Ollama / LM Studio. Bascule automatique si l'un tombe. |
| **Zéro dépendance d'exécution** | Le `package.json` n'a aucune dépendance runtime. Rien à auditer, rien qui casse, démarrage instantané. |
| **Le code est réellement exécuté** | Forge lance `install`, `lint`, `build` et `test` dans le projet généré. Ce qui est livré a été vérifié, pas supposé. |
| **Il se répare tout seul** | En cas d'échec, il lit la vraie sortie d'erreur, cible les fichiers fautifs, les régénère et relance — jusqu'à ce que ça passe. |
| **Intégration GitHub native** | Création du dépôt, publication de l'arborescence complète en un commit via l'API Git Data, workflow CI inclus. |

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

# Modèle local, sans vérification, sortie machine
forge new "Un convertisseur Markdown vers HTML" --provider ollama --no-verify --json

# Publier après coup un projet déjà généré
forge publish ./forge-projects/mon-app --repo mon-app
```

Options principales de `forge new` :

| Option | Effet |
|---|---|
| `--out <dir>` | Répertoire de sortie |
| `--name <nom>` / `--stack <pile>` | Impose le nom ou la pile technique |
| `--provider <nom>` | Force un fournisseur |
| `--no-verify` | N'exécute pas `install` / `build` / `test` |
| `--repair <n>` | Nombre de boucles de correction (`0` = illimité, défaut) |
| `--github` `--repo` `--owner` `--public` `--ci` | Publication GitHub |
| `--json` / `--quiet` | Sortie machine / journal minimal |

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
| `POST /api/projects/:id/publish` | Publie sur GitHub après coup |
| `POST /api/projects/:id/cancel` | Annule une génération en cours |
| `GET /api/health`, `GET /api/providers` | État du service |

### Bibliothèque

```ts
import { createForge, buildApp } from 'forge-ai';

const forge = createForge();
forge.bus.onEvent((event) => console.log(event));

const result = await buildApp(forge, {
  prompt: 'Un tableau de bord de métriques avec API REST et tests',
  github: true,
  withCi: true,
});

console.log(result.projectDir, result.repo?.url, result.verification.ok);
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

Structure du code :

```
src/
├── config.ts            configuration ; 0 = illimité partout
├── providers/           OpenAI-compatible, Anthropic, Google, SSE
├── llm/                 client (retry, bascule, comptabilité) + cache
├── pipeline/            plan · graphe · génération · vérification · réparation
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
npm test                   # 31 tests, aucun appel réseau sortant
npm run build
```

Les tests couvrent le tri topologique, l'extraction JSON tolérante, le confinement des chemins,
le pool de concurrence, le transport HTTP des fournisseurs (JSON, SSE, 429, bascule), le pipeline
complet avec un fournisseur simulé, la boucle de réparation (correction réussie et arrêt sur
erreur bloquée), ainsi que l'API du serveur.

## Licence

MIT.
