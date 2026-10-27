# Déploiement Ubuntu 24.04 LTS

[Français](deployment.md) · [English](deployment.en.md)

Pour essayer le projet sur votre ordinateur avec Docker, suivre la section [Docker local du README](../README.fr.md#docker-local) : `npm run local:up`, puis `npm run local:admin` au premier lancement. Cette pile autonome utilise des données et identifiants fictifs sur [http://127.0.0.1:5180](http://127.0.0.1:5180), sans Nginx, FTPS, mails réels ni pairs BitTorrent Internet.

L’image locale est construite pour `http://127.0.0.1:5180` : ne pas la réutiliser en production. Le déploiement ci-dessous conserve son réseau et son reverse proxy Nginx.

Ce guide installe TorrentsDuck2 sur un hôte **Ubuntu Noble 24.04 LTS amd64 neuf**, avec Docker Engine. Node et PostgreSQL sur l'hôte ne sont pas nécessaires : les services s'exécutent dans des conteneurs. Les domaines, adresses et comptes ci-dessous sont des exemples à remplacer. Aucun script du projet ne réinstalle le système ni ne reformate un disque.

En cas de remplacement d'une installation Meteor, sauvegarder les comptes et tester leur restauration avant toute intervention ; voir le [guide de migration et sauvegarde](migration-backups.md). Les téléchargements, torrents et messages historiques sont exclus de la migration des comptes.

## 1. Préparer l'hôte et l'accès SSH

Configurer une clé publique pour le compte SSH d'administration. Vérifier une deuxième session avant de désactiver l'authentification par mot de passe. Garder l'accès à la console du fournisseur.

Vérifier les disques avec `lsblk` et, si un RAID est utilisé, ses outils de diagnostic et `cat /proc/mdstat`. Prévoir un espace persistant pour `/srv/torrentduck`, du swap selon la mémoire disponible et au moins 10 % d'espace libre sur le volume de données. Si un volume dédié est utilisé, le déclarer dans `/etc/fstab` par UUID et vérifier son montage avant de continuer. Conserver les sauvegardes sur une autre machine.

```sh
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git python3 age iptables openssl ufw
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

TorrentsDuck2 n'exige pas de serveur DNS local. Les ports publiés par Docker peuvent contourner les règles UFW : voir les [limites du filtrage Docker](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations). La politique dédiée de l'étape 5 complète UFW et doit être appliquée avant le démarrage de qBittorrent.

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

Configurer les mails avant l'ouverture : `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` et `MAILGUN_API_URL` (`https://api.mailgun.net` aux États-Unis, `https://api.eu.mailgun.net` en Europe). Le domaine d'envoi doit être vérifié dans Mailgun. Sans clé Mailgun, utiliser les variables `SMTP_*` décrites dans le [README](../README.fr.md). Ces mails servent à la confirmation d'adresse, à la réinitialisation et aux notifications d'inscription.

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

`scripts/deploy.sh` installe les unités systemd, applique le pare-feu, construit les images, attend PostgreSQL, applique les migrations puis démarre la pile. Il active aussi son démarrage au boot, le timer de renouvellement et celui de sauvegarde FTP ; les transferts de sauvegarde restent désactivés tant que `BACKUP_FTP_ENABLED=false`. Il conserve les données existantes et ne crée pas d'administrateur implicite.

Pour une installation neuve, s'inscrire sur le site avec l'adresse configurée dans `ADMIN_EMAIL`, puis suivre le lien de confirmation reçu par mail pour activer l'administrateur. La page d'attente permet de renvoyer ce lien. Les autres comptes attendent la validation d'un administrateur. Modifier `ADMIN_EMAIL` ensuite ne change pas les comptes existants. Une inscription prévient les administrateurs actifs et validés ; à défaut, `ADMIN_EMAIL` reçoit la notification si elle est définie. Un échec d'envoi est journalisé et n'annule pas l'inscription.

## 8. Vérifier l'installation

```sh
sudo docker compose ps
sudo docker compose logs --tail=100 web nginx ftp qbittorrent postgres
sudo docker compose exec -T nginx nginx -t
sudo systemctl status torrentduck.service torrentduck-firewall.service --no-pager
sudo systemctl list-timers torrentduck-certificates.timer --no-pager
sudo systemctl list-timers torrentduck-backup.timer --no-pager
curl -fsS https://duck.example.com/api/health
```

L'état `active (exited)` des unités oneshot est normal ; `docker compose ps` décrit l'état des conteneurs. `/api/health` confirme la réponse HTTP de l'application et ne remplace pas les essais de base de données, torrents et FTP.

Avant ouverture aux membres :

- En navigation privée, vérifier le refus des listes, téléchargements et lectures ; `/_protected/...` et `/api/internal/ftp-auth` doivent retourner 404 depuis Internet.
- Tester inscription, attente, confirmation du premier administrateur, réception des mails et validation d'un membre. En cas d'import, vérifier les comptes, droits, pseudo accentué, connexion par e-mail, renouvellement du hash, réinitialisation et révocation.
- Sur un navigateur déconnecté, afficher le QR code de connexion et le scanner depuis un téléphone. Vérifier le retour à la confirmation après connexion du téléphone, la comparaison du code, l’autorisation explicite puis la connexion automatique du premier navigateur. Tester aussi le refus et l’expiration après cinq minutes ; un compte en attente ou désactivé ne doit pas pouvoir autoriser un appareil. Utiliser la même adresse HTTPS sur les deux appareils.
- Connecter le même compte dans plusieurs navigateurs, dont la télé, puis se déconnecter depuis un seul : tous ses accès web doivent être refusés immédiatement et les écrans ouverts doivent revenir à la connexion en quelques secondes. Vérifier qu’un QR code déjà autorisé mais pas encore utilisé ne reconnecte pas la télé et qu’un autre compte reste connecté.
- Ajouter un torrent public autorisé, vérifier progression, arrêt/reprise, persistance après redémarrage et les deux modes de suppression. Tester recherche, tri, pagination, chat et reconnexion SSE.
- Dans Recherche, lancer une recherche, ajouter un résultat aux transferts et vérifier les erreurs d'une source indisponible. Attribuer puis retirer le droit « Gestionnaire des sources » à un membre : il doit pouvoir administrer les sources seulement pendant l'attribution, sans accéder aux comptes ni aux sauvegardes. Vérifier aussi le refus des API pour un membre ordinaire, en attente ou désactivé.
- Tester la lecture vidéo avec déplacement, un lien VLC, sa révocation et son expiration, ainsi qu'un format non lu par le navigateur. Sur Android, iPhone et iPad (y compris en mode bureau), vérifier le bouton « Ouvrir dans VLC » dans la fenêtre du lien, avec VLC installé ; vérifier aussi que la copie du lien reste accessible sans VLC.
- Dans le site, vérifier qu'un administrateur actif et approuvé peut supprimer un fichier ou dossier de `downloads` après confirmation et qu'un membre ordinaire ne le peut pas, y compris par l'API. La suppression est définitive pour toute la communauté ; les fichiers encore gérés par qBittorrent peuvent être signalés manquants ou téléchargés de nouveau.
- Dans FileZilla/Cyberduck, choisir **FTP avec TLS explicite obligatoire**, le nom du certificat et le port `21000`. Vérifier téléchargement et écriture dans `share`. Dans `downloads`, vérifier la suppression de fichiers et dossiers pour un administrateur et son refus pour un membre, ainsi que le refus d'upload, de renommage et de création pour les deux rôles. Refuser le FTP en clair et les canaux de données non chiffrés.
- Désactiver un membre connecté ou retirer le rôle d'un administrateur : toutes les sessions FTPS doivent se fermer en quelques secondes et les nouveaux accès doivent respecter les droits actualisés. L'indisponibilité de l'API interne doit aussi fermer les sessions.
- Depuis le conteneur qBittorrent, vérifier l'échec d'accès à `169.254.169.254`, `172.30.20.1` et l'adresse privée PostgreSQL, tout en conservant un tracker public et l'accès RPC depuis `web`. Répéter après redémarrage de l'hôte.
- Sur un volume de test, simuler le seuil de 10 % libres : les nouveaux transferts/uploads, y compris FTPS, doivent être refusés avant saturation.
- Créer une sauvegarde chiffrée hors de l'hôte, la restaurer dans une base de test vide et vérifier un compte avec un mot de passe connu.

Ces essais nécessitent une vérification réelle des certificats, ports passifs, stockage, performances et restauration sur l'hôte ou une machine équivalente. Cette documentation ne certifie pas leur réussite.

## Recherche et sources

La page Recherche combine les plugins qBittorrent et les sources URL analysées
par le serveur web, avec une recherche active par
membre, quatre recherches simultanées pour le site, une durée maximale de
90 secondes et des résultats conservés cinq minutes. Les tâches sont rattachées
au compte qui les a créées ; l'ajout d'un résultat réutilise les autorisations,
l'attribution d'auteur et la réserve disque de l'ajout manuel.
Le suivi des recherches reste en mémoire dans l'unique processus web : les
résultats ne sont pas restaurés après son redémarrage. Plusieurs réplicas web
nécessiteraient un stockage partagé de ce suivi.

Les tris par seeders, leechers, date récente, taille décroissante ou nom et les
filtres de seeders minimum et de taille minimum/maximum s'appliquent avant la
pagination, sur les 2 000 premiers résultats au maximum renvoyés par le moteur.
La page signale si cette limite est atteinte ; un tri ne porte donc pas sur les
résultats au-delà de cette limite. Choisir une source ou toutes les sources avant
de lancer la recherche. Les tailles des filtres sont exprimées en Gio. Une date
absente de la réponse du moteur reste indiquée comme inconnue ; les dates
Snowfl et LimeTorrents, lorsqu'elles sont disponibles, sont approximatives car calculées à
partir d'un âge relatif fourni par le site.

L'image qBittorrent contient un catalogue figé de cinq plugins : The Pirate Bay
(généraliste via APiBay), Torrents CSV (généraliste), Nyaa.si (anime et contenus
asiatiques), LimeTorrents (généraliste) et Snowfl (agrégateur). Le premier démarrage de cette version installe
les quatre premiers sans remplacer de fichier existant. Snowfl reste facultatif :
sa page a répondu HTTP 520 pendant la vérification du 25 octobre 2026. Les autres
sources ont répondu à une recherche de test depuis l'environnement de validation ;
leur disponibilité depuis le serveur reste à vérifier. Aucun contenu n'a été
téléchargé pendant ces contrôles.

Le plugin LimeTorrents est adapté localement pour produire des magnets à partir
des hashes déjà présents dans les liens de la liste. Il n'envoie pas une fiche
HTML à l'ajout de torrent et ignore les lignes sans hash valide. Si les sources
ont déjà été initialisées sur le volume, installer LimeTorrents depuis Sources
après reconstruction de l'image ; le marqueur de premier démarrage préserve les
choix existants.

Un administrateur peut attribuer le droit supplémentaire **Gestionnaire des
sources** (`canManageSources`) depuis la liste des membres. Un membre actif et
approuvé disposant de ce droit peut ajouter des URL, tester ces sources,
installer les versions du catalogue, activer, désactiver et retirer des sources.
Les administrateurs ont toujours cet
accès. Ce droit ne permet pas d'administrer les comptes ou les sauvegardes.
La révocation est contrôlée à chaque appel API.

Pour ajouter une source URL depuis **Recherche → Sources** :

1. Saisir un nom et l'URL de recherche, en remplaçant les mots-clés par `{query}`,
   par exemple `https://example.org/search?q={query}`. Une URL sans marqueur
   est traitée comme une liste ou un flux fixe, filtré par le nom des résultats.
2. Choisir éventuellement HTTP Basic (identifiant/mot de passe), Bearer ou une
   clé API envoyée dans `X-Api-Key`. Les accès authentifiés exigent HTTPS.
3. Choisir **Analyser et ajouter**. La vérification utilise `ubuntu` et reconnaît
   JSON, RSS/Atom/Torznab et les pages HTML contenant des magnets, liens torrent
   ou hashes reconnus. **Tester** revérifie ensuite une source enregistrée.

Les sources URL n'exécutent aucun code fourni par leur gestionnaire. Leurs accès
authentifiés sont partagés : tous les membres approuvés peuvent rechercher et
ajouter leurs résultats aux transferts collectifs. Seuls les gestionnaires et
administrateurs modifient les sources. Le navigateur reçoit uniquement leur
origine publique et des références opaques pour les résultats ; URL complètes,
paramètres et identifiants restent côté serveur.

La limite est de dix sources URL, avec des réponses de 2 Mio et un délai total
de 30 secondes par requête. Les adresses privées sont refusées et les
redirections ne peuvent changer d'origine ni rétrograder de HTTPS vers HTTP.
Les fichiers `.torrent` peuvent atteindre 8 Mio ; les identifiants sont transmis
uniquement à l'origine configurée, jamais à un autre hébergeur de fichier.

En cas d'échec, utiliser **Copier** dans le rapport de détection v1 puis le
transmettre pour faire ajouter un adaptateur. Il décrit le statut HTTP, le type,
la taille et la structure de la réponse, sans corps brut, cookie, mot de passe,
jeton ou valeur de paramètre. Ces rapports ne sont pas enregistrés en base et
leurs réponses HTTP portent `Cache-Control: no-store`.
Les formulaires de connexion spécifiques, pages nécessitant JavaScript et
captchas nécessitent un adaptateur ; une page inconnue n'est pas ajoutée.

Le schéma rejouable `db/001-initial.sql` crée la table `search_sources` lors de
la migration habituelle du déploiement. La configuration complète des sources
URL est chiffrée en AES-256-GCM avec une clé dérivée de `BETTER_AUTH_SECRET`.
Conserver ce secret ; après sa rotation, retirer puis ajouter à nouveau les
sources URL avec leurs identifiants.

Les plugins du catalogue exécutent du Python dans le conteneur qBittorrent :
l'interface accepte les URL de recherche déclaratives, mais aucune URL de code
Python à installer. Les fichiers, versions, licences et
empreintes sont conservés dans
[`deploy/qbittorrent/search/SOURCES.md`](../deploy/qbittorrent/search/SOURCES.md).
Un nouveau plugin ou une mise à jour de son code nécessite une revue, une
reconstruction de l'image puis une installation depuis le catalogue ; pour un
plugin déjà installé, le retirer puis le réinstaller. Les sources
retirées ou désactivées restent dans cet état après redémarrage. La pile
`compose.local.yaml` garde qBittorrent sur un réseau interne sans accès aux
indexeurs Internet. Les sources URL utilisent la sortie réseau de `web` ; les
tests locaux restent fondés sur des réponses simulées.

## Exploitation, certificats et sauvegardes

```sh
sudo systemctl restart torrentduck.service
sudo systemctl start torrentduck-certificates.service
```

Le redémarrage de la pile interrompt les services et les transferts en cours. Le timer vérifie les certificats deux fois par jour, avec un délai aléatoire pouvant atteindre une heure. Un renouvellement met à jour le PEM FTPS, contrôle certificat et clé, recharge Nginx et redémarre le serveur FTPS ; une session FTPS active peut être coupée. Après une modification des règles Docker ou du pare-feu, réappliquer `sudo sh deploy/firewall.sh` avant de redémarrer les torrents. L'unité dédiée est installée avant Docker pour appliquer cette politique au boot.

Tester le renouvellement ACME sans remplacer le certificat de production et sans délai aléatoire supplémentaire ; remplacer `duck.example.com` par la valeur de `DOMAIN` dans `.env` :

```sh
sudo docker compose --profile maintenance run --rm certbot renew --cert-name duck.example.com --dry-run --webroot -w /var/www/acme --no-random-sleep-on-renew
```

Le gardien FTPS vérifie les autorisations toutes les 5 secondes, avec un délai HTTP maximal de 3 secondes. Une désactivation, suppression de compte, modification de mot de passe ou de rôle ferme **toutes** les sessions FTPS, y compris celles d'autres membres. Elles doivent se reconnecter et relancer les transferts. En cas d'indisponibilité de la politique, le conteneur attend le retour de l'application avant de rouvrir son écoute. `downloads` est monté en écriture dans `web` et `ftp` pour permettre la suppression réservée aux administrateurs ; Nginx le garde en lecture seule. Les contrôles applicatifs interdisent toujours l'upload, le renommage et la création dans `downloads`. Dans `share`, les uploads FTPS sont publiés atomiquement sans écraser un fichier existant ; l'ajout à un fichier et la reprise d'un upload partiel sont refusés. Un upload interrompu doit être recommencé avec `STOR` et un nom libre ; `STOU` est refusé. Pour changer de compte FTPS, se déconnecter puis se reconnecter.

Les journaux Docker sont limités à 3 × 10 Mo par service. Nginx désactive son journal d'accès pour protéger les jetons des liens de lecture et de récupération. L'application n'a pas accès au socket Docker.

La carte CPU de la page Transferts mesure Web, qBittorrent, PostgreSQL, Nginx et FTPS en pourcentage de la capacité CPU totale de l'hôte (100 % = tous les cœurs occupés). Le relevé compare les compteurs [`cpu.stat` de cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#cpu-interface-files) entre deux instantanés partagés, environ toutes les 3 secondes lorsque la page est ouverte. `compose.yaml` place chaque service dans une slice `torrentduck-<service>.slice` et monte `/sys/fs/cgroup` dans `web` en lecture seule ; aucun droit d'écriture ni socket Docker n'est ajouté. Ces relevés utilisent le pilote cgroup `systemd` et cgroup v2 d'Ubuntu 24.04 : vérifier `sudo docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}'` (résultat attendu : `2 systemd`). Après la mise à jour, les conteneurs doivent être recréés par le déploiement pour appliquer ces paramètres. Un premier relevé, un service absent ou une configuration différente affiche une valeur indisponible ; la pile Docker locale garde sa configuration portable et ne fournit pas ces compteurs. Le remplissage et la réserve de 10 % sont calculés sur le système de fichiers de `DOWNLOADS_DIR` (le dossier `downloads` de `DATA_ROOT` sur l’hôte), afin de mesurer le disque de données même lorsqu’il est monté séparément du système. Le remplissage exclut les espaces encore libres réservés par le système de fichiers ; le seuil applicatif de 10 % reste inchangé.

Sur un poste de sauvegarde avec Node 24, `age` et une identité SSH adaptée, créer une clé `age` hors du dépôt, garder une seconde copie protégée de sa clé privée, puis utiliser son destinataire public :

```sh
umask 077
mkdir -p "$HOME/.config/torrentduck" "$HOME/TorrentsDuck-backups"
age-keygen -o "$HOME/.config/torrentduck/backup-identity.txt"
age-keygen -y "$HOME/.config/torrentduck/backup-identity.txt"
node scripts/backup.mjs --host backup-host --recipient age1… --directory "$HOME/TorrentsDuck-backups" --keep 14
```

Remplacer `backup-host` par un alias SSH configuré et `age1…` par la clé publique obtenue. Le compte distant doit lire la configuration et utiliser Docker, ce qui lui donne un accès administrateur sur l'hôte. Le [guide de sauvegarde](migration-backups.md) détaille ces droits et les essais de restauration. Cette sauvegarde SSH contient PostgreSQL et la configuration ; téléchargements, fichiers partagés et état des torrents en sont exclus. La dernière sauvegarde enregistrée apparaît dans l'administration ; sans autre sauvegarde, un poste éteint laisse cette date vieillir.

### Sauvegarde FTP automatique facultative

Le serveur peut envoyer sa propre archive chiffrée sans dépendre du poste de sauvegarde. Il utilise Python 3, Docker Compose et `age` sur l'hôte ; seule la clé publique `age1…` obtenue ci-dessus va sur le serveur. Si aucune clé n'existe encore, la créer d'abord sur le poste de sauvegarde suivant le [guide de sauvegarde](migration-backups.md#clé-de-sauvegarde-sur-le-mac). Garder la clé privée et sa seconde copie protégée hors de cet hôte. Laisser `BACKUP_FTP_ENABLED=false` tant que `BACKUP_AGE_RECIPIENT` n'est pas renseigné : les identifiants FTP seuls ne suffisent pas.

Éditer les variables suivantes dans `.env` sans charger ce fichier dans le shell ; Compose les résout dans `x-backup-ftp`. Ne jamais afficher la configuration résolue contenant les identifiants.

| Variable | Valeur |
| --- | --- |
| `BACKUP_FTP_ENABLED` | `true` pour activer ; `false` par défaut. |
| `BACKUP_FTP_HOST`, `BACKUP_FTP_USER`, `BACKUP_FTP_PASSWORD` | Hôte et identifiants fournis par le service de sauvegarde. |
| `BACKUP_FTP_PORT` | `21` par défaut. |
| `BACKUP_FTP_TLS` | `false` par défaut ; `true` impose le FTPS explicite avec vérification du certificat. |
| `BACKUP_FTP_DIRECTORY` | `torrents-duck` par défaut ; dossier dédié à cette installation. |
| `BACKUP_AGE_RECIPIENT` | Clé publique `age1…` ; jamais la clé privée. |
| `BACKUP_FTP_QUOTA_BYTES` | `100000000000` par défaut (100 Go décimaux). |
| `BACKUP_FTP_KEEP` | `1` par défaut. |

L'archive contient la base et la configuration complètes, puis les fichiers ordinaires de `share` par taille croissante dans la place restante. `backup-manifest.json` indique les fichiers retenus, le nombre et le volume écartés par manque de place, ainsi que le nombre d'entrées écartées pour sécurité ; `downloads` et l'état qBittorrent restent exclus. Le budget par archive est au plus `quota / (keep + 1)`, soit 50 Go par défaut, afin de garder l'ancienne copie pendant l'envoi. Les autres fichiers du dossier FTP comptent aussi ; réduire le quota si le même compte sert à d'autres usages. Le script envoie sous nom `.partial`, contrôle la taille, renomme puis relit entièrement l'archive distante pour comparer son SHA256 à celui de la copie locale. Ce contrôle implique un aller-retour complet de l'archive sur le réseau. L'enregistrement de réussite dans l'application précède la purge des seules anciennes archives du script.

Une archive chiffrée temporaire est préparée dans `DATA_ROOT/backup-ftp`, avec un budget calculé au départ pour laisser 10 % d'espace libre ; dump et configuration en clair restent dans `/dev/shm`. Après déploiement, le timer lance la sauvegarde chaque jour à 03 h 30, heure du serveur, avec jusqu'à 30 minutes de délai aléatoire. Tester un envoi puis une restauration isolée suivant le [guide de sauvegarde](migration-backups.md#sauvegarde-ftp-automatique-depuis-le-serveur) :

```sh
sudo systemctl start torrentduck-backup.service
sudo journalctl -u torrentduck-backup.service -n 50 --no-pager
```

Pour Dedibackup, envoyer depuis le réseau Dedibox et conserver au plus 1 000 fichiers sur le compte. Le FTP sans TLS transmet les identifiants en clair ; `age` protège le contenu de l'archive. Utiliser les paramètres et contraintes de la [documentation Scaleway](https://www.scaleway.com/en/docs/dedibox/how-to/use-dedibackup-ftp-backup/). Ce FTP sortant est indépendant du FTPS obligatoire pour les membres.

## Mettre à jour

Pour les mises à jour courantes d'un dépôt Git installé dans `/opt/torrentduck`, copier une fois le script dans le compte propriétaire du dépôt :

```sh
cd /opt/torrentduck
install -m 755 scripts/update.sh "$HOME/deploy-torrentduck.sh"
"$HOME/deploy-torrentduck.sh"
```

Les fois suivantes, lancer simplement `~/deploy-torrentduck.sh`, **sans sudo devant le script**. Git utilise le compte courant ; sudo demande le mot de passe pour la partie Docker et système. Le dépôt doit avoir une branche avec un suivi distant configuré. Le script refuse deux déploiements simultanés et les modifications locales, y compris les fichiers non suivis non ignorés, puis fait `git pull --ff-only` et appelle `scripts/deploy.sh` : construction, schéma, pare-feu et unités systemd restent gérés par la procédure existante. Il recrée ensuite Nginx pour appliquer son template et vérifie `/api/health` en HTTPS public. Les sessions web et FTPS peuvent être interrompues.

La suppression administrateur dans `downloads` nécessite cette mise à jour complète pour reconstruire les images et recréer les conteneurs `web` et `ftp` avec leurs nouveaux montages ; un simple redémarrage ne suffit pas.

Le nettoyage s'exécute avant la construction et à la sortie, même en cas d'échec : seules les images sans tag du projet qui ne sont plus utilisées par un conteneur sont supprimées. Le cache de build inutilisé du builder Docker par défaut est réduit avec `--keep-storage 1GB` ; ce cache est commun aux autres projets éventuels de l'hôte. Le script exige au moins 10 % libres plus 5 Gio sur le volume Docker avant de construire. Il ne crée ni archive ni tag de sauvegarde et ne supprime aucun volume, fichier partagé, téléchargement ou sauvegarde existante. Les sorties restent dans le terminal.

Conserver une sauvegarde externe régulière et éprouver sa restauration séparément : ce script n'en crée pas à chaque déploiement. Il ne télécharge pas automatiquement de nouvelles images PostgreSQL ou Certbot ; leur mise à jour reste une opération de maintenance. Examiner les éventuelles nouvelles variables de `.env.example` avant le déploiement. Garder `.env`, `DATA_ROOT` et les secrets existants, en particulier `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_PASSWORD` et le mot de passe de `DATABASE_URL` : changer seulement ces variables ne change pas les mots de passe d'une base déjà initialisée. Une rotation doit coordonner PostgreSQL et la configuration applicative. Maintenir PostgreSQL en version majeure 17 pour cette procédure ; un changement de version majeure exige une migration dédiée. Reprendre les contrôles de fonctionnement après la mise à jour.

## Tests de protocoles sur une instance de test

Sur une machine de développement ou de test, avec Docker accessible au compte exécutant Python :

```sh
docker compose --env-file .env.example build
docker run --rm --entrypoint python3 -v "$PWD/deploy/ftp:/checks:ro" torrentduck-ftp /checks/test_server.py
python3 tests/infrastructure.integration.py
```

La commande dans l'image FTPS teste les chemins, les uploads, la réserve disque et les renommages avec des fichiers temporaires, sans connexion à un service existant.

Le test exige **le sous-réseau libre `172.30.20.0/24` et les ports locaux `50000–50100` libres**. Une pile de production utilise déjà ces ressources : utiliser une instance de test séparée. Le script crée et supprime ses conteneurs `duck-infra-…` et son réseau temporaire ; il n'altère pas le pare-feu de l'hôte.

Il exerce le RPC protégé, l'ajout/arrêt/reprise et la persistance qBittorrent, X-Accel et les requêtes `Range` Nginx, TLS FTPS obligatoire, droits des membres et administrateurs dans `downloads`, écriture/renommage/suppression dans `share` et révocation des sessions. Le torrent est une fixture locale sans tracker, avec DHT/PEX/découverte locale désactivés. Le certificat autosigné reste limité au test. L'API d'authentification est simulée ; les tests applicatifs couvrent séparément comptes et droits. Ce test ne vérifie pas ACME public, le routage passif externe, le pare-feu Linux, les pairs Internet ni les performances de l'hôte.
