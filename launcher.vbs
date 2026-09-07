' ============================================================
' BiliNest Launcher
' ------------------------------------------------------------
' 1. Check whether the local proxy is already running;
' 2. If not, start "node server.mjs" in a hidden window;
' 3. Wait until the service is ready, then open the browser.
' If the default port 4173 is occupied, server.mjs auto-advances
' to the next free port and writes it to bilinest.port; this
' script opens the correct address based on that file.
' ============================================================
Option Explicit

Const DEF_PORT = 4173
Const PORT_FILE = "bilinest.port"
Const MAX_WAIT = 40   ' 40 x 500ms = wait up to 20 seconds

Dim fso, scriptDir, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir

' 1) Already running on default port? Open it directly.
If HealthOk(DEF_PORT) Then
  OpenBrowser DEF_PORT
  WScript.Quit
End If

' 2) Did we advance ports last run? If that port is really BiliNest, open it.
Dim lastPort
lastPort = ReadPortFile()
If lastPort > 0 And lastPort <> DEF_PORT Then
  If HealthOk(lastPort) Then
    OpenBrowser lastPort
    WScript.Quit
  End If
End If

' 3) Clear stale port file before starting, to avoid reading old value.
Dim portFilePath
portFilePath = fso.BuildPath(scriptDir, PORT_FILE)
If fso.FileExists(portFilePath) Then fso.DeleteFile portFilePath

' 4) Start the local server (window style 0 = hidden, do not wait).
shell.Run "node server.mjs", 0, False

' 5) Poll until ready: prefer the port file, fall back to default port.
Dim i, p
For i = 1 To MAX_WAIT
  WScript.Sleep 500
  p = ReadPortFile()
  If p > 0 Then
    If HealthOk(p) Then
      OpenBrowser p
      WScript.Quit
    End If
  ElseIf HealthOk(DEF_PORT) Then
    OpenBrowser DEF_PORT
    WScript.Quit
  End If
Next

' 6) Timeout fallback: try the port file or default port one last time.
p = ReadPortFile()
If p > 0 And HealthOk(p) Then
  OpenBrowser p
Else
  OpenBrowser DEF_PORT
End If
WScript.Quit

' ------------------------------------------------------------
' Read bilinest.port (plain numeric text); return 0 on failure.
' ------------------------------------------------------------
Function ReadPortFile()
  On Error Resume Next
  Dim f, s, p
  ReadPortFile = 0
  p = fso.BuildPath(scriptDir, PORT_FILE)
  If fso.FileExists(p) Then
    Set f = fso.OpenTextFile(p, 1, False, -2)
    s = Trim(f.ReadAll)
    f.Close
    If IsNumeric(s) Then ReadPortFile = CInt(s)
  End If
  On Error GoTo 0
End Function

' ------------------------------------------------------------
' Health check: confirm /api/health returns and the response
' actually contains "bilinest" (so we don't open a stranger's
' page if 4173 is taken by something else).
' ------------------------------------------------------------
Function HealthOk(port)
  On Error Resume Next
  Dim xml
  Set xml = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If IsObject(xml) Then
    xml.Open "GET", "http://127.0.0.1:" & port & "/api/health", False
    xml.setTimeouts 800, 800, 800, 2000
    xml.Send
    HealthOk = (xml.Status = 200) And (InStr(xml.responseText, "bilinest") > 0)
    Set xml = Nothing
  Else
    HealthOk = False
  End If
  On Error GoTo 0
End Function

' ------------------------------------------------------------
' Open BiliNest in the default browser.
' ------------------------------------------------------------
Sub OpenBrowser(port)
  Dim s
  Set s = CreateObject("WScript.Shell")
  s.Run "http://127.0.0.1:" & port, 1, False
End Sub
