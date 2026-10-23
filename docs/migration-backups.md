# Comptes historiques et sauvegardes chiffrées

## Clé de sauvegarde sur le Mac

Installer [age](https://github.com/FiloSottile/age) sur le Mac (`brew install age`) et conserver la clé privée hors du dépôt. Le chiffrement utilise un destinataire public ; les scripts ne demandent aucun secret dans les arguments de commande et n'écrivent aucun export sensible en clair sur le Mac.

```sh
umask 077
mkdir -p "$HOME/.config/torrentduck" "$HOME/TorrentsDuck-backups"
age-keygen -o "$HOME/.config/torrentduck/backup-identity.txt"
age-keygen -y "$HOME/.config/torrentduck/backup-identity.txt"
```

Copier la ligne publique `age1…` dans les commandes suivantes. Conserver une seconde copie protégée de la clé privée : sans elle, les sauvegardes ne sont pas récupérables. Ne pas envoyer cette clé dans une conversation.

## Exporter avant tout effacement

Les outils suivants effectuent uniquement des lectures sur les services historiques. Ils utilisent une session SSH normale, sa configuration locale et éventuellement son invite de mot de passe. Ils ne stockent pas le mot de passe SSH. L'utilisateur doit déjà pouvoir appeler Docker. Le script ne demande pas sudo par défaut ; `--sudo` permet d'utiliser des droits d'audit existants si nécessaire, sans les élargir automatiquement. Une configuration facultative illisible est signalée sur stderr ; un export de comptes impossible arrête toute l'opération.

L'hôte SSH doit être indiqué explicitement avec `--host`, sous forme d'alias SSH ou de `utilisateur@hôte`. Les valeurs par défaut pour MongoDB sont le conteneur `mongodb` et la base `TorrentsDuck` ; vérifier ces noms sur l'installation Meteor et les adapter avec les options si nécessaire. Depuis le Mac :

```sh
node scripts/export-legacy.mjs --host operator@legacy.example.com --mongo-container mongodb --database TorrentsDuck --recipient age1… --output "$HOME/TorrentsDuck-backups/legacy.tar.age"
node scripts/restore-backup.mjs verify "$HOME/TorrentsDuck-backups/legacy.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt"
```

L'export conserve `_id`, pseudo, e-mails et leur vérification, date, droits `isAdmin`/`isValid` (et `roles`/`allowed` si présents), hash `services.password.bcrypt`. Les anciennes sessions, jetons, mots de passe en clair et messages ne sont pas exportés. Les configurations lisibles de Nginx, `/opt/mup-nginx-proxy/config`, `/etc/bind`, fstab, Docker, sshd et l'inspection du conteneur MongoDB sont incluses **dans l'archive chiffrée** ; une inspection Docker peut contenir des secrets de configuration. Les fichiers temporaires distants restent dans un répertoire privé de `/dev/shm` (tmpfs) et sont supprimés à la fin. Aucun fichier de torrent n'est copié.

Sur une base PostgreSQL **de test vide**, initialiser le schéma, puis contrôler l'import sans l'appliquer. Remplacer `N` par le nombre total de comptes de la source et `M` par son nombre d'administrateurs ; ces compteurs portent toujours sur l'archive complète, avant tout filtrage. `/dev/stdin` évite un fichier d'utilisateurs en clair :

```sh
set -o pipefail
node scripts/restore-backup.mjs users "$HOME/TorrentsDuck-backups/legacy.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt" | node --env-file=.env --import tsx scripts/migrate-users.ts /dev/stdin --expected-users=N --expected-admins=M
```

Comparer le nombre de comptes, les administrateurs et les droits effectifs avec l'installation Meteor source. Le script rejette comptes invalides, doublons, dates absentes, hash mal formé et compte de droits inconnus ; il n'invente pas de mot de passe ni d'e-mail. L'import avec `--apply` est transactionnel et exige par défaut que la table utilisateurs soit vide. Tester un compte dont le mot de passe est connu et vérifier son changement de hash avant d'effacer l'ancien serveur.

Après réinstallation et initialisation PostgreSQL sur le nouveau serveur, transmettre le même flux via SSH :

```sh
set -o pipefail
node scripts/restore-backup.mjs users "$HOME/TorrentsDuck-backups/legacy.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt" | ssh -T NOUVEL_ALIAS 'cd /opt/torrentduck && sudo -n docker compose run --rm -T --no-deps --entrypoint node web --import tsx scripts/migrate-users.ts /dev/stdin --expected-users=N --expected-admins=M --apply'
```

La vérification complète du chiffrement précède toute émission du JSON ; une archive corrompue ne peut donc pas déclencher un import partiel. La réussite du seul export ne prouve pas la capacité de restauration : le test de base vide et la connexion restent obligatoires.

## Importer en conservant des comptes déjà inscrits

Si un administrateur a déjà été recréé par inscription, `--skip-existing` permet de le conserver et d'importer les autres comptes. Sauvegarder d'abord la base actuelle et tester la procédure sur une copie de test. Sans cette option, `--apply` continue d'exiger une table utilisateurs vide.

Un compte source est ignoré uniquement si un seul compte existant porte **exactement le même pseudo** et le même e-mail sans tenir compte de la casse, et si son `legacyId` est `NULL` ou correspond à l'identifiant historique. Aucun champ du compte conservé n'est modifié : identifiant, droits, approbation, vérification d'e-mail, mot de passe, sessions et jetons actuels restent en place. Les autres comptes sont importés avec leurs droits et leur hash historiques.

Une correspondance partielle, un identifiant ou `legacyId` déjà attribué à un autre compte, ou une ambiguïté entre le pseudo d'un compte et l'e-mail d'un autre arrête toute la transaction. Aucune insertion partielle n'est conservée. Résoudre ces conflits avant de relancer ; l'option ne fusionne pas les identités.

Vérifier d'abord la source sans `--apply`, avec les mêmes compteurs `N` et `M` que ci-dessus :

```sh
set -o pipefail
node scripts/restore-backup.mjs users "$HOME/TorrentsDuck-backups/legacy.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt" | node --env-file=.env --import tsx scripts/migrate-users.ts /dev/stdin --expected-users=N --expected-admins=M --skip-existing
```

Ce contrôle valide uniquement les comptes et compteurs de l'archive. Il ne lit pas la base cible et ne détecte donc pas ses conflits ni le nombre de comptes qui seront ignorés. `--skip-existing` agit lors de l'application :

```sh
set -o pipefail
node scripts/restore-backup.mjs users "$HOME/TorrentsDuck-backups/legacy.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt" | ssh -T NOUVEL_ALIAS 'cd /opt/torrentduck && sudo -n docker compose run --rm -T --no-deps --entrypoint node web --import tsx scripts/migrate-users.ts /dev/stdin --expected-users=N --expected-admins=M --skip-existing --apply'
```

Après réussite, une ligne JSON supplémentaire indique `imported` (comptes ajoutés) et `skipped` (comptes existants conservés). Comparer leur somme au total de la source, puis vérifier les droits des comptes importés, leur connexion et la connexion de l'administrateur conservé avec son mot de passe actuel. L'import ne remplace pas ce mot de passe par son ancien hash Meteor.

## Sauvegarde régulière récupérée par le Mac

Configurer un alias SSH avec clé publique vers la **nouvelle** machine. À partir du Mac :

```sh
node scripts/backup.mjs --host NOUVEL_ALIAS --recipient age1… --directory "$HOME/TorrentsDuck-backups" --keep 14
```

Le serveur émet un dump PostgreSQL cohérent et les configurations `.env`, Compose et `deploy/` ; seul le flux chiffré arrive sur le disque du Mac. Le compte SSH doit lire ces fichiers et appeler Docker, ce qui équivaut à un accès administrateur sur cet hôte. Les données temporairement nécessaires au tar restent dans `/dev/shm` avec permissions privées. Les téléchargements, fichiers de Partage et état des torrents sont exclus : prévoir une autre stratégie si leur conservation devient nécessaire.

Le script attend la fin réussie de SSH et age, synchronise le fichier, refuse d'écraser une archive existante, calcule son SHA256, enregistre le résultat auprès de l'application puis conserve les 14 dernières copies de cet hôte. Il renvoie un échec si le serveur ne peut pas enregistrer la date, même si la copie locale est déjà présente. `last-backup.json` contient uniquement nom, date et empreinte de la copie locale ; il ne contient pas de clé.

L'exécution peut être attachée au planificateur du Mac en utilisant des chemins absolus vers Node, le dépôt et la destination. Une machine éteinte ou sans réseau ne sauvegarde pas. La date affichée dans l'administration rend ce retard visible, sans promettre une sauvegarde indépendante du Mac.

## Restauration et essais

Vérifier l'archive avant toute restauration. Pour une base PostgreSQL 17 vide sur une installation de test, **avant la création du schéma** :

```sh
set -o pipefail
node scripts/restore-backup.mjs database "$HOME/TorrentsDuck-backups/COPIE.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt" | ssh -T ALIAS_TEST 'cd /opt/torrentduck && sudo -n docker compose exec -T postgres pg_restore --exit-on-error --no-owner --no-acl -U duck -d duck'
```

Cette commande ne détruit aucune base existante pour forcer la restauration : si des tables existent, elle échoue. Utiliser une base de test neuve. Restaurer la configuration dans un dossier temporaire privé après vérification, examiner les domaines, chemins et secrets, puis copier les seuls fichiers nécessaires ; ne pas écraser `.env` d'une production en cours.

```sh
python3 deploy/test_services.py
node --test scripts/backup.test.mjs
```

Le test age fait un aller-retour chiffré avec un compte accentué puis corrompt l'archive et vérifie que la restauration échoue sans émettre de JSON. Il est explicitement ignoré si `age` n'est pas installé. Ces essais ne remplacent pas un test PostgreSQL restauré ni la vérification des comptes et droits de l'installation migrée.
