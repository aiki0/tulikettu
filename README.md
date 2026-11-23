# 🦊 Tulikettu – revontulivahti Ylläsjärvelle

Kertoo, näkyykö revontulia Ylläsjärvellä juuri nyt, milloin tänä yönä ja seuraavina öinä on paras hetki katsoa,
onko aurinkomyrskyjä tulossa, ja missä lähistöllä taivas on selkein. Lähettää ilmoituksen puhelimeen ntfy-sovellukseen.

Nimi tulee kansantarusta: tulikettu juoksee tuntureilla ja lakaisee hännällään lumesta kipinöitä taivaalle.

## Osat
- `core.js` – kaikki logiikka (datan haku, Aurinko/Kuu, pisteytys, yön parhaat ikkunat, varmuussignaalit). Toimii selaimessa ja Nodessa.
- `index.html`, `app.js`, `style.css` – verkkosovellus (PWA, lisää Koti-valikkoon).
- `watcher.mjs` – taustavahti: ilmoitukset ntfy:hin + `fmi.json`-tilannekuva Ilmatieteen laitoksen R-indeksistä (FMI ei salli CORSia).
- `notify.js` – ilmoituspäätökset ja ntfy-lähetys (yhteinen GitHubille ja Workerille).
- `worker/` – Cloudflare Worker: vahti **joka minuutti** + `/fmi.json` (FMI CORS-proxy) + `/health`. Deploy: `cd worker && npx wrangler deploy`. Secrets: `NTFY_TOPIC`, `APP_URL`, `NTFY_TOKEN`.
- `.github/workflows/watch.yml` – 10 min välein: julkaisee sivun Pagesiin ja on varavahti (lähettää vain jos Worker ei ole ajanut 8 min sisällä tai ei pysty lähettämään).
- `simulate.mjs` – simuloi myrskyillan ilmoitukset.

## Datalähteet
| Mitä | Lähde |
|---|---|
| Revontulten todennäköisyys nyt (R-indeksi, RX-nowcast) | Ilmatieteen laitos, space.fmi.fi (CC BY 4.0) |
| Magnetometrit (varalla) | FMI avoin data WFS |
| Kp nyt + 3 vrk ennuste, aurinkotuuli (Bz, nopeus), OVATION, varoitukset, 27 vrk näkymä | NOAA SWPC |
| CME-osumat Maahan | NASA DONKI WSA-Enlil |
| Pilvisyys | Open-Meteo, MET Nordic |
| Aurinko ja Kuu | lasketaan paikallisesti (SunCalc-algoritmit) |

## Ilmoitukset
| Milloin | Mitä |
|---|---|
| Muonion R-indeksi ylittää FMI:n rajan, pimeää ja selkeää | "Revontulia nyt" (suuri raja → kiireellinen) |
| Revontulia, mutta pilvessä ja lähellä selkeää | Pilvipako: minne ajaa |
| Bz etelään ≥15 min ja voimakas kytkentä | "Purkaus todennäköinen pian" |
| Indeksi ≥50 | "Hyvä hetki katsoa taivaalle" |
| Uusi NOAA:n myrskyvaroitus / CME-osuma | Kerran per varoitus |
| CME:n saapumisikkuna aukeaa | "L1-valvonta päällä" (kerran) |
| Ikkunassa: L1-tiheys ×2, kenttä ×1,7 tai nopeus +40 km/s | "CME:n reuna saapui – osuu ~N min päästä" (kiireellinen) |
| Ikkunassa: Bz ≤ −5 nT 10 min | "Bz kääntyi etelään" |
| Klo 15 joka päivä | Yön katsaus: paras ikkuna, %, pilvet, kuu |

## Avaimet
Avaimet ovat tiedostossa `.env` (ei gitissä, ks. `.env.example`). Workerin päivitys:
```sh
set -a; source .env; set +a
cd worker && npx wrangler deploy
```

## Käyttö paikallisesti
```sh
node --test test/
node watcher.mjs --dry --force-daily --site .   # tulostaa ilmoitukset, kirjoittaa fmi.json
node simulate.mjs                               # simuloi myrskyillan ilmoitukset
python3 -m http.server 4321                     # avaa http://localhost:4321
```
Secrets (GitHub): `NTFY_TOPIC` (pakollinen), `NASA_KEY` (valinnainen, api.nasa.gov). `APP_URL` (secret, linkki ilmoituksista).
