// "Módszertan": every formula and assumption used by the engine.
export async function render(el) {
  el.innerHTML = `<article class="prose">
  <div class="page-head"><div><h1>Módszertan</h1><p>Minden képlet és feltevés, amelyet az elemző használ. A modellek egyszerűek és átláthatók – nem garantálnak nyereséget.</p></div></div>

  <h2>1. Szorzók és valószínűségek</h2>
  <p>Minden szorzó decimális (pl. 1,85). Az implikált valószínűség és a méltányos szorzó egymás inverze:</p>
  <code class="formula">implikált p = 1 / szorzó        méltányos szorzó = 1 / p_modell</code>
  <p>A fogadóiroda árrése (overround): <code>Σ(1/o_i) − 1</code>. Az árrés eltávolítása két módszerrel történik:</p>
  <ul>
    <li><strong>Arányos:</strong> <code>p_i = q_i / Σq</code>, ahol <code>q_i = 1/o_i</code>.</li>
    <li><strong>Shin-módszer (alapértelmezett):</strong> a piac egy <code>z</code> arányú „bennfentes” kereskedőt feltételez:
      <code class="formula">p_i = ( √(z² + 4(1−z)·q_i²/B) − z ) / ( 2(1−z) ),   B = Σq</code>
      A <code>z</code> értékét felezéses kereséssel határozzuk meg úgy, hogy <code>Σp_i = 1</code>. Ez a favorit–esélytelen torzítást jobban kezeli, mint az arányos módszer.</li>
  </ul>
  <p><strong>Várható érték (EV)</strong> egységnyi tétre: <code>EV = p_modell · szorzó − 1</code>. <strong>Előny</strong>: <code>p_modell − p_piac(árrés nélkül)</code>.</p>

  <h2>2. Tétméret: tört Kelly plafonnal</h2>
  <code class="formula">f* = (p · o − 1) / (o − 1)          (0, ha negatív)
tét = min( bankroll · min(k · f*, plafon), hátralévő korlát )</code>
  <p>Alapértelmezés: <code>k = 0,25</code> (negyed Kelly), plafon a bankroll 5%-a. A javaslatot a napi/heti tét- és veszteségkorlát is csökkenti. Kelly csak valós vagy kézi szorzóra számolódik, becsültre nem.</p>

  <h2>3. Tényezők</h2>
  <p>Minden tényező egy normalizált különbség <code>d ∈ [−1,5; 1,5]</code> (pozitív = a hazai / 1. játékos javára). Példák:</p>
  <ul>
    <li>Forma: utolsó 10 eredmény (Gy=1, D=0,5, V=0), frissebbek nagyobb súllyal (lineáris); <code>d = (forma_h − forma_v)/0,5</code>.</li>
    <li>Lendület: utolsó 3 meccs átlaga mínusz az azt megelőző 5-é.</li>
    <li>Hazai/idegenbeli mérleg, egymás elleni eredmények (a mintanagysággal arányosan csillapítva), pihenőnapok, back-to-back (NBA/NHL), sűrű program és utazás, sérülések/eltiltások (hatássúly × státusz).</li>
    <li>NBA: nettó értékelés, True Shooting %, védekezési értékelés, tempó (az összpontszámhoz), sztárfüggőség (usage).</li>
    <li>NHL: Corsi (CF%), Fenwick (FF%), PDO (regresszió 1,000 felé – a magas PDO <em>negatív</em> jel), kapus védési % (nem megerősített kezdőnél 0,7-es szorzóval), gólkülönbség.</li>
    <li>Tenisz: összesített és borításfüggő Elo, világranglista (log-skála), borításon mért győzelmi arány, adogatás/fogadás, terhelés (meccsek 14 nap alatt), feladott meccsek.</li>
    <li>Labdarúgás: xG − xGA, pont/meccs, gólkülönbség, labdabirtoklás, tabellahely, motiváció (bajnoki cím, európai hely, kiesés, tét nélküli meccs).</li>
    <li>Piaci mozgás: a nyitó és az aktuális hazai ár implikált valószínűségének változása.</li>
  </ul>
  <p>Ha egy tényezőhöz nincs adat, kimarad a modellből, és csökkenti az adatlefedettséget (ezzel a bizalmi pontszámot). Minden tényező mellett látszik a forrása és a frissessége (ÉLŐ / GYORSÍTÓTÁR + kor / MINTA).</p>

  <h2>4. Modellek</h2>
  <h3>Súlyozott pontozás (minden sportág, alapmodell)</h3>
  <code class="formula">S = Σ(w_i · d_i) / Σw_i            (csak elérhető tényezők)
p_hazai = σ(k · S + h)              σ(x) = 1 / (1 + e^(−x))</code>
  <p>Paraméterek: NBA k=2,4 h=0,25 · NHL k=1,4 h=0,15 · tenisz k=2,6 h=0 · labdarúgás k=1,8 h=0,30 (kétesélyes, a döntetlent a Poisson-modell adja). A tényező hozzájárulása logitban: <code>c_i = k·w_i·d_i / Σw</code> – ebből készül a „fő tényezők” lista.</p>
  <h3>Logisztikus regresszió (NBA, NHL)</h3>
  <code class="formula">p_hazai = σ(β0 + Σ β_j · d_j)</code>
  <p>Az alapegyütthatók kézzel beállított priorok. A <code>npm run backtest -- --save</code> parancs időrendi 70/30 bontással, L2-regularizált gradiensmódszerrel újrabecsüli őket, és csak akkor menti, ha a teszthalmazon javul a log loss.</p>
  <h3>Poisson-gólmodell Dixon–Coles-korrekcióval (labdarúgás)</h3>
  <code class="formula">λ_h = μ · att_h · def_v · H         λ_v = μ · att_v · def_h / H
att = (gól/meccs ⊕ xG/meccs) / μ,  zsugorítás: 1 + n/(n+6)·(att − 1)
P(i, j) = Pois(i; λ_h) · Pois(j; λ_v) · τ(i, j)</code>
  <p>μ = 1,37, H = 1,12, ρ = −0,06 a τ-korrekcióban (0–0, 1–0, 0–1, 1–1). Kis kontextuális szorzók: forma, sérülések, motiváció, pihenő; erős szél (&gt;35 km/h) vagy eső (&gt;4 mm) −6% gól; 1500 m feletti helyszín +5% hazai. A mátrixból: 1X2, kettős esély, gólszám 1,5/2,5/3,5, mindkét csapat szerez gólt. Végső 1X2: a Poisson döntetlen-valószínűsége, a maradék a Poisson (60%) és a súlyozott modell (40%) keverékével osztva.</p>
  <h3>Elo (tenisz)</h3>
  <code class="formula">E = 0,5 · Elo_összes + 0,5 · Elo_borítás
p_1 = 1 / (1 + 10^((E_2 − E_1)/400))
szett: p = s²(3 − 2s) (3 nyert szettig: s³(1 + 3(1−s) + 6(1−s)²))</code>
  <p>Ha nincs Elo-adat, a világranglistából becsüljük: <code>2100 − 140·ln(helyezés)</code>. A szettvalószínűségből jön a „szettveszteség nélküli győzelem” és a „legalább egy szett” piac.</p>
  <h3>NBA összpontszám és hendikep</h3>
  <code class="formula">várható különbség = 13 · Φ⁻¹(p_hazai)
várható összpontszám = tempó · ( (ORtg_h + DRtg_v)/2 + (ORtg_v + DRtg_h)/2 ) / 100
P(hazai fedez −L) = Φ((különbség − L)/13),  P(több mint T) = 1 − Φ((T − összpont)/18)</code>
  <h3>NHL gólszám</h3>
  <p>Poisson a csapatok gól/meccs és kapott gól/meccs adataiból (μ = 3,05), a győzelmi valószínűség felé billentve, a teljes várható gólszám megtartásával.</p>
  <h3>Kézilabda</h3>
  <code class="formula">várható gól_h = μ + k·((lőtt_h + kapott_v)/2 − μ) + 0,9     k = n/(n+5)
különbség ~ N(M, 6,2²),  M = 0,6·(gól_h − gól_v) + 0,4 · 6,2 · Φ⁻¹(p_súlyozott)
P(hazai) = 1 − Φ((0,5 − M)/6,2),  P(vendég) = Φ((−0,5 − M)/6,2),  P(döntetlen) = a maradék
gólszám ~ N(T, 6,0²)</code>
  <p>μ = 29,5 gól/csapat (férfi), 27,5 (női). Élő meccsen a hátralévő idő arányában szűkül a szórás, az állás eltolásként számít. Piacok: 1X2, kettős esély, hendikep, gólszám.</p>
  <h3>Kiegészítő piacok</h3>
  <ul>
    <li><strong>Gólszerző (foci, NHL), bármikor:</strong> <code>P = 1 − e^(−λ_csapat · részesedés · játékidő-arány)</code>, ahol a részesedés a játékos góljai / a csapat góljai (élő adatnál az API-Sports góllövőlistájából, NHL-nél az ESPN gólkirályából), a játékidő-arány a lejátszott percek / (meccsek · 90). Élő meccsen a hátralévő λ számít; aki már gólt szerzett, annál a tipp eldőlt.</li>
    <li><strong>Játékos pontjai (NBA) / góljai (kézilabda):</strong> az átlag a várható csapatpontszám és a szezonátlag arányával skálázva; NBA: normális eloszlás 27%-os szórással, kézilabda: Poisson. Csak meccs előtt.</li>
    <li><strong>Hendikep:</strong> foci: ázsiai hendikep a gólmátrixból (az 50%-hoz legközelebbi félvonal); NHL: ±1,5 (puck line) a hosszabbítást is számolva; tenisz: játékhendikep.</li>
    <li><strong>Over/under:</strong> több vonal meccsre és csapatonként (foci, NHL: gólmátrix; NBA, kézilabda: normális közelítés; tenisz: összes játék).</li>
    <li><strong>Mindkét csapat gól:</strong> foci és NHL a gólmátrixból; teniszben a megfelelője „mindkét játékos nyer szettet”. NBA-ben és kézilabdában nincs értelme, ezért nincs.</li>
    <li><strong>Sárga lapok (foci):</strong> összes sárga lap ~ negatív binomiális (átlag = a két csapat lapátlaga, diszperzió r = 10). A csapatátlag a korábban archivált meccsekből jön, 4 meccsnyi súllyal a bajnoki átlag felé húzva; ha nincs adat, a bajnoki átlag (becslés). Két motivált csapatnál +6%. Élő meccsen: eddigi lapok + a hátralévő idő arányos része.</li>
    <li><strong>Tenisz játékmodell:</strong> a két játékos adogatójáték-nyerési esélyéből (alap: ATP 79%, WTA 66%, ill. a statisztika) olyan eltolást keresünk, amely kiadja a modell szettvalószínűségét; ebből pontos szett- és meccs-játékeloszlás számolható (rövidítés: 0,5 + 0,9·(h1 − h2)).</li>
    <li><strong>Elszámolás:</strong> ha a szolgáltató nem ad gólszerzőlistát, lapszámot vagy játékosstatisztikát, az ilyen tipp <em>érvénytelen</em>, nem „veszített”. A gólszerzőlistát csak akkor fogadjuk el, ha minden gólt megmagyaráz.</li>
    <li>A kiegészítő piacok nem kerülnek a napi ajánlások közé (azok a fő piacokból jönnek), de a meccs adatlapján és a mixekben elérhetők.</li>
  </ul>
  <h3>Élő meccsek</h3>
  <ul>
    <li>Labdarúgás: a hátralévő idő arányában csökkentett λ, az aktuális állás eltolásként; piros lap: saját λ × 0,7, ellenfélé × 1,2.</li>
    <li>NBA: a hátralévő különbség és szórás a hátralévő idő arányában (szórás √r-rel).</li>
    <li>NHL: Poisson a hátralévő időre, döntetlen esetén hosszabbítás a meccs előtti esély szerint.</li>
    <li>Tenisz: a szettállásból rekurzívan számolt meccsnyerési esély.</li>
  </ul>
  <h3>Együttes (ensemble)</h3>
  <p>A győztes piacon: <code>p = 0,6 · p_sportágspecifikus + 0,4 · p_súlyozott</code> (élő labdarúgásban 0,9 / 0,1). A modellek cserélhetők: a <code>server/engine/models/index.js</code> regiszterébe új modell (pl. gépi tanulási) is felvehető.</p>

  <h2>5. Bizalmi pontszám (1–100)</h2>
  <code class="formula">bizalom = 100 · (0,40 · lefedettség + 0,30 · egyetértés + 0,30 · határozottság) · élő(0,9) · kis minta(0,85)
egyetértés = 1 − min(1, |p_specifikus − p_súlyozott| / 0,25)
határozottság = (p_tipp − 1/n) / (1 − 1/n)</code>

  <h2>6. Ajánlás kiválasztása</h2>
  <ul>
    <li><strong>Értéktipp:</strong> a valós/kézi szorzójú kimenetelek közül EV ≥ 3%, p ≥ 22%, szorzó ≤ 6; a legnagyobb <code>EV · √p</code> nyer.</li>
    <li><strong>Esélyes kimenetel:</strong> ha nincs értéktipp, a legvalószínűbb 55–97% közötti kimenetel (értéket nem állít).</li>
    <li>Ha nincs piaci szorzó, a <strong>BECSÜLT</strong> szorzó a méltányos szorzó 6% árréssel; ilyenkor érdemes saját szorzót megadni.</li>
  </ul>

  <h2>7. Szelvényépítő</h2>
  <ul>
    <li><strong>Könnyű mix:</strong> 2–6 tétel, eredő szorzó ≤ 10,00; tételenként p ≥ 58%, szorzó 1,10–2,40, csak közelgő meccsek, meccsenként legfeljebb egy tétel. Négy szorzósáv: 1,3–2,6 · 2,6–4,5 · 4,5–7 · 7–10.</li>
    <li><strong>Brutális mix:</strong> eredő szorzó ≥ 70,00, 4–12 tétel, az adott napon elérhető összes sportágból (NBA, NHL, tenisz, labdarúgás, kézilabda), élő tételekkel is. Azonos meccsről csak eltérő piaccsaládból jöhet tétel, büntetéssel.</li>
    <li><strong>Piacszűrő:</strong> a mix oldalán kiválasztható, milyen típusú tételek kerülhetnek a szelvényre (győztes, hendikep, over/under, mindkét csapat gól, gólszerző/játékos, sárga lapok). Azonos meccsről azonos piaccsoport nem kerülhet kétszer egy szelvényre; a korreláció pl. gólszerző–gólszám ρ = 0,3, gólszerző–győztes ρ = 0,2, sárga lap–bármi ρ ≤ 0,05.</li>
    <li><strong>Becsült szorzós tételek:</strong> ahol nincs fogadóirodai ár, a tétel BECSÜLT szorzóval kerül a szelvényre, és a szelvény ezt jelzi.</li>
    <li><strong>Egy nap, egy szelvény:</strong> egy szelvény minden meccse ugyanazon a naptári napon (budapesti idő szerint) kezdődik. Alapértelmezés: a legkorábbi nap, ahol elég kínálat van (Könnyű: legalább 4 meccs, Brutális: legalább 8 meccs és 3 sportág), egyébként a legtöbb meccset kínáló nap. A napot a felületen át lehet váltani.</li>
    <li><strong>Ütközés:</strong> azonos meccs + azonos piaccsalád (a győztes, hendikep és szett piacok egy családnak számítanak).</li>
    <li><strong>Korreláció:</strong> azonos meccs: győztes–gólszám ρ=0,15, győztes–mindkét csapat gól ρ=0,12, gólszám–mindkét csapat gól ρ=0,45; azonos bajnokság 3 órán belül ρ=0,02.</li>
    <li><strong>Esély:</strong> <code>Π p_i</code> (függetlenséget feltételez – a korrelált tételeket a pontozás bünteti). <strong>EV:</strong> <code>P · O − 1</code>. <strong>Kockázat:</strong> P ≥ 35% alacsony, ≥ 15% közepes, egyébként magas.</li>
    <li><strong>Diverzifikáció (0–100):</strong> <code>100·(0,35·sportágak/elérhető + 0,2·bajnokságok/n + 0,25·meccsek/n + 0,2·piaccsaládok/min(n,3)) − 15·Σρ</code>.</li>
    <li>A rögzített tételek minden újragenerálásnál megmaradnak; a többi tétel súlyozott véletlen mintavétellel, sávonként több száz próbálkozásból a legjobb pontszámú.</li>
  </ul>

  <h2>8. AI-motor (helyi önálló tanulás)</h2>
  <p>Nem nyelvi modell és nem külső szolgáltatás: statisztikai tanulás a saját lezárt meccseidből, a gépeden.</p>
  <ul>
    <li><strong>Adatgyűjtés:</strong> minden meccs előtt elmenti a nyers modellvalószínűséget (p<sub>m</sub>), a piac árrés nélküli valószínűségét (p<sub>k</sub>, ha van) és a tényezőket; a meccs végén az eredményt.</li>
    <li><strong>Kalibráló-összegző (stacking)</strong> sportáganként és piaccsaládonként (győztes, gólszám/összpontszám, hendikep, mindkét csapat gól):
      <code class="formula">p_AI = σ( b0 + bm · logit(p_m) + bk · logit(p_k) · [van piac] + bh · [van piac] )</code>
      Ridge-regularizált Newton-módszerrel illesztve, a priort az identitásra (bm = 1, többi 0) centrálva – kevés adatnál így semmit nem változtat. Megtanulja, hogy a modell túl magabiztos vagy túl óvatos-e (bm + bk), van-e torzítás (b0), és mennyire bízzon a modellben a piachoz képest (bm és bk aránya).</li>
    <li><strong>Védőkorlát:</strong> legalább 80 lezárt eset kell, és időrendi bontásban a régebbi 75%-on tanítva a legújabb 25%-on a log lossnak legalább 0,002-vel jobbnak kell lennie, mint a nyers modellé. Csak ekkor kapcsol be (ezután az összes adaton újratanul). Újratanítás 10 új eredményenként vagy 12 óránként.</li>
    <li><strong>Alkalmazás:</strong> csak meccs előtti becslésekre. Kétesélyes piacnál az első kimenetelt korrigálja (a másik a kiegészítője), többesélyesnél mindet, majd 1-re normál. A kettős esély a korrigált 1X2-ből épül újra. A nyers érték látható marad („nyers …%”).</li>
    <li><strong>Tényező-tanulás:</strong> sportáganként regularizált logisztikus regresszió a hazai győzelemre a tényezőkből; a fontosság = együttható × szórás. Csak tájékoztató, a súlyokat nem írja át.</li>
    <li><strong>Megfigyelések:</strong> automatikus magyar szövegek a kalibrációs eltérésekről (≥ 15 eset, ≥ 8 százalékpont), a modell és a piac pontosságáról, a hazai torzításról (≥ 60 meccs, ≥ 4 százalékpont) és a legerősebb tényezőkről.</li>
    <li>Az élő és a mintaadatból tanult paraméterek teljesen külön kezelődnek.</li>
  </ul>

  <h2>9. Statisztika és visszatesztelés</h2>
  <ul>
    <li>Minden közelgő meccsre (36 órán belül) egy ajánlás naplózódik; a meccs végén automatikusan elszámolódik (nyert / veszített / érvénytelen). 3 napnál régebbi, eredmény nélküli tipp érvénytelen.</li>
    <li>ROI egységnyi tétekkel: <code>Σ nyereség / Σ tét</code>. Brier-pontszám: <code>átlag (p − y)²</code>.</li>
    <li>Visszatesztelés: <code>npm run backtest</code> (szimulált előzmény) vagy <code>npm run backtest -- --file data/history.json</code> (az alkalmazás által archivált valós végeredmények).</li>
  </ul>

  <h2>10. Fontos korlátok</h2>
  <ul>
    <li>A modellek egyszerűsítések; a kézi priorok nincsenek valós adaton kalibrálva, amíg nem futtatod a visszatesztelést.</li>
    <li>Kulcs nélküli módban a haladó mutatók (xG, Corsi, nettó értékelés, sérülések) általában nem érhetők el – ezt a tényezőtáblázat jelzi.</li>
    <li>A mintaadat (MINTA) szimuláció: a csapatnevek valósak, de minden szám kitalált; a teniszezők és a sérült játékosok nevei fiktívek.</li>
    <li>A szerencsejáték hosszú távon a fogadóirodának kedvez. Az alkalmazás tájékoztató célú.</li>
  </ul>
  </article>`;
}
