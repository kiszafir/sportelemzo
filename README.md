# Sportelemző

Helyben futó, magyar nyelvű sportelemző és szelvényépítő öt sportágra:
- **NBA**, **NHL**, **tenisz** (ATP/WTA),
- **labdarúgás:** Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Bajnokok Ligája, Európa-liga, Konferencia-liga, Eredivisie, Primeira Liga, Championship, Süper Lig, Jupiler Pro League, skót Premiership, MLS, NB I,
- **kézilabda:** férfi és női EHF Bajnokok Ligája, férfi és női NB I, Handball-Bundesliga.
Modellvalószínűséget, méltányos szorzót, árrés nélküli piaci valószínűséget, értéket (EV), bizalmi pontszámot és magyar nyelvű indoklást ad meccsenként, és „Könnyű” (≤ 10,00) valamint „Brutális” (≥ 70,00) kombinált szelvényeket generál.

> **Csak tájékoztató és elemző célra, 18 éven felülieknek.** Nincs garantált kimenetel; a szerencsejáték pénzügyi kockázattal jár és függőséget okozhat. Az alkalmazás nem köt fogadást, és nem kapcsolódik fogadóirodai fiókhoz. Segítség: Szerencsejátékos Segélytelefon (06-80) 980-025, Lelki Elsősegély 116-123.

---

## 1. Telepítés és indítás

**Követelmény:** Node.js 18.17 vagy újabb (ajánlott: 20 vagy 22 LTS). Más nem kell: nincs adatbázis-szerver, nincs Docker, nincs API-kulcs.

```bash
npm install && npm start
```

Ezután nyisd meg: **http://localhost:3000**

Az alkalmazásnak **nincs külső függősége**, ezért az `npm install` gyakorlatilag azonnal lefut, és az `npm start` internet nélkül is működik.

| Parancs | Mit csinál |
|---|---|
| `npm start` | Indítás automatikus adatmódban (élő források, hiba esetén mintaadat) |
| `npm run mock` | Indítás tisztán mintaadattal, hálózat nélkül |
| `npm test` | Egységtesztek (szorzómatematika, modellek, kombinációs motor, adatforrás-normalizálás) |
| `npm run verify` | Végponttól végpontig tartó ellenőrzés mintaadat-módban, ideiglenes adatmappával |
| `npm run backtest` | Visszatesztelés (lásd 7. pont) |
| `npm run dev` | Indítás fájlfigyeléssel (fejlesztéshez) |

Másik port: `PORT=3001 npm start` (Windows PowerShell: `$env:PORT=3001; npm start`).

## 2. Adatmódok és jelölések

- **auto** (alapértelmezett): bajnokságonként az ESPN kulcs nélküli végpontjairól tölt. Ha egy forrás nem érhető el és nincs gyorsítótárazott adat, az adott bajnokság **mintaadatra** vált, és ezt a felület jelzi.
- **mock**: `npm run mock` vagy `DATA_MODE=mock` – teljesen hálózat nélkül, determinisztikus szimulációval. Az élő meccsek az órával együtt haladnak (állás, játékidő, lapok, szettek), így az automatikus frissítés is kipróbálható.
- **live**: csak élő források (hiba esetén is gyorsítótárra / mintára esik vissza, hogy a felület ne üresedjen ki).

Minden adatpont mellett látható a forrás állapota:

| Jelölés | Jelentés |
|---|---|
| **ÉLŐ** | Az elmúlt 2 percben frissített adat a szolgáltatótól |
| **GYORSÍTÓTÁR · kor** | Régebbi vagy a szolgáltató kiesése miatt tárolt adat, a korával |
| **MINTA** | Szimulált adat (nem valós esemény, szorzó vagy eredmény) |
| **BECSÜLT** | Nincs piaci szorzó: a modell méltányos szorzója 6% árréssel |
| **KÉZI** | Te adtad meg a szorzót a meccs adatlapján |

## 3. Opcionális, ingyenes API-kulcsok

Kulcs nélkül minden funkció működik. A kulcsok csak gazdagítják az adatot. Másold a `.env.example` fájlt `.env` néven, töltsd ki, amit szeretnél, majd indítsd újra az alkalmazást. A kulcsokat a program kizárólag környezeti változóból olvassa, sehol nem tárolja és nem naplózza.

