# Deployment — kiosk.olgascheese.net

De kioskserver draait op **dezelfde VPS als de POS**, als eigen gebruiker en
eigen systemd-service, achter nginx met HTTPS. Hij praat met de POS rechtstreeks
over `127.0.0.1:3001`; aan de POS verandert niets.

```
tablet ──https──▶ nginx (kiosk.olgascheese.net) ──▶ kiosk :8080 ──▶ POS :3001
                                                        └──https──▶ SumUp Cloud API ──▶ Solo
```

## 1. Gebruiker en code

Node.js 20+ staat al op de VPS (voor de POS).

```sh
adduser kiosk --disabled-password
sudo -u kiosk -i
git clone https://github.com/AMLopezAdrados/SelfServiceCheese.git /home/kiosk/app
cd /home/kiosk/app
npm ci --omit=dev
mkdir -p data
cp .env.example .env && chmod 600 .env && nano .env
```

## 2. `.env` op de VPS

| Variabele | Waarde op de VPS |
| --- | --- |
| `PORT` / `HOST` | `8080` / `127.0.0.1` (alleen nginx kan erbij) |
| `KIOSK_PUBLIC_URL` | `https://kiosk.olgascheese.net` (dan stuurt SumUp ook een webhook) |
| `KIOSK_ACCESS_KEY` | een lange willekeurige sleutel: `openssl rand -hex 24` |
| `KIOSK_STAFF_PIN` | de PIN van het personeelsmenu op de kiosk (niet `1234`) |
| `KIOSK_DATA_DIR` | `data` (hier bewaart de kiosk welke producten aan staan) |
| `POS_URL` | `http://127.0.0.1:3001` (rechtstreeks naar de POS-backend) |
| `POS_USERNAME` / `POS_PIN` | het kiosk-account in de POS (rol staff) |
| `POS_EVENT_ID` | leeg laten: de kiosk kiest het BX-event met een open dag |
| `SUMUP_API_KEY`, `SUMUP_MERCHANT_CODE` | uit het SumUp-dashboard |
| `SUMUP_AFFILIATE_KEY`, `SUMUP_APP_ID` | affiliate key + de application identifier die je daarbij invulde |
| `SUMUP_READER_ID` | na stap 5 |
| `SUMUP_MOCK` | `false` |

`.env` staat alleen op de server en komt nooit in git.

## 3. systemd

```sh
cp /home/kiosk/app/deploy/olgas-kiosk.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now olgas-kiosk
curl -s localhost:8080/health          # {"ok":true}
journalctl -u olgas-kiosk -n 20        # toont POS- en SumUp-instellingen bij de start
```

## 4. nginx + HTTPS

DNS eerst: A-record `kiosk.olgascheese.net` → VPS-IP.

```sh
cp /home/kiosk/app/deploy/nginx-olgas-kiosk.conf /etc/nginx/sites-available/olgas-kiosk
ln -s /etc/nginx/sites-available/olgas-kiosk /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d kiosk.olgascheese.net
```

## 5. De Solo koppelen

Op de Solo: menu → **Connections → API → Connect**; de Solo toont een code.

```sh
sudo -u kiosk -i
cd /home/kiosk/app
npm run pair -- <code> "Kiosk Solo"     # bevestig daarna op de Solo
npm run readers                          # rdr_… en online-status
nano .env                                # SUMUP_READER_ID=rdr_…
exit
systemctl restart olgas-kiosk
```

## 6. De tablet

Open in Chrome één keer `https://kiosk.olgascheese.net/?key=<KIOSK_ACCESS_KEY>`.
De sleutel wordt onthouden en uit de adresbalk gehaald. Daarna *Toevoegen aan
startscherm* (schermvullend) en Android's *scherm vastzetten*.

Personeelsmenu: 5× op het logo tikken, `KIOSK_STAFF_PIN`. Daar:
- **Choose products**: per categorie en per product aan/uit. Producten en
  prijzen komen uit de POS; nieuwe producten staan automatisch aan.
- **Receipt printer**: eenmalig de USB-bonprinter koppelen.
- status van POS en Solo.

## 7. Updates

```sh
sudo -u kiosk -i
cd /home/kiosk/app && git pull && npm ci --omit=dev
exit
systemctl restart olgas-kiosk
```

De productinstellingen (`data/assortment.json`) blijven bij een update staan.

## 8. Controlelijst

- [ ] `https://kiosk.olgascheese.net/health` → `{"ok":true}`.
- [ ] Zonder `?key=` geeft `https://kiosk.olgascheese.net/api/status` 401.
- [ ] Personeelsmenu: groen bij POS (juiste event, aantal producten) en bij de Solo (ONLINE).
- [ ] Een product uitzetten → het verdwijnt van de kiosk; weer aanzetten → terug.
- [ ] Testbetaling met een klein bedrag → bon uit de printer → in de POS in
      Dagoverzicht als betaald. Daarna storneren in de SumUp-app.
- [ ] Testbetaling op de Solo afbreken → kiosk terug bij de bestelling, POS-verkoop geannuleerd.
