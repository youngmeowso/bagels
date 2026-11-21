# Bagel Royale – online (Render)

Hra + server v jednom. Server nemá žádné závislosti (jen Node 18+), takže se nic neinstaluje.

## Co to umí
- **Účty:** v menu zadáš jméno + heslo. Neexistující jméno = vytvoří se nový účet, existující = přihlášení.
  Hesla jsou uložená jako scrypt hash, přihlášení drží 60 dní (token v prohlížeči).
- **Synchronizace účtu:** vzhled postavy a odemčené itemy (bug bag, meowsi glider, puppet) se ukládají na server
  a načtou se na každém zařízení, kde se přihlásíš.
- **Kódy** (`puppet`, `meowsi`, `craigmorrisonbugbag`) jsou **jen na serveru**, ve hře nejsou vidět. Další přidáš
  proměnnou `CODES_JSON`, např. `{"mujkod":"bag"}`.
- **Levely a XP:** za každý dohraný zápas v místnosti (2+ hráči) dostaneš XP: 20 za účast, 25 za každou eliminaci
  (max 15), 150 za výhru a až 120 za přežitý čas (max 600 za zápas). Level se počítá z celkového XP
  (lv2 = 100 XP, lv3 = 300, lv4 = 600, …). XP bar vidíš v menu, level u jmen v lobby a nad hlavami hráčů.
  XP uděluje server a jen po zápase, který sám odstartoval (nejde farmit sólo ani posílat vymyšlené hodnoty).
- **Lobby:** po „play“ v room módu se všichni se stejným kódem objeví na jevišti i se svými skiny a jmény.
  Tlačítkem **ready** se označíš (zelený kruh pod postavou). Když jsou všichni ready, odpočítá se 3 s a zápas začne
  pro všechny (výběr místa klece → drop). Kdo se připojí do už rozběhnutého zápasu, jde rovnou do hry.
  V lobby jde měnit vzhled (customize) a ostatní to hned vidí. Další zápas = nový kód místnosti (nebo počkat, až se místnost vyprázdní).
- **Online místnosti:** do pole „room code“ napiš libovolný kód a dej *join room* – všichni se stejným kódem
  mají stejnou mapu (bedny, loot, Tilted Town) a vidí se. Mezi hráči se synchronizuje: pozice a vzhled, střelba
  a zásahy, eliminace, sebraný loot, otevřené bedny, postavené a zničené stavby. Max 12 hráčů v místnosti.

## Nasazení na Render
1. Nahraj tuhle složku na GitHub (`public/`, `server.js`, `package.json`, `render.yaml`).
2. Render → **New + → Blueprint** → vyber repozitář → Apply.
3. Počkej na deploy a otevři adresu `https://bagel-royale.onrender.com` (nebo jak se ti služba bude jmenovat).

### Ukládání účtů (důležité)
Účty jsou v souboru `users.json` v `DATA_DIR`. Render ukládá trvale **jen na Persistent Disk**, a ten
vyžaduje placenou instanci (Starter) – proto je to tak v `render.yaml`.
**Free instance** disk nemá: smaž z `render.yaml` řádky `plan`, `DATA_DIR` a celý blok `disk`. Hra poběží,
ale účty se smažou při každém restartu/deployi a free služba usíná po 15 min nečinnosti.

## Lokální test
```
node server.js        # http://localhost:3000
```
Proměnná `SECRET` (délka alespoň 32 znaků) podepisuje tokeny; když chybí, po restartu se všichni odhlásí.

## Známé limity
- Střelba a zásahy věří klientovi (žádný anti-cheat), je to hra pro kamarády.
- Nesynchronizuje se: supply dropy, kácení stromů, výbuchy papriky/kočky na hráče, editace dílků staveb.
- Staré postupy uložené jen v prohlížeči (localStorage) se do nového účtu nepřenášejí – itemy se znovu odemknou kódem.
