# IT-Troubleshooter

Lokales Windows-Desktop-Tool (Electron + TypeScript) für Supporter. Es sitzt wie ein Senior Support Engineer neben dem Supporter und
gibt eine Hauptempfehlung ("Jetzt tun"): Kunden fragen, ohne Fernwartung lösen, Kunden kontaktieren, eskalieren, Fernwartung starten,
Serverzugriff klären oder – erst wenn Fernwartung wirklich nötig ist – Schritt für Schritt per Pfeil-Overlay auf dem Bildschirm zeigen,
wo geklickt werden soll.

## Starten und Bauen

Voraussetzungen: Windows 10/11, Node.js 24.

```powershell
npm install
npm start        # baut und startet die App
npm run build    # Typprüfung (tsc) und Bündelung nach dist/ (esbuild)
npm test         # Unit-Tests (Vitest)
npm run lint     # ESLint
```

Zum Ausprobieren ohne Key den Anbieter **Mock** wählen (Einstellungen). Für echte Hilfe: Anthropic-API-Key eintragen.

## Ablauf

1. **Problem eingeben** (oder **Jetzt Telefonat mit Kunden**). Die erste Einschätzung läuft **ohne Screenshot** (günstig, keine Aufnahme).
2. Das Tool liefert genau **eine Hauptempfehlung** mit Begründung (und höchstens einer Alternative). Buttons: *Gemacht*, *Anders* (Text im
   Eingabefeld = Grund/Gegenvorschlag), *Später*. Die Reaktion geht in den Incident-Verlauf und wird bei der nächsten Empfehlung berücksichtigt.
3. Nur bei **Fernwartung** (Empfehlung `start_remote`, Bestätigung nötig) wird bei jedem Schritt ein Screenshot der gewählten Quelle
   aufgenommen, ans LLM gesendet und der Pfeil im Overlay angezeigt. Bestätigung per *Erledigt / Weiter* oder *Hat nicht geklappt*.
4. Das Modell kann jederzeit zu Antwort, Rückfrage, Kontakt, Eskalation oder Abschluss zurückschwenken. Der Supporter kann übersteuern
   (*Doch erst nachfragen*, *Fernwartung starten*).

Aktionen der Empfehlung: `ask_customer`, `start_remote`, `contact_customer`, `answer_directly`, `do_step`, `wait_check`, `escalate`, `close`,
`check_server_access`. Alle Antworten werden strikt mit zod validiert (eine Hauptempfehlung, höchstens eine Alternative, `do_step` nur
mit Screenshot, `start_remote` nur ohne).

### Telefonat-Modus

Button "Telefonat" (Haupt- und Chatfenster, Kürzel Strg+Alt+T, abschaltbar): legt einen Incident an (Status "Telefonat") oder hängt sich an den
aktiven, startet einen eigenen Zeitabschnitt "Telefonat" und zeigt sofort fünf lokale Einstiegsfragen (ohne API-Aufruf). Der Supporter tippt
Stichworte der Kundenantworten; das Tool schlägt 2 bis 3 weitere Fragen vor (kleinste Modellstufe, kein Bild, Antwort wird gestreamt,
Beantwortetes wird nie wiederholt), optional mit "Verdacht" und dem Hinweis, ob Fernwartung nötig ist oder eine Lösung ohne Fernwartung
möglich ist (Übergang in die Einschätzung). Es gibt **kein Mikrofon, keine Aufzeichnung und keine Transkription** – bewusst nicht im Umfang.

### Serverzugriff

Deuten Symptome auf Server, Dienste, Logs, Datenbank, Netzwerk oder Rechte, fragt das Tool nach dem Zugriff (Ja / Nein / Unklar, Art
RDP / SSH / Webkonsole, Servername/Rolle). Gespeichert wird nur diese Angabe, **keine Zugangsdaten** (bitte keine Passwörter eingeben).
Bei "Ja" nennt das Tool Prüfbefehle zum Kopieren, gekennzeichnet als *Nur lesen* oder *ÄNDERND* (mit Warnung und Rückfallplan; "Gemacht"
erst nach "Ich habe es verstanden"). **Das Tool führt nie selbst Befehle aus und verbindet sich nie mit Servern.** Bei "Nein":
Zugriff beim Kunden anfragen, der Kunde führt aus oder Eskalation.

## Incidents und Zeiterfassung

