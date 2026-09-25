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
- `plugins/` : **généré**, à ne pas modifier à la main ; il est versionné
  parce que Claude Code copie chaque dossier de plugin tel quel.

Ajouter un agent revient à écrire un nouveau `providers/<id>.mjs`, puis à
lancer `npm run build`.

## Licence

Apache-2.0. Voir `LICENSE` et `NOTICE` (crédits xAI et OpenAI).
