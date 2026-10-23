# Torrents Duck 2 — consignes du projet

## Repères

Application de torrents et de fichiers partagés : Node.js 24+, Svelte 5,
SvelteKit 3, TypeScript/ESM, Better Auth et PostgreSQL 17. Déploiement avec
Docker Compose, qBittorrent, Nginx et FTPS. Utiliser npm et le lockfile existant.

- `src/routes/` : pages SvelteKit, chargements serveur et API.
- `src/lib/client.ts`, `src/lib/i18n.ts`, `src/lib/Modal.svelte` : outils UI communs.
- `src/lib/server/` : authentification, permissions, SQL, fichiers et moteur torrent.
- `db/`, `scripts/` : schéma, migrations, import Meteor et sauvegardes.
- `deploy/`, `compose.yaml` : services, réseau, certificats et pare-feu.
- `tests/`, `.github/workflows/ci.yml` : tests applicatifs et vérifications CI.

Lire les fichiers concernés et leurs appelants avant de modifier un comportement.
Privilégier les helpers existants et le plus petit changement complet ; ne pas
ajouter de dépendance ou d'abstraction pour quelques lignes. Garder les imports
`#lib/...` existants et les modules serveur hors du code envoyé au navigateur.

## Règles métier à préserver

- Un compte doit être actif et approuvé pour accéder aux services. La protection
  des pages ne remplace pas celle des API. Les helpers de `permissions.ts` font foi.
- `downloads` et `share` sont collectifs. Le site et FTPS lisent `downloads` ;
  qBittorrent le gère. Seul `share` est directement modifiable par les membres.
- Retirer un torrent conserve ses fichiers ; supprimer ses données exige une
  confirmation explicite et affecte toute la communauté.
- Conserver les protections des chemins, les écritures sans écrasement, la
  réserve disque de 10 %, les limites réseau et la révocation des accès.
- Ne jamais versionner ni afficher de secrets, de vrais identifiants, de dumps ou
  de contenu de `.env`/sauvegardes. Les exemples utilisent `.env.example` et des
  données fictives. Ne pas modifier les artefacts générés dans `build/` ou `.svelte-kit/`.

## Skills locaux

Charger le skill correspondant à la tâche ; leurs chemins sont relatifs à la
racine du dépôt. Ils complètent ces consignes sans élargir la demande utilisateur.

| Tâche | Skill |
| --- | --- |
| Pages, composants, styles, traductions | [torrentduck-ui](.agents/skills/torrentduck-ui/SKILL.md) |
| API, comptes, fichiers, torrents, liens de lecture | [torrentduck-api](.agents/skills/torrentduck-api/SKILL.md) |
| Déploiement, services, migrations, sauvegardes | [torrentduck-operations](.agents/skills/torrentduck-operations/SKILL.md) |

## Vérifications

Installation locale : `npm ci`, puis suivre [README.md](README.md) pour les services
et la configuration. `npm run dev` charge `.env`. Les autres scripts npm ne le
chargent pas automatiquement : pour la base, utiliser par exemple
`node --env-file=.env --run db:migrate`.

Pour une modification applicative, lancer `npm run check`, les tests concernés
(`npm test -- tests/files.test.ts`, par exemple), puis `npm test` et
`npm run build` avant livraison. Pour les services et sauvegardes, choisir aussi
les vérifications indiquées dans le skill d'exploitation. Pour des consignes ou
de la documentation seules, vérifier les chemins, commandes et formats modifiés.

`npm test` ne lance que `tests/**/*.test.ts`. Les tests PostgreSQL nécessitent
`TEST_DATABASE_URL` vers une base de test dédiée ; sans cette variable, ils sont
ignorés. Le parcours `node --test tests/http-flow.test.mjs` utilise une instance
locale de test avec `HTTP_BASE_URL`, `HTTP_ADMIN_LOGIN` et `HTTP_ADMIN_PASSWORD`.
Ces tests écrivent des données : ne pas les pointer vers la production.

Mettre à jour la documentation quand une procédure ou une variable change,
y compris les deux guides de déploiement français/anglais si concernés. Dans le
compte rendu, préciser les vérifications effectuées et celles non exécutées.
