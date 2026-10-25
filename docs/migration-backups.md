# Comptes historiques et sauvegardes chiffrées

## Clé de sauvegarde sur le Mac

Installer [age](https://github.com/FiloSottile/age) sur le Mac (`brew install age`) et conserver la clé privée hors du dépôt. Le chiffrement utilise un destinataire public ; les scripts ne demandent aucun secret dans les arguments de commande et n'écrivent aucun export sensible en clair sur le Mac.

```sh
umask 077
mkdir -p "$HOME/.config/torrentduck" "$HOME/TorrentsDuck-backups"
age-keygen -o "$HOME/.config/torrentduck/backup-identity.txt"
age-keygen -y "$HOME/.config/torrentduck/backup-identity.txt"
```

Copier la ligne publique `age1…` dans les commandes suivantes, ou dans `BACKUP_AGE_RECIPIENT` pour la sauvegarde FTP. Si aucune identité n'existe encore, cette création est nécessaire avant l'activation du FTP ; les identifiants FTP seuls ne permettent pas de chiffrer une archive. Conserver une seconde copie protégée de la clé privée : sans elle, les sauvegardes ne sont pas récupérables. Ne pas envoyer cette clé dans une conversation.

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

## Sauvegarde FTP automatique depuis le serveur

Cette option envoie une archive `age` directement depuis le nouveau serveur. Elle complète la récupération SSH par le Mac, dont le périmètre reste inchangé. Le serveur nécessite Python 3, Docker Compose et `age` (`sudo apt-get install -y age` sur Ubuntu). Créer la clé sur le poste de sauvegarde avec la procédure en début de guide ; copier seulement sa ligne publique `age1…` dans la configuration du serveur. Ne conserver aucune clé privée de déchiffrement sur le serveur de production ou l'espace FTP.

Après activation de l'espace de sauvegarde chez le fournisseur, éditer les variables `BACKUP_FTP_*` et `BACKUP_AGE_RECIPIENT` de `.env` ; ne pas charger `.env` dans un shell ni afficher la configuration résolue. Laisser `BACKUP_FTP_ENABLED=false` tant que la clé publique n'a pas été créée et renseignée. Les valeurs ci-dessous sont fictives :

```dotenv
BACKUP_FTP_ENABLED=true
BACKUP_FTP_HOST=backup.example.com
BACKUP_FTP_PORT=21
BACKUP_FTP_USER=backup-user
BACKUP_FTP_PASSWORD='replace-with-a-unique-secret'
BACKUP_FTP_TLS=false
BACKUP_FTP_DIRECTORY=torrents-duck
BACKUP_AGE_RECIPIENT=age1…
BACKUP_FTP_QUOTA_BYTES=100000000000
BACKUP_FTP_KEEP=1
```

`BACKUP_FTP_ENABLED` vaut `false` par défaut. La configuration est lue par Compose dans l'extension `x-backup-ftp`. `BACKUP_FTP_TLS=true` impose le FTPS explicite et un certificat valide ; utiliser le protocole réellement proposé par le fournisseur. Le FTP sans TLS transmet les identifiants en clair, même si le contenu est chiffré par `age`. Pour Dedibackup, les envois doivent provenir du réseau Dedibox et le compte est limité à 1 000 fichiers : vérifier hôte, accès et contraintes dans la [documentation Scaleway](https://www.scaleway.com/en/docs/dedibox/how-to/use-dedibackup-ftp-backup/). Ce service sortant est distinct du FTPS des membres.

Chaque archive contient toujours le dump PostgreSQL complet et la configuration `.env`, Compose et `deploy/`. Elle inclut ensuite les fichiers ordinaires de `share` par taille croissante dans le budget disponible ; les gros fichiers peuvent donc être absents. `downloads` et l'état qBittorrent ne sont jamais inclus. Le fichier `backup-manifest.json` de l'archive recense les chemins et tailles sélectionnés, leur nombre (`included`), le volume total des fichiers ordinaires candidats (`totalBytes`), le nombre (`excludedForSpace`) et le volume (`excludedBytes`) écartés par manque de place, et le nombre d'entrées écartées pour sécurité (`excludedUnsafe`, notamment les liens). Vérifier ce manifeste avant de considérer le Partage comme sauvegardé ; cette copie de fichiers actifs ne constitue pas un instantané cohérent avec le dump PostgreSQL.

Le budget de chaque archive est au plus `BACKUP_FTP_QUOTA_BYTES / (BACKUP_FTP_KEEP + 1)`. Par défaut, 100 Go décimaux et une copie conservée donnent au plus 50 Go par archive, base, configuration, manifeste et chiffrement compris : l'ancienne copie reste disponible pendant la création de la nouvelle. Si même la base et la configuration complètes ne tiennent pas, la sauvegarde échoue. Utiliser un dossier FTP dédié ; les fichiers inconnus présents dans ce dossier sont comptés sans être supprimés. Le script ne connaît pas l'occupation du reste du compte : réduire le quota configuré si d'autres usages y consomment de la place.

Seule une copie temporaire chiffrée est écrite dans `DATA_ROOT/backup-ftp`, avec un budget calculé au départ pour laisser la réserve disque de 10 %. Le dump et la configuration temporaires en clair restent dans le répertoire privé de `/dev/shm`. L'envoi utilise un nom `.partial`, contrôle la taille distante puis renomme l'archive. Le script relit ensuite entièrement le fichier distant avec `RETR`, en flux, pour vérifier que son SHA256 correspond à celui de la copie locale chiffrée ; prévoir le trafic d'un envoi et d'un téléchargement complets par sauvegarde. L'application doit ensuite enregistrer la réussite avant toute purge des anciennes archives du script. Si cet enregistrement échoue, la nouvelle copie peut déjà être présente sur FTP alors que la date de l'administration n'a pas avancé ; examiner les archives avant de relancer. Aucun fichier inconnu n'est purgé.

`scripts/deploy.sh` installe le service et le timer systemd. Le timer s'exécute chaque jour à 03 h 30, heure du serveur, avec jusqu'à 30 minutes de délai aléatoire ; sans activation dans `.env`, aucun transfert n'est effectué. Depuis la racine du dépôt sur le serveur :

```sh
sudo systemctl start torrentduck-backup.service
sudo systemctl list-timers torrentduck-backup.timer --no-pager
sudo journalctl -u torrentduck-backup.service -n 50 --no-pager
```

Pour un lancement manuel sans systemd, utiliser `sudo python3 scripts/backup-ftp.py`. Vérifier un premier envoi, récupérer l'archive chiffrée sur le poste de sauvegarde et effectuer les essais de restauration ci-dessous. La présence d'une archive et la date d'administration ne prouvent pas à elles seules sa restauration.

## Restauration et essais

Vérifier l'archive avant toute restauration. Pour une base PostgreSQL 17 vide sur une installation de test, **avant la création du schéma** :

```sh
set -o pipefail
node scripts/restore-backup.mjs database "$HOME/TorrentsDuck-backups/COPIE.tar.age" --identity "$HOME/.config/torrentduck/backup-identity.txt" | ssh -T ALIAS_TEST 'cd /opt/torrentduck && sudo -n docker compose exec -T postgres pg_restore --exit-on-error --no-owner --no-acl -U duck -d duck'
```

Cette commande ne détruit aucune base existante pour forcer la restauration : si des tables existent, elle échoue. Utiliser une base de test neuve. Restaurer la configuration dans un dossier temporaire privé après vérification, examiner les domaines, chemins et secrets, puis copier les seuls fichiers nécessaires ; ne pas écraser `.env` d'une production en cours.

Pour examiner une archive FTP récupérée sur le poste de sauvegarde, vérifier d'abord tout son chiffrement, puis extraire dans un **nouveau dossier privé**, jamais dans le `share` actif ni dans le dépôt :

```sh
set -o pipefail
umask 077
archive="$HOME/TorrentsDuck-backups/COPIE.tar.age"
identity="$HOME/.config/torrentduck/backup-identity.txt"
restore_dir=$(mktemp -d "$HOME/TorrentsDuck-restore.XXXXXX")
node scripts/restore-backup.mjs verify "$archive" --identity "$identity" &&
  age --decrypt --identity "$identity" "$archive" | tar -x -f - -C "$restore_dir"
```

Dans ce dossier isolé, examiner `backup-manifest.json`, `share/` et `config/`, et comparer les fichiers restaurés aux fichiers sélectionnés. Des fichiers de Partage ignorés par le quota ne peuvent pas être restaurés depuis cette archive. Tester le dump avec la commande PostgreSQL ci-dessus ; ne recopier dans le Partage collectif que les fichiers nécessaires après examen et sans écraser de données existantes. Garder la configuration et ses secrets dans le dossier privé jusqu'à leur suppression.

```sh
python3 deploy/test_services.py
node --test scripts/backup.test.mjs
python3 scripts/backup-ftp.test.py
```

Le test age fait un aller-retour chiffré avec un compte accentué puis corrompt l'archive et vérifie que la restauration échoue sans émettre de JSON. Il est explicitement ignoré si `age` n'est pas installé. Les tests Python FTP vérifient hors ligne la sélection, les contrôles d'intégrité et la rétention, ainsi qu'un aller-retour d'archive lorsque `age` est disponible ; ils ne valident pas un envoi réel chez le fournisseur. Ces essais ne remplacent pas un test PostgreSQL restauré ni la vérification des comptes et droits de l'installation migrée.