- Jeder Fall wird lokal als Incident gespeichert (`incidents.json` in `%APPDATA%\IT-Troubleshooter`, mit Schema-Version und Migration,
  atomares Schreiben; defekte oder zu neue Dateien werden beiseitegelegt statt überschrieben). **Keine Screenshots, keine API-Keys** im Incident.
- Liste (Tab *Incidents*): Suche, Filter nach Status, Sortierung, Spalten Titel, Status, zuletzt geändert, Dauer, Kosten (Schätzung).
  Aktionen: öffnen, wieder aufnehmen, abschließen, löschen (mit Bestätigung), Status manuell übersteuern, Dauer korrigieren.
- Status (automatisch aus dem Ablauf): Entwurf, Telefonat, Triage, Rückfrage offen, Fernwartung läuft, Pausiert, Gelöst, Nicht gelöst
  (mit Zusatzinfo wie "Schritt 4, letzter Schritt: ..."). Wird die App während einer Sitzung beendet oder stürzt ab, kommt der Fall als
  "pausiert" zurück; die Zeit nach dem letzten Herzschlag zählt nicht.
- **Wieder aufnehmen**: Abgeschlossene Fälle brauchen eine **Begründung** (Pflicht, max. 500 Zeichen). Sie wird im Incident gespeichert
  (Zeitpunkt, Begründung, vorheriger Status; Liste zeigt "wiedergeöffnet (n×)") und dem Modell als Kontext mitgegeben. Aufnahme und Overlay
  starten erst, wenn wieder Fernwartung nötig ist; der Bildschirmzustand wird dann neu aufgenommen. Nur eine aktive Sitzung gleichzeitig.
- **Zeitmessung**: aktive Zeit pro Sitzung (Start, Pause, Zeitabschnitte "Arbeit"/"Telefonat"); Leerlauf wird nicht automatisch gezählt, es
  gibt keine Zeit bei "wartet auf Kunden" oder pausierter Zeit. Manuell korrigierbar.
- **Zeiterfassungs-Eintrag** beim Abschluss: Datum, Dauer, Incident, Kunde/Referenz, kurze Zusammenfassung (vom Modell aus dem Textverlauf,
  kleine Stufe, von Passwörtern bereinigt, im Dialog editierbar), Ergebnis. Bei Wiedereröffnung entsteht ein **eigener neuer** Eintrag nur für
  die neue Arbeit; bestehende Einträge bleiben unverändert. Austauschbare Schnittstelle `TimeTrackingSink` mit (a) lokaler Liste
  (Status offen/übertragen) und (b) CSV-Export (Datum, Start, Ende, Dauer in Minuten, Incident, Kunde, Beschreibung; RFC-4180-Escaping,
  Schutz gegen CSV-Injection bei führendem `=`, `+`, `-`, `@`). Weitere Sinks (API, Jira, Tempo) kommen später.

**Datenschutz-Hinweis:** Incident-Texte (Problem, Verlauf, Zusatzinfos, Notizen) liegen **lokal im Klartext** in `incidents.json`.
Begründung: Eine Verschlüsselung per `safeStorage` ist an das Windows-Benutzerprofil gebunden – dort liegt die Datei ohnehin, sie
würde also nur wenig gegen lokalen Zugriff derselben Person schützen, riskiert aber Datenverlust (Profilwechsel, Schlüsselverlust) und
verhindert Backup/Suche. Wer das nicht möchte, löscht Fälle über die Liste (dauerhaft) oder nutzt eine verschlüsselte Festplatte.

## Modellwahl und Kosten

**Modellwahl: so klein wie möglich, so groß wie nötig.** Jeder Anbieter hat drei Stufen. Anthropic (Standard): klein = `claude-haiku-5-5`,
mittel = `claude-sonnet-5-5`, groß = `claude-opus-5-5` (je Stufe frei einstellbar; fehlt eine Stufe, wird die nächstgrößere genommen).
Startzuordnung (änderbar): Triage und Rückfragen, Telefonat und Zusammenfassung = klein; Schritt mit Screenshot = mittel.
Eskalation auf die nächste Stufe höchstens **einmal pro Anfrage**, nie über die höchste Stufe, bei: Schwelle "Hat nicht geklappt" in Folge
(Standard 2), wiedergeöffneten Fällen mit langem Verlauf, ungültiger Antwort (nach Retry) oder `confidence: low`. Danach beginnt die
nächste Anfrage wieder bei der Basisstufe (abschaltbar). Pro Anfrage zeigt die UI Stufe, Modell, Grund und Tokens; im Incident stehen nur
Zahlen und Modellnamen.

