# Torrents Duck 2

[Installation en français](docs/deployment.md) · [Installation in English](docs/deployment.en.md)

Torrents Duck 2 est la suite de [TorrentsDuck](https://github.com/guidouil/TorrentsDuck), initialement développé avec Meteor. Cette nouvelle version utilise SvelteKit/TypeScript, Better Auth, PostgreSQL 17, qBittorrent, Nginx et FTPS pour gérer une bibliothèque de torrents et de fichiers partagée.

L’inscription est libre ; chaque nouveau compte reste sur une page d’attente, sans accès aux services, jusqu’à sa validation par un administrateur. L’adresse configurée dans `ADMIN_EMAIL` reçoit automatiquement le rôle administrateur à son inscription ; ses accès s’activent après confirmation de son adresse par mail.

Pour connecter une télé sans y saisir son mot de passe, choisir « Se connecter avec mon téléphone » sur la page de connexion. Scanner le QR code, se connecter sur le téléphone si nécessaire, comparer le code affiché sur les deux écrans puis autoriser la connexion. Le QR code expire après cinq minutes et ne peut servir qu’une fois. N’autoriser que les demandes lancées sur son propre appareil ; le navigateur de la télé reste connecté jusqu’à sa déconnexion ou l’expiration de sa session. Les deux appareils doivent pouvoir accéder à la même adresse du site (HTTPS en production).

Dans l’explorateur, l’action « Ouvrir dans VLC » prépare un lien de lecture valable six heures et révocable. Sur Android, iPhone et iPad, toucher ensuite le bouton « Ouvrir dans VLC » de la fenêtre pour transmettre le média à l’application installée ; le navigateur peut demander confirmation. Le site ne peut pas vérifier si VLC est installé. La copie du lien et la playlist restent disponibles, notamment sur ordinateur ou si le navigateur bloque l’ouverture de l’application.

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

Cette configuration utilise des identifiants fictifs pour les essais locaux, sans Nginx, FTPS ni envoi de mails réels. qBittorrent fonctionne sur un réseau interne sans accès aux pairs Internet : les essais du moteur utilisent des torrents de test et des appels API locaux, sans téléchargement public.

## Développement

Node 24 et PostgreSQL 17 sont nécessaires. Copier `.env.example` vers `.env`, choisir les secrets, et adapter `DATABASE_URL`, `QBT_URL`, `ORIGIN` et les chemins locaux.

Pour les mails, définir `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` (domaine vérifié dans Mailgun), `MAILGUN_FROM` (par exemple `Torrents Duck <noreply@mg.example.com>`) et `MAILGUN_API_URL` : `https://api.mailgun.net` pour un domaine US ou `https://api.eu.mailgun.net` pour un domaine EU. Les mails de réinitialisation, de confirmation et de notification des inscriptions utilisent l’API Mailgun ; sans clé Mailgun, la configuration `SMTP_*` existante reste utilisable. Chaque inscription avertit les administrateurs actifs et validés, avec un lien vers `/admin` ; en l’absence d’administrateur actif, le mail est envoyé à `ADMIN_EMAIL` si elle est définie. Un échec d’envoi est journalisé sans annuler l’inscription. Garder la clé dans `.env`, jamais dans Git.

Définir `ADMIN_EMAIL=admin@example.com` pour attribuer automatiquement le rôle admin lors de la création de ce compte, sans tenir compte de la casse. Le lien envoyé par mail active ses accès ; la page d’attente permet de renvoyer ce lien en cas d’échec d’envoi ou d’expiration. Les autres comptes restent soumis à la validation d’un administrateur. Une valeur vide désactive cette attribution ; changer la variable ne modifie pas les comptes existants.

```sh
npm ci
node --env-file=.env --run db:migrate
npm run dev
```

Pour les fichiers locaux, définir `DATA_ROOT=./data`, `DOWNLOADS_DIR=./data/downloads`, `SHARE_DIR=./data/share` et `FILE_DELIVERY=node`, puis créer ces dossiers. Définir `ORIGIN` et `BETTER_AUTH_URL` sur `http://127.0.0.1:5173`, et `DATABASE_URL` sur le port PostgreSQL publié sur l’hôte (`postgres` est un nom interne à Docker). `npm run dev` charge automatiquement `.env` au démarrage ; redémarrer le serveur après toute modification de ce fichier. Le compte administrateur initial se crée avec `node --env-file=.env --run admin:create` et les variables `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. En cas de migration des comptes Meteor, effectuer l'import avant cette création : l'import exige une table utilisateurs vide.

```sh
npm run check
npm test
npm run build
python3 deploy/test_services.py
node --test scripts/backup.test.mjs
docker compose --env-file .env.example config --no-env-resolution -q
```

Définir `TEST_DATABASE_URL` pour exécuter aussi les tests d'authentification sur PostgreSQL. Le parcours HTTP complet se vérifie avec `node --test tests/http-flow.test.mjs`, en définissant `HTTP_BASE_URL`, `HTTP_ADMIN_LOGIN` et `HTTP_ADMIN_PASSWORD` pour une instance locale et un administrateur de test.

## Installation et récupération des comptes

Suivre le guide Ubuntu 24.04 LTS et Docker en [français](docs/deployment.md) ou en [anglais](docs/deployment.en.md), puis [le guide de sauvegarde et migration depuis Meteor](docs/migration-backups.md) si nécessaire. L'installation couvre les ports, les secrets, PostgreSQL, les certificats HTTPS/FTPS, le premier administrateur, les sauvegardes et les mises à jour. Aucun script ne reformate un disque et aucun identifiant SSH n'est embarqué. Les services PostgreSQL et RPC qBittorrent ne publient aucun port. Les téléchargements HTTP passent par une autorisation de session, puis Nginx sert les fichiers.

Les deux espaces sont collectifs : `downloads` est géré par qBittorrent et accessible en lecture via le site et FTPS ; `share` est modifiable via le site et FTPS. Le FTPS explicite utilise le port 21000 et exige TLS pour les commandes et les données.

Les images et le fonctionnement sur le serveur doivent être validés avec les essais du guide avant ouverture. Les fichiers et anciens torrents du serveur historique ne sont pas inclus dans la migration des comptes.

## Contribuer

Les issues et pull requests peuvent décrire un problème reproductible ou une amélioration ciblée. Exécuter les vérifications ci-dessus avant de proposer un changement. Utiliser des données fictives dans les exemples, captures et journaux ; conserver les domaines de production, sauvegardes, clés et fichiers `.env` hors du dépôt.

## Licence

Sous [licence Apache 2.0](LICENSE), comme le projet TorrentsDuck d'origine.