| Változó | Szolgáltató | Mire használjuk | Ingyenes keret | Hol szerezhető |
|---|---|---|---|---|
| `THE_ODDS_API_KEY` | The Odds API | Fogadóirodai szorzók (NBA, NHL, tenisz, foci; NB I nincs) | 500 kredit/hó | https://the-odds-api.com |
| `API_SPORTS_KEY` | API-Sports (API-Football + API-Handball) | NB I meccsek és tabella, sérülések/eltiltások (foci), **kézilabda** meccsek és tabellák | 100 kérés/nap API-nként | https://api-sports.io |
| `FOOTBALL_DATA_KEY` | football-data.org | Tabella, pont/meccs, gólok, forma (PL, La Liga, Serie A, Bundesliga, Ligue 1, BL) | 10 kérés/perc | https://www.football-data.org |

**Az ESPN nem közli** az NB I-et és a kézilabdát. Ezekhez az `API_SPORTS_KEY` kell (ugyanaz a kulcs az API-Football és az API-Handball szolgáltatáshoz, mindkettőnek külön napi kerete van); kulcs nélkül ezek a bajnokságok MINTA jelöléssel futnak. A kézilabda-bajnokságokat a program ország és név alapján keresi meg az API-Handballban, a napi meccslistát pedig egyetlen kéréssel kéri le az összes bajnokságra. Ha az ingyenes csomag nem engedi az aktuális szezont, az API-Sports hibaüzenete az Adatforrások oldalon látszik.

**Kvótakímélés:** minden szolgáltató saját sebességkorláttal, napi kerettel, exponenciális visszalépéssel (backoff) és „circuit breakerrel” fut (3 egymás utáni hiba után 5 perc szünet). The Odds API alapból csak `h2h` piacot kér (1 kredit/kérés), csak olyan bajnokságra, amelynek 36 órán belül meccse van, bajnokságonként 12 óránként, napi max. 15 kredit – ez havi ~450 kredit. A sok bajnokság miatt egy napon nem mindegyik kap piaci szorzót; a keret a `ODDS_API_DAILY_CREDITS` értékkel emelhető, ha nagyobb csomagod van. A sportkulcsokat (kézilabdáét is) a program a díjmentes `/sports` végpontból ellenőrzi. Állítható: `ODDS_API_MARKETS`, `ODDS_API_TTL_HOURS`, `ODDS_API_DAILY_CREDITS`. Bármely szolgáltató kikapcsolható: `PROVIDER_ODDSAPI=off` stb.

## 4. Adatforrások és felhasználási feltételek

| Forrás | Kulcs | Feltételek |
|---|---|---|
| ESPN nyilvános JSON (`site.api.espn.com`) – menetrend, állás, rekordok, tabella, esetenként beágyazott szorzók | nem kell | Nem hivatalos, dokumentálatlan végpontok; bármikor megváltozhatnak. Csak személyes, nem kereskedelmi használatra. |
| Open-Meteo – időjárás és tengerszint feletti magasság (szabadtéri focimeccsek) | nem kell | Nem kereskedelmi használatra ingyenes, CC BY 4.0 (forrásmegjelölés: Open-Meteo.com). |
| The Odds API | opcionális | A szolgáltató felhasználási feltételei szerint; az ingyenes keret havi 500 kredit. |
| API-Sports | opcionális | A kulcs a saját fiókodhoz kötött; napi 100 kérés. |
| football-data.org | opcionális | Ingyenes csomag nem kereskedelmi célra; forrásmegjelölés ajánlott. |
| Beépített mintaadat | – | Szimuláció. A csapatnevek valósak, de minden hozzájuk tartozó szám kitalált; a teniszezők, kapusok és sérült játékosok nevei fiktívek, hogy valós személyekről ne jelenjen meg kitalált állítás. |

A felület **Adatforrások** oldala megmutatja, melyik szolgáltató aktív, mikor frissült utoljára, mennyi a napi kerete és milyen hibát adott.

## 5. Funkciók röviden

