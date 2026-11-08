# UX: Prinzipien und Begriffe

Ziel: Jeder Mensch versteht die Oberfläche, auch ohne Support-Erfahrung. Die Fachlogik (Schemas, IPC, Tests) ist unverändert; geändert sind
nur Darstellung, Texte, Struktur und die Zustandsführung der Fenster. Die Übersetzungen stehen als reine Funktionen in `src/shared/ux.ts`
(getestet in `tests/ux.test.ts`), die Gestaltung in `src/ui/tokens.css` und `src/ui/base.css`.

## Prinzipien

1. **Eine Sache pro Bildschirm, eine Hauptaktion.** Startbildschirm: ein Feld, ein Button ("Los geht's").
2. **Geführter Ablauf:** vier Schritte sichtbar (Problem beschreiben, Klären, Gemeinsam lösen, Abschließen) und oben ein Satz "Wo bin ich? Was soll ich jetzt tun?".
3. **Die "Jetzt tun"-Karte ist der Held:** eine Anweisung, höchstens zwei Buttons (*Erledigt*, *Hat nicht geklappt*), ein Link *Anderer Vorschlag*.
   Begründung, Alternative, Modell und Vertrauen liegen unter *Mehr Details* (Modell und Vertrauen nur im Erweiterten Modus).
4. **Einfache Sprache:** Du-Form, kurze Sätze, Verben statt Substantive, keine Abkürzungen. Die KI-Anweisungen werden ebenfalls in Du-Form angefordert.
5. **Zwei Modi:** *Einfach* (Standard) und *Erweitert*. Sinnvolle Standardwerte, damit niemand etwas einstellen muss.
6. **Wenig Chrome:** links schmale Fallliste, rechts der aktuelle Fall, 8-px-Raster, zwei Schriftgrößen im Fließtext (16 und 14 px), ein farbiger Button pro Bereich.
7. **Menschliche Fehler:** statt Technik ein Satz plus nächste Handlung; Details nur unter *Fehlerdetails anzeigen*. Leerzustände erklären kurz, was zu tun ist.
8. **Barrierefreiheit:** Kontrast mindestens WCAG AA (per Test geprüft, hell und dunkel), Mindestschrift 14 px, Klickflächen mindestens 44 px, sichtbarer
   Fokus (3 px), volle Tastaturbedienung, Hell/Dunkel nach Systemeinstellung, Status immer mit Farbe **und** Symbol **und** Text, keine Buttons ohne Text.

## Begriffsliste (alt → neu)

| Alt | Neu |
| --- | --- |
| Incident | Fall |
| Triage, Einschätzung | Erste Einschätzung (im Alltag: "Die KI macht sich ein erstes Bild") |
| Eskalieren | An Kollegen weitergeben |
| Provider | KI-Anbieter |
| API-Key | Zugangsschlüssel (API-Key) |
| Screenshot | Bildschirmfoto |
| Zeiterfassungs-Eintrag | Arbeitszeit eintragen |
| Modellstufe, Routing, Token, Kontext | nur im Erweiterten Modus ("Modelle", "Tokens") |
| Fernwartung starten (Empfehlung `start_remote`) | "Gemeinsam am Bildschirm arbeiten" / Button "Fernwartung starten" |
| Ungültige Antwort (Schema-Fehler) | "Die KI hat nicht verständlich geantwortet" + "Versuche es noch einmal." |

### Status in Alltagsworten

| Status | Text | Symbol | Farbe |
| --- | --- | --- | --- |
| draft | Noch nicht gestartet | ○ | neutral |
| call | Im Telefonat | ☎ | blau |
| triage | Wir arbeiten dran | ⚙ | blau |
| waiting | Wartet auf den Kunden | ⏳ | gelb |
| remote | Wir lösen es gemeinsam | ▶ | blau |
| paused | Pausiert | ⏸ | neutral |
| solved | Gelöst | ✓ | grün |
| unsolved | Nicht gelöst | ✕ | rot |

## Ablauf der Bildschirme

```
Erster Start ─► Willkommens-Assistent (Anbieter/Testmodus ─► Datenschutz ─► Kostenwarnung ─► Testlauf) ─┐
                                   (überspringbar, erscheint nie wieder)                                │
                                                                                                        ▼
Startbildschirm ──"Los geht's"──► Fall: 2 Klären ──(Fernwartung nötig)──► Fall: 3 Gemeinsam lösen ──► Fall: 4 Abschließen
   │  "Telefonat mit Kunden" ───► Fall: Telefonat (Fragen, Stichworte)          │                          │
   │  "Offene Fälle" / Karte ───► Fall-Dialog (weiterbearbeiten, abschließen)   └─ zurück zu 2 möglich     ▼
   └─ "Arbeitszeit ansehen" ───► Arbeitszeit (Liste, CSV)                                    Arbeitszeit eintragen ─► Neuer Fall
```

Mini-Fenster: begleitet die Sitzung (Status, die eine Anweisung, zwei Buttons, Notiz), öffnet und schließt mit dem Fall.

## Usability-Checkliste

Ein Neuling versteht **ohne Erklärung**:

1. **Was ich eingeben soll:** Die Überschrift fragt "Was ist das Problem?", der Platzhalter nennt ein Beispiel, ein Satz reicht.
2. **Was der Pfeil bedeutet:** Die Karte sagt "Nächster Klick" und "Der Pfeil auf deinem Bildschirm zeigt dir die Stelle."
3. **Was ich jetzt klicken soll:** genau ein hervorgehobener Button (*Erledigt* bzw. *Fernwartung starten*).
4. **Wie ich pausiere oder beende:** unter der Karte stehen *Pausieren* und *Fall abschließen* als Text-Links; "Mehr Optionen" enthält den Rest.
5. **Wo meine Fälle sind:** links als Karten, immer sichtbar, mit Status und "zuletzt vor ...".

Prüfen bei jeder Änderung: kein Fachwort in Hauptbildschirmen (Test in `tests/ux.test.ts`), Kontrast und Schriftgrößen (Test in `tests/a11y.test.ts`),
Selbsttest mit `ITT_SELFTEST_SHOTS` ansehen (nur eigene Fenster, Mock-Daten).

## Ehrliche Grenzen

- Die Bedienung per Maus und Tastatur wurde nicht von Menschen getestet; geprüft sind Struktur, Kontrast, Texte und der automatische Durchlauf.
- Der Hell-Modus wurde per Kontrast-Test, aber nicht als Bild geprüft (die Testmaschine nutzt den Dunkelmodus).
- Die KI-Texte (Du-Form, einfache Sprache) werden angefordert, ihre tatsächliche Qualität hängt vom Modell ab (im Mock sind sie festgelegt).