**Kontext klein halten:** pro Anfrage nur der aktuelle Screenshot (nie ältere Bilder), Triage ohne Bild, die letzten 5 Schritte im Detail,
ältere als Kurzzeile, Notizen/Kommentare gekürzt (max. 20 Notizen à 400 Zeichen), Screenshot standardmäßig max. 1280 px Breite bei JPEG-Qualität 70
(einstellbar 800-1920 px bzw. 40-90).

**Kosten & Limits (Schätzung):** Eingestellt werden "Warnung ab X €", "Limit Y €" (Y ≥ X), Zeitraum (Tag / Monat / gesamt) und optional ein Limit
je Incident. Berechnet wird lokal aus den Usage-Angaben der API (Input, Output, Cache; Bildtokens stecken im Input) und einer Preistabelle
(USD pro 1 Mio. Tokens, Stand 2026-10-06, überschreibbar in `settings.json` unter `priceOverrides`) mit einem **manuell zu pflegenden**
USD-EUR-Kurs. Unbekannte Modelle werden konservativ mit der teuersten bekannten Stufe gerechnet. **Das ist eine Schätzung, keine Rechnung;
maßgeblich ist die Abrechnung in der Anthropic Console.** Warnung und 90 %-Hinweis erscheinen einmal pro Periode (Hauptfenster, Chat-Statuszeile,
Overlay-Pill, Button "Verstanden"). Am Limit werden keine neuen Anfragen mehr gestartet (laufende werden nicht abgebrochen, die nächste wird vorab mit
Obergrenze `max_tokens` geprüft), bis Sie "Limit anheben" oder "Einmal fortfahren" wählen. Eskalation und Auto-Weiter respektieren das Limit.

## Sichtbare KI-Aktivität

Statuszeile im Chatfenster (immer sichtbar, ein Zeile mit Sekundenzähler), aufklappbares Aktivitätsprotokoll im Hauptfenster und ein
kleines klickdurchlässiges Statuspill im Overlay bei Wartezeiten über 3 s (abschaltbar). Zustände: Bereit, Screenshot, Bild verkleinern,
Anfrage läuft an *Modell (Stufe)*, Antwort prüfen, Wiederholung (Versuch n von m), Eskalation, Rate-Limit-Countdown, Fehler mit Handlungshinweis,
Zeitmessung pausiert, wartet auf Kunden, "wartet, bis <Fenster> vorne ist", "Bitte klicken", "Klick erkannt – denkt nach", "wartet – keine
Änderung erkannt", "schreibt dir im Chat". Die Texte enthalten keine Keys und keine Inhalte von Eingaben oder Screenshots. Bei Hängern
(Zeitlimit 60 s) erscheinen *Erneut versuchen*, *Abbrechen* und *Manuell weiter*.

## Begleit-Chatfenster

Kleines (Standard 340×210), frameless, immer oben liegendes Fenster; öffnet automatisch mit der Sitzung, schließt mit ihr und lässt sich
bewusst schließen (wieder öffnen per Button oder Strg+Alt+Leertaste, abschaltbar). Verschieben per Titelleiste oder **Alt+Pfeile**, Größe per Rand
oder **Alt+Umschalt+Pfeile**; Position und Größe werden gemerkt und gegen die sichtbaren Monitore geprüft. Zeigt "Jetzt tun"-Karte, Eingabefeld
(Enter sendet, Umschalt+Enter Zeilenumbruch), Schalter "Sofort neu bewerten" (Standard aus) und einen eingeklappten Verlauf, der nur auf Wunsch
aufklappt und danach (Fokusverlust oder Zuklappen) wieder auf Minimalgröße springt.

**Aufnahme:** Overlay, Chatfenster und (per Einstellung) Hauptfenster sind per `setContentProtection` (Windows `SetWindowDisplayAffinity`) aus
Screenshots ausgeschlossen. Sie müssen daher vor der Aufnahme nicht ausgeblendet werden (das Overlay wird zur Sicherheit trotzdem kurz
ausgeblendet). Wirksamkeit ist nur auf Windows 10 2004+ garantiert und wurde von mir **nicht** live gegen eine echte Aufnahme geprüft. Hinweis:
Das gilt auch für andere Aufnahmen – Fernwartungssoftware überträgt diese Fenster dadurch vermutlich ebenfalls nicht.

## Auto-Weiter (optional, Standard aus)

