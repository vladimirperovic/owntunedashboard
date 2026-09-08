# Arhitektura i optimizacije — 8. septembar 2026.

## Ocjena

Osnova odgovara dashboardu koji radi na jednom računaru u lokalnoj mreži.
Nginx servira statički interfejs i prosljeđuje zahtjeve OwnTone serveru;
Python companion obavlja zakazivanje, istoriju i prateće funkcije.
Audio ne prolazi kroz Python. Updater API i privilegovani instalacioni proces
imaju odvojene uloge. Te granice treba sačuvati.

Kod ipak nije dovoljno jasno podijeljen unutar tih cjelina. Frontend ima globalno
promjenljivo stanje, funkcionalne module i naknadne vizuelne slojeve koji čitaju
ili mijenjaju isti DOM. Backend kombinuje HTTP obradu, domensku logiku,
persistenciju i mrežne pozive u jednom fajlu. Najkorisnije je postepeno razdvajanje
odgovornosti uz očuvanje postojećih API ugovora. Sam prelazak na framework ne bi
riješio vlasništvo nad stanjem i konkurentne operacije.

Pregled obuhvata radno stablo poslije prethodnog audita. Izmjene i nalazi iz tog
audita ostaju u [posebnom izvještaju](AUDIT-2026-09-08.md). Backend pregled je
nezavisno uradio subagent; njegove nalaze i reference provjerili smo u sklopu
ovog pregleda. Nije rađen produkcioni profil performansi niti novi deploy.

## Implementirano u ovom prolazu

### Eksplicitno obavještavanje o promjenama playera

`app.js` sada šalje `owntone:player-updated` na kraju `renderPlayer()`, nakon
ažuriranja osnovnih kontrola. Uspješno asinhrono učitavanje aktuelne slike šalje
`owntone:artwork-updated`, uz postojeću zaštitu od zastarjelih odgovora.

Premium prikaz, mini player, LIVE status i oznake audio izlaza slušaju relevantne
događaje. Uklonjeno je pet `MutationObserver` instanci: dvije iz premium modula,
po jedna iz mini playera, LIVE prikaza i multi-room oznake. Uklonjena su i dva
intervala za sinhronizaciju, od 500 ms i 1.800 ms.

Premium i fullscreen oznake izlaza sada koriste isti `outputLabel` helper kao
glavni player i multi-room. Ranije su čitale ime izabranog `<option>` elementa,
pa je nezavisno osvježavanje moglo prepisati „2 outputs“ imenom jednog zvučnika.
Novi regresioni test prvo je reprodukovao taj problem, a zatim potvrdio ispravku.

Ovo smanjuje lančane reakcije u kojima jedan vizuelni modul promijeni DOM, drugi
to primijeti i ponovo promijeni DOM. Događaj označava završen osnovni render;
još ne predstavlja nepromjenljivi snimak kompletnog aplikacionog stanja.
Pretplatnici ne smiju iz handlera rekurzivno pozivati isti render.
Sinhronizacija pri montiranju ostaje potrebna jer se ovi događaji ne ponavljaju
naknadno za nove pretplatnike.

### Manje rada nad skrivenim i nepovezanim sadržajem

- Premium fullscreen sinhronizacija preskače zatvoren dijalog i osvježava ga
  odmah pri otvaranju. Ovo ne uklanja sve druge handlere koji mogu pisati u taj
  dijalog, već njegov redovni premium render.
- Context-menu observer obrađuje dodate elemente i njihove potomke umjesto da
  pretražuje cijelu biblioteku nakon svake nepovezane DOM promjene. Početna i
  pojedina eksplicitna osvježavanja i dalje mogu pretražiti cijeli dokument.
- Verzija frontend asseta u `config.js` podignuta je na `20260908-02`.

### Pouzdaniji test server

Prethodna Playwright konfiguracija mogla je prihvatiti bilo koji server na portu
4173. Tokom provjere tamo je radio drugi projekat, pa su prvi pokušaji testirali
pogrešnu aplikaciju. Taj server nije diran. Testovi sada pokreću sopstveni server
na portu 4185, odbijaju zauzet port i podržavaju `OWNTONE_TEST_PORT` za drugi port.

## Mjerenje efekta

`tools/measure-ui.cjs` instrumentira `MutationObserver`, bilježi broj poziva po
modulu i blokira mrežu izvan `127.0.0.1`. Test koristi lokalni preview, Chromium,
viewport 1440 × 1000 i dvije sekunde zagrijavanja. Mjeri tri sekunde mirovanja,
zatim deset `playerCommand('toggle')` poziva sa razmakom od 40 ms i završnim
čekanjem od 200 ms. Promjena stanja ne pokreće stvarni audio u ovom mjerenju.

| Scenario | Prije ovog prolaza | Poslije | Promjena |
| --- | ---: | ---: | ---: |
| Tri sekunde mirovanja | 35 | 3 | oko 91% manje callbackova |
| Deset promjena reprodukcije | 151 | 45 | oko 70% manje callbackova |

