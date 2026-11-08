# Spike: Provider über offizielle CLIs (Claude Code, GitHub Copilot)

Stand: 2026-11-08. Status: **nur Spike, Adapter `claude-cli` und `copilot-cli` sind NICHT gebaut.**

## Grundsatz

Keine eigene OAuth-Anmeldung, keine Tokens aus CLI-Konfigurationen lesen oder kopieren. Anthropic untersagt Drittanbieter-Apps die
Nutzung von claude.ai-Abo-Logins; robust ist nur, dass der Nutzer die **offizielle, bereits angemeldete CLI lokal** startet. Dasselbe
Prinzip gilt für Copilot (keine inoffiziellen Endpunkte). Beide Provider wären in der UI "experimentell" zu kennzeichnen; Standard bleibt der API-Key-Provider.

## Befunde am echten Rechner (nur `--version`/`--help`, ohne Bildschirmaufnahme und ohne Inhalte)

| Prüfung | Ergebnis |
| --- | --- |
| `where claude` | gefunden: `%APPDATA%\npm\claude.cmd` (npm-Shim) |
| `claude --version` | 2.1.319 (Claude Code) |
| Anmeldestatus | nicht geprüft (kein Aufruf, der das Modell erreicht); wäre über einen harmlosen Prüfaufruf möglich |
| `claude --help`: nicht-interaktiv | `-p, --print` (Antwort ausgeben und beenden), `--output-format` (nur mit `--print`; u. a. `json`, `stream-json`), `--input-format` (nur mit `--print`) |
| Strukturierte Ausgabe | `--json-schema <schema>` vorhanden |
| Modellwahl | `--model <model>`, `--fallback-model` |
| Tools einschränken | `--tools <tools...>` (Liste verfügbarer Tools), `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--disable-slash-commands`, `--strict-mcp-config`, `--bare` (minimal: keine Hooks u. a.), `--no-session-persistence`, `--max-budget-usd` |
| Bildübergabe | **in `--help` nicht dokumentiert.** Ein Bild bräuchte vermutlich den Lese-Tool-Zugriff auf eine Datei, was dem Ziel "keine Tools" widerspricht. **Ungeprüft** – nicht raten |
| `where copilot` | nicht gefunden |
| `gh copilot --help` | `gh` 2.102.0 vorhanden; `gh copilot` startet die Copilot CLI (Vorschau); falls nicht installiert, würde sie nach `%LOCALAPPDATA%\GitHub CLI\copilot` heruntergeladen (deshalb nicht ausgeführt) |

## Konsequenzen für den Bau (falls gewünscht)

- Adapter hinter einer austauschbaren **Prozess-Schnittstelle** (`spawn` mit Argument-Array, ohne Shell, stdin für den Prompt, Timeout, Prozessbaum
  beenden, leerer Temp-Ordner als Arbeitsverzeichnis, minimale Umgebungsvariablen) und Fake-Prozess für Tests.
- Claude-CLI: `-p --output-format json --json-schema <Schema> --model <Stufe> --tools "" --no-session-persistence --bare` wäre der Ansatz; ob
  `--tools ""` Bilder zuließe, ist **ungeprüft**. Ohne Bildübergabe wäre nur der Text-Modus (siehe `docs/M365-COPILOT.md`) möglich.
- Kosten: keine verlässlichen Token-Preise, Anzeige "Abo/Firmenlizenz, nicht berechnet", Limit nach Anfragen pro Tag.
- Datenschutz: Claude-CLI sendet an Anthropic, Copilot an GitHub/Microsoft nach Firmenrichtlinie; Nutzer muss die Zulässigkeit prüfen.

**Nicht live verifiziert:** Anmeldezustand, tatsächliches Verhalten von `--json-schema`, Bildübergabe, Copilot-CLI-Funktionen (nicht installiert).
