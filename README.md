# Olga's Cheese — zelfbedieningskiosk

Een kiosk op een tablet, in de stijl van een fastfoodzuil: de klant kiest,
betaalt met de kaart op een **SumUp Solo** naast het scherm, krijgt meteen een
bonnetje uit de **USB-bonprinter** (geen printvenster) en schrijft daarna het
bedrag en een handtekening op het papieren formulier.

Dit project staat **los van de POS**. Het praat met de POS als gewone client,
via de API die de POS al heeft; aan de POS verandert niets.

```
 Android-tablet (Chrome)               kioskserver (dit project)                 buiten
┌─────────────────────────┐   /api   ┌──────────────────────────┐   HTTPS   ┌──────────────────┐
│ public/index.html       │ ───────▶ │ src/  (Node + Express)   │ ────────▶ │ POS-API          │
│ bonprinter via WebUSB   │          │ SumUp-sleutel, POS-login │ ────────▶ │ SumUp Cloud API  │──▶ Solo
└─────────────────────────┘          └──────────────────────────┘           └──────────────────┘
```

De pagina in de browser kent geen enkele sleutel. Alles wat geheim is
(SumUp API-sleutel, de PIN van het kiosk-account in de POS) staat alleen in de
`.env` van de kioskserver.

## Hoe een betaling loopt

1. De klant tikt op **Pay by card**. De pagina stuurt alleen product-id's en
   aantallen naar `POST /api/orders`.
2. De server prijst de bestelling zelf uit de prijslijst van de POS (nooit de
   prijzen uit de browser) en maakt in de POS een gewone BX-verkoop aan
   (`payment_method: 'sumup'`). De POS rekent `amount_eur` uit met de koers van
   de open dag.
3. De server zet dat **euro-bedrag** op de Solo (SumUp Cloud API), met de
   POS-verkoop-id als SumUp's `foreign_transaction_id`. Het SumUp-account rekent
   in euro's af; de klant ziet vooraf beide bedragen.
4. De pagina vraagt elke 2 s `POST /api/orders/:id/poll`. De server vraagt
   SumUp: wacht de Solo op een kaart of PIN, is de betaling gelukt, geweigerd,
   verlopen? De pagina laat zien wat de Solo vraagt.
5. **Gelukt**: de bon gaat direct naar de printer (met kaarttype, laatste vier
   cijfers en SumUp-transactiecode) en het formulierscherm verschijnt. De server
   vraagt de POS om de verkoop te bevestigen; de POS vraagt dat zelf aan SumUp.
6. **Niet gelukt** (geweigerd, klant weggelopen, "Cancel payment"): de server
   sluit de POS-verkoop af. "Try again" is een nieuwe verkoop, zodat een mislukte
   poging nooit voor de uitkomst van de volgende kan worden aangezien.

### Wie beslist of er betaald is

Alleen SumUp. Niets wat de browser of een webhook beweert telt.

- De **kiosk** gaat op "betaald" zodra SumUp's eigen gegevens dat zeggen (de
  status van de checkout op de Solo en het transactierecord, opgehaald met onze
  sleutel). Een geslaagde betaling wint altijd van een faalsignaal.
- De **POS** boekt de verkoop pas als betaald na zijn eigen controle bij SumUp
  (`/sales/:id/sumup-check`, en zijn eigen 30 s-controle als vangnet). Kiosk-
  betalingen staan daardoor ook gewoon in de afstemming en het SumUp-dagrapport.
- Kan SumUp na 4 minuten nog niets zeggen, dan wordt de bestelling **stuck**:
  de klant krijgt "Please ask our staff" en wordt nooit naar een tweede betaling
  gestuurd.
- SumUp's webhook (`POST /api/sumup/webhook/:id`) wordt gelogd en is alleen
  een seintje om opnieuw te kijken.

## Wat de POS nodig heeft

- Een **apart personeelsaccount** voor de kiosk (rol *staff* is genoeg).
- Een **BX-event met een open dag**. Zonder `POS_EVENT_ID` kiest de kiosk het
  enige BX-event met een open dag; zijn er meer, zet dan `POS_EVENT_ID`.
- De **SumUp-koppeling in de POS** (Instellingen → Koppel SumUp-account). Zonder
  die koppeling kan de POS een kiosk-betaling niet zelf controleren: de klant is
  dan wél klaar (SumUp zei "betaald"), maar de verkoop blijft in de POS open
  staan tot iemand hem in Dagoverzicht afhandelt.