To su zabilježeni pojedinačni uzorci, a ne statistički benchmark. Tajmeri i
raspoređivanje u browseru donose mala odstupanja. Broj callbackova ne predstavlja
njihovo trajanje: rezultat **ne znači 70% brži dashboard**, niti dokazuje uštedu
CPU-a ili baterije iste veličine. Za to je potreban profil na reprezentativnom
uređaju, sa stvarnom bibliotekom i OwnTone serverom.

Reprodukcija aktuelnog mjerenja, u dva terminala iz korijena projekta:

```sh
PORT=4184 node tests/static-server.js
```

```sh
node tools/measure-ui.cjs
```

## Preostale arhitektonske prioritete rješavati ovim redom

1. **Izdvojiti operatersku konfiguraciju iz release direktorijuma.** `config.js`
   trenutno spaja podešavanja lokacije i verzionisani loader. Uspješan update
   zamjenjuje taj fajl i lokalne slike u release stablu. Uvesti zasebne override
   postavke i skladište za korisničke slike, sa validacijom i kompatibilnošću pri
   rollbacku. Ovo je konkretan operativni rizik, ne samo pitanje stila.

2. **Ujediniti instalaciju i oporavak.** Ručni deploy i automatski updater treba
   da koriste zajednički host lock i istu implementaciju aktivacije, provjere i
   rollbacka. Nezavisni staging direktorijumi sprečavaju sudare. Kasniji prelazak
   na nepromjenljive release direktorijume i `current` symlink zahtijeva migraciju:
   postojeći skriptovi namjerno odbijaju symlink kao cilj.

3. **Skratiti backend zaključavanje oko mrežnih poziva.** Scheduler drži opšti
   state lock dok callback obavlja probe streamova i OwnTone zahtjeve. Spor uređaj
   zato može odložiti nepovezano čitanje stanja. Prvo izmjeriti čekanje i trajanje
   zaključavanja; zatim izdvojiti faze rezervacije zadatka, izvršenja i upisa
   rezultata, uz identitet zakazanog izvršenja i reviziju rasporeda. Samo pomjeranje
   mrežnih poziva izvan locka moglo bi vratiti izgubljene izmjene ili zastarjele
   komande. Serijalizacija komandi za reprodukciju i dalje mora ostati jasna.

4. **Definisati vlasništvo nad frontend stanjem.** `window.OWNTONE_APP.state`
   je javno promjenljiv, a dio prikaza zaključuje stanje iz teksta i klasa DOM-a.
   Sljedeći korak je jedno mjesto za izmjene stanja, eksplicitne akcije i selektori
   ili snimci za čitanje. Tek zatim razdvojiti `app.js` na player, biblioteku i
   prikaze, te postepeno objediniti preklopljene premium/polish slojeve.
   Novi događaji su mali korak u tom pravcu, ne završetak tog refaktorisanja.

5. **Izdvojiti backend interfejse prije promjene infrastrukture.** OwnTone klijent
   i state store mogu imati zamjenljive implementacije za testove. Iza njih se
   mogu odvojiti odluke schedulera i tanki HTTP handleri. Istorija trenutno čuva
   do 500 zapisa, a activity do 30: nema dokaza da baza podataka rješava postojeće
   usko grlo. JSON zamjena fajla takođe ne garantuje trajnost nakon nestanka struje
   niti tačno jedno izvršenje spoljne playback komande.

6. **Mjeriti preostale zahtjeve i render prije novih optimizacija.** Player,
   istorija, queue i pojedine funkcije i dalje imaju odvojene cikluse osvježavanja.
   Backend može ponoviti istu radio probu pri paralelnom cache missu. Pratiti broj
   zahtjeva, čekanja, trajanje rendera i cache pogodaka, pa po potrebi objediniti
   istovremene zahtjeve. Bundler, virtualizacija biblioteke ili promjena CSS
   organizacije imaju smisla tek uz konkretan problem učitavanja/rendera.

Detaljni backend nalazi, reference na kod i predložene provjere nalaze se u
[ARCHITECTURE-BACKEND.md](ARCHITECTURE-BACKEND.md). Postojeća ograničenja produkcije
i hardvera ostaju u [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## Provjere

- Chromium: provjereno svih **81 scenarija**. U završnom paketu 80 je prošlo,
  a desktop context/multi-room test prekoračio je 30 sekundi tokom paralelnog
  pokretanja Chromiuma i WebKita, uz visoko opterećenje računara. Izolovljeno
  ponavljanje istog testa, bez izmjene koda ili timeouta, prošlo je za 5,8 sekundi
  ukupnog pokretanja. To upućuje na osjetljivost testa na opterećenje; završni
  puni prolaz nije bio potpuno zelen iz prvog pokušaja.
- WebKit paket za izmijenjene tokove: **19/19 prolazi**.
- Četiri nova regresiona testa provjeravaju završen render pri emitovanju
  događaja, mirovanje zatvorenog fullscreen prikaza, dosljedne multi-room oznake
  i obradu novog sadržaja bez globalnog pretraživanja biblioteke.
- ESLint, Prettier, sintaksna provjera mjernog skripta i `git diff --check`.
- Backend kod u ovom arhitektonskom prolazu nije mijenjan; ranije backend
  rezultate treba čitati u prethodnom auditu, a ne kao nova mjerenja.

Izmjene su lokalne. Nije napravljen commit, push ili deploy.