- **Meccselemzés:** sportág-/bajnokságváltó, napszűrő (Élő, Ma, Holnap, Később, Tegnap), **Statisztika nézet** kapcsoló (kategóriák egymás mellett: meccsszám, élő, értéktippek, átlagos bizalom, átlagos EV, adatlefedettség). Meccsenként: állás és játékidő, modellvalószínűség-sáv a piaci (árrés nélküli) jelöléssel, ajánlás szorzóval, EV-vel és bizalommal.
- **Meccs adatlap:** minden piac (modell, méltányos szorzó, legjobb piaci szorzó kiemelve, árrés nélküli valószínűség, előny, EV, Kelly), **saját szorzó megadása** (az érték azonnal újraszámolódik), tényezőtábla forrással és frissességgel, élő tényezők, piaci mozgás (nyitó → aktuális), modellrészletek, Kelly-tétjavaslat és rögzítés a bankrollba.
- **Frissítés:** élő meccseknél 45 másodpercenként (Server-Sent Events, kiesés esetén lekérdezés), kézi „Frissítés” gomb, „Utolsó frissítés” időbélyeg.
- **Kiegészítő piacok minden sportágban:** gólszerző (foci, NHL), játékos pontjai (NBA) / góljai (kézilabda), hendikep (ázsiai, puck line, játékhendikep), több over/under vonal és csapatonkénti gólszám/pontszám, mindkét csapat gól (foci, NHL; teniszben „mindkét játékos nyer szettet”), sárga lapok (foci).
- **Piacszűrő a mixekben:** kiválasztható, milyen piactípusokból álljon a szelvény (pl. csak gólszerző és sárga lap).
- **Egy nap, egy szelvény:** minden mix-szelvény meccsei ugyanazon a napon kezdődnek; a napot (Ma / Holnap / Holnapután) a mix oldalán lehet váltani.
- **AI-motor:** helyi, önállóan tanuló réteg (lásd lent).
- **Könnyű mix:** 2–6 tétel, eredő szorzó ≤ 10,00, nagy valószínűségű tételek (favorit, kettős esély, gólszám, legalább egy szett / szettveszteség nélküli győzelem). Tételek rögzíthetők lakattal, a többi újragenerálható.
- **Brutális mix:** eredő szorzó ≥ 70,00, mind a négy sportágból, élő tételekkel ahol lehet; eltérő (sötét, csíkos) megjelenés, minden szelvényen kockázati figyelmeztetés, becsült esély („1 a N-hez”), EV, diverzifikációs pontszám, korrelációs büntetés.
- **Statisztika:** heti pontosság a várthoz képest, kumulált ROI, találati arány sportágankénti, fogadástípusonkénti és bizalmi sávonkénti bontásban, tippnapló (nyert / veszített / érvénytelen) automatikus elszámolással; szűrők: dátum, sportág, piac, adatforrás.
- **Bankroll:** saját fogadások, egyenleg, futó egyenleg, grafikon, tört Kelly tétjavaslat plafonnal; a modelltipphez kötött fogadás automatikusan elszámolódik.
- **Felelős játék:** napi/heti tét- és veszteségkorlát (a szerver is betartatja; emelés csak 24 óra után lép életbe), munkamenet-emlékeztető, önkéntes szünet (1/7/30 nap, nem rövidíthető), önkizárási tájékoztató, magyar segítő szervezetek. 18+ életkor-ellenőrzés az első indításkor.
- Világos és sötét téma, mobilbarát elrendezés, billentyűzettel kezelhető, csökkentett mozgás tiszteletben tartása, minden diagram mellett táblázatos adatnézet.

## 5/b. AI-motor – mit csinál és mit nem

Nem chatbot és nem külső szolgáltatás: statisztikai tanulás a saját lezárt meccseidből, a gépeden, internet és kulcs nélkül.

