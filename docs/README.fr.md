# IP Player — Extension Chrome

[Español](../README.md) · [English](README.en.md) · [Català](README.ca.md) · [Euskara](README.eu.md) · [Français](README.fr.md) · [Português](README.pt.md)

---

Lecteur de listes de lecture M3U avec prise en charge complète de **DASH**, **HLS** et **Smooth Streaming (ISM/ISML)**, ainsi que des DRM **ClearKey**, **Widevine** et des serveurs de licences personnalisés. Intègre [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 pour le MSS en direct et [hls.js](https://github.com/video-dev/hls.js) 1.5 pour le HLS FairPlay/SAMPLE-AES avec clés connues, tous inclus dans `lib/` sans dépendance distante.

## Installation

1. Accédez à `chrome://extensions` et activez le **Mode développeur**.
2. Cliquez sur **Charger l'extension non empaquetée** et sélectionnez le dossier du projet.
3. Cliquez sur l'icône de l'extension dans votre barre d'outils pour lancer le lecteur.

## Utilisation

- **Listes de lecture** (icône ☰) : Ajoutez une liste par URL, fichier local ou en collant directement le texte brut. Elles sont enregistrées dans l'extension et peuvent être rafraîchies à tout moment.
- **Ouvrir un flux** (icône 🔗) : Lisez une URL individuelle avec type, DRM et en-têtes configurables manuellement. Accepte également les entrées M3U brutes au format `#KODIPROP`.
- **Modifier** (icône crayon) : Ouvre le canal en cours de lecture dans le formulaire pour ajuster les clés, les licences ou les en-têtes.
- **Contrôles personnalisés du lecteur**, identiques sur Shaka et dash.js : Sélection de la qualité (affiche la résolution active ou ⚙ → Qualité), pistes audio, sous-titres, vitesse de lecture, barre de progression DVR pour les flux en direct, indicateur « EN DIRECT », volume, Picture-in-Picture (PiP) et plein écran.
- **Listes personnalisées** (☰ → *Créer une liste personnalisée*) : Créez vos propres listes et organisez-les en catégories (créer, renommer, supprimer, déplacer et réorganiser les chaînes par glisser-déposer). Pour enregistrer une chaîne dans vos listes, utilisez le bouton dossier de la barre inférieure ou l'option « Enregistrer dans la liste » du formulaire. Toute liste peut être **téléchargée en M3U** (incluant `#KODIPROP`, `#EXTVLCOPT` et `#EXTHTTP`, prêt pour Kodi, TiviMate ou VLC) ou **en JSON**, permettant une réimportation complète.
- **Assistance intégrée** : Guide rapide lors du premier lancement (accessible via le bouton ?), infobulles détaillant les raccourcis clavier sur chaque bouton, fenêtres d'erreur avec options « Réessayer » et « Inspecter le flux », et mode de texte agrandi pour l'accessibilité.
- **Langues et sous-titres** : Si le flux propose plusieurs pistes, ⚙ → *Audio* et ⚙ → *Sous-titres* listent les langues et caractéristiques (5.1 surround, audiodescription, CC, forcés). Le bouton **CC** active/désactive instantanément les sous-titres. La préférence de langue est conservée pour les chaînes suivantes. Prise en charge de WebVTT, TTML et CEA-608 sur DASH, HLS et Smooth Streaming.
- **Interface adaptative** : Lecteur affiché en haut uniquement pendant la lecture (avec bouton de fermeture), mini-lecteur flottant lors du défilement, et blocs de chaînes organisés par catégorie (vue en ligne ou en grille avec filtres rapides, favoris et chaînes récemment consultées).
- **Bouton d'ajout unifié** : Un seul bouton pour ajouter une chaîne (avec assignation directe de liste et de catégorie), une catégorie, une liste M3U (lien/fichier/texte) ou une liste personnalisée.
- **Édition directe** : Renommez listes et catégories en cliquant directement sur leurs titres, réorganisez les catégories, déplacez les chaînes par glisser-déposer et accédez au menu contextuel ⋯ de chaque chaîne (modifier, déplacer, dupliquer, supprimer).
- **Langues de l'interface** : Espagnol, anglais, catalan, basque, français et portugais (Portugal et Brésil via sous-menu). Chaque langue est définie dans `locales/<code_langue>.json` selon la structure `{ "texte espagnol": "traduction" }`.
- **Proxy pour les flux (HTTP, HTTPS, SOCKS4 et SOCKS5)** : Permet de router les flux et leurs manifestes via un proxy. Configurez un proxy général dans ? (Aide) → *Options* (avec bouton de test de connexion), ou définissez un proxy spécifique par chaîne dans *Options avancées* → *Proxy*. Prend en charge l'authentification par identifiant et mot de passe en HTTP/HTTPS. La présence d'un proxy actif est signalée par le badge **Proxy** dans les métadonnées de lecture.
- **Guide TV (EPG) intégré** : Prise en charge complète des grilles de programmes XMLTV en texte clair (`.xml`) ou compressées avec gzip (`.xml.gz`, décompression native dans le navigateur avec `DecompressionStream`). Si une liste M3U contient la directive `#EXTM3U url-tvg="..."` ou `x-tvg-url="..."`, le guide est automatiquement téléchargé, analysé et associé aux chaînes.
  - **Superposition en cours de lecture** : Barre de progression en direct, horaires et aperçu du programme suivant dans le lecteur.
  - **Grille interactive du Guide TV** (bouton « Guide TV » ou raccourci `G`) : Vue dédiée sur 24 heures avec sélection de dates, filtres par catégorie, champ de recherche, indicateur vertical rouge « Maintenant », détails complets du programme et lecture immédiate.
  - **Persistance dans IndexedDB** : Mise en cache locale des données du guide pour un affichage instantané dès l'ouverture.

### Raccourcis clavier

| Touche | Action |
|---|---|
| `Espace` / `K` | Lecture / Pause |
| `←` / `→` | Reculer / Avancer de 10 s |
| `↑` / `↓` | Augmenter / Baisser le volume |
| `M` | Couper / Réactiver le son |
| `C` | Activer / Désactiver les sous-titres |
| `F` | Plein écran (ou double-clic) |
| `PageUp` / `PageDown` | Chaîne précédente / suivante |
| `/` | Rechercher une chaîne |
| `G` | Guide TV (EPG) |
| `N` | Ajouter une chaîne |
| `?` | Aide et tableau des raccourcis |

- **Menu contextuel** : Clic droit sur n'importe quel lien web → « Lire dans IP Player » ou « Charger comme liste M3U ».

## Balises M3U prises en charge

| Balise | Attributs / Syntaxe |
|---|---|
| `#EXTM3U` | `url-tvg="https://…/guide.xml.gz"`, `x-tvg-url="…"` |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Sport` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie`, `http-proxy`, `socks-proxy` |
| `#EXTHTTP` | `#EXTHTTP:{"User-Agent":"…","Cookie":"…"}` |
| URL avec `\|` | `https://…/index.mpd\|User-Agent=X&Referer=Y` |

### Formats DRM

```m3u
# ClearKey avec clés locales (hex, UUID ou base64 ; séparées par des virgules)
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KID:KEY

# ClearKey au format JSON / JWK
#KODIPROP:inputstream.adaptive.license_key={"keys":[{"kty":"oct","kid":"…","k":"…"}]}

# Widevine avec serveur de licences : URL|en-têtes|modèle de corps|modèle de réponse
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic/wv|Authorization=Bearer%20x|b{SSM}|JBlicense

# Ancien format Kodi
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|KID:KEY

# HLS FairPlay (SAMPLE-AES en TS) avec clé connue : KID:KEY, KEY seule ou *:KEY:IV
#KODIPROP:inputstream.adaptive.license_type=com.apple.fps
#KODIPROP:inputstream.adaptive.license_key=*:KEY:IV

# HLS FairPlay avec proxy de clés (requête GET ; accepte {uri}, {id} = texte après skd://, et {kid})
#KODIPROP:inputstream.adaptive.license_key=https://mon-proxy/cle?id={id}
```

Modèles : Corps `R{SSM}` (binaire), `b{SSM}` (base64) ou `B{SSM}` (base64 URL-encoded) ; Réponse vide (binaire), `B` (base64) ou `J<champ>` / `JB<champ>` (champ JSON en base64).

### Proxy dans les listes M3U

```m3u
# Proxy par chaîne (SOCKS5, SOCKS4, HTTP ou HTTPS ; accepte utilisateur:mot_de_passe en HTTP/HTTPS)
#EXTVLCOPT:http-proxy=socks5://127.0.0.1:1080
#EXTINF:-1 group-title="Chaînes via proxy",Chaîne via SOCKS5
https://exemple.fr/stream.m3u8
```

## Notes techniques

- Les en-têtes personnalisés (`User-Agent`, `Referer`, `Origin`, `Cookie`) sont appliqués de manière sécurisée via `declarativeNetRequest`, restreints strictement aux requêtes initiées par l'extension.
- **Proxy PAC dynamique (`chrome.proxy`)** : Le proxy est configuré via un script PAC généré dynamiquement (`FindProxyForURL`). Seuls les domaines des médias du canal en cours (manifeste, fragments vidéo, serveurs de clés/licences) transitent par le proxy ; le trafic web normal du navigateur reste direct. L'arrêt de la lecture ou la fermeture de l'onglet libère immédiatement le proxy.
- **Smooth Streaming en direct** : Shaka Player ne gère nativement que le MSS à la demande (VOD). Pour les flux MSS en direct (erreur 4047), le lecteur bascule automatiquement sur le moteur **dash.js**. Ce moteur prend en charge le contenu non chiffré et le DRM ClearKey.
- **HLS FairPlay / SAMPLE-AES en TS** : Les navigateurs basés sur Chromium ne disposent pas de module CDM FairPlay. Si la chaîne fournit des clés ClearKey ou un proxy de clés, IP Player bascule sur **hls.js** (`lib/hls.min.js`, 1.5.20), intercepte les descripteurs `skd://` et déchiffre les segments TS en local. Si le vecteur d'initialisation (IV) est absent du manifeste, spécifiez `*:KEY:IV`.
- **PlayReady** : Fonctionne exclusivement sur Microsoft Edge (Chrome ne dispose pas du CDM PlayReady). Sur Chrome, utilisez Widevine ou ClearKey.
- Les flux MPEG-TS bruts (`.ts` isolés sans manifeste) ne sont pas pris en charge ; les flux HLS contenant des segments TS le sont parfaitement.
- Le fichier `sample/ejemplos.m3u` fournit des exemples de flux publics pour chaque format (accessible via le bouton « Liste d'exemple »).

## Licence

Ce projet est distribué sous licence [Creative Commons Attribution - Pas d'Utilisation Commerciale - Partage dans les Mêmes Conditions 4.0 International (CC BY-NC-SA 4.0)](../LICENSE).
- **Attribution obligatoire (BY)** : Vous devez créditer **Francesc Xavier Rosselló Encinas**.
- **Pas d'utilisation commerciale (NC)** : La vente, la commercialisation ou la monétisation de ce logiciel et de ses dérivés sont strictement interdites.
- **Partage dans les mêmes conditions (SA)** : Les modifications sont autorisées à condition que toute œuvre dérivée soit diffusée sous cette même licence stricte.
