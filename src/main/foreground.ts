import { execFile } from 'node:child_process';
import type { ForegroundInfo, ForegroundProbe } from './autoAdvance';

/**
 * Vordergrundfenster unter Windows (GetForegroundWindow, Prozessname und Fenstertitel) per PowerShell.
 * Liest nur Titel und Prozessnamen, keine Bildinhalte. Nur für den optionalen Modus Auto-Weiter.
 */
export class WindowsForegroundProbe implements ForegroundProbe {
  private cache: { at: number; value: ForegroundInfo | null } | null = null;

  get(): Promise<ForegroundInfo | null> {
    if (process.platform !== 'win32') return Promise.resolve(null);
    if (this.cache && Date.now() - this.cache.at < 700) return Promise.resolve(this.cache.value);
    const script = [
      "Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class F{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'",
      '$h=[F]::GetForegroundWindow()',
      '$sb=New-Object Text.StringBuilder 256',
      '[void][F]::GetWindowText($h,$sb,256)',
      '$p=0;[void][F]::GetWindowThreadProcessId($h,[ref]$p)',
      '$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName',
      'Write-Output ("{0}|{1}" -f $n,$sb.ToString())',
    ].join(';');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        let value: ForegroundInfo | null = null;
        if (!err) {
          const line = stdout.trim().split(/\r?\n/)[0] ?? '';
          const i = line.indexOf('|');
          if (i >= 0) value = { processName: line.slice(0, i), title: line.slice(i + 1) };
        }
        this.cache = { at: Date.now(), value };
        resolve(value);
      });
    });
  }
}