1. Minden meccs előtt elmenti a modell nyers becslését, a piac árrés nélküli valószínűségét és a tényezőket, a meccs végén pedig az eredményt (`data/db.json`, `learn`).
2. Sportáganként és piaconként egy kalibráló-összegzőt tanít: megtanulja, hogy a modell túl magabiztos vagy túl óvatos-e, túlbecsüli-e a hazait, és mennyire bízzon a modellben a piachoz képest.
3. **Csak akkor kapcsol be**, ha legalább 80 lezárt eset van, és a régebbi 75%-on tanítva a legújabb 25%-on bizonyíthatóan jobb (log loss), mint a nyers modell. Különben semmit nem változtat.
4. Az AI-korrigált becslés minden piacon látszik a nyers érték mellett, az ajánlás indoklása is jelzi.
5. Megmutatja, mely tényezők jelezték előre valójában az eredményeket, és magyar nyelvű megfigyeléseket ír (pl. „a 70–80%-ra becsült kimenetelek csak 61%-ban jöttek be”).
6. Mintaadaton tanult beállításokat soha nem alkalmaz élő meccsekre. Élő adatokkal az első bekapcsolásig jellemzően néhány nap kell.

A javulás jobb valószínűségbecslést jelent, nem garantált nyereséget. A paraméterek a `data/ai.json` fájlban vannak; törlésükkel a tanulás elölről kezdődik.

## 6. Képletek és feltevések (összefoglaló)

A teljes leírás az alkalmazás **Módszertan** oldalán található. Röviden:

- **Implikált valószínűség:** `1 / szorzó`; **méltányos szorzó:** `1 / p_modell`; **árrés:** `Σ(1/o) − 1`.
- **Árrés eltávolítása:** arányos (`q_i / Σq`) és **Shin** (alapértelmezett): `p_i = (√(z² + 4(1−z)q_i²/B) − z) / (2(1−z))`, `z` felezéses kereséssel úgy, hogy `Σp = 1`.
- **EV:** `p · o − 1`; **előny:** `p_modell − p_piac`.
- **Kelly:** `f* = (p·o − 1)/(o − 1)`; javasolt tét `min(bankroll · min(0,25·f*, 5%), hátralévő korlát)`.
- **Súlyozott alapmodell (minden sportág):** `p = σ(k · Σ(w·d)/Σw + h)`, a tényezők hozzájárulása logitban mérve adja a „fő tényezőket”.
- **NBA/NHL:** logisztikus regresszió (kézi priorok, a visszatesztelés újrabecsülheti); NBA hendikep/összpont normál közelítéssel (szórás 13 / 18 pont); NHL gólszám Poisson-modellel.
- **Labdarúgás:** Poisson-gólmodell Dixon–Coles-korrekcióval, xG és gólátlag keverékével, kis mintára zsugorítva; időjárás és magasság korrekció.
- **Kézilabda:** gólkülönbség és gólszám normális közelítéssel (szórás 6,2 / 6,0 gól), a döntetlen a ±0,5 gólos sáv valószínűsége; a csapatok gólátlaga kis mintára zsugorítva.
- **Tenisz:** borításfüggő Elo; szett- és meccsvalószínűség közötti átváltás (`p = s²(3 − 2s)`); rangsorból becsült Elo, ha nincs más adat.
- **Élő meccsek:** a hátralévő idő arányában számolt várható gólok/pontok, az aktuális állás eltolásként, piros lap korrekció, tenisznél a szettállásból.
- **Együttes modell:** 60% sportágspecifikus + 40% súlyozott (élő focin 90/10).
- **Bizalom (1–100):** `100 · (0,4·lefedettség + 0,3·modellegyetértés + 0,3·határozottság)`, élő meccsen ×0,9, kis mintán ×0,85.
- **AI-motor:** `p_AI = σ(b0 + bm·logit(p_modell) + bk·logit(p_piac) + bh)`, ridge-regularizálva az identitás felé, időrendi 75/25-ös validációval.
- **Szelvények:** egy szelvény = egy nap; esély `Π p_i` piaccal kevert valószínűséggel (`0,5·p_modell + 0,5·p_piac`), hogy a modellhibák ne halmozódjanak; ütköző tételek tiltva; korreláció büntetve; diverzifikáció 0–100.

**Fő feltevések:** a tételek függetlenek (kivéve a büntetett azonos meccses párokat); a kézi priorok ésszerű kiindulópontok, de nincsenek valós adaton kalibrálva, amíg nem futtatsz visszatesztelést; a piaci szorzók a legjobb elérhető árak.

## 7. Tesztek és visszatesztelés

