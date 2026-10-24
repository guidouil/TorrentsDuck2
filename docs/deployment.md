# Déploiement Ubuntu 24.04 LTS

[Français](deployment.md) · [English](deployment.en.md)

Pour essayer le projet sur votre ordinateur avec Docker, suivre la section [Docker local du README](../README.md#docker-local) : `npm run local:up`, puis `npm run local:admin` au premier lancement. Cette pile autonome utilise des données et identifiants fictifs sur [http://127.0.0.1:5180](http://127.0.0.1:5180), sans Nginx, FTPS, mails réels ni pairs BitTorrent Internet.

L’image locale est construite pour `http://127.0.0.1:5180` : ne pas la réutiliser en production. Le déploiement ci-dessous conserve son réseau et son reverse proxy Nginx.

Ce guide installe Torrents Duck 2 sur un hôte **Ubuntu Noble 24.04 LTS amd64 neuf**, avec Docker Engine. Node et PostgreSQL sur l'hôte ne sont pas nécessaires : les services s'exécutent dans des conteneurs. Les domaines, adresses et comptes ci-dessous sont des exemples à remplacer. Aucun script du projet ne réinstalle le système ni ne reformate un disque.

En cas de remplacement d'une installation Meteor, sauvegarder les comptes et tester leur restauration avant toute intervention ; voir le [guide de migration et sauvegarde](migration-backups.md). Les téléchargements, torrents et messages historiques sont exclus de la migration des comptes.

## 1. Préparer l'hôte et l'accès SSH

Configurer une clé publique pour le compte SSH d'administration. Vérifier une deuxième session avant de désactiver l'authentification par mot de passe. Garder l'accès à la console du fournisseur.

Vérifier les disques avec `lsblk` et, si un RAID est utilisé, ses outils de diagnostic et `cat /proc/mdstat`. Prévoir un espace persistant pour `/srv/torrentduck`, du swap selon la mémoire disponible et au moins 10 % d'espace libre sur le volume de données. Si un volume dédié est utilisé, le déclarer dans `/etc/fstab` par UUID et vérifier son montage avant de continuer. Conserver les sauvegardes sur une autre machine.

```sh
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git python3 iptables openssl ufw
```

Effectuer tout redémarrage système nécessaire avant de poursuivre.

## 2. Installer Docker Engine et Compose

Installer Docker depuis son [dépôt APT officiel pour Ubuntu](https://docs.docker.com/engine/install/ubuntu/). Sur un hôte déjà équipé, examiner les services existants et suivre la section des paquets en conflit avant de continuer.

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
sudo docker compose version
```

Compose doit prendre en charge `gw_priority` (2.33.1 ou ultérieur). Utiliser le backend **iptables** de Docker ; `iptables-nft` est compatible avec les règles du projet. Les commandes de ce guide utilisent `sudo` pour Docker. L'appartenance au groupe `docker` accorde des droits d'administration sur l'hôte.

## 3. Ouvrir les ports nécessaires

Adapter d'abord le port SSH si celui du serveur diffère de `22`, et conserver les règles des services déjà nécessaires. Sur l'hôte neuf :

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 21000/tcp
sudo ufw allow 50000:50100/tcp
sudo ufw allow 51413/tcp
sudo ufw allow 51413/udp
sudo ufw enable
sudo ufw status verbose
```

Vérifier une nouvelle connexion SSH après activation. Reproduire ces ouvertures sur le pare-feu du fournisseur, s'il existe. Le port `21000` et la plage `50000–50100` servent au FTPS explicite ; `51413` sert aux pairs BitTorrent. PostgreSQL `5432` et le RPC qBittorrent `8080` restent internes à Docker.

**Uniquement si cet hôte assure déjà un service DNS public**, conserver aussi ses ports DNS TCP et UDP :

```sh
sudo ufw allow 53/tcp
sudo ufw allow 53/udp
```

Torrents Duck n'exige pas de serveur DNS local. Les ports publiés par Docker peuvent contourner les règles UFW : voir les [limites du filtrage Docker](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations). La politique dédiée de l'étape 5 complète UFW et doit être appliquée avant le démarrage de qBittorrent.

## 4. Cloner et configurer le projet

```sh
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 755 /opt/torrentduck
git clone https://github.com/guidouil/TorrentsDuck2.git /opt/torrentduck
cd /opt/torrentduck
umask 077
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Éditer `.env` avec un éditeur. Relancer `openssl rand -hex 32` pour chaque secret afin d'obtenir des valeurs distinctes. Compose lit ce fichier directement : **ne pas l'exécuter ni le charger avec `source` ou `. .env`**.

| Variable | Valeur à configurer |
| --- | --- |
| `DOMAIN` | Nom public, par exemple `duck.example.com`. |
| `ORIGIN`, `BETTER_AUTH_URL` | La même URL HTTPS, par exemple `https://duck.example.com`. |
| `PUBLIC_IPV4` | IPv4 publique réelle de l'hôte ; `203.0.113.10` est seulement un exemple documentaire. |
| `DATA_ROOT` | `/srv/torrentduck` pour les commandes de ce guide. |
| `POSTGRES_ADMIN_PASSWORD` | Secret du superutilisateur PostgreSQL, distinct du mot de passe applicatif. |
| `POSTGRES_PASSWORD` | Secret hexadécimal du rôle applicatif `duck`. |
| `DATABASE_URL` | `postgresql://duck:MOT_DE_PASSE@postgres:5432/duck`, avec exactement la valeur de `POSTGRES_PASSWORD`. |
| `BETTER_AUTH_SECRET`, `INTERNAL_API_SECRET` | Deux autres secrets indépendants. |
| `QBT_USERNAME`, `QBT_PASSWORD` | Identifiant RPC interne et secret d'au moins 24 caractères. Le nom accepte lettres ASCII, chiffres, point, tiret et underscore. |
| `ACME_EMAIL` | Adresse de contact pour les certificats, par exemple `admin@example.com`. |
| `ADMIN_EMAIL` | Adresse du futur administrateur inscrit, par exemple `admin@example.com` ; une valeur vide désactive l'attribution automatique. |

Configurer les mails avant l'ouverture : `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` et `MAILGUN_API_URL` (`https://api.mailgun.net` aux États-Unis, `https://api.eu.mailgun.net` en Europe). Le domaine d'envoi doit être vérifié dans Mailgun. Sans clé Mailgun, utiliser les variables `SMTP_*` décrites dans le [README](../README.md). Ces mails servent à la confirmation d'adresse, à la réinitialisation et aux notifications d'inscription.

Créer dans la zone DNS du domaine un enregistrement A pour `duck.example.com` vers l'IPv4 du serveur. Attendre sa propagation avant l'émission du certificat. Ne publier un AAAA qu'après avoir préparé et testé l'IPv6 ; le moteur torrent est limité à IPv4.

## 5. Préparer les données, le pare-feu et les images

Vérifier que les sous-réseaux `172.30.10.0/24`, `172.30.11.0/24`, `172.30.20.0/24`, `172.30.30.0/24`, `172.30.40.0/24` et `172.30.50.0/24` sont libres. En cas de conflit, modifier ensemble `compose.yaml` et `deploy/firewall.sh` avant tout démarrage. Si `DATA_ROOT` diffère, adapter les chemins de création ci-dessous.

```sh
sudo install -d -o 10000 -g 10000 -m 755 /srv/torrentduck/downloads /srv/torrentduck/share /srv/torrentduck/qbittorrent
sudo install -d -m 700 /srv/torrentduck/postgres /srv/torrentduck/certificates /srv/torrentduck/ftp-tls
sudo install -d -m 755 /srv/torrentduck/acme
sudo docker compose config -q
sudo sh deploy/firewall.sh
sudo docker compose build --pull
```

`deploy/firewall.sh` utilise `DOCKER-USER` et `INPUT` pour bloquer les connexions initiées par qBittorrent vers l'hôte, les réseaux privés, loopback, link-local, CGNAT, métadonnées et plages réservées. Le DNS Docker et les réponses aux appels RPC de l'application restent permis. Le moteur doit toujours démarrer après cette politique. Le conteneur qBittorrent utilise des paquets Debian amd64, indépendamment de l'hôte Ubuntu ; ses identifiants RPC sont configurés avant son premier démarrage.

## 6. Initialiser PostgreSQL et le schéma

Effectuer cette étape **avant l'émission du certificat et le démarrage public de Nginx/FTPS** :

```sh
sudo docker compose up -d --wait postgres
sudo docker compose run --rm --no-deps --entrypoint node web --import tsx scripts/migrate-db.ts
```

L'initialisation crée un rôle applicatif limité à sa base. Les mots de passe d'initialisation s'appliquent uniquement à un volume PostgreSQL neuf.

Si des comptes Meteor doivent être récupérés, suivre maintenant le [guide de migration](migration-backups.md) : contrôler l'archive, importer dans cette base encore vide et vérifier les comptes et leurs droits. Effectuer l'import avant toute inscription ou création d'administrateur ; il exige une table utilisateurs vide. Une installation neuve peut passer directement à l'étape suivante.

## 7. Obtenir le certificat et démarrer les services

Vérifier que le DNS public pointe vers l'hôte et que TCP `80` est accessible de l'extérieur. Depuis `/opt/torrentduck` :

```sh
sudo sh scripts/deploy-certificates.sh issue
sudo sh scripts/deploy.sh
```

La première commande lit `ACME_EMAIL` depuis `.env` via Compose. Pour remplacer ponctuellement cette adresse : `sudo ACME_EMAIL=admin@example.com sh scripts/deploy-certificates.sh issue`. Le challenge ACME utilise un Nginx temporaire sur le port 80 ; après émission, le script prépare le PEM FTPS et démarre Nginx/FTPS et leurs dépendances avec le schéma déjà prêt.

`scripts/deploy.sh` installe les unités systemd, applique le pare-feu, construit les images, attend PostgreSQL, applique les migrations puis démarre la pile. Il active aussi son démarrage au boot et le timer de renouvellement. Il conserve les données existantes et ne crée pas d'administrateur implicite.

Pour une installation neuve, s'inscrire sur le site avec l'adresse configurée dans `ADMIN_EMAIL`, puis suivre le lien de confirmation reçu par mail pour activer l'administrateur. La page d'attente permet de renvoyer ce lien. Les autres comptes attendent la validation d'un administrateur. Modifier `ADMIN_EMAIL` ensuite ne change pas les comptes existants. Une inscription prévient les administrateurs actifs et validés ; à défaut, `ADMIN_EMAIL` reçoit la notification si elle est définie. Un échec d'envoi est journalisé et n'annule pas l'inscription.

## 8. Vérifier l'installation

```sh
sudo docker compose ps
sudo docker compose logs --tail=100 web nginx ftp qbittorrent postgres
sudo docker compose exec -T nginx nginx -t
sudo systemctl status torrentduck.service torrentduck-firewall.service --no-pager
sudo systemctl list-timers torrentduck-certificates.timer --no-pager
curl -fsS https://duck.example.com/api/health
```

L'état `active (exited)` des unités oneshot est normal ; `docker compose ps` décrit l'état des conteneurs. `/api/health` confirme la réponse HTTP de l'application et ne remplace pas les essais de base de données, torrents et FTP.

Avant ouverture aux membres :

- En navigation privée, vérifier le refus des listes, téléchargements et lectures ; `/_protected/...` et `/api/internal/ftp-auth` doivent retourner 404 depuis Internet.
- Tester inscription, attente, confirmation du premier administrateur, réception des mails et validation d'un membre. En cas d'import, vérifier les comptes, droits, pseudo accentué, connexion par e-mail, renouvellement du hash, réinitialisation et révocation.
- Sur un navigateur déconnecté, afficher le QR code de connexion et le scanner depuis un téléphone. Vérifier le retour à la confirmation après connexion du téléphone, la comparaison du code, l’autorisation explicite puis la connexion automatique du premier navigateur. Tester aussi le refus et l’expiration après cinq minutes ; un compte en attente ou désactivé ne doit pas pouvoir autoriser un appareil. Utiliser la même adresse HTTPS sur les deux appareils.
- Connecter le même compte dans plusieurs navigateurs, dont la télé, puis se déconnecter depuis un seul : tous ses accès web doivent être refusés immédiatement et les écrans ouverts doivent revenir à la connexion en quelques secondes. Vérifier qu’un QR code déjà autorisé mais pas encore utilisé ne reconnecte pas la télé et qu’un autre compte reste connecté.
- Ajouter un torrent public autorisé, vérifier progression, arrêt/reprise, persistance après redémarrage et les deux modes de suppression. Tester recherche, tri, pagination, chat et reconnexion SSE.
- Tester la lecture vidéo avec déplacement, un lien VLC, sa révocation et son expiration, ainsi qu'un format non lu par le navigateur. Sur Android, iPhone et iPad (y compris en mode bureau), vérifier le bouton « Ouvrir dans VLC » dans la fenêtre du lien, avec VLC installé ; vérifier aussi que la copie du lien reste accessible sans VLC.
- Dans FileZilla/Cyberduck, choisir **FTP avec TLS explicite obligatoire**, le nom du certificat et le port `21000`. Vérifier téléchargement, écriture dans `share` et refus d'écriture dans `downloads`. Refuser le FTP en clair et les canaux de données non chiffrés.
- Désactiver un membre connecté : toutes les sessions FTPS doivent se fermer en quelques secondes et le compte révoqué doit échouer à se reconnecter. L'indisponibilité de l'API interne doit aussi fermer les sessions.
- Depuis le conteneur qBittorrent, vérifier l'échec d'accès à `169.254.169.254`, `172.30.20.1` et l'adresse privée PostgreSQL, tout en conservant un tracker public et l'accès RPC depuis `web`. Répéter après redémarrage de l'hôte.
- Sur un volume de test, simuler le seuil de 10 % libres : les nouveaux transferts/uploads doivent être refusés avant saturation. Pure-FTPd applique également une limite de disque à 90 %.
- Créer une sauvegarde chiffrée hors de l'hôte, la restaurer dans une base de test vide et vérifier un compte avec un mot de passe connu.

Ces essais nécessitent une vérification réelle des certificats, ports passifs, stockage, performances et restauration sur l'hôte ou une machine équivalente. Cette documentation ne certifie pas leur réussite.

## Exploitation, certificats et sauvegardes

```sh
sudo systemctl restart torrentduck.service
sudo systemctl start torrentduck-certificates.service
```

Le redémarrage de la pile interrompt les services et les transferts en cours. Le timer vérifie les certificats deux fois par jour, avec un délai aléatoire pouvant atteindre une heure. Un renouvellement met à jour le PEM FTPS, contrôle certificat et clé, recharge Nginx et redémarre Pure-FTPd ; une session FTPS active peut être coupée. Après une modification des règles Docker ou du pare-feu, réappliquer `sudo sh deploy/firewall.sh` avant de redémarrer les torrents. L'unité dédiée est installée avant Docker pour appliquer cette politique au boot.

Tester le renouvellement ACME sans remplacer le certificat de production et sans délai aléatoire supplémentaire ; remplacer `duck.example.com` par la valeur de `DOMAIN` dans `.env` :

```sh
sudo docker compose --profile maintenance run --rm certbot renew --cert-name duck.example.com --dry-run --webroot -w /var/www/acme --no-random-sleep-on-renew
```

Le gardien FTPS vérifie les autorisations toutes les 5 secondes, avec un délai HTTP maximal de 3 secondes. Une désactivation, suppression de compte ou modification de mot de passe ferme **toutes** les sessions FTPS, y compris celles d'autres membres. Elles doivent se reconnecter et reprendre les transferts. En cas d'indisponibilité de la politique, le conteneur attend le retour de l'application avant de rouvrir son écoute. Le montage `downloads` est en lecture seule ; les remplacements de fichiers FTPS existants sont atomiques.

Les journaux Docker sont limités à 3 × 10 Mo par service. Nginx désactive son journal d'accès pour protéger les jetons des liens de lecture et de récupération. L'application n'a pas accès au socket Docker.

Sur un poste de sauvegarde avec Node 24, `age` et une identité SSH adaptée, créer une clé `age` hors du dépôt, garder une seconde copie protégée de sa clé privée, puis utiliser son destinataire public :

```sh
umask 077
mkdir -p "$HOME/.config/torrentduck" "$HOME/TorrentsDuck-backups"
age-keygen -o "$HOME/.config/torrentduck/backup-identity.txt"
age-keygen -y "$HOME/.config/torrentduck/backup-identity.txt"
node scripts/backup.mjs --host backup-host --recipient age1… --directory "$HOME/TorrentsDuck-backups" --keep 14
```

Remplacer `backup-host` par un alias SSH configuré et `age1…` par la clé publique obtenue. Le compte distant doit lire la configuration et utiliser Docker, ce qui lui donne un accès administrateur sur l'hôte. Le [guide de sauvegarde](migration-backups.md) détaille ces droits et les essais de restauration. L'archive contient PostgreSQL et la configuration ; téléchargements, fichiers partagés et état des torrents sont exclus et nécessitent une stratégie séparée si leur conservation est requise. La dernière sauvegarde récupérée apparaît dans l'administration ; un poste éteint laisse cette date vieillir.

## Mettre à jour

Pour les mises à jour courantes d'un dépôt Git installé dans `/opt/torrentduck`, copier une fois le script dans le compte propriétaire du dépôt :

```sh
cd /opt/torrentduck
install -m 755 scripts/update.sh "$HOME/deploy-torrentduck.sh"
"$HOME/deploy-torrentduck.sh"
```

Les fois suivantes, lancer simplement `~/deploy-torrentduck.sh`, **sans sudo devant le script**. Git utilise le compte courant ; sudo demande le mot de passe pour la partie Docker et système. Le dépôt doit avoir une branche avec un suivi distant configuré. Le script refuse deux déploiements simultanés et les modifications locales, y compris les fichiers non suivis non ignorés, puis fait `git pull --ff-only` et appelle `scripts/deploy.sh` : construction, schéma, pare-feu et unités systemd restent gérés par la procédure existante. Il recrée ensuite Nginx pour appliquer son template et vérifie `/api/health` en HTTPS public. Les sessions web et FTPS peuvent être interrompues.

Le nettoyage s'exécute avant la construction et à la sortie, même en cas d'échec : seules les images sans tag du projet qui ne sont plus utilisées par un conteneur sont supprimées. Le cache de build inutilisé du builder Docker par défaut est réduit avec `--keep-storage 1GB` ; ce cache est commun aux autres projets éventuels de l'hôte. Le script exige au moins 10 % libres plus 5 Gio sur le volume Docker avant de construire. Il ne crée ni archive ni tag de sauvegarde et ne supprime aucun volume, fichier partagé, téléchargement ou sauvegarde existante. Les sorties restent dans le terminal.

Conserver une sauvegarde externe régulière et éprouver sa restauration séparément : ce script n'en crée pas à chaque déploiement. Il ne télécharge pas automatiquement de nouvelles images PostgreSQL ou Certbot ; leur mise à jour reste une opération de maintenance. Examiner les éventuelles nouvelles variables de `.env.example` avant le déploiement. Garder `.env`, `DATA_ROOT` et les secrets existants, en particulier `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_PASSWORD` et le mot de passe de `DATABASE_URL` : changer seulement ces variables ne change pas les mots de passe d'une base déjà initialisée. Une rotation doit coordonner PostgreSQL et la configuration applicative. Maintenir PostgreSQL en version majeure 17 pour cette procédure ; un changement de version majeure exige une migration dédiée. Reprendre les contrôles de fonctionnement après la mise à jour.

## Tests de protocoles sur une instance de test

Sur une machine de développement ou de test, avec Docker accessible au compte exécutant Python :

```sh
docker compose --env-file .env.example build
python3 tests/infrastructure.integration.py
```

Le test exige **le sous-réseau libre `172.30.20.0/24` et les ports locaux `50000–50100` libres**. Une pile de production utilise déjà ces ressources : utiliser une instance de test séparée. Le script crée et supprime ses conteneurs `duck-infra-…` et son réseau temporaire ; il n'altère pas le pare-feu de l'hôte.

Il exerce le RPC protégé, l'ajout/arrêt/reprise et la persistance qBittorrent, X-Accel et les requêtes `Range` Nginx, TLS FTPS obligatoire, lecture seule, écriture/renommage/suppression et révocation des sessions. Le torrent est une fixture locale sans tracker, avec DHT/PEX/découverte locale désactivés. Le certificat autosigné reste limité au test. L'API d'authentification est simulée ; les tests applicatifs couvrent séparément comptes et droits. Ce test ne vérifie pas ACME public, le routage passif externe, le pare-feu Linux, les pairs Internet ni les performances de l'hôte.
