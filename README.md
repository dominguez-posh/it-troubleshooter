# IT-Troubleshooter

Lokales Windows-Desktop-Tool (Electron + TypeScript) für Supporter bei der Fernwartung (z. B. TeamViewer).
Du beschreibst das Problem, das Tool nimmt einen Screenshot, fragt ein LLM nach **genau einem** nächsten Schritt und zeigt per
Pfeil-Overlay auf dem Bildschirm, wo als Nächstes geklickt werden soll. Danach bestätigst du im Chatfenster
(„Erledigt / Weiter“ oder „Hat nicht geklappt“ mit Kommentar), das Tool nimmt einen neuen Screenshot und liefert den nächsten Schritt.

## Voraussetzungen

- Windows 10/11, Node.js 24 (andere aktuelle LTS-Versionen sollten ebenfalls gehen)
- Für echte Hilfe: ein Anthropic-API-Key. Zum Ausprobieren gibt es den **Mock**-Anbieter ohne Key.

## Starten

```powershell
npm install
npm start        # baut und startet die App
```

Weitere Befehle:

| Befehl           | Zweck                                                  |
| ---------------- | ------------------------------------------------------ |
| `npm run build`  | Typprüfung (tsc) und Bündelung nach `dist/` (esbuild)  |
| `npm test`       | Unit-Tests (Vitest)                                    |
| `npm run lint`   | ESLint                                                 |

Automatischer Selbsttest der echten UI mit dem Mock-Anbieter (Quelle wählen, Problem eingeben, Schritte bestätigen, lösen,
Bildschirm- und Fensteraufnahme). Das Ergebnis steht in der Datei, die `ITT_SELFTEST_OUT` angibt:

```powershell
npm run build
$env:ITT_SELFTEST = "1"; $env:ITT_SELFTEST_OUT = "$PWD\dist\selftest.json"; npx electron .
```

## Bedienung

1. **Einstellungen**: Anbieter wählen (Standard: Anthropic, Modell `claude-sonnet-5-5`), API-Key eintragen. Der Key wird nur im
   Hauptprozess mit Electron `safeStorage` verschlüsselt im userData-Ordner gespeichert. Das Fenster zeigt nur „Key gesetzt: ja/nein“.
2. **Quelle** wählen: ganzer Bildschirm (auch mehrere Monitore) oder ein einzelnes Fenster (z. B. TeamViewer).
3. Problem beschreiben, **Hilfe starten**. Der Pfeil erscheint als Overlay über dem Ziel; der Text steht im Overlay und im Fenster.
4. Schritt ausführen, dann **Erledigt / Weiter** oder **Hat nicht geklappt** (optional mit Kommentar). Am Ende **Problem gelöst**.
   Der Verlauf (Schritte und Ergebnisse) steht unten im Fenster und wird dem LLM bei jedem Schritt mitgegeben.

## Aufbau

```
src/main/        Hauptprozess: Fenster, IPC, Aufnahme (desktopCapturer), Overlay, Sitzung, KeyStore, Einstellungen
src/main/llm/    Provider-Schnittstelle, Registry, Anthropic-Adapter, Mock-Provider, Antwort-Validierung (zod)
src/preload/     schmale, typisierte Brücke zum Renderer (contextBridge)
src/renderer/    UI (Deutsch), kein Node-Zugriff
src/overlay/     Overlay-Seite (zeichnet Pfeil und Text)
src/shared/      Typen, Koordinaten-Umrechnung, Overlay-Layout
tests/           Vitest
```

### Neuen LLM-Anbieter ergänzen

`ProviderDefinition` (siehe `src/main/llm/types.ts`) implementieren – ein `LlmProvider` mit `nextStep(req)`, das einen per
`validateStep` geprüften `Step` liefert – und in `src/main/llm/index.ts` in der Registry registrieren. UI und Key-Speicher
übernehmen den Anbieter automatisch.

### Koordinaten

Das LLM liefert das Ziel in Pixeln des gesendeten, auf max. 1600 px Breite skalierten JPEG. Daraus wird über den aufgenommenen
Bereich in DIP (Bildschirm: `display.bounds`; Fenster: Win32-Fensterposition zum Zeitpunkt der Aufnahme, per
`screen.screenToDipRect` umgerechnet) die Overlay-Position bestimmt. So sind DPI-Skalierung und Mehrmonitor-Versatz berücksichtigt.

## Sicherheit und Datenschutz

- Electron: `contextIsolation`, `nodeIntegration` aus, `sandbox`, strikte CSP, Navigation und `window.open` gesperrt,
  Berechtigungsanfragen abgelehnt, IPC nur vom Hauptfenster akzeptiert und Parameter geprüft.
- API-Keys: nur im Hauptprozess, verschlüsselt (`safeStorage`), nie im Renderer, nie in Logs, nie im Repo. Ist keine
  Verschlüsselung verfügbar, wird nichts gespeichert.
- Screenshots liegen nur im Arbeitsspeicher und werden **nicht** auf die Festplatte geschrieben. Sie werden bei jedem Schritt an den
  gewählten Anbieter gesendet (Hinweis steht in der UI). Bitte nur freigeben, was der Anbieter sehen darf.
- Overlay und (per Einstellung) das Hauptfenster sind per `setContentProtection` von Bildschirmaufnahmen ausgenommen, damit das LLM
  seinen eigenen Pfeil nicht sieht. Hinweis: Das gilt auch für andere Aufnahmen (z. B. Fernwartungs-Software kann diese Fenster dadurch
  ebenfalls nicht übertragen). Der Pfeil ist also nur für den Supporter am eigenen Bildschirm sichtbar.

## Bekannte Grenzen

- Fenster-Aufnahme: Die Fensterposition kommt per PowerShell/Win32 (`GetWindowRect`). Minimierte oder geschützte Fenster liefern kein Bild.
- Genauigkeit der Pfeilposition hängt vom Modell ab; bei Unsicherheit beschreibt das Modell den Weg zum Element.
