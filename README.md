# Bagel Royale – online (Render)

Hra + server v jednom. Server nemá žádné závislosti (jen Node 18+), takže se nic neinstaluje.

## Major update: obří mapa
- Mapa je 4× větší (1400×1400) a má **4 typy země**: červená vlna (Crimson Fields), sníh s horami (Frostlands),
  oblázky (Pebble Coast) a zelená vlna (Emerald Weave). Textury jsou v `public/index.html` (kameny, sníh, zelená vlna).
- **4 města** s budovami, skly a dřevěnými střechami: Tilted Town (střed), Frost Peak, Pebble Port, Emerald Row.
  Navíc ~44 samostatných domů po mapě v materiálech podle biomu, víc domů, věží a ruin.
- **3 typy beden:** dřevěná, modrá (lepší loot, víc rarity) a fialová (zbraně + epic loot, drží se u věží a na létajících ostrovech).
  Na minimapě jsou žluté / modré / fialové.
- Zóna je větší (poloměr 700) a hra hlásí vstup do nového biomu.

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

## Nasazení na Render ZDARMA
1. Nahraj tuhle složku na GitHub (`public/`, `server.js`, `package.json`, `render.yaml`).
2. **Účty zdarma (Upstash):** na upstash.com si založ účet a vytvoř **Redis** databázi (free plán). Na její stránce
   zkopíruj `UPSTASH_REDIS_REST_URL` a `UPSTASH_REDIS_REST_TOKEN`.
3. Render → **New + → Blueprint** → vyber repozitář. Render se zeptá na dvě proměnné
   (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) – vlož je. Apply.
4. Po deployi otevři `https://<tvoje-služba>.onrender.com`.

### Proč Render chtěl platit a jak to jde zadarmo
Dřív byl v `render.yaml` plán Starter, protože ukládání účtů do souboru potřebuje *Persistent Disk* a ten Render
nabízí jen u placených instancí. Free web služba má efemérní disk: smaže se při každém restartu, deployi i uspání.
Proto teď server ukládá účty do **Upstash Redis** (zdarma) a Render poběží na plánu **free**. Účty přežijí
restart i uspání. Bez těch dvou proměnných se server vrátí k ukládání do souboru (účty se pak při restartu ztratí).

Limity free plánu Renderu: služba se po 15 minutách bez provozu uspí (WebSocket zprávy z hry se počítají jako
provoz) a první připojení po uspání trvá asi minutu. Free hodiny jsou 750 za měsíc.

## Lokální test
```
node server.js        # http://localhost:3000
```
Proměnná `SECRET` (délka alespoň 32 znaků) podepisuje tokeny; když chybí, po restartu se všichni odhlásí.

## Známé limity
- Střelba a zásahy věří klientovi (žádný anti-cheat), je to hra pro kamarády.
- Nesynchronizuje se: supply dropy, kácení stromů, výbuchy papriky/kočky na hráče, editace dílků staveb.
- Staré postupy uložené jen v prohlížeči (localStorage) se do nového účtu nepřenášejí – itemy se znovu odemknou kódem.
