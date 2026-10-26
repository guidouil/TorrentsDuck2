---
name: torrentduck-api
description: Modifier ou corriger les API et services serveur de Torrents Duck 2, notamment les comptes, permissions, fichiers partagés, torrents et liens de lecture. À utiliser pour les changements de comportement serveur et leurs tests.
---

# API et services Torrents Duck

Les chemins ci-dessous sont relatifs à la racine du dépôt. Lire la route, son
helper partagé, ses appelants et les tests associés avant de changer le contrat.

## Comptes et frontières d'accès

- Réutiliser `requireMember`, `requireAdmin` et `requireInternal` de
  `src/lib/server/permissions.ts` avant tout accès protégé. Un contrôle dans un
  layout ou un bouton masqué n'autorise pas une API.
- Les comptes en attente peuvent se connecter pour afficher `/waiting`, mais
  n'accèdent pas aux services. Garder les contrôles SQL de `enabled`/`approved`
  et le cache de session désactivé pour que les changements de droits s'appliquent.
- Les routes publiques d'authentification et d'inscription ainsi que les liens
  de lecture ont leur propre contrôle : ne pas leur ajouter aveuglément un guard
  membre. L'inscription passe par `/api/registration`, avec rôle/approbation
  imposés côté serveur ; les champs fournis par le client ne donnent aucun droit.
- Préserver le contrôle d'origine de `src/hooks.server.ts`. Son exception
  `/api/internal/` exige le secret Bearer vérifié par `requireInternal` ; ces
  routes restent bloquées publiquement par Nginx.
- Les changements d'administration passent par les transactions et verrous
  existants : préserver le dernier administrateur actif, les révocations de
  sessions/liens et la propagation des changements de droits vers FTPS.

## Réutiliser les protections existantes

- Pour un objet JSON courant, utiliser `readJson` de `network.ts` (également
  réexporté comme `readJsonObject` dans `permissions.ts`) : lecture bornée à
  16 Kio et validation d'objet. Les uploads conservent leur traitement dédié.
- Employer `query`/`transaction` de `db.ts`, avec paramètres SQL. Conserver les
  limites de débit et l'audit des routes voisines sans journaliser de secrets.
- Fichiers : utiliser `fileSpace`, `relativePath`, `fileName` et `resolveFile`
  de `files.ts`. Préserver le refus des traversées/liens symboliques, l'ouverture
  sans suivi de lien et les opérations sans écrasement concurrent. `share`
  est modifiable directement ; dans `downloads`, seuls les administrateurs actifs
  et approuvés peuvent supprimer des fichiers ou dossiers, avec confirmation web.
  Upload, renommage et création y restent interdits. Ne pas charger un upload
  entier en mémoire.
- Conserver `requireStorage` et la réserve de 10 %, y compris pendant un upload.
  Une erreur ou une annulation nettoie les fichiers temporaires.
- Téléchargement : préserver GET/HEAD, Range/416 et les modes `FILE_DELIVERY=node`
  et `nginx`. L'autorisation précède le `X-Accel-Redirect` vers un chemin interne.
- Lecture externe : réutiliser `playback.ts`. Le secret du lien est stocké sous
  forme de hash ; expiration, révocation et état du compte sont vérifiés à la lecture.
- Torrents : passer par `qbittorrent.ts` et `network.ts`. Préserver le filtrage
  des URL publiques, la validation DNS et l'adresse épinglée, les contrôles après
  redirection, les tailles et timeouts. Un `fetch` direct ne les remplace pas.
- Préserver les tags d'auteur persistés dans qBittorrent et l'invalidation de
  l'instantané après mutation. Réutiliser le flux partagé de `torrent-stream.ts`
  plutôt qu'un nouveau polling par client, avec révocation des accès au flux.
- `remove` conserve les fichiers ; `delete` exige `confirm === true` et les efface.
  Garder cette distinction dans les appelants et la confirmation UI.

## Vérification ciblée

Ajouter un test de régression observable au niveau du helper ou de la route
modifiée ; étendre les tests existants plutôt que créer une infrastructure.

| Domaine | Tests dans `tests/` |
| --- | --- |
| Accès et comptes | `permissions.test.ts`, `api-protection.test.ts`, `registration.test.ts`, `waiting.test.ts` |
| Authentification et mots de passe | `auth-migration.test.ts`, `auth.integration.test.ts`, `mail.test.ts` |
| Chemins, uploads, médias | `files.test.ts`, `playback.test.ts` |
| Réseau, moteur et événements | `network.test.ts`, `network-fetch.test.ts`, `qbittorrent.test.ts`, `torrent-stream.test.ts` |
| Limites de débit | `rate-limit.test.ts` |

Exemple : `npm test -- tests/files.test.ts tests/playback.test.ts`.
Terminer avec les vérifications applicatives de `AGENTS.md`. Les intégrations
SQL utilisent une base de test dédiée via `TEST_DATABASE_URL` ; indiquer quand
elles ont été ignorées. Pour changer le schéma ou les services FTPS/Nginx,
charger aussi `torrentduck-operations`.
