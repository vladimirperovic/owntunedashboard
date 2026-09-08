# Arhitektonsko uređenje — 8. septembar 2026.

Ovaj dokument prati implementaciju četiri koraka iz prethodnog
[arhitektonskog pregleda](ARCHITECTURE-2026-09-08.md). Pregled je istorijski
zapis nalaza prije ovih izmjena. Opis ispod odnosi se na implementaciju i
automatizovane provjere; produkciona provjera je zaseban korak.

## 1. Korisnička konfiguracija

Verzionisani `config.js` sadrži defaults i loader. Javni override JSON i slike
nalaze se u `/etc/owntone-dashboard`, a release ima samo linkove ka tom sadržaju.
Loader učitava i provjerava konfiguraciju prije modula. Mrežna ili validaciona
greška blokira inicijalizaciju umjesto da neprimjetno vrati podrazumijevanu
glasnoću ili API postavke.

`deploy/site_config.py` migrira literalna stara podešavanja bez izvršavanja
JavaScripta, kopira postojeće slike i čuva eksterni sadržaj kroz naredne release.
Privatni service environment fajlovi nijesu dio javnih linkova. Oni se učitavaju
iz opcionalnih systemd EnvironmentFiles ili kroz administratorske drop-in fajlove.
Prvo ažuriranje mora koristiti novi installer, jer stari instalirani helper nema
ovu migraciju. Detalji su u [uputstvu za instalaciju](DEPLOYMENT.md#operator-configuration).

## 2. Jedna implementacija instalacije

`deploy.sh` sada samo pakuje commit, prenosi arhivu kroz jedinstvene privremene
direktorijume i poziva zajednički `update-dashboard.sh --archive ... SHA`.
Bez argumenata isti installer preuzima GitHub main. Oba ulaza prolaze isti host
lock, validaciju arhive i fajlova, migraciju, zamjenu release, provjeru servisa
i rollback. Prva instalacija i oporavak poslije njene greške takođe koriste taj put.

Nema više dvije različite implementacije aktivacije. Ostaje ograničenje dvije
uzastopne promjene imena direktorijuma: SIGKILL ili nestanak struje između njih
može zahtijevati ručni oporavak. Prelazak na `current` symlink nije dio ove izmjene.
Migrirani eksterni podaci ostaju sačuvani i kada se release vrati na staru verziju.

Pokušaj ponovne migracije prepoznaje naknadno promijenjenu staru konfiguraciju ili
slike i zaustavlja instalaciju radi usklađivanja. Nestandardne putanje se upisuju
u updater jedinicu za naredno ažuriranje; javni direktorijumi dobijaju prava
pristupa nezavisno od restriktivnog umaska.

## 3. Kratke backend transakcije

Scheduler sada za svaku akciju odvojeno preuzima zadatak, izvršava mrežne operacije
i upisuje rezultat u svježe učitano stanje. `PLAYBACK_LOCK` i dalje uređuje redosljed
komandi; opšti `LOCK` više ne obuhvata mrežne pozive. Revizija i identitet rasporeda
sprečavaju da rezultat ranijeg izvršenja izmijeni novu ili obrisanu verziju.
Sleep tajmer takođe ima identitet, a skeniranje biblioteke je izvan `FILES_LOCK`.

Preuzimanje zadatka je granica otkazivanja: izmjena rasporeda ne može povući već
preuzetu mrežnu operaciju. Start se evidentira prije mrežnog poziva uz `fsync`
fajla i direktorijuma. Prekid procesa poslije tog upisa može preskočiti jedno
izvršenje; to je namjeran izbor protiv duplog starta nakon nepoznatog rezultata.
Stop i ramp mogu biti ponovljeni ako rezultat nije potvrđen. Tačno jedno izvršenje
spoljne OwnTone komande i JSON upis ne mogu postati jedna transakcija.

## 4. Vlasništvo nad frontend stanjem

`app-state.js` pruža privatno stanje vlasniku, proxy samo za čitanje modulima i
nepromjenljive snimke za događaje ili asinhronu obradu. Obično čitanje ne kopira
cijelu biblioteku. Player događaj kopira samo podatke reprodukcije. Tajmeri i drag
zastavice izdvojeni su iz javnog domenskog stanja; pairing forma je lokalna
multi-room modulu.

Moduli mijenjaju fizičke izlaze i njihove glasnoće kroz akcije u `app.js`.
Neuspjeli upis glasnoće više ne ostavlja promijenjeno zajedničko stanje. Direktan
upis kroz javni API, uključujući ugniježđene objekte i nizove, prijavljuje grešku.
Postojeći čitaoci ostaju kompatibilni. Testovi koji moraju simulirati stanje servera
koriste isključivo testnu instrumentaciju; produkcija nema taj dodatni ulaz.

## Automatizovane provjere

- 89 Chromium testova prolazi u cijelom paketu.
- 25 WebKit testova za konfiguraciju, stanje, player i responsive prikaz prolazi.
- Backend scheduler: 102 testa, uključujući 16 novih provjera konkurentnosti,
  upisa, otkazivanja i ponovnog pokretanja.
- Migracija konfiguracije: 11 Python testova; updater API: 13 testova.
- Zajednički installer: offline GitHub i lokalne arhive, oštećene arhive,
  neispravna konfiguracija, migracija, prva instalacija, zaključavanje i rollback.
- ESLint, Prettier, Ruff, ShellCheck i provjera whitespace grešaka.
