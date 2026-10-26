# Torrents Duck 2

[English](README.md) · **Français** · [Guide de déploiement](docs/deployment.md) · [Contribuer](#contribuer) · [Apache 2.0](LICENSE)

**Une plateforme open source auto-hébergée pour partager torrents, fichiers et ressources au sein d'une communauté.**

Torrents Duck 2 rassemble les membres autour d'un même serveur, d'un moteur torrent commun et d'une bibliothèque collective. Là où une organisation en seedboxes individuelles répartit le serveur en espaces séparés, le projet mutualise les téléchargements et le stockage : chaque ajout enrichit la bibliothèque de tous les membres approuvés.

L'esprit est celui d'une « cour des miracles » du torrent : un carrefour communautaire où chacun contribue à un espace commun. Les comptes et les permissions encadrent l'accès ; les fichiers et les transferts sont partagés.

Le projet est la suite de [TorrentsDuck](https://github.com/guidouil/TorrentsDuck), initialement développé avec Meteor. Cette nouvelle version repose sur Node.js 24+, Svelte 5, SvelteKit 3 et TypeScript, avec Better Auth, PostgreSQL 17, qBittorrent, Nginx et FTPS. Elle est distribuée sous [licence Apache 2.0](LICENSE).

L'ensemble du projet a été orchestré avec **OpenAI Sol 6.1 Ultra**.

## Fonctionnalités

- **Torrents collectifs** : recherche et gestion des transferts via qBittorrent.
- **Bibliothèque partagée** : exploration, téléchargement et liens de lecture révocables, avec ouverture dans VLC.
- **Accès web et FTPS** : mêmes espaces de fichiers et accès réservés aux comptes actifs et approuvés.
- **Gestion de la communauté** : validation des inscriptions, administration des comptes et permission dédiée à la gestion des sources de recherche.
- **Connexion sur téléviseur** : autorisation depuis un téléphone par QR code, sans saisir le mot de passe sur la télé.
- **Exploitation documentée** : Docker Compose, HTTPS/FTPS, sauvegardes chiffrées et migration des comptes Meteor.

## Un serveur, une bibliothèque commune

| Espace | Rôle | Accès des membres |
| --- | --- | --- |
| `downloads` | Fichiers gérés par qBittorrent | Lecture via le site et FTPS ; suppression de fichiers et dossiers par les administrateurs |
| `share` | Fichiers déposés par la communauté | Lecture et modification via le site et FTPS |

Les deux espaces sont collectifs. Retirer un torrent conserve ses fichiers ; supprimer ses données exige une confirmation explicite et affecte toute la communauté.

Les administrateurs actifs et approuvés peuvent aussi supprimer directement des fichiers et dossiers de `downloads` via le site et FTPS. La suppression est définitive pour tous ; le site demande une confirmation. Upload, renommage et création de dossiers y restent interdits. Les fichiers encore gérés par qBittorrent peuvent être signalés manquants ou téléchargés de nouveau.

## Docker local

Avec Docker, Compose et npm disponibles, lancer depuis la racine du dépôt :

```sh
npm run local:up
npm run local:admin
```

`local:up` construit les images et démarre la configuration autonome [compose.local.yaml](compose.local.yaml), sans fichier `.env` ni installation des dépendances npm sur l’hôte. Le schéma PostgreSQL est initialisé automatiquement. Ouvrir [http://127.0.0.1:5180](http://127.0.0.1:5180), puis se connecter avec le compte fictif `admin` et le mot de passe `local-admin-password` (`admin@example.com`). `local:admin` crée ce premier administrateur et refuse de modifier une base contenant déjà des utilisateurs : l’exécuter uniquement au premier lancement.

L’origine HTTP `http://127.0.0.1:5180` est incluse dans l’image à la construction ; pour changer cette URL, adapter `build.args.ORIGIN`, `ORIGIN`, `BETTER_AUTH_URL` et le port publié dans `compose.local.yaml`, puis reconstruire avec `npm run local:up`.

```sh
npm run local:logs  # Suivre les journaux
npm run local:down  # Arrêter en conservant les données
npm run local:up    # Reconstruire et redémarrer après une modification du code
```

Les données restent dans des volumes nommés dédiés à cette pile locale, y compris après `local:down`. Seul le site publie un port, sur `127.0.0.1:5180` ; PostgreSQL et le RPC qBittorrent restent internes. Le port `5180` et le sous-réseau Docker `172.30.20.0/24` doivent être libres. Une autre pile Torrents Duck ne peut pas utiliser ce sous-réseau en parallèle ; arrêter ses conteneurs sans libérer son réseau ne suffit pas.

Cette configuration utilise des identifiants fictifs pour les essais locaux, sans Nginx, FTPS ni envoi de mails réels. qBittorrent fonctionne sur un réseau interne sans accès aux pairs ni aux indexeurs Internet : les essais du moteur utilisent des torrents de test, des résultats de recherche simulés et des appels API locaux, sans téléchargement public.

## Utilisation

### Comptes et validation

L’inscription est libre ; chaque nouveau compte reste sur une page d’attente, sans accès aux services, jusqu’à sa validation par un administrateur. L’adresse configurée dans `ADMIN_EMAIL` reçoit automatiquement le rôle administrateur à son inscription ; ses accès s’activent après confirmation de son adresse par mail.

### Connexion sur téléviseur

Pour connecter une télé sans y saisir son mot de passe, choisir « Se connecter avec mon téléphone » sur la page de connexion. Scanner le QR code, se connecter sur le téléphone si nécessaire, comparer le code affiché sur les deux écrans puis autoriser la connexion. Le QR code expire après cinq minutes et ne peut servir qu’une fois. N’autoriser que les demandes lancées sur son propre appareil. Une déconnexion sur un appareil ferme toutes les sessions web du compte, y compris sur la télé, et annule ses QR codes déjà autorisés mais pas encore utilisés. Les écrans ouverts détectent la déconnexion en quelques secondes lorsque leur connexion réseau est disponible. Les deux appareils doivent pouvoir accéder à la même adresse du site (HTTPS en production).

### Lecture dans VLC

Dans l’explorateur, l’action « Ouvrir dans VLC » prépare un lien de lecture valable six heures et révocable. Sur Android, iPhone et iPad, toucher ensuite le bouton « Ouvrir dans VLC » de la fenêtre pour transmettre le média à l’application installée ; le navigateur peut demander confirmation. Le site ne peut pas vérifier si VLC est installé. La copie du lien et la playlist restent disponibles, notamment sur ordinateur ou si le navigateur bloque l’ouverture de l’application.

### Recherche et sources

La page Recherche permet de trouver des torrents puis de les ajouter aux
transferts collectifs. Le catalogue initial comprend The Pirate Bay, Torrents CSV,
Nyaa.si et LimeTorrents ; Snowfl est disponible en installation facultative. Un administrateur
peut attribuer à certains membres le droit supplémentaire « Gestionnaire des
sources » pour installer, activer, désactiver ou retirer les plugins du catalogue.
Les versions sont incluses dans l'image qBittorrent et leurs
[sources et licences](deploy/qbittorrent/search/SOURCES.md) sont conservées dans
le dépôt. La disponibilité des indexeurs externes peut varier.

Les gestionnaires peuvent aussi ajouter une source par URL, avec détection
JSON, RSS/Atom/Torznab ou HTML contenant des magnets, fichiers torrent ou hashes
reconnus. Utiliser `{query}` pour les mots-clés, ou une liste/un flux fixe filtré
par nom. L'authentification HTTP Basic, Bearer ou `X-Api-Key` est facultative et
exige HTTPS. URL et identifiants sont chiffrés côté serveur ; les sources et leurs
accès sont partagés entre les membres approuvés. En cas d'échec, copier le rapport
de détection depuis Sources ou Recherche pour demander un nouvel adaptateur.
Voir les [limites et la procédure](docs/deployment.md#recherche-et-sources).
Appliquer `db:migrate` sur une installation existante pour créer `search_sources`.

Les tris (seeders, leechers, date récente, taille ou nom) et les filtres de
seeders minimum et de taille s'appliquent avant pagination sur un maximum de
2 000 résultats ; une limite atteinte est signalée. La recherche peut cibler une
source ou toutes les sources actives. Les dates non fournies par le moteur
restent inconnues ; celles de Snowfl et LimeTorrents sont approximatives lorsqu'elles existent.

### Jauges de transfert

Les jauges de transfert utilisent les pics de réception et d’envoi observés par le serveur. Ces deux maxima sont conservés dans une seule ligne PostgreSQL, commune à tous les navigateurs, et remplacés seulement lorsqu’ils sont dépassés ; aucun historique de débits n’est enregistré. Sur une installation existante, appliquer le schéma avec la commande `db:migrate` ci-dessous avant de redémarrer la nouvelle version.

## Développement

Node.js 24+, PostgreSQL 17 et une instance qBittorrent sont nécessaires. Copier [.env.example](.env.example) vers `.env`, choisir les secrets, et adapter `DATABASE_URL`, `QBT_URL`, `ORIGIN` et les chemins locaux.

Pour les mails, définir `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` (domaine vérifié dans Mailgun), `MAILGUN_FROM` (par exemple `Torrents Duck <noreply@mg.example.com>`) et `MAILGUN_API_URL` : `https://api.mailgun.net` pour un domaine US ou `https://api.eu.mailgun.net` pour un domaine EU. Les mails de réinitialisation, de confirmation et de notification des inscriptions utilisent l’API Mailgun ; sans clé Mailgun, configurer `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` et `SMTP_FROM` dans `.env`. Chaque inscription avertit les administrateurs actifs et validés, avec un lien vers `/admin` ; en l’absence d’administrateur actif, le mail est envoyé à `ADMIN_EMAIL` si elle est définie. Un échec d’envoi est journalisé sans annuler l’inscription. Garder les clés et mots de passe dans `.env`, jamais dans Git.

Définir `ADMIN_EMAIL=admin@example.com` pour attribuer automatiquement le rôle admin lors de la création de ce compte, sans tenir compte de la casse. Le lien envoyé par mail active ses accès ; la page d’attente permet de renvoyer ce lien en cas d’échec d’envoi ou d’expiration. Les autres comptes restent soumis à la validation d’un administrateur. Une valeur vide désactive cette attribution ; changer la variable ne modifie pas les comptes existants.

```sh
npm ci
node --env-file=.env --run db:migrate
npm run dev
```

Pour les fichiers locaux, définir `DATA_ROOT=./data`, `DOWNLOADS_DIR=./data/downloads`, `SHARE_DIR=./data/share` et `FILE_DELIVERY=node`, puis créer ces dossiers. Définir `ORIGIN` et `BETTER_AUTH_URL` sur `http://127.0.0.1:5173`, et `DATABASE_URL` sur le port PostgreSQL publié sur l’hôte (`postgres` est un nom interne à Docker). `npm run dev` charge automatiquement `.env` au démarrage ; redémarrer le serveur après toute modification de ce fichier. Le compte administrateur initial se crée avec `node --env-file=.env --run admin:create` et les variables `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. En cas de migration des comptes Meteor, effectuer l'import avant cette création : l'import exige une table utilisateurs vide.

### Vérifications

```sh
npm run check
npm test
npm run build
python3 deploy/test_services.py
node --test scripts/backup.test.mjs
python3 scripts/backup-ftp.test.py
docker compose --env-file .env.example config --no-env-resolution -q
```

`npm test` exécute les fichiers `tests/**/*.test.ts`. Définir `TEST_DATABASE_URL` vers une base de test dédiée pour inclure les tests PostgreSQL ; sans cette variable, ils sont ignorés. Le parcours HTTP complet se vérifie séparément avec `node --test tests/http-flow.test.mjs`, en définissant `HTTP_BASE_URL`, `HTTP_ADMIN_LOGIN` et `HTTP_ADMIN_PASSWORD` pour une instance locale et un administrateur de test. Ces tests écrivent des données : ne jamais les pointer vers la production.

## Installation et récupération des comptes

Suivre le guide Ubuntu 24.04 LTS et Docker en [français](docs/deployment.md) ou en [anglais](docs/deployment.en.md), puis [le guide de sauvegarde et migration depuis Meteor](docs/migration-backups.md) si nécessaire. L'installation couvre les ports, les secrets, PostgreSQL, les certificats HTTPS/FTPS, le premier administrateur, les sauvegardes et les mises à jour. Aucun script ne reformate un disque et aucun identifiant SSH n'est embarqué. Les services PostgreSQL et RPC qBittorrent ne publient aucun port. Les téléchargements HTTP passent par une autorisation de session, puis Nginx sert les fichiers.

Les deux espaces sont collectifs : `downloads` est géré par qBittorrent, accessible en lecture aux membres et en suppression aux administrateurs via le site et FTPS ; `share` est modifiable via le site et FTPS. Le FTPS explicite utilise le port 21000 et exige TLS pour les commandes et les données.

Une sauvegarde FTP chiffrée facultative peut partir directement du serveur chaque nuit, sans Mac allumé : PostgreSQL et configuration complets, puis les fichiers de `share` qui tiennent dans le quota, en commençant par les plus petits. Elle est désactivée par défaut ; le [guide de sauvegarde](docs/migration-backups.md#sauvegarde-ftp-automatique-depuis-le-serveur) décrit les clés `age`, le quota de 100 Go, la rétention et la restauration. Les téléchargements et l'état qBittorrent restent exclus.

Les images et le fonctionnement sur le serveur doivent être validés avec les essais du guide avant ouverture. Les fichiers et anciens torrents du serveur historique ne sont pas inclus dans la migration des comptes.

## Contribuer

Les issues et pull requests peuvent décrire un problème reproductible ou une amélioration ciblée. Exécuter les vérifications ci-dessus avant de proposer un changement. Utiliser des données fictives dans les exemples, captures et journaux ; conserver les domaines de production, sauvegardes, clés et fichiers `.env` hors du dépôt.

## Licence

Sous [licence Apache 2.0](LICENSE), comme le projet TorrentsDuck d'origine. Les
[plugins de recherche tiers](deploy/qbittorrent/search/SOURCES.md) conservent
leurs licences BSD, MIT ou GPL, incluses avec leurs sources.