```bash
npm test                                   # egységtesztek (node:test)
npm run verify                             # teljes körű ellenőrzés mintaadattal
npm run backtest                           # 120 nap szimulált előzmény
npm run backtest -- --file data/history.json   # az alkalmazás által archivált valós végeredmények
npm run backtest -- --save                 # NBA/NHL logisztikus együtthatók mentése, ha javítanak
```

Az alkalmazás a valós forrásból érkező befejezett meccseket a `data/history.json` fájlba archiválja, így idővel saját adaton is visszatesztelhetsz. A visszatesztelés pontosságot, Brier-pontszámot, log losst és az értéktippek ROI-ját méri, és időrendi 70/30 bontással újrabecsüli a logisztikus regressziót.

## 8. Projektszerkezet

```
server/
  index.js            HTTP-szerver (frontend + API + SSE egy folyamatban), ütemező
  config.js           környezeti változók, .env betöltése, bajnokságok
  routes.js           API-végpontok
  logger.js           strukturált JSON-napló (stdout/stderr)
  store.js            JSON-fájl alapú tárolás (data/db.json, atomi írás)
  lib/                router, ütemező, HTTP-kliens (korlátok, backoff, circuit breaker), gyorsítótár, időzóna
  providers/          adapter-interfész + ESPN, The Odds API, API-Sports, football-data.org, Open-Meteo, mintaadat
  engine/             szorzómatematika, tényezők, modellek (models/), elemzés, kombinációs motor, elszámolás, visszatesztelés, ai.js (AI-motor)
  services/           adatgyűjtés, tippnapló és statisztika, bankroll és korlátok, learn.js (AI-motor adatok és tanítás)
public/               felület (HTML, CSS design tokenekkel, ES-modulok build nélkül)
scripts/              backtest.js, verify.js
test/                 egységtesztek
data/                 futás közben jön létre (db.json, cache.json, history.json, models.json, ai.json)
```

**Új modell hozzáadása:** a `server/engine/models/index.js` regiszterébe egy `{ id, name, sports, predict(match, factors) }` objektumot kell felvenni, és az `ENSEMBLE` táblában súlyt adni neki. **Új adatforrás:** a `server/providers/base.js` `Provider` osztályából származtatva, a `registry.js`-ben regisztrálva.

**Technikai megjegyzés:** a specifikáció Expresst, node-cront és Chart.js-t javasolt. Ez a verzió szándékosan függőség nélküli: egy kis Express-szerű router (`server/lib/router.js`) a `node:http` modulon, egy átfedésmentes időzítő (`server/lib/scheduler.js`) a node-cron helyett, és saját, akadálymentes SVG/HTML diagramok a Chart.js helyett. Így az `npm start` internet nélkül, telepítés nélkül is működik, és semmi nem töltődik le CDN-ről. Ha mégis Expresst szeretnél, a `router.js` API-ja (`app.get/post`, `req.params`, `req.query`, `req.body`, `res.json`) egy az egyben átvihető.

## 9. Ismert korlátok

- **Kiegészítő piacok szorzói:** az ingyenes The Odds API-csomag a gólszerző, lap- és játékospiacokra nem ad árat (meccsenként és piaconként külön kreditbe kerülne), ezért ezek BECSÜLT szorzóval jelennek meg; saját szorzó megadható. A mixek ezt tételenként jelzik.
- **Gólszerző élő adatokkal:** focinál az `API_SPORTS_KEY` (góllövőlista) kell hozzá, NHL-nél csak a csapat gólkirálya ismert (ESPN). Kulcs nélkül élő focimeccsen nincs gólszerző piac. A játékosok meccskeretét az ingyenes források nem adják, ezért a kezdőcsapat bizonytalan.
- **Elszámolás:** gólszerző, lapszám és játékosstatisztika csak akkor számolható el, ha a szolgáltató közli; különben a tipp érvénytelen. NBA-ben az ESPN csak a meccs legjobb pontszerzőjét adja, így más játékos pontjai érvénytelenek lesznek. Az NB I gólszerzőit az API-Football meccslista nem tartalmazza.
- **Sárga lapok:** a csapatonkénti lapátlag az alkalmazás saját archívumából épül, így az első hetekben főleg bajnoki átlaggal (becslés) számol; a játékvezető személyét nem veszi figyelembe.
- **Kézilabda játékospiacok** élő adatokkal nem érhetők el (az ingyenes API-Handball nem ad játékosstatisztikát).