## Installeren en draaien

Node.js 20 of nieuwer.

```sh
npm install
cp .env.example .env      # invullen, zie de uitleg in het bestand zelf
npm start                 # http://localhost:8080
```

**Proberen zonder Solo en zonder POS:** zet in `.env` alleen `SUMUP_MOCK=true`
en laat de POS-regels leeg. De kiosk draait dan in demo-modus. Met
`SUMUP_MOCK=true` én een POS erachter loopt alles echt via de POS, met een
virtuele Solo (`SUMUP_MOCK_OUTCOME`: `successful`, `declined`, `timeout`,
`offline`). `public/index.html` werkt ook los als bestand, maar dan alleen als
demo.

## De SumUp Solo koppelen

1. Haal in het SumUp-dashboard een **API-sleutel** en een **affiliate key**
   (met de bijbehorende app-id), en noteer de **merchant code**. Zet ze in `.env`.
2. Op de Solo: menu → **Connections → API → Connect**. De Solo toont een code.
3. `npm run pair -- <code> "Kiosk Solo"` en bevestig op de Solo.
4. Zet het getoonde `rdr_…`-nummer in `SUMUP_READER_ID`. `npm run readers` laat
   alle gekoppelde lezers zien met batterij en online-status.

Alleen de Solo werkt zo. De SumUp Air is een Bluetooth-lezer die alleen met een
app op het toestel praat en heeft geen Cloud API.

## De tablet

- **Chrome op Android** (of Edge/Chrome op Windows, macOS, ChromeOS). Open de
  kiosk-URL; met `KIOSK_ACCESS_KEY` eenmalig als `…/?key=<sleutel>`. Kies
  *Toevoegen aan startscherm*: de kiosk draait dan schermvullend. Zet Android's
  *scherm vastzetten* aan, zodat klanten de kiosk niet kunnen verlaten.
- **Personeelsmenu**: tik 5× op het logo en voer `KIOSK_STAFF_PIN` in. Daar staan
  de bonprinter, de status van POS en Solo, en de schakelaar Live/Demo.
- **Bonprinter** (58 mm ESC/POS, USB): één keer *Connect printer* in het
  personeelsmenu. Daarna maakt de kiosk bij elke start zelf verbinding en print
  hij elk bonnetje meteen, zonder printvenster. Dit werkt in Chrome, niet op een
  iPad of iPhone, en niet in apps of kioskbrowsers die op Android WebView draaien.

## Waar de server draait

Overal waar Node draait en internet is: op de VPS naast de POS (bijvoorbeeld
`kiosk.olgascheese.net` achter nginx met HTTPS — dan zet je `KIOSK_PUBLIC_URL`
en krijgt SumUp ook een webhook-adres), of op een laptop bij de kraam. De Solo
heeft zelf ook internet nodig (wifi, of mobiele data als SumUp die aanzet).

## Testen

```sh
npm test         # kioskserver tegen een virtuele Solo en een nagebootste POS
npm run typecheck
```

De tests dekken: prijzen uit de POS, verkoop in de POS, euro-bedrag op de Solo,
betaald (met en zonder bevestiging door de POS), geweigerd, weggelopen,
"Cancel payment", Solo offline, foute bestellingen, webhook, kiosk-sleutel,
verlopen POS-sessie, personeels-PIN en "stuck". Daarnaast is de pagina in een
echte browser getest tegen de echte POS, met een virtuele Solo.

**Nog niet getest:** een echte Solo met een echte kaart, en SumUp's echte API.
Daarvoor is de Solo nodig. De velden en endpoints komen uit SumUp's officiële
TypeScript-SDK (`@sumup/sdk`).

## Bestanden

| Pad | Wat |
| --- | --- |
| `public/index.html` | De kiosk: schermen, demo-modus, bon (ESC/POS via WebUSB) |
| `public/assets/` | Logo, het logo als 1-bits raster voor de bonprinter, app-iconen |
| `src/app.ts` | De API van de kioskserver |
| `src/orders.ts` | Eén bestelling: POS-verkoop, betaling op de Solo, afhandeling |
| `src/sumup.ts` | SumUp Cloud API (Solo), plus de virtuele Solo |
| `src/pos.ts` | De POS-API als client |
| `scripts/` | `npm run pair` en `npm run readers` |
| `test/` | Tests en de nagebootste POS |