Der Supporter bleibt in der Ziel-App; das Tool erkennt per Vordergrundfenster (Titel/Prozessname via GetForegroundWindow) und Bildvergleich (kleine
Graustufenbilder nur im Speicher, Schwelle, ignorierte Bereiche, Entprellen bis der Bildschirm ruhig ist, Mindestabstand 4 s, höchstens 6 pro
Minute, Zeitlimit 90 s) eine Änderung und löst den nächsten Schritt aus. Ohne Änderung: "wartet – keine Änderung erkannt" und *Erledigt / Weiter*
manuell. Standard bleibt Schritt für Schritt mit Bestätigung.

## Sicherheit und Datenschutz

- Electron: `contextIsolation`, `nodeIntegration` aus, `sandbox`, strikte CSP in allen Seiten, Navigation und `window.open` gesperrt,
  Berechtigungsanfragen abgelehnt, schmale typisierte Preload-APIs (Hauptfenster, Chatfenster, Overlay getrennt), IPC nur vom jeweils
  eigenen Fenster akzeptiert, alle Parameter geprüft.
- API-Keys: nur im Hauptprozess, mit `safeStorage` verschlüsselt in `userData`, nie im Renderer, nie in Logs, nie im Repo. Ist keine
  Verschlüsselung verfügbar, wird nichts gespeichert.
- **Screenshots werden bei Fernwartung an den gewählten Anbieter gesendet, aber nicht auf der Festplatte gespeichert** (nur im Speicher).
  Vor "Fernwartung" geht kein Screenshot an den Anbieter. Texte (Problem, Verlauf, Zusatzinfos) werden gesendet; Eingaben werden gekürzt und
  Tags entschärft (Schutz vor Prompt-Injection), sind aber kein Ersatz für eine Prüfung: bitte keine Passwörter oder unnötige Kundendaten eingeben.
- Benutzerdaten liegen unter `%APPDATA%` (userData), nicht im Repo; `.gitignore` schließt `node_modules`, `dist`, `out` aus.

## Tests und Selbsttest

`npm test` (Vitest, 166 Tests) deckt u. a. Schema-Validierung aller Aktionen, Routing/Eskalation, Kosten/Limits, Incident-Speicher mit Migration,
Statusmaschine, Zeitmessung (Fake-Zeit), CSV-Export, Aktivitätszustände, Bildvergleich/Auto-Weiter und den Sitzungsablauf mit Mock ab.

**Wichtig – keine echte Bildschirmaufnahme in Tests:** Tests und der Selbsttest nutzen eine **simulierte Aufnahmequelle** (Fake-Frames). Der
Selbsttest läuft in einem temporären Datenordner und berührt keine echten Fälle. Eine echte Aufnahme im Selbsttest gibt es nur bei
ausdrücklichem Opt-in (`ITT_SELFTEST_CAPTURE=1`) und nur mit Erlaubnis des Nutzers; Bilder werden nie auf Platte geschrieben.

```powershell
npm run build
$env:ITT_SELFTEST = "1"; $env:ITT_SELFTEST_OUT = "$PWD\dist\selftest.json"; npx electron .
```

## Aufbau

```
src/main/        Hauptprozess: Fenster, IPC, Sitzung, Incidents/Zeit, Kosten, Aktivität, Aufnahme, Overlay, Chat, Auto-Weiter
src/main/llm/    Provider-Schnittstelle, Registry, Anthropic-Adapter, Mock, Schemas (zod), Prompts, Routing und Stufen
src/preload/     schmale, typisierte Brücken (Hauptfenster, Chat, Overlay)
src/renderer/    Hauptfenster (Deutsch), src/chat/ Begleit-Chat, src/overlay/ Pfeil und Statuspill, src/ui/ gemeinsame Karte
src/shared/      Typen, Koordinaten, Incident-Modell, Zeit- und Anzeige-Helfer
docs/            Spikes und Konzepte (CLI-Provider, M365 Copilot)
tests/           Vitest
```

Neuen Anbieter ergänzen: `ProviderDefinition` (`src/main/llm/types.ts`) mit `recommend`, `callQuestions`, `summarize` implementieren und in
`src/main/llm/index.ts` registrieren; UI, Stufen, Key-Speicher und Kosten übernehmen ihn.

## Noch nicht umgesetzt

Siehe Abschlussbericht und `docs/`: Speichern und Dokumentieren von Screenshots (Doku-Export), die Anbieter `claude-cli`,
`copilot-cli` und `m365-copilot` (Spikes sind dokumentiert, die Adapter sind nicht gebaut). Bis dahin gilt: Screenshots werden nicht gespeichert.
