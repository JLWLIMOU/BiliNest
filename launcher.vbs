' ============================================================
' BiliPure Launcher
' ------------------------------------------------------------
' 1. Check whether the local proxy is already running;
' 2. If not, start "node server.mjs" in a hidden window;
' 3. Wait until the service is ready, then open the browser.
' ============================================================
Option Explicit

Const APP_URL = "http://127.0.0.1:4173"

Dim fso, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Open the browser directly if the service is already up
If HealthOk() Then
  OpenBrowser
  WScript.Quit
End If

' Start the local proxy hidden (window style 0, do not wait)
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir
shell.Run "node server.mjs", 0, False

' Wait up to ~15 seconds for the service to become ready
Dim i
For i = 1 To 30
  WScript.Sleep 500
  If HealthOk() Then Exit For
Next

OpenBrowser
WScript.Quit

' ------------------------------------------------------------
' Health check against the local proxy (MSXML2 is built into Windows)
' ------------------------------------------------------------
Function HealthOk()
  On Error Resume Next
  Dim xml
  Set xml = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If IsObject(xml) Then
    xml.Open "GET", APP_URL & "/api/health", False
    xml.setTimeouts 800, 800, 800, 2000
    xml.Send
    HealthOk = (xml.Status = 200)
    Set xml = Nothing
  Else
    HealthOk = False
  End If
  On Error GoTo 0
End Function

' ------------------------------------------------------------
' Open BiliPure in the default browser
' ------------------------------------------------------------
Sub OpenBrowser()
  Dim s
  Set s = CreateObject("WScript.Shell")
  s.Run APP_URL, 1, False
End Sub
