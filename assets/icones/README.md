# Icônes LISTMAX

Ce dossier contient le logo et les icônes de la barre de navigation. Ce sont
pour l'instant des **exemples** (traits fuchsia simples) — remplace-les
directement par tes propres fichiers, en gardant **exactement les mêmes noms**.

| Fichier             | Utilisé pour                                  |
|----------------------|------------------------------------------------|
| `logo.svg`           | Logo de l'app (écran de connexion + en-tête)   |
| `nav-home.svg`       | Onglet "Home"                                   |
| `nav-todo.svg`       | Onglet "To-do list"                             |
| `nav-calendar.svg`   | Onglet "Calendar"                               |
| `nav-goals.svg`      | Onglet "Life goals"                             |
| `nav-settings.svg`   | Onglet "Settings"                               |

## Comment remplacer une icône

1. Prépare ton image (voir recommandations ci-dessous).
2. Renomme-la exactement comme dans le tableau ci-dessus (ex : `nav-home.svg`).
3. Remplace le fichier existant dans ce dossier (`assets/icones/`) — sur
   GitHub : ouvre le fichier, bouton crayon "Edit" n'accepte pas les images,
   utilise plutôt **Add file → Upload files** et dépose ta nouvelle version
   avec le même nom, GitHub proposera de remplacer l'ancienne.
4. Recharge l'app : ta nouvelle icône apparaît immédiatement, aucune
   modification de code n'est nécessaire.

## Recommandations

- **Format** : SVG de préférence (net à toutes les tailles, fichier léger).
  PNG fonctionne aussi (voir plus bas).
- **Taille du logo** : carré, idéalement 512×512 px si PNG, ou un `viewBox`
  carré si SVG (ex. `0 0 24 24`).
- **Taille des icônes de nav** : carré également, simple et lisible en
  petit format (elles s'affichent à 24×24 px dans l'app).
- **Fond transparent** recommandé pour un rendu propre sur le thème sombre.

## Utiliser des PNG / JPG à la place de SVG

Tu peux tout à fait utiliser des `.png` ou `.jpg`. Il suffit de :
1. Nommer ton fichier `logo.png` (ou `.jpg`) au lieu de `logo.svg`, par exemple.
2. Ouvrir `index.html`, chercher la ligne concernée (attribut
   `data-icon-src="assets/icones/logo.svg"`) et remplacer l'extension par
   `.png`/`.jpg`. Fais de même pour les icônes `nav-*.svg` que tu changes.

## Si un fichier est absent ou cassé

Pas de panique : l'app affiche automatiquement une icône de secours
(Material Symbols) à la place, le temps que tu ajoutes/corriges le fichier.
Rien ne plante.
