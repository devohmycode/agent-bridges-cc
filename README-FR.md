# Agent Bridges pour Claude Code

> 🇬🇧 [English version](README.md)

Un marketplace Claude Code qui regroupe, au même endroit, des plugins pour
confier une **revue**, une **critique** ou une **tâche déléguée** à un autre
agent de code depuis Claude Code :

| Plugin | Agent | CLI | Provenance |
| --- | --- | --- | --- |
| `codex` | OpenAI Codex | `codex` | officiel, [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (référencé, non copié) |
| `grok-build` | xAI Grok Build | `grok` | officiel, [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc) (référencé, non copié) |
| `cursor-bridge` | Cursor Agent | `cursor-agent` | ce dépôt |
| `devin-bridge` | Devin | `devin` | ce dépôt |
| `copilot-bridge` | GitHub Copilot CLI | `copilot` | ce dépôt |
| `antigravity-bridge` | Google Antigravity | `agy` | ce dépôt |
| `warp-bridge` | Warp Oz | `oz` | ce dépôt |

Les cinq plugins `*-bridge` sont générés à partir d'un seul moteur, dérivé du
plugin Grok Build (lui-même calqué sur celui de Codex) : même commandes, même
suivi des exécutions en arrière-plan, même rendu.

## Installation

```text
/plugin marketplace add devohmycode/agent-bridges-cc
/plugin install cursor-bridge@agent-bridges
/reload-plugins
```

Remplacez `cursor-bridge` par le plugin voulu ; on peut en installer
plusieurs. `codex` et `grok-build` sont récupérés depuis leurs dépôts
officiels au moment de l'installation.

Depuis un clone local :

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install devin-bridge@agent-bridges
```

Prérequis : Node.js ≥ 18.18 et le CLI de l'agent, installé et connecté.

## Commandes des plugins `*-bridge`

Chaque plugin expose les mêmes commandes sous son propre préfixe
(`/cursor-bridge:…`, `/devin-bridge:…`, etc.) :

| Commande | Rôle |
| --- | --- |
| `check` | Vérifie Node, le CLI, la connexion, et si la lecture seule est garantie |
| `review [--base <ref>] [--scope auto\|working-tree\|branch]` | Revue en lecture seule de l'état git local |
| `critique [focus…]` | Revue qui conteste les choix de conception ; sortie JSON structurée |
| `delegate [--resume\|--fresh] <tâche>` | Confie une tâche au sous-agent `<id>-delegate` ; écriture autorisée par défaut |
| `runs [id] [--wait]` | Exécutions en cours et récentes |
| `show [id]` | Résultat complet d'une exécution terminée |
| `stop [id]` | Arrête une exécution en arrière-plan (agent et processus du pont) |

Options communes : `--wait` / `--background`, `--model <modèle>`, et
`--effort <niveau>` quand le CLI le permet.

## Profils et workflows (`bridges-hub`)

Le plugin `bridges-hub` pilote les bridges installés :

- un **profil** donne un rôle à l'agent d'un provider (revue de sécurité,
  critique d'architecture, écriture de tests…) ;
- un **workflow** enchaîne plusieurs providers sur une même tâche, par exemple
  Cursor implémente, Codex et Grok Build relisent en parallèle, puis Cursor
  applique les corrections.

```text
/plugin install bridges-hub@agent-bridges
/bridges-hub:check                                   # bridges utilisables
/bridges-hub:list                                    # profils et workflows
/bridges-hub:ask codex --profile security-review audite le flux de connexion
/bridges-hub:flow implement-review ajoute une option --verbose au build
/bridges-hub:flow --dry-run multi-review             # aperçu, n'exécute rien
```

`runs`, `show` et `stop` fonctionnent comme dans les bridges. Chaque étape
passe par le script du plugin du provider (`run`/`task --json`) : elle
apparaît donc aussi dans les `runs` de ce bridge. Les étapes en lecture
tournent en parallèle ; une étape `write` tourne toujours seule, car toutes
partagent le même arbre de travail.

Fournis : les profils `security-review`, `performance-review`,
`architecture-critic`, `test-writer`, `implementer`, `docs-writer` ; les
workflows `implement-review`, `multi-review`, `security-audit`.

Les fichiers personnalisés sont en Markdown avec un frontmatter plat. Un
fichier de projet remplace un fichier utilisateur, qui remplace un fichier
fourni du même nom :

| Niveau | Emplacement |
| --- | --- |
| projet | `.claude/bridges-hub/{profiles,workflows}/*.md` |
| utilisateur | `~/.claude/bridges-hub/{profiles,workflows}/*.md` |
| fourni | `plugins/bridges-hub/{profiles,workflows}/` |

```markdown
---
name: review-then-fix
description: Codex relit, Cursor corrige
---
## review
provider: codex
profile: security-review

Relis les changements non commités faits pour : {{task}}

## fix
provider: cursor
mode: write
after: review

Corrige ce qui est fondé dans cette revue : {{steps.review.output}}
```

Clés d'étape : `provider`, `profile`, `mode` (`read`/`write`), `model`,
`effort`, `after`, `on_failure` (`stop`/`continue`). Variables : `{{task}}`,
`{{vars.<nom>}}` (`--var nom=valeur`), `{{steps.<id>.output}}` et
`{{steps.<id>.status}}`. Le frontmatter d'un workflow peut fixer `exclude`
(globs que toutes les étapes laissent de côté) et `vars` (valeurs par défaut
`clé=valeur, …`) ; `flow --model` / `--effort` complètent les étapes qui n'en
fixent pas.

Un profil peut s'appuyer sur un autre au lieu de le remplacer :

- `extends: security-review` ajoute chaque `## Section` du fichier sous la
  même section du profil de base, en la marquant comme prioritaire ; un profil
  de projet qui porte le nom de sa base étend la version utilisateur ou
  fournie ;
- `include: _commun#Remediation, implementer` ajoute un autre profil ou l'une
  de ses sections (les profils `_nom` sont masqués dans `list`) ;
- `exclude` et `vars` fonctionnent comme dans les workflows.

`/bridges-hub:new-profile` et
`/bridges-hub:new-workflow` rédigent et valident un fichier pour vous ;
`validate [nom|fichier]` en vérifie un à la main.

## Correspondance avec chaque CLI

| | Lecture seule (review, critique) | Écriture (delegate) | Reprise | `--effort` |
| --- | --- | --- | --- | --- |
| Cursor | `--mode ask` | `--force` | `--resume <chatId>` | via le modèle : `--model 'modèle[effort=high]'` |
| Devin | `--permission-mode auto` | `--permission-mode dangerous` | `--resume <id>` | — |
| Copilot | `--deny-tool write --deny-tool shell` | `--allow-all-tools` | `--resume <id>` (identifiant fixé d'avance) | `--reasoning-effort` |
| Antigravity | `--mode plan` | `--mode accept-edits --dangerously-skip-permissions` | `--conversation <id>` | `--effort` |
| Warp Oz | **non garantie** (voir plus bas) | profil d'agent facultatif | `--conversation <id>` | — |

Le prompt passe par l'entrée standard (Cursor), par un fichier (Devin) ou en
argument. Au-delà de 24 000 caractères, il est écrit dans un fichier temporaire
que l'agent lit, pour ne pas dépasser la limite de ligne de commande de
Windows.

### Garde-fou git en lecture seule

Chaque exécution en lecture seule est encadrée par un instantané
`git status` + `git diff`. Si l'arbre de travail a changé, la sortie se
termine par un avertissement qui liste les fichiers touchés. Ce contrôle a
servi pendant la mise au point : `agy --mode plan --dangerously-skip-permissions`
a exécuté un `git restore` au milieu d'une revue. Ce drapeau n'est donc
jamais utilisé en lecture seule.

### Warp Oz

`oz agent run` n'a pas de mode lecture seule. Pour le garantir, créez dans
Warp un profil d'agent qui interdit les modifications, puis :

```bash
export WARP_BRIDGE_READONLY_PROFILE=<id du profil>   # oz agent profile list
export WARP_BRIDGE_WRITE_PROFILE=<id>                # facultatif, pour delegate
```

Sans profil, la revue ne tient qu'au prompt et au garde-fou git ci-dessus,
et `check` le signale. Chaque exécution Oz est aussi visible sur
`oz.warp.dev` (le lien figure dans la sortie) ; `--no-snapshot` désactive
l'envoi de l'instantané de fin d'exécution.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `CURSOR_AGENT_BINARY`, `DEVIN_BINARY`, `COPILOT_BINARY`, `AGY_BINARY`, `WARP_OZ_BINARY` | Chemin explicite du CLI |
| `WARP_BRIDGE_READONLY_PROFILE`, `WARP_BRIDGE_WRITE_PROFILE` | Profils d'agent Warp |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | Authentification Copilot (sinon, la connexion `/login` enregistrée) |

Sous Windows, Cursor est lancé directement par son `node.exe` embarqué et
Warp par `warp.exe` (avec `WARP_CLI_MODE=1`), sans passer par les scripts
`.cmd`.

## Développement

```bash
npm run build         # régénère plugins/ et .claude-plugin/marketplace.json
npm run check-build   # échoue si les fichiers générés ne sont pas à jour
npm test
```

- `core/` : moteur commun (pont, suivi des exécutions, git, rendu, hooks).
- `providers/<id>.mjs` : un adaptateur par CLI (voir `providers/README.md`).
- `templates/` : commandes, agent et compétences, avec des variables `{{…}}`.
- `hub/` : le plugin `bridges-hub` (runner, profils, workflows, commandes) ;
  le build y ajoute les bibliothèques du core qu'il réutilise.
- `plugins/` : **généré**, à ne pas modifier à la main ; il est versionné
  parce que Claude Code copie chaque dossier de plugin tel quel.

Ajouter un agent revient à écrire un nouveau `providers/<id>.mjs`, puis à
lancer `npm run build`.

## Licence

Apache-2.0. Voir `LICENSE` et `NOTICE` (crédits xAI et OpenAI).
