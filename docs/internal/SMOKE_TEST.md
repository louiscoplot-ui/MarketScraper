# SuburbDesk — Smoke Test Checklist

10 minutes, à faire après chaque session de fixes.

## AUTH

- [ ] Ouvre suburbdesk.com en navigation privée → page login s'affiche
- [ ] Connecte-toi avec ton email → accès au dashboard

## SIDEBAR

- [ ] Tape "Subiaco" dans la recherche → "Subiaco 6008" apparaît
- [ ] Tape "Balcatta" → "Balcatta 6021" apparaît

## LISTINGS

- [ ] Onglet Listings → tableau charge avec des propriétés
- [ ] Filtre "Sold" → affiche des sold
- [ ] Clique "+ Note" sur une ligne → tu peux sauvegarder une note

## PIPELINE

- [ ] Onglet Pipeline → sélectionne Nedlands 14 days → des targets apparaissent
- [ ] Bouton "Word" sur une ligne → lettre se télécharge

## MARKET REPORT

- [ ] Onglet Market Report → sélectionne un suburb → rapport charge
- [ ] Section Withdrawn apparaît EN PREMIER dans le rapport

## HOT VENDORS

- [ ] Onglet Hot Vendors → liste des uploads apparaît
- [ ] Clique un rapport existant → données chargent sans spinner infini

## SCRAPE

- [ ] Clique scrape sur un suburb existant → modal s'ouvre, progress visible
- [ ] Clique Cancel → modal se ferme, scrape s'arrête
- [ ] Refresh page → modal ne se rouvre PAS automatiquement

## ADMIN

- [ ] Onglet Admin → liste users visible
- [ ] Ton user a bien role=admin