- Az ESPN végpontjai nem hivatalosak: a mezők változhatnak, ilyenkor az adott bajnokság mintaadatra vált, a hibát az Adatforrások oldal mutatja.
- Kulcs nélküli módban a haladó mutatók (xG, Corsi/Fenwick, PDO, nettó értékelés, kapusstatisztika, sérülések, egymás elleni eredmények) általában nem érhetők el; ezek „nem elérhető” jelölést kapnak, és csökkentik a bizalmi pontszámot.
- Piaci szorzó kulcs nélkül csak ott van, ahol az ESPN beágyazza; egyébként BECSÜLT szorzó vagy saját megadás.
- Az ESPN néhány bajnokságkódja (pl. Konferencia-liga, MLS) idővel változhat; ilyenkor az adott bajnokság MINTA lesz, és az Adatforrások oldal mutatja a hibát.
- A kézilabdánál az API-Handball nem ad játékórát, ezért élő meccsen a játékperc a kezdési időből becsült („~34'”).
- Az AI-motor élő adatokon csak lezárt meccsekből tanul, ezért az első napokban még nem aktív; kis mintán a megfigyelések véletlenek is lehetnek.
- A tenisz kulcs nélküli adatai többnyire csak a világranglista-helyezést tartalmazzák; a borítás nem mindig ismert.
- A tippnapló valós forrásnál csak a futás közben látott meccseket rögzíti; ha az alkalmazás nem fut, kimaradhatnak meccsek. 3 napnál régebbi, eredmény nélküli tipp „érvénytelen” lesz.
- Az archivált meccsek statisztikái a meccs végén mentett állapotot tükrözik, ezért a valós visszatesztelésben enyhe adat-szivárgás lehet (a szezonrekord már tartalmazza az adott meccset).
- A szelvényvalószínűség függetlenséget feltételez; a korrelációt pontozással büntetjük, de nem modellezzük pontosan.
- Az időjárás csak a helyszín városa alapján, geokódolással kérhető le.
- A mintaadat eredményei – a statisztika oldalon is – szimuláltak, és a modell valós teljesítményéről semmit nem mondanak.

## 10. Hibaelhárítás

- **„A 3000-es port foglalt”:** `PORT=3001 npm start`.
- **Minden bajnokság MINTA, pedig van internet:** nézd meg az Adatforrások oldalt és a konzolnaplót (`LOG_LEVEL=debug npm start`). Céges hálózatban proxy vagy tűzfal blokkolhatja a `site.api.espn.com` címet.
- **Tiszta lap:** állítsd le az alkalmazást, és töröld a `data/` mappát (a beállításaid és a bankroll is törlődik).
- **Életkor-ellenőrzés újra:** a böngészőben töröld az oldal helyi tárolóját (localStorage).

## Felelős játék

A szerencsejáték hosszú távon a szervezőnek kedvez. Ha úgy érzed, elveszíted az irányítást:

- **Szerencsejátékos Segélytelefon:** (06-80) 980-025 vagy (06-1) 411-677, hétköznap 15–19 óra, ingyenes és névtelen (ELTE PPK, Pro Psychologia Alapítvány) – szerencse@ppk.elte.hu
- **Lelki Elsősegély Telefonszolgálat:** 116-123, éjjel-nappal
- **Játékosvédelmi zöld szám (SZTFH):** (06-80) 205-352, 0–24
- Szerencsejáték Zrt. felelős játékszervezés: https://rolunk.szerencsejatek.hu/hu/felelos-jatekszervezes
- Önkorlátozás, nyomtatványok: https://bet.szerencsejatek.hu/informaciok/a-jatekszenvedelyrol
- Játékfüggőséggel foglalkozó szervezetek (SZTFH): https://sztfh.hu/tevekenysegek/szerencsejatek-felugyelet/jatekosvedelem/jatekfuggoseggel-foglalkozo-szervezetek/

Licenc: MIT.
