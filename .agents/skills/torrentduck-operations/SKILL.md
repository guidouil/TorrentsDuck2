---
name: torrentduck-operations
description: 'Modifier et vérifier les opérations de Torrents Duck 2 : Docker Compose, déploiement Ubuntu, pare-feu qBittorrent, certificats FTPS, sauvegardes chiffrées et import de comptes Meteor.'
---

# Opérations Torrents Duck 2

Les chemins de code et commandes se résolvent depuis la racine du dépôt ; les liens documentaires sont relatifs à ce fichier.
Adapter le travail à la demande et à son autorisation existante ; charger ce skill ne déclenche aucune action en production.

## Sources à consulter selon la tâche

- Déploiement et mise à jour : [guide français](../../../docs/deployment.md), [guide anglais](../../../docs/deployment.en.md), `compose.yaml`, `scripts/deploy.sh` et `deploy/systemd/`.
- Sauvegarde, restauration et comptes Meteor : [guide de migration](../../../docs/migration-backups.md), `scripts/backup*.mjs`, `scripts/backup-remote.sh`, `scripts/restore-backup.mjs` et `scripts/migrate-users.ts`.
- Certificats : `scripts/deploy-certificates.sh` et ses tests dans `deploy/test_services.py`.
- Répercuter les changements de procédure dans les deux guides de déploiement.

## Déploiement et isolation

- `.env` est lu par Compose ; ne pas l'exécuter avec `source` ou `. .env`. Ne pas afficher de configuration Compose résolue contenant de vrais secrets.
- Une installation neuve initialise PostgreSQL et le schéma avant l'émission des certificats et le démarrage public de Nginx/FTPS. L'import Meteor précède toute création de compte.
- `scripts/deploy.sh` modifie l'hôte Ubuntu : unités systemd, pare-feu, images, schéma et services. Ce script ne sert pas de vérification locale.
- Préserver `DATA_ROOT` et les secrets existants. Modifier les variables de mot de passe ne modifie pas les rôles d'un volume PostgreSQL déjà initialisé ; une rotation coordonne base et application.
- La procédure de mise à jour conserve PostgreSQL 17 ; un changement de version majeure nécessite une migration dédiée.
- Les adresses qBittorrent `172.30.20.2` et `172.30.40.2` et leurs sous-réseaux sont couplés à `deploy/firewall.sh`, aux fixtures et aux guides. Modifier ces références ensemble.
- Le pare-feu doit précéder le démarrage automatique de Docker/qBittorrent. Conserver le filtrage de l'hôte et des destinations privées/métadonnées, les réponses RPC établies et le refus temporaire pendant la reconstruction des règles.
- Garder PostgreSQL `5432` et le RPC qBittorrent `8080` internes. Nginx renvoie 404 pour `/api/internal/` ; `/_protected/` reste réservé aux redirections internes autorisées, avec protection contre les liens symboliques.
- `downloads` et `share` sont collectifs. qBittorrent gère `downloads` ; seuls les administrateurs actifs et approuvés peuvent y supprimer des fichiers ou dossiers via le site et FTPS. Upload, renommage et création y restent interdits. Les montages `web` et `ftp` permettent cette suppression ; celui de Nginx reste en lecture seule. `share` accepte les écritures autorisées du site et de FTPS.
- FTPS impose TLS sur commandes et données. Une erreur de l'API interne ou une révocation doit fermer les sessions existantes ; ne pas remplacer ce comportement par une autorisation permissive.
- Le renouvellement prépare un PEM vérifié, recharge Nginx et redémarre FTP lorsqu'il change. Préserver `.reload-pending` pour reprendre un rechargement interrompu.

## Schéma et import Meteor

- `scripts/migrate-db.ts` n'exécute que `db/001-initial.sql` : ajouter un fichier SQL numéroté ne l'applique pas. Conserver les migrations rejouables et les données existantes.
- L'import est transactionnel et exige une table utilisateurs vide par défaut. Préserver l'ordre des verrous : advisory `782412`, verrou exclusif de `"user"`, puis lecture des identités.
- Passer explicitement les compteurs source `--expected-users=N --expected-admins=M` ; les valeurs par défaut ne décrivent pas toutes les installations.
- Exécuter d'abord sans `--apply`. Ce contrôle valide la source et ses compteurs, sans détecter les conflits de la base cible ni calculer les comptes ignorés.
- `--skip-existing` conserve un compte seulement si le pseudo correspond exactement, l'e-mail correspond sans tenir compte de la casse et le `legacyId` est compatible. Il ne fusionne pas les comptes et ne remplace ni droits, ni mot de passe, ni sessions.
- Garder la validation des droits, dates, identités et hash historiques. Vérifier la connexion d'un compte connu et le renouvellement de son hash après import.

## Sauvegarde et restauration

- Réutiliser les scripts existants et `age`. Les archives contiennent PostgreSQL et la configuration sensible ; les données de `downloads`, `share` et l'état qBittorrent sont exclus.
- Garder le texte clair temporaire distant dans le répertoire privé de `/dev/shm` et le flux local chiffré. Les clés privées et archives restent hors du dépôt.
- Préserver l'authentification complète de l'archive avant toute émission par `restore-backup.mjs`, ainsi que le refus d'écrasement des sauvegardes existantes.
- Utiliser `set -o pipefail` pour les pipelines de restauration/import documentés.
- Tester une restauration dans une base PostgreSQL 17 de test neuve, avant la création du schéma. Ne pas ajouter de suppression de tables pour forcer une restauration sur une base existante.
- Une sauvegarde peut être enregistrée localement même si la notification de son état au serveur échoue. Examiner ce cas avant une relance ; la purge ne suit que l'enregistrement réussi.
- Ne pas remplacer le `.env` d'une production par celui d'une archive ; examiner la configuration restaurée dans un dossier privé séparé.

## Vérifications ciblées

Choisir les contrôles correspondant aux fichiers modifiés ; les commandes suivantes utilisent les fixtures ou la configuration d'exemple :

```sh
python3 deploy/test_services.py
node --test scripts/backup.test.mjs
docker compose --env-file .env.example config --no-env-resolution -q
```

- Les tests `age` et certains contrôles Compose sont ignorés si leurs outils manquent ; signaler ces limites.
- Pour un changement d'import : `npm test -- tests/users-import.test.ts tests/auth-migration.test.ts`.
- Les tests PostgreSQL utilisent `TEST_DATABASE_URL` d'une base de test ; le parcours HTTP utilise une instance et un administrateur de test. Ces tests écrivent des données.
- Pour les protocoles réels, suivre la section dédiée du guide : construire les images de test, puis `python3 tests/infrastructure.integration.py` sur une instance séparée avec `172.30.20.0/24` et les ports `50000–50100` libres.
- Cette intégration ne valide ni ACME public, ni routage FTP externe, ni pare-feu Linux réel, ni pairs Internet. Rapporter les essais effectivement réalisés et les limites restantes.
