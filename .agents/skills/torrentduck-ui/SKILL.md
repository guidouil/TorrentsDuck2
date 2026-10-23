---
name: torrentduck-ui
description: Modifier les pages, composants Svelte, styles et traductions de Torrents Duck 2 en réutilisant son interface et ses contrats API. À utiliser pour les changements visibles dans le navigateur.
---

# Interface Torrents Duck

Les chemins ci-dessous sont relatifs à la racine du dépôt.

## Points d'entrée

- Lire la page concernée, son éventuel `+page.server.ts` et les layouts parents.
  `src/routes/(app)/` contient les pages réservées aux membres approuvés ;
  `login/`, `register/`, `waiting/` et `reset-password/` ont leurs parcours propres.
- Réutiliser `src/lib/Modal.svelte`, les helpers `api`, `bytes` et `duration` de
  `src/lib/client.ts`, et les classes/variables de `src/routes/styles.css`.
- Ajouter les libellés aux deux dictionnaires `fr` et `en` de `src/lib/i18n.ts`.
  Utiliser `$t` comme les pages voisines ; conserver le choix de langue et de
  thème géré par les layouts.

## Conventions à conserver

- Suivre les composants existants : TypeScript, `$props`, `$state`, `$derived`,
  événements `onclick`/`onsubmit` et snippets. Ne pas introduire une seconde
  bibliothèque de composants ou un autre système de styles.
- Garder les accès à `window`, `document`, `localStorage` et `EventSource` dans
  le cycle de vie navigateur. Fermer flux et timers au démontage.
- `api()` accepte du JSON sérialisé ou un `FormData` et remonte les erreurs HTTP.
  Laisser le navigateur définir le Content-Type multipart. Ne jamais appeler le
  RPC qBittorrent ou importer `src/lib/server/` depuis un composant.
- La page des transferts reçoit un instantané initial puis les événements de
  `/api/events` ; préserver les états de connexion, erreur et accès révoqué.
- Conserver les états chargement/vide/erreur et désactiver les actions pendant
  leur exécution. Les suppressions collectives gardent leur dialogue explicite,
  le nom de la cible et la distinction retrait/suppression des données.
- Préserver labels, boutons accessibles, navigation clavier et focus des
  dialogues. Utiliser les variables CSS pour les deux thèmes et vérifier la
  présentation mobile, notamment sous le breakpoint existant de 700 px.

## Vérification

Lancer `npm run check`, puis les vérifications applicatives de `AGENTS.md`.
Si le MCP Svelte est disponible, passer les composants modifiés dans son
Autofixer et revérifier après correction. Pour un changement visuel, examiner
le parcours concerné en français/anglais, en clair/sombre et sur mobile avec
les outils navigateur disponibles. Signaler si cette vérification n'a pas pu
être faite. Un changement de contrat API utilise aussi le skill `torrentduck-api`.
