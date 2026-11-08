# Spike: Microsoft 365 Copilot als LLM-Provider

Stand: 2026-11-08. Status: **nur Spike und Konzept, der Provider `m365-copilot` ist NICHT gebaut.**
Quelle der Fakten: Recherche des Koordinators in der Microsoft-Doku (learn.microsoft.com: Copilot APIs Overview, Chat API Overview,
`copilotconversation-chat`); von mir **nicht erneut geprüft**. Alles unten gilt als "laut Koordinator-Recherche".

## Ergebnis in einem Satz

Es **geht grundsätzlich**, aber nur als **reiner Text-Provider** über die Beta-Chat-API, **ohne Bilder**; die Voraussetzungen (Add-on-Lizenz,
sieben delegierte Scopes mit Admin-Consent, Preview-Status) muss die IT der Firma schaffen.

## Fakten (laut Koordinator-Recherche, ungeprüft von mir)

- Endpunkt: **Preview/Beta** `https://graph.microsoft.com/beta/copilot/conversations` (POST erzeugt eine Konversation), dann
  `POST /{id}/chat` (synchron) oder `/chatOverStream` (SSE). Nur **delegiert**, "Application" nicht unterstützt. Lizenz: **M365-Copilot-Add-on pro Nutzer**.
  Produktivnutzung der Beta ist laut Doku nicht unterstützt.
- Delegierte Scopes, **alle sieben** nötig: `Sites.Read.All`, `Mail.Read`, `People.Read.All`, `OnlineMeetingTranscript.Read.All`, `Chat.Read`,
  `ChannelMessage.Read.All`, `ExternalItem.Read.All`. Genau diese und nichts weiter anfordern.
- Eingaben: `message.text`, `additionalContext[].text`, `contextualResources.files[].uri` (nur OneDrive/SharePoint), `webContext.isWebEnabled`,
  `locationHint.timeZone` (Pflicht). **Keine Bilder, nur Textantworten.** Keine dokumentierte strukturierte Ausgabe (JSON per Prompt erzwingen).
  Antworten können Markup wie `<Person>` und Zitate `[^1^]` enthalten (vor dem Parsen bereinigen).
- Web-Grounding standardmäßig **aus**: `isWebEnabled: false` pro Nachricht (gilt nur für eine Runde). Enterprise-Grounding ist nicht abschaltbar –
  im Prompt kein Bezug darauf nehmen, im README erwähnen.
- Rate-Limits, Datenresidenz, Modellwahl (vermutlich keine), Streaming: nur Streaming (`chatOverStream`) belegt; übrige Punkte **ungeprüft**.

## Konsequenzen für das Design

1. **Betriebsart Bild entfällt.** Keine Screenshots in die Cloud hochladen (kein OneDrive-Upload).
2. **TEXT-ONLY-Modus** mit `additionalContext`:
   - Pfeilziel nicht aus Pixeln raten, sondern aus der **Windows-UI-Automation-Elementliste** (lesend: Name, Typ, AutomationId, Bounding-Rect;
     begrenzte Anzahl, nach Sichtbarkeit gefiltert, **keine Passwortfelder, keine Werte von Eingabefeldern**). Das Textmodell wählt die Element-ID,
     das Tool setzt den Pfeil auf die Rect-Mitte (Umrechnung DPI/Monitor wie in `src/shared/coords.ts`).
   - **TeamViewer/RDP/Remote-Canvas:** Das Fernbild ist ein Bitmap, **UI-Automation hilft dort nicht**. Dann nur lokale **OCR** (Windows.Media.Ocr, Text + Wort-Rects)
     oder ehrlich "Anweisung ohne Pfeil" bzw. manuelle Zielauswahl. Im Bildmodus mit einem anderen Provider (Anthropic) ist das kein Problem.
   - UI muss klar anzeigen, welcher Modus aktiv ist.
3. **Authentifizierung** (nicht gebaut): selbst registrierte Entra-ID-App (Public Client), MSAL Node, Authorization Code + PKCE mit Loopback-Redirect
   `http://localhost` über den Systembrowser, Tokens im MSAL-Cache verschlüsselt per `safeStorage`, nie im Renderer oder in Logs. Einstellungen: Tenant-ID und
   Client-ID (GUID-Validierung). Anzeige "angemeldet als UPN", Abmelden, Fehler 401/403 (Lizenz/Consent)/Throttling mit `Retry-After`.
   Die Anleitung für die IT (Registrierung, Admin-Consent) liegt dem Nutzer vor; hier gilt nur die Scope-Liste und die Redirect-URI.
4. **Harte Allowlist** im Provider: ausschließlich `https://graph.microsoft.com/beta/copilot/*`; nie Mail/Chats/Sites direkt lesen, Token nie weitergeben.
   Test: jeder andere Host oder Pfad wird abgelehnt.
5. **Kosten/Limits:** "Lizenz, nicht berechnet"; Limit nach Anfragen pro Tag statt Euro. Auto-Weiter und Eskalation respektieren das.
6. **Datenschutz:** UIA-/OCR-Text und Verlauf gehen an Microsoft im Rahmen des Firmenvertrags; IT/Datenschutz muss freigeben.

## Nicht live verifiziert

Alles oben: Anmeldung, Aufruf der API, Lizenz-/Consent-Zustand, tatsächliche Antwortqualität bei JSON-per-Prompt, UIA-Ausbeute je Zielprogramm.
