# SaveStock

Kleiner Node.js-Server, der pro "SaveStock" eine eigene REST-API zum Speichern und
Abrufen von Variablen bereitstellt. Das Dashboard hinter `/` ist per Login geschuetzt,
die Zugangsdaten stehen in der `.env`.

## Start

```bash
npm install
npm start          # http://localhost:3000
```

Zugangsdaten stehen in `.env` (Vorlage: `.env.example`). Default: `admin` / `changeme` —
bitte direkt unter **Optionen** aendern, dann landet statt Klartext ein scrypt-Hash
(`ADMIN_PASSWORD_HASH`) in der `.env`.

## Dashboard

Kopfzeile: `Number of savestocks`, `Traffic` (uebertragene Bytes + Calls) und
`Used memory` (Node-Heap, Datengroesse im RAM, Groesse auf Platte). Aktualisiert sich alle 5s.

* **SaveStock einrichten** – Name eingeben, Stock anlegen, API-Key wird erzeugt und gespeichert.
* **SaveStock einsehen** – Liste aller Stocks; im Detail: Anzahl API-Calls, Durchschnitt pro
  Minute (60min / 24h / seit Anlage / pro aktiver Minute), Peak, Lese-/Schreib-/Fehlerquote,
  Traffic, Minutenverlauf der letzten Stunde, der API-Key (kopierbar, neu generierbar),
  alle Variablen sowie das Loeschen des Stocks (mit Namensbestaetigung).
* **Optionen** – Benutzername und Passwort aus der `.env` aendern, Session-Laufzeit setzen,
  Session-Secret neu erzeugen.

## REST-API

Authentifizierung mit dem API-Key des Stocks, wahlweise:

```
X-API-Key: sk_...
Authorization: Bearer sk_...
?api_key=sk_...
```

| Methode | Pfad | Bedeutung |
| --- | --- | --- |
| `GET` | `/api/{stock}` | alle Variablen |
| `GET` | `/api/{stock}/{var}` | eine Variable |
| `POST` | `/api/{stock}/new_var/{name}/{typ}/{wert}` | Variable anlegen |
| `POST` | `/api/{stock}/new_var/{name}/{typ}` | Variable anlegen, Wert im Body `{"value": ...}` |
| `PUT`/`POST`/`PATCH` | `/api/{stock}/{var}/{wert}` | Wert setzen (Typ bleibt) |
| `PUT`/`POST`/`PATCH` | `/api/{stock}/{var}` | Wert setzen, Body `{"value": ...}` |
| `DELETE` | `/api/{stock}/{var}` | Variable loeschen |

Typen: `string`, `int`, `float`, `bool`, `json`.
Passt der Wert nicht zum Typ, kommt `400 invalid_value` — `.../new_var/x/int/0c76`
wird also abgelehnt, `.../new_var/x/int/76` angenommen.

Beispiele:

```bash
curl -X POST -H "X-API-Key: sk_..." http://localhost:3000/api/sensor/new_var/temperatur/float/21.5
curl        -H "X-API-Key: sk_..." http://localhost:3000/api/sensor/temperatur
curl -X PUT -H "X-API-Key: sk_..." http://localhost:3000/api/sensor/temperatur/22.8
curl        -H "X-API-Key: sk_..." http://localhost:3000/api/sensor
```

Antworten sind immer JSON mit `ok: true` bzw. `ok: false` plus `error` und `message`.

## Speicherung

Statt einer Datenbank: **In-Memory-State + Append-Only-WAL + Snapshot**.

* `data/wal.jsonl` – jede Aenderung eine JSON-Zeile (Append, kein Rewrite).
* `data/snapshot.json` – vollstaendiger Zustand; wird alle 500 Events, alle 30s bei
  geaenderten Statistiken und beim sauberen Beenden geschrieben, danach ist das WAL leer.
* Beim Start wird der Snapshot geladen und das WAL darueber abgespielt — eine
  abgeschnittene letzte Zeile nach einem Absturz wird einfach verworfen.

Lesezugriffe gehen damit nie auf die Platte. Der bewusste Kompromiss: Call-Statistiken
laufen im RAM mit und werden nur periodisch mitgeschrieben, ein harter Kill kann also
bis zu 30s Zaehlerstand kosten — die Daten selbst nicht.

## Sicherheit

* Session als HMAC-signiertes, `httpOnly`/`SameSite=Strict`-Cookie. Passwort-, Benutzer-
  oder Secret-Aenderung macht alle bestehenden Sessions sofort ungueltig.
* Login-Bremse: 8 Fehlversuche pro IP, danach 5 Minuten Sperre.
* API-Keys und Passwoerter werden zeitkonstant verglichen.
* Hinter einem Reverse Proxy mit HTTPS betreiben — das Session-Cookie setzt `secure`
  automatisch, sobald die Anfrage als `https` ankommt (`trust proxy` ist aktiv).
